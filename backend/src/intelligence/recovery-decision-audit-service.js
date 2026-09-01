import crypto from 'node:crypto';
import { RecoveryActionType } from '../enums/recovery-action.js';
import { RETRY_LIMIT } from '../services/recovery-decision-engine.js';
import {
  DECISION_SOURCES,
  FALLBACK_REASONS,
  CANDIDATE_ACTION_ORDER
} from './recovery-decision-policy.js';
import {
  FEATURE_PIPELINE_VERSION,
  FEATURE_SCHEMA_VERSION
} from './recovery-feature-pipeline.js';
import { INTERACTION_MODEL_VERSION } from './candidate-model-comparison.js';

export const AUDIT_SCHEMA_VERSION = '6.7.0';
export const DECISION_POLICY_VERSION = '6.7.0';

export const SAFETY_REJECTION_REASONS = Object.freeze({
  RETRY_NOT_APPLICABLE_FOR_CATEGORY: 'RETRY_NOT_APPLICABLE_FOR_CATEGORY',
  RETRY_LIMIT_EXCEEDED: 'RETRY_LIMIT_EXCEEDED',
  NO_SAFE_ALTERNATE_METHOD: 'NO_SAFE_ALTERNATE_METHOD',
  ACTION_ALREADY_EXECUTED: 'ACTION_ALREADY_EXECUTED',
  TRANSACTION_NOT_FAILED: 'TRANSACTION_NOT_FAILED'
});

function firstDefined(context, fields) {
  return fields.map((field) => context[field]).find((value) => value !== undefined);
}

export function evaluateCandidateSafety(context, action) {
  const transactionStatus = firstDefined(context, ['transaction_status', 'transactionStatus']);
  if (transactionStatus !== undefined && transactionStatus !== 'FAILED') {
    return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.TRANSACTION_NOT_FAILED };
  }

  const executedActions = firstDefined(context, ['executed_action_types', 'executedActionTypes', 'already_executed_actions']);
  if (Array.isArray(executedActions) && executedActions.includes(action)) {
    return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.ACTION_ALREADY_EXECUTED };
  }

  const recoveryActions = firstDefined(context, ['existing_recovery_actions', 'existingRecoveryActions']);
  if (Array.isArray(recoveryActions)) {
    const isExecuted = recoveryActions.some((item) => {
      const itemAction = item.actionType ?? item.action_type ?? item.candidate_action_type;
      return itemAction === action && ['EXECUTED', 'SUCCESS', 'FAILED'].includes(item.status);
    });
    if (isExecuted) {
      return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.ACTION_ALREADY_EXECUTED };
    }
  }

  if (action === RecoveryActionType.RETRY) {
    const failureCategory = firstDefined(context, ['failure_category', 'failureCategory']);
    const previousTemporaryFailureCount = firstDefined(context, [
      'prior_temporary_failure_count',
      'previousTemporaryFailureCount',
      'priorTemporaryFailureCount'
    ]) ?? 0;

    if (failureCategory !== 'TEMPORARY_FAILURE') {
      return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.RETRY_NOT_APPLICABLE_FOR_CATEGORY };
    }
    if (!Number.isInteger(previousTemporaryFailureCount) || previousTemporaryFailureCount >= RETRY_LIMIT) {
      return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.RETRY_LIMIT_EXCEEDED };
    }
    return { is_safe: true, rejection_reason: null };
  }

  if (action === RecoveryActionType.ALTERNATE_METHOD) {
    const attemptedMethod = firstDefined(context, ['payment_method_attempted', 'paymentMethodAttempted', 'payment_method', 'paymentMethod']);
    const requestedMethod = firstDefined(context, ['alternate_payment_method', 'alternatePaymentMethod']);
    if (requestedMethod !== undefined && requestedMethod === attemptedMethod) {
      return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.NO_SAFE_ALTERNATE_METHOD };
    }

    const availableMethods = firstDefined(context, ['available_payment_methods', 'availablePaymentMethods']);
    if (Array.isArray(availableMethods) && !availableMethods.some((method) => method !== attemptedMethod)) {
      return { is_safe: false, rejection_reason: SAFETY_REJECTION_REASONS.NO_SAFE_ALTERNATE_METHOD };
    }
    return { is_safe: true, rejection_reason: null };
  }

  return { is_safe: true, rejection_reason: null };
}

export function buildDecisionAuditRecord({
  decision,
  context,
  correlation = {},
  decisionTimestamp = new Date().toISOString(),
  decisionLatencyMs = 0
}) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('Decision object is required to build an audit record.');
  }
  if (!context || typeof context !== 'object') {
    throw new Error('Context object is required to build an audit record.');
  }
  if (!decision.selected_action || typeof decision.selected_action !== 'string') {
    throw new Error('Decision must contain a valid selected_action.');
  }
  if (!decision.decision_source || ![DECISION_SOURCES.ML, DECISION_SOURCES.RULE].includes(decision.decision_source)) {
    throw new Error('Decision must specify a valid decision_source (ML or RULE).');
  }

  const transactionId = correlation.transaction_id ?? correlation.transactionId ?? context.transaction_id ?? context.transactionId ?? null;
  const attemptId = correlation.attempt_id ?? correlation.attemptId ?? context.attempt_id ?? context.attemptId ?? null;
  const recoveryActionId = correlation.recovery_action_id ?? correlation.recoveryActionId ?? null;

  const failureCategory = firstDefined(context, ['failure_category', 'failureCategory']) ?? null;
  const paymentMethodAttempted = firstDefined(context, ['payment_method_attempted', 'paymentMethodAttempted', 'payment_method', 'paymentMethod']) ?? null;
  const attemptNumber = firstDefined(context, ['attempt_number', 'attemptNumber']) ?? 1;
  const priorFailedAttemptCount = firstDefined(context, ['prior_failed_attempt_count', 'priorFailedAttemptCount']) ?? 0;
  const priorTemporaryFailureCount = firstDefined(context, ['prior_temporary_failure_count', 'priorTemporaryFailureCount', 'previousTemporaryFailureCount']) ?? 0;
  const transactionAmount = firstDefined(context, ['transaction_amount', 'transactionAmount']) ?? null;
  const currency = firstDefined(context, ['currency']) ?? null;
  const hasFailureReason = firstDefined(context, ['has_failure_reason', 'hasFailureReason']) ?? false;

  const candidatePredictions = Array.isArray(decision.candidate_predictions) ? decision.candidate_predictions : [];
  const predictionMap = new Map();
  for (const pred of candidatePredictions) {
    const action = pred.candidate_action_type ?? pred.action;
    const prob = pred.recovery_probability ?? pred.probability;
    if (action) {
      predictionMap.set(action, {
        probability: typeof prob === 'number' ? prob : null,
        modelVersion: pred.model_version ?? null
      });
    }
  }

  const candidateRecords = CANDIDATE_ACTION_ORDER.map((action) => {
    const safety = evaluateCandidateSafety(context, action);
    const predInfo = predictionMap.get(action);
    return {
      action_type: action,
      ml_probability: predInfo ? predInfo.probability : null,
      is_safe: safety.is_safe,
      rejection_reason: safety.rejection_reason
    };
  });

  const rejectedCandidates = candidateRecords
    .filter((c) => !c.is_safe)
    .map((c) => ({
      action_type: c.action_type,
      ml_probability: c.ml_probability,
      rejection_reason: c.rejection_reason
    }));

  const isFallback = decision.decision_source === DECISION_SOURCES.RULE;
  const fallbackReason = isFallback
    ? (decision.fallback_reason ?? FALLBACK_REASONS.MODEL_UNAVAILABLE)
    : null;
  const fallbackError = isFallback ? (decision.fallback_error ?? null) : null;

  const modelVersion = decision.decision_source === DECISION_SOURCES.ML
    ? (decision.model_version ?? INTERACTION_MODEL_VERSION)
    : null;

  const auditRecord = {
    audit_id: `audit_${crypto.randomUUID()}`,
    audit_schema_version: AUDIT_SCHEMA_VERSION,
    decision_timestamp: decisionTimestamp,
    correlation: {
      transaction_id: transactionId,
      attempt_id: attemptId,
      recovery_action_id: recoveryActionId
    },
    context: {
      failure_category: failureCategory,
      payment_method_attempted: paymentMethodAttempted,
      attempt_number: Number(attemptNumber),
      prior_failed_attempt_count: Number(priorFailedAttemptCount),
      prior_temporary_failure_count: Number(priorTemporaryFailureCount),
      transaction_amount: transactionAmount !== null ? Number(transactionAmount) : null,
      currency: currency,
      has_failure_reason: Boolean(hasFailureReason)
    },
    candidates: candidateRecords,
    rejected_candidates: rejectedCandidates,
    selected_action: decision.selected_action,
    decision_source: decision.decision_source,
    decision_reason: decision.reason ?? '',
    selected_probability: decision.decision_source === DECISION_SOURCES.ML
      ? (decision.recovery_probability ?? (predictionMap.get(decision.selected_action)?.probability ?? null))
      : null,
    fallback: {
      is_fallback: isFallback,
      fallback_reason: fallbackReason,
      fallback_error: fallbackError
    },
    versions: {
      model_version: modelVersion,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      feature_pipeline_version: FEATURE_PIPELINE_VERSION,
      policy_version: DECISION_POLICY_VERSION,
      audit_schema_version: AUDIT_SCHEMA_VERSION
    },
    performance: {
      decision_latency_ms: Number(Number(decisionLatencyMs).toFixed(3))
    }
  };

  return Object.freeze(auditRecord);
}

export class RecoveryDecisionAuditService {
  constructor({ maxBufferedRecords = 1000 } = {}) {
    this.maxBufferedRecords = maxBufferedRecords;
    this.buffer = [];
  }

  createAuditRecord(params) {
    return buildDecisionAuditRecord(params);
  }

  record(params) {
    const auditRecord = params?.audit_schema_version ? params : this.createAuditRecord(params);
    this.buffer.push(auditRecord);
    if (this.buffer.length > this.maxBufferedRecords) {
      this.buffer.shift();
    }
    return auditRecord;
  }

  getRecentRecords({ limit = 50, filter = null } = {}) {
    let records = [...this.buffer];
    if (typeof filter === 'function') {
      records = records.filter(filter);
    }
    return records.slice(-limit);
  }

  findByRecoveryActionId(actionId, transactionId = null) {
    if (!actionId) return null;
    return this.buffer.find((record) =>
      record.correlation.recovery_action_id === actionId &&
      (!transactionId || record.correlation.transaction_id === transactionId)
    ) ?? null;
  }

  findByAttemptId(attemptId, transactionId = null) {
    if (!attemptId) return null;
    return this.buffer.find((record) =>
      record.correlation.attempt_id === attemptId &&
      (!transactionId || record.correlation.transaction_id === transactionId)
    ) ?? null;
  }

  findByTransactionId(transactionId) {
    if (!transactionId) return [];
    return this.buffer.filter((record) => record.correlation.transaction_id === transactionId);
  }

  getRecordCount() {
    return this.buffer.length;
  }

  clear() {
    this.buffer = [];
  }
}
