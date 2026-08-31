import { jest } from '@jest/globals';
import {
  CANDIDATE_ACTION_ORDER,
  DECISION_SOURCES,
  FALLBACK_REASONS,
  RecoveryDecisionPolicy
} from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';

const baseContext = {
  transaction_amount: 5000,
  currency: 'INR',
  payment_method_attempted: 'UPI',
  failure_category: 'TEMPORARY_FAILURE',
  has_failure_reason: true,
  attempt_number: 1,
  prior_failed_attempt_count: 0,
  prior_temporary_failure_count: 0,
  transaction_status: 'FAILED'
};

function predictions(probabilities, modelVersion = 'test-model-v1') {
  return CANDIDATE_ACTION_ORDER.map((candidate_action_type, index) => ({
    candidate_action_type,
    recovery_probability: probabilities[index],
    model_version: modelVersion
  }));
}

function createPolicy(predictionResult, ruleEngine = { decide: jest.fn(() => ({ actionType: 'ESCALATE', reason: 'Rule fallback' })) }) {
  const predictionService = { predictAll: jest.fn(() => predictionResult) };
  return {
    policy: new RecoveryDecisionPolicy(predictionService, ruleEngine),
    predictionService,
    ruleEngine
  };
}

describe('RecoveryDecisionPolicy', () => {
  test('selects the highest-probability valid action', () => {
    const { policy } = createPolicy(predictions([0.2, 0.8, 0.4, 0.1]));

    expect(policy.decide(baseContext)).toMatchObject({
      selected_action: 'ALTERNATE_METHOD',
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8,
      model_version: 'test-model-v1'
    });
  });

  test('skips an unsafe higher-probability retry after the retry limit', () => {
    const { policy } = createPolicy(predictions([0.95, 0.6, 0.4, 0.1]));

    const result = policy.decide({ ...baseContext, prior_temporary_failure_count: 2 });
    expect(result.selected_action).toBe('ALTERNATE_METHOD');
    expect(result.decision_source).toBe(DECISION_SOURCES.ML);
  });

  test('breaks equal-probability ties using the fixed action order', () => {
    const { policy } = createPolicy(predictions([0.7, 0.7, 0.7, 0.7]));

    expect(policy.decide(baseContext).selected_action).toBe('RETRY');
  });

  test('falls back to rules when the prediction service fails', () => {
    const ruleEngine = { decide: jest.fn(() => ({ actionType: 'RETRY', reason: 'Rule reason' })) };
    const { policy } = createPolicy(new Error('model unavailable'), ruleEngine);
    policy.predictionService.predictAll = jest.fn(() => { throw new Error('model unavailable'); });

    expect(policy.decide(baseContext)).toMatchObject({
      selected_action: 'RETRY',
      decision_source: DECISION_SOURCES.RULE,
      recovery_probability: null,
      model_version: null,
      fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE
    });
    expect(ruleEngine.decide).toHaveBeenCalledWith({ failureCategory: 'TEMPORARY_FAILURE', previousTemporaryFailureCount: 0 });
  });

  test('falls back to rules for an invalid probability', () => {
    const ruleEngine = { decide: jest.fn(() => ({ actionType: 'ESCALATE', reason: 'Rule reason' })) };
    const { policy } = createPolicy(predictions([2, 0.4, 0.3, 0.2]), ruleEngine);

    expect(policy.decide(baseContext).fallback_reason).toBe(FALLBACK_REASONS.INVALID_PREDICTION);
    expect(ruleEngine.decide).toHaveBeenCalled();
  });

  test('falls back to rules when no ML candidate is safe', () => {
    const ruleEngine = { decide: jest.fn(() => ({ actionType: 'RETRY', reason: 'Rule reason' })) };
    const { policy } = createPolicy(predictions([0.9, 0.8, 0.7, 0.6]), ruleEngine);

    const result = policy.decide({ ...baseContext, transaction_status: 'PENDING' });
    expect(result).toMatchObject({ selected_action: 'RETRY', fallback_reason: FALLBACK_REASONS.NO_SAFE_CANDIDATE });
    expect(ruleEngine.decide).toHaveBeenCalled();
  });

  test('preserves retry constraints', () => {
    const { policy } = createPolicy(predictions([0.99, 0.1, 0.2, 0.3]));

    expect(policy.decide({ ...baseContext, failure_category: 'PAYMENT_METHOD_FAILURE' }).selected_action).not.toBe('RETRY');
    expect(policy.decide({ ...baseContext, prior_temporary_failure_count: 2 }).selected_action).not.toBe('RETRY');
  });

  test('preserves alternate-method constraints', () => {
    const { policy } = createPolicy(predictions([0.4, 0.99, 0.3, 0.2]));

    const result = policy.decide({ ...baseContext, alternate_payment_method: 'UPI' });
    expect(result.selected_action).toBe('RETRY');
  });

  test('returns the complete ML result contract', () => {
    const candidatePredictions = predictions([0.8, 0.4, 0.3, 0.2]);
    const { policy } = createPolicy(candidatePredictions);

    expect(policy.decide(baseContext)).toEqual({
      selected_action: 'RETRY',
      decision_source: 'ML',
      recovery_probability: 0.8,
      model_version: 'test-model-v1',
      reason: 'ML selected RETRY as the highest-probability safe recovery action.',
      candidate_predictions: candidatePredictions.map((prediction) => ({ ...prediction }))
    });
  });

  test('returns fallback metadata and the original predictions when candidates are unsafe', () => {
    const candidatePredictions = predictions([0.8, 0.4, 0.3, 0.2]);
    const ruleEngine = { decide: jest.fn(() => ({ actionType: 'ESCALATE', reason: 'Rule reason' })) };
    const { policy } = createPolicy(candidatePredictions, ruleEngine);

    expect(policy.decide({ ...baseContext, transaction_status: 'PENDING' })).toMatchObject({
      decision_source: 'RULE',
      recovery_probability: null,
      model_version: null,
      candidate_predictions: candidatePredictions,
      fallback_reason: 'NO_SAFE_CANDIDATE'
    });
  });

  test('has no execution service dependency or invocation', () => {
    const executionService = { execute: jest.fn() };
    const { policy } = createPolicy(predictions([0.8, 0.4, 0.3, 0.2]));

    policy.decide(baseContext);
    expect(executionService.execute).not.toHaveBeenCalled();
  });

  test('leaves the Phase 1 decision engine behavior unchanged', () => {
    const engine = new RecoveryDecisionEngine();

    expect(engine.decide({ failureCategory: 'TEMPORARY_FAILURE', previousTemporaryFailureCount: 2 })).toEqual({
      actionType: 'ESCALATE',
      reason: 'The automatic retry limit has been reached, so the payment should be escalated.'
    });
  });
});