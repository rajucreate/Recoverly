import crypto from 'node:crypto';
import { RecoveryActionType } from '../enums/recovery-action.js';
import { DECISION_SOURCES } from './recovery-decision-policy.js';
import {
  FEATURE_PIPELINE_VERSION,
  FEATURE_SCHEMA_VERSION
} from './recovery-feature-pipeline.js';
import {
  AUDIT_SCHEMA_VERSION,
  DECISION_POLICY_VERSION
} from './recovery-decision-audit-service.js';
import { INTERACTION_MODEL_VERSION } from './candidate-model-comparison.js';
import {
  DATASET_VERSION,
  SCHEMA_VERSION
} from './recovery-dataset-generator.js';

export const FEEDBACK_SCHEMA_VERSION = '6.10.0';

export const FEEDBACK_OUTCOMES = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXECUTED: 'EXECUTED'
});

const VALID_ACTIONS = new Set(Object.values(RecoveryActionType));
const VALID_SOURCES = new Set(Object.values(DECISION_SOURCES));
const VALID_OUTCOMES = new Set(Object.values(FEEDBACK_OUTCOMES));

function firstDefined(object, fields) {
  if (!object || typeof object !== 'object') return undefined;
  for (const field of fields) {
    if (object[field] !== undefined && object[field] !== null) {
      return object[field];
    }
  }
  return undefined;
}

export function buildFeedbackRecord(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('Feedback parameters must be a non-null object.');
  }

  const executionResult = params.executionResult ?? params.execution_result ?? null;
  const auditService = params.auditService ?? null;
  let auditRecord = params.auditRecord ?? params.audit_record ?? null;
  const correlationObj = params.correlation ?? (auditRecord?.correlation ?? {});

  // 1. Initial correlation lookup
  const transactionId = firstDefined(params, ['transaction_id', 'transactionId'])
    ?? firstDefined(correlationObj, ['transaction_id', 'transactionId'])
    ?? firstDefined(auditRecord?.correlation, ['transaction_id', 'transactionId'])
    ?? firstDefined(executionResult?.recoveryAction, ['transactionId', 'transaction_id'])
    ?? firstDefined(executionResult?.attempt, ['transactionId', 'transaction_id'])
    ?? null;

  const recoveryActionId = firstDefined(params, ['recovery_action_id', 'recoveryActionId', 'action_id', 'actionId'])
    ?? firstDefined(correlationObj, ['recovery_action_id', 'recoveryActionId'])
    ?? firstDefined(auditRecord?.correlation, ['recovery_action_id', 'recoveryActionId'])
    ?? firstDefined(executionResult?.recoveryAction, ['id', 'recoveryActionId'])
    ?? null;

  const triggerAttemptId = firstDefined(params, ['attempt_id', 'attemptId', 'trigger_attempt_id', 'triggerAttemptId'])
    ?? firstDefined(correlationObj, ['attempt_id', 'attemptId', 'trigger_attempt_id', 'triggerAttemptId'])
    ?? firstDefined(auditRecord?.correlation, ['attempt_id', 'attemptId', 'trigger_attempt_id', 'triggerAttemptId'])
    ?? firstDefined(executionResult?.recoveryAction, ['attemptId', 'attempt_id'])
    ?? null;

  // 2. If auditRecord not directly passed, query auditService scoped by transactionId
  if (!auditRecord && auditService) {
    if (recoveryActionId) {
      auditRecord = auditService.findByRecoveryActionId(recoveryActionId, transactionId);
    }
    if (!auditRecord && triggerAttemptId) {
      auditRecord = auditService.findByAttemptId(triggerAttemptId, transactionId);
    }
  }

  const executionAttemptId = firstDefined(params, ['execution_attempt_id', 'executionAttemptId'])
    ?? firstDefined(executionResult?.attempt, ['id', 'attemptId'])
    ?? null;

  if (!transactionId || typeof transactionId !== 'string' || transactionId.trim().length === 0) {
    throw new Error('transaction_id is required and must be a valid non-empty string.');
  }
  if (!triggerAttemptId || typeof triggerAttemptId !== 'string' || triggerAttemptId.trim().length === 0) {
    throw new Error('attempt_id (trigger attempt) is required and must be a valid non-empty string.');
  }

  const decisionObj = params.decision ?? null;
  const contextObj = params.context ?? (auditRecord?.context ?? {});

  // 3. Authoritative decision details (from original audit record, explicit decision object, or explicit parameters)
  const recoveryAction = firstDefined(auditRecord, ['selected_action', 'selectedAction'])
    ?? firstDefined(decisionObj, ['selected_action', 'selectedAction', 'action_type', 'actionType'])
    ?? firstDefined(params, ['recovery_action', 'recoveryAction', 'selected_action', 'selectedAction', 'action_type', 'actionType'])
    ?? firstDefined(executionResult?.recoveryAction, ['actionType', 'action_type'])
    ?? null;

  if (!recoveryAction || !VALID_ACTIONS.has(recoveryAction)) {
    throw new Error(`Invalid or missing recovery_action: ${recoveryAction}`);
  }

  const decisionSource = firstDefined(auditRecord, ['decision_source', 'decisionSource'])
    ?? firstDefined(decisionObj, ['decision_source', 'decisionSource'])
    ?? firstDefined(params, ['decision_source', 'decisionSource'])
    ?? DECISION_SOURCES.RULE;

  if (!VALID_SOURCES.has(decisionSource)) {
    throw new Error(`Invalid decision_source: ${decisionSource}. Expected ML or RULE.`);
  }

  let predictedProbability = null;
  let modelVersion = null;

  if (decisionSource === DECISION_SOURCES.ML) {
    const rawProb = firstDefined(auditRecord, ['selected_probability', 'selectedProbability'])
      ?? firstDefined(decisionObj, [
        'predicted_recovery_probability',
        'predictedRecoveryProbability',
        'predicted_probability',
        'predictedProbability',
        'recovery_probability',
        'recoveryProbability',
        'selected_probability',
        'selectedProbability',
        'probability'
      ])
      ?? firstDefined(params, [
        'predicted_recovery_probability',
        'predictedRecoveryProbability',
        'predicted_probability',
        'predictedProbability',
        'selected_probability',
        'selectedProbability',
        'recovery_probability',
        'recoveryProbability',
        'probability'
      ])
      ?? null;

    if (rawProb !== null && rawProb !== undefined) {
      const numProb = Number(rawProb);
      if (!Number.isFinite(numProb) || numProb < 0 || numProb > 1) {
        throw new Error(`predicted_recovery_probability must be a number between 0 and 1, got ${rawProb}`);
      }
      predictedProbability = numProb;
    }

    modelVersion = firstDefined(auditRecord?.versions, ['model_version', 'modelVersion'])
      ?? firstDefined(decisionObj, ['model_version', 'modelVersion'])
      ?? firstDefined(params, ['model_version', 'modelVersion'])
      ?? INTERACTION_MODEL_VERSION;
  }

  const decisionReason = firstDefined(auditRecord, ['decision_reason', 'decisionReason'])
    ?? firstDefined(decisionObj, ['reason', 'decision_reason'])
    ?? firstDefined(params, ['decision_reason', 'decisionReason', 'reason'])
    ?? firstDefined(executionResult?.recoveryAction, ['reason'])
    ?? '';

  const fallbackReason = firstDefined(auditRecord?.fallback, ['fallback_reason', 'fallbackReason'])
    ?? firstDefined(decisionObj, ['fallback_reason', 'fallbackReason'])
    ?? firstDefined(params?.fallback, ['fallback_reason', 'fallbackReason'])
    ?? null;

  const fallbackError = firstDefined(auditRecord?.fallback, ['fallback_error', 'fallbackError'])
    ?? firstDefined(decisionObj, ['fallback_error', 'fallbackError'])
    ?? firstDefined(params?.fallback, ['fallback_error', 'fallbackError'])
    ?? null;

  // 4. Authoritative execution outcome
  const rawOutcome = firstDefined(params, ['execution_outcome', 'executionOutcome', 'outcome', 'status'])
    ?? firstDefined(executionResult?.attempt, ['status', 'outcome'])
    ?? firstDefined(executionResult?.recoveryAction, ['status', 'outcome'])
    ?? null;

  if (!rawOutcome || !VALID_OUTCOMES.has(rawOutcome)) {
    throw new Error(
      `Execution outcome is required and must be a terminal outcome (${Array.from(VALID_OUTCOMES).join(', ')}). ` +
      `Received: '${rawOutcome}'. No feedback can be created before an actual execution outcome exists.`
    );
  }

  const executionOutcome = rawOutcome;

  // 5. Actual recovery_success tri-state evaluation (strictly derived from authoritative execution, NEVER from prediction)
  let actualRecoverySuccess;
  if (params.actual_recovery_success !== undefined || params.actualRecoverySuccess !== undefined) {
    const explicitSuccess = params.actual_recovery_success ?? params.actualRecoverySuccess;
    if (explicitSuccess !== null && typeof explicitSuccess !== 'boolean') {
      throw new Error(`actual_recovery_success must be a boolean or null, received ${typeof explicitSuccess}`);
    }
    actualRecoverySuccess = explicitSuccess;
  } else {
    if (executionOutcome === FEEDBACK_OUTCOMES.SUCCESS) {
      actualRecoverySuccess = true;
    } else if (executionOutcome === FEEDBACK_OUTCOMES.FAILED) {
      actualRecoverySuccess = false;
    } else {
      // EXECUTED (e.g. CUSTOMER_ACTION, ESCALATE): tri-state null represents action executed with payment outcome unobserved
      actualRecoverySuccess = null;
    }
  }

  const outcomeTimestamp = firstDefined(params, ['outcome_timestamp', 'outcomeTimestamp'])
    ?? firstDefined(executionResult?.attempt, ['createdAt', 'created_at'])
    ?? firstDefined(executionResult?.recoveryAction, ['createdAt', 'created_at'])
    ?? new Date().toISOString();

  const feedbackTimestamp = firstDefined(params, ['feedback_timestamp', 'feedbackTimestamp', 'created_at', 'createdAt'])
    ?? new Date().toISOString();

  // 6. Prediction context
  const transactionAmount = firstDefined(contextObj, ['transaction_amount', 'transactionAmount', 'amount'])
    ?? firstDefined(params, ['transaction_amount', 'transactionAmount'])
    ?? null;

  const currency = firstDefined(contextObj, ['currency'])
    ?? firstDefined(params, ['currency'])
    ?? null;

  const paymentMethodAttempted = firstDefined(contextObj, ['payment_method_attempted', 'paymentMethodAttempted', 'payment_method', 'paymentMethod'])
    ?? firstDefined(params, ['payment_method_attempted', 'paymentMethodAttempted', 'payment_method', 'paymentMethod'])
    ?? null;

  const failureCategory = firstDefined(contextObj, ['failure_category', 'failureCategory'])
    ?? firstDefined(params, ['failure_category', 'failureCategory'])
    ?? null;

  const hasFailureReason = firstDefined(contextObj, ['has_failure_reason', 'hasFailureReason'])
    ?? (firstDefined(contextObj, ['failure_reason', 'failureReason', 'failure_reason_text', 'failureReasonText']) ? true : false);

  const failureReasonText = firstDefined(contextObj, ['failure_reason_text', 'failureReasonText', 'failure_reason', 'failureReason'])
    ?? firstDefined(params, ['failure_reason_text', 'failureReasonText', 'failure_reason', 'failureReason'])
    ?? null;

  const attemptNumber = Number(firstDefined(contextObj, ['attempt_number', 'attemptNumber']) ?? firstDefined(params, ['attempt_number', 'attemptNumber']) ?? 1);
  const priorFailedAttemptCount = Number(firstDefined(contextObj, ['prior_failed_attempt_count', 'priorFailedAttemptCount']) ?? firstDefined(params, ['prior_failed_attempt_count', 'priorFailedAttemptCount']) ?? 0);
  const priorTemporaryFailureCount = Number(firstDefined(contextObj, ['prior_temporary_failure_count', 'priorTemporaryFailureCount']) ?? firstDefined(params, ['prior_temporary_failure_count', 'priorTemporaryFailureCount']) ?? 0);

  const priorPaymentMethodHistory = firstDefined(contextObj, ['prior_payment_method_history', 'priorPaymentMethodHistory'])
    ?? (paymentMethodAttempted ? JSON.stringify([paymentMethodAttempted]) : '[]');

  const feedbackId = params.feedback_id ?? params.feedbackId ?? `feedback_${crypto.randomUUID()}`;

  const feedbackRecord = {
    feedback_id: feedbackId,
    feedback_schema_version: FEEDBACK_SCHEMA_VERSION,
    feedback_timestamp: feedbackTimestamp,
    correlation: {
      transaction_id: transactionId,
      trigger_attempt_id: triggerAttemptId,
      recovery_action_id: recoveryActionId,
      execution_attempt_id: executionAttemptId,
      audit_id: auditRecord?.audit_id ?? null
    },
    decision: {
      selected_action: recoveryAction,
      decision_source: decisionSource,
      predicted_recovery_probability: predictedProbability,
      model_version: modelVersion,
      decision_reason: decisionReason,
      fallback: {
        is_fallback: decisionSource === DECISION_SOURCES.RULE,
        fallback_reason: fallbackReason,
        fallback_error: fallbackError
      }
    },
    context: {
      transaction_amount: transactionAmount !== null ? Number(transactionAmount) : null,
      currency,
      payment_method_attempted: paymentMethodAttempted,
      failure_category: failureCategory,
      has_failure_reason: Boolean(hasFailureReason),
      failure_reason_text: failureReasonText,
      attempt_number: attemptNumber,
      prior_failed_attempt_count: priorFailedAttemptCount,
      prior_temporary_failure_count: priorTemporaryFailureCount,
      prior_payment_method_history: typeof priorPaymentMethodHistory === 'string' ? priorPaymentMethodHistory : JSON.stringify(priorPaymentMethodHistory)
    },
    execution: {
      execution_outcome: executionOutcome,
      actual_recovery_success: actualRecoverySuccess,
      outcome_timestamp: outcomeTimestamp
    },
    versions: {
      model_version: modelVersion,
      feature_schema_version: FEATURE_SCHEMA_VERSION,
      feature_pipeline_version: FEATURE_PIPELINE_VERSION,
      policy_version: DECISION_POLICY_VERSION,
      audit_schema_version: AUDIT_SCHEMA_VERSION,
      feedback_schema_version: FEEDBACK_SCHEMA_VERSION
    }
  };

  return Object.freeze(feedbackRecord);
}

export function feedbackRecordToDatasetRow(feedbackRecord) {
  if (!feedbackRecord || typeof feedbackRecord !== 'object') {
    throw new Error('Feedback record is required to construct a dataset row.');
  }

  const { correlation, decision, context, execution } = feedbackRecord;

  let targetSuccess = null;
  if (execution.actual_recovery_success === true) {
    targetSuccess = 1;
  } else if (execution.actual_recovery_success === false) {
    targetSuccess = 0;
  }

  return {
    record_id: `fb_row_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    decision_id: feedbackRecord.feedback_id,
    decision_timestamp: feedbackRecord.feedback_timestamp,
    transaction_id: correlation.transaction_id,
    attempt_id: correlation.trigger_attempt_id,
    transaction_amount: context.transaction_amount !== null ? Number(context.transaction_amount) : 0,
    currency: context.currency || 'INR',
    payment_method: context.payment_method_attempted || 'UPI',
    failure_category: context.failure_category || 'UNKNOWN_FAILURE',
    failure_reason_present: Boolean(context.has_failure_reason),
    failure_reason_text: context.failure_reason_text || (context.has_failure_reason ? 'generic failure' : ''),
    attempt_number: Number(context.attempt_number || 1),
    prior_failed_attempt_count: Number(context.prior_failed_attempt_count || 0),
    prior_temporary_failure_count: Number(context.prior_temporary_failure_count || 0),
    prior_payment_method_history: context.prior_payment_method_history || '[]',
    candidate_action: decision.selected_action,
    selected_action: decision.selected_action,
    action_executed: true,
    recovery_success: targetSuccess !== null ? targetSuccess : 0,
    recovery_outcome: execution.execution_outcome === FEEDBACK_OUTCOMES.SUCCESS ? 'SUCCESS' : 'FAILED',
    outcome_timestamp: execution.outcome_timestamp,
    dataset_version: DATASET_VERSION,
    schema_version: SCHEMA_VERSION
  };
}

export class RecoveryFeedbackService {
  constructor({ auditService = null, maxBufferedRecords = 1000 } = {}) {
    this.auditService = auditService;
    this.maxBufferedRecords = maxBufferedRecords;
    this.buffer = [];
    this.dedupIndex = new Map();
  }

  buildDeduplicationKey(record) {
    const txn = record.correlation.transaction_id;
    const trigger = record.correlation.trigger_attempt_id;
    const action = record.decision.selected_action;
    const outcome = record.execution.execution_outcome;
    return `${txn}:${trigger}:${action}:${outcome}`;
  }

  createFeedbackRecord(params) {
    return buildFeedbackRecord({
      auditService: this.auditService,
      ...params
    });
  }

  recordFeedback(params, { overwrite = false } = {}) {
    const record = this.createFeedbackRecord(params);
    const dedupKey = this.buildDeduplicationKey(record);

    if (this.dedupIndex.has(dedupKey) && !overwrite) {
      return this.dedupIndex.get(dedupKey);
    }

    if (this.dedupIndex.has(dedupKey) && overwrite) {
      const existing = this.dedupIndex.get(dedupKey);
      const index = this.buffer.findIndex((item) => item.feedback_id === existing.feedback_id);
      if (index >= 0) {
        this.buffer[index] = record;
      }
      this.dedupIndex.set(dedupKey, record);
      return record;
    }

    this.buffer.push(record);
    this.dedupIndex.set(dedupKey, record);

    if (this.buffer.length > this.maxBufferedRecords) {
      const evicted = this.buffer.shift();
      const evictedKey = this.buildDeduplicationKey(evicted);
      this.dedupIndex.delete(evictedKey);
    }

    return record;
  }

  record(params, options) {
    return this.recordFeedback(params, options);
  }

  getRecentFeedback({ limit = 50, filter = null } = {}) {
    let records = [...this.buffer];
    if (typeof filter === 'function') {
      records = records.filter(filter);
    }
    return records.slice(-limit);
  }

  getFeedbackById(feedbackId) {
    return this.buffer.find((record) => record.feedback_id === feedbackId) ?? null;
  }

  getFeedbackForTransaction(transactionId) {
    return this.buffer.filter((record) => record.correlation.transaction_id === transactionId);
  }

  getFeedbackCount() {
    return this.buffer.length;
  }

  exportDatasetRows(records = null) {
    const list = records ?? this.buffer;
    return list.map((record) => feedbackRecordToDatasetRow(record));
  }

  clear() {
    this.buffer = [];
    this.dedupIndex.clear();
  }
}
