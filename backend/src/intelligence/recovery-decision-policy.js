import { RecoveryActionType } from '../enums/recovery-action.js';
import { RETRY_LIMIT } from '../services/recovery-decision-engine.js';

export const DECISION_SOURCES = Object.freeze({ ML: 'ML', RULE: 'RULE' });
export const FALLBACK_REASONS = Object.freeze({
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  INVALID_PREDICTION: 'INVALID_PREDICTION',
  NO_SAFE_CANDIDATE: 'NO_SAFE_CANDIDATE'
});

export const CANDIDATE_ACTION_ORDER = Object.freeze([
  RecoveryActionType.RETRY,
  RecoveryActionType.ALTERNATE_METHOD,
  RecoveryActionType.CUSTOMER_ACTION,
  RecoveryActionType.ESCALATE
]);

const SUPPORTED_ACTIONS = new Set(CANDIDATE_ACTION_ORDER);
const EXECUTED_STATUSES = new Set(['EXECUTED', 'SUCCESS', 'FAILED']);

function firstDefined(context, fields) {
  return fields.map((field) => context[field]).find((value) => value !== undefined);
}

function actionFromPrediction(prediction) {
  return prediction.candidate_action_type ?? prediction.action;
}

function probabilityFromPrediction(prediction) {
  return prediction.recovery_probability ?? prediction.probability;
}

function validatePredictions(predictions) {
  if (!Array.isArray(predictions) || predictions.length !== CANDIDATE_ACTION_ORDER.length) return null;

  const versions = new Set();
  const actions = new Set();
  for (const prediction of predictions) {
    if (!prediction || typeof prediction !== 'object' || Array.isArray(prediction)) return null;
    const action = actionFromPrediction(prediction);
    const probability = probabilityFromPrediction(prediction);
    if (!SUPPORTED_ACTIONS.has(action) || actions.has(action)) return null;
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    if (typeof prediction.model_version !== 'string' || prediction.model_version.length === 0) return null;
    actions.add(action);
    versions.add(prediction.model_version);
  }

  if (actions.size !== CANDIDATE_ACTION_ORDER.length || versions.size !== 1) return null;
  return predictions.map((prediction) => ({
    ...prediction,
    candidate_action_type: actionFromPrediction(prediction),
    recovery_probability: probabilityFromPrediction(prediction)
  }));
}

function hasExecutedAction(context, action) {
  const executedActions = firstDefined(context, ['executed_action_types', 'executedActionTypes', 'already_executed_actions']);
  if (Array.isArray(executedActions) && executedActions.includes(action)) return true;

  const recoveryActions = firstDefined(context, ['existing_recovery_actions', 'existingRecoveryActions']);
  return Array.isArray(recoveryActions) && recoveryActions.some((item) => {
    const itemAction = item.actionType ?? item.action_type ?? item.candidate_action_type;
    return itemAction === action && EXECUTED_STATUSES.has(item.status);
  });
}

function hasSafeAlternateMethod(context) {
  const attemptedMethod = firstDefined(context, ['payment_method_attempted', 'paymentMethodAttempted']);
  const requestedMethod = firstDefined(context, ['alternate_payment_method', 'alternatePaymentMethod']);
  if (requestedMethod !== undefined && requestedMethod === attemptedMethod) return false;

  const availableMethods = firstDefined(context, ['available_payment_methods', 'availablePaymentMethods']);
  if (Array.isArray(availableMethods) && !availableMethods.some((method) => method !== attemptedMethod)) return false;
  return true;
}

function isSafeCandidate(context, action) {
  const transactionStatus = firstDefined(context, ['transaction_status', 'transactionStatus']);
  if (transactionStatus !== undefined && transactionStatus !== 'FAILED') return false;
  if (hasExecutedAction(context, action)) return false;

  if (action === RecoveryActionType.RETRY) {
    const failureCategory = firstDefined(context, ['failure_category', 'failureCategory']);
    const previousTemporaryFailureCount = firstDefined(context, [
      'prior_temporary_failure_count',
      'previousTemporaryFailureCount',
      'priorTemporaryFailureCount'
    ]);
    return failureCategory === 'TEMPORARY_FAILURE' && Number.isInteger(previousTemporaryFailureCount) && previousTemporaryFailureCount < RETRY_LIMIT;
  }
  if (action === RecoveryActionType.ALTERNATE_METHOD) return hasSafeAlternateMethod(context);
  return true;
}

export class RecoveryDecisionPolicy {
  constructor(predictionService, ruleEngine) {
    this.predictionService = predictionService;
    this.ruleEngine = ruleEngine;
  }

  decide(context) {
    let predictions;
    try {
      predictions = validatePredictions(this.predictionService.predictAll(context));
    } catch (error) {
      return this.fallback(context, FALLBACK_REASONS.MODEL_UNAVAILABLE, [], error);
    }

    if (!predictions) return this.fallback(context, FALLBACK_REASONS.INVALID_PREDICTION, []);

    const safePredictions = predictions.filter(({ candidate_action_type: action }) => isSafeCandidate(context, action));
    safePredictions.sort((left, right) => {
      const probabilityDifference = right.recovery_probability - left.recovery_probability;
      if (probabilityDifference !== 0) return probabilityDifference;
      return CANDIDATE_ACTION_ORDER.indexOf(left.candidate_action_type) - CANDIDATE_ACTION_ORDER.indexOf(right.candidate_action_type);
    });

    const selected = safePredictions[0];
    if (!selected) return this.fallback(context, FALLBACK_REASONS.NO_SAFE_CANDIDATE, predictions);
    return {
      selected_action: selected.candidate_action_type,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: selected.recovery_probability,
      model_version: selected.model_version,
      reason: `ML selected ${selected.candidate_action_type} as the highest-probability safe recovery action.`,
      candidate_predictions: predictions
    };
  }

  fallback(context, fallbackReason, candidatePredictions, cause) {
    const decision = this.ruleEngine.decide({
      failureCategory: context.failureCategory ?? context.failure_category,
      previousTemporaryFailureCount: context.previousTemporaryFailureCount
        ?? context.previous_temporary_failure_count
        ?? context.prior_temporary_failure_count
        ?? 0
    });
    return {
      selected_action: decision.actionType,
      decision_source: DECISION_SOURCES.RULE,
      recovery_probability: null,
      model_version: null,
      reason: decision.reason,
      candidate_predictions: candidatePredictions,
      fallback_reason: fallbackReason,
      ...(cause ? { fallback_error: cause.message } : {})
    };
  }
}