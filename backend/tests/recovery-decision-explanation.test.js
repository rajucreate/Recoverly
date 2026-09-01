import { jest } from '@jest/globals';
import {
  explainDecision,
  RecoveryDecisionExplanationService,
  EXPLANATION_SCHEMA_VERSION,
  REASON_TYPES
} from '../src/intelligence/recovery-decision-explanation.js';
import { buildDecisionAuditRecord, SAFETY_REJECTION_REASONS } from '../src/intelligence/recovery-decision-audit-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { FEATURE_SCHEMA_VERSION, FEATURE_PIPELINE_VERSION } from '../src/intelligence/recovery-feature-pipeline.js';
import { INTERACTION_MODEL_VERSION } from '../src/intelligence/candidate-model-comparison.js';

describe('RecoveryDecisionExplanation (Task 6.8)', () => {
  const baseContext = {
    transaction_id: 'txn-555',
    attempt_id: 'att-555',
    transaction_amount: 1499,
    currency: 'INR',
    payment_method_attempted: 'UPI',
    failure_category: 'TEMPORARY_FAILURE',
    has_failure_reason: true,
    attempt_number: 1,
    prior_failed_attempt_count: 0,
    prior_temporary_failure_count: 0,
    transaction_status: 'FAILED'
  };

  const samplePredictions = [
    { candidate_action_type: RecoveryActionType.RETRY, recovery_probability: 0.8576, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.ALTERNATE_METHOD, recovery_probability: 0.4210, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.CUSTOMER_ACTION, recovery_probability: 0.1834, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.ESCALATE, recovery_probability: 0.1120, model_version: INTERACTION_MODEL_VERSION }
  ];

  // 1. ML decision explanation
  test('1. Generates structured and human-readable explanation for a valid ML decision', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY as the highest-probability safe recovery action.',
      candidate_predictions: samplePredictions
    };

    const auditRecord = buildDecisionAuditRecord({ decision, context: baseContext });
    const explanation = explainDecision({ auditRecord });

    expect(explanation.explanation_schema_version).toBe(EXPLANATION_SCHEMA_VERSION);
    expect(explanation.selected_action).toBe(RecoveryActionType.RETRY);
    expect(explanation.decision_source).toBe(DECISION_SOURCES.ML);
    expect(explanation.summary).toContain('ML selected RETRY');
    expect(explanation.human_readable_text).toContain('RETRY was recommended based on machine learning scoring');
    expect(explanation.human_readable_text).toContain('85.76%');
    expect(explanation.reasons.length).toBeGreaterThan(0);
    expect(explanation.fallback).toBeNull();
  });

  // 2. RULE fallback explanation
  test('2. Generates structured and human-readable explanation for a RULE fallback decision', () => {
    const decision = {
      selected_action: RecoveryActionType.ESCALATE,
      decision_source: DECISION_SOURCES.RULE,
      recovery_probability: null,
      model_version: null,
      reason: 'The automatic retry limit has been reached, so the payment should be escalated.',
      candidate_predictions: [],
      fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE,
      fallback_error: 'Model file missing'
    };

    const auditRecord = buildDecisionAuditRecord({
      decision,
      context: { ...baseContext, prior_temporary_failure_count: 2 }
    });
    const explanation = explainDecision({ auditRecord });

    expect(explanation.selected_action).toBe(RecoveryActionType.ESCALATE);
    expect(explanation.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(explanation.fallback.is_fallback).toBe(true);
    expect(explanation.fallback.fallback_reason).toBe(FALLBACK_REASONS.MODEL_UNAVAILABLE);
    expect(explanation.human_readable_text).toContain('ESCALATE was selected by Phase 1 deterministic rules');
    expect(explanation.human_readable_text).toContain('prediction service was unavailable');
  });

  // 3. Selected action preserved exactly
  test('3. Selected action is preserved exactly and never mutated by explanation', () => {
    const decision = {
      selected_action: RecoveryActionType.ALTERNATE_METHOD,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.70,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML chose ALTERNATE_METHOD',
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: baseContext });
    expect(explanation.selected_action).toBe(RecoveryActionType.ALTERNATE_METHOD);
  });

  // 4. Candidate ranking correctly represented
  test('4. Candidate comparison represents ranking and relative positions accurately', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML chose RETRY',
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: baseContext });
    const comparison = explanation.candidate_comparison;

    expect(comparison).toHaveLength(4);
    expect(comparison[0].action).toBe(RecoveryActionType.RETRY);
    expect(comparison[0].rank).toBe(1);
    expect(comparison[0].status).toBe('SELECTED');
    expect(comparison[1].action).toBe(RecoveryActionType.ALTERNATE_METHOD);
    expect(comparison[1].rank).toBe(2);
    expect(comparison[1].status).toBe('CONSIDERED_LOWER_PROBABILITY');
  });

  // 5. Rejected candidates correctly explained
  test('5. Correctly explains rejected candidate actions and their safety constraints', () => {
    const restrictedContext = {
      ...baseContext,
      failure_category: 'PAYMENT_METHOD_FAILURE', // RETRY rejected
      payment_method_attempted: 'CARD',
      available_payment_methods: ['CARD'], // ALTERNATE_METHOD rejected
      prior_temporary_failure_count: 2
    };

    const decision = {
      selected_action: RecoveryActionType.CUSTOMER_ACTION,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.30,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML chose CUSTOMER_ACTION',
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: restrictedContext });

    expect(explanation.rejected_candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: RecoveryActionType.RETRY,
          rejection_reason: SAFETY_REJECTION_REASONS.RETRY_NOT_APPLICABLE_FOR_CATEGORY,
          explanation: expect.stringContaining('temporary failures')
        }),
        expect.objectContaining({
          action: RecoveryActionType.ALTERNATE_METHOD,
          rejection_reason: SAFETY_REJECTION_REASONS.NO_SAFE_ALTERNATE_METHOD,
          explanation: expect.stringContaining('No different, valid payment method')
        })
      ])
    );

    const safetyRejectionReasons = explanation.reasons.filter((r) => r.type === REASON_TYPES.SAFETY_REJECTION);
    expect(safetyRejectionReasons.length).toBe(2);
  });

  // 6. Fallback reason correctly explained
  test('6. Correctly explains distinct fallback reasons (NO_SAFE_CANDIDATE, INVALID_PREDICTION, MODEL_UNAVAILABLE)', () => {
    const reasons = [
      FALLBACK_REASONS.MODEL_UNAVAILABLE,
      FALLBACK_REASONS.INVALID_PREDICTION,
      FALLBACK_REASONS.NO_SAFE_CANDIDATE
    ];

    for (const reason of reasons) {
      const decision = {
        selected_action: RecoveryActionType.ESCALATE,
        decision_source: DECISION_SOURCES.RULE,
        reason: 'Rule escalated',
        fallback_reason: reason
      };

      const explanation = explainDecision({ decision, context: baseContext });
      expect(explanation.fallback.fallback_reason).toBe(reason);
      expect(explanation.reasons.some((r) => r.type === REASON_TYPES.RULE_FALLBACK)).toBe(true);
    }
  });

  // 7. Model/schema/pipeline versions preserved
  test('7. Preserves all version metadata in structured output', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      model_version: INTERACTION_MODEL_VERSION,
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: baseContext });
    expect(explanation.versions.model_version).toBe(INTERACTION_MODEL_VERSION);
    expect(explanation.versions.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(explanation.versions.feature_pipeline_version).toBe(FEATURE_PIPELINE_VERSION);
    expect(explanation.versions.explanation_schema_version).toBe(EXPLANATION_SCHEMA_VERSION);
  });

  // 8. Deterministic explanation generation
  test('8. Explanation output is 100% deterministic given identical inputs', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      model_version: INTERACTION_MODEL_VERSION,
      candidate_predictions: samplePredictions
    };

    const exp1 = explainDecision({ decision, context: baseContext });
    const exp2 = explainDecision({ decision, context: baseContext });

    expect(exp1).toEqual(exp2);
  });

  // 9. Malformed decision/audit input rejected
  test('9. Rejects invalid or missing input structures with explicit errors', () => {
    expect(() => explainDecision(null)).toThrow('Input is required to generate an explanation.');
    expect(() => explainDecision({})).toThrow();
    expect(() => explainDecision({ decision: { selected_action: null } })).toThrow();
  });

  // 10. Probability values described as predictions, not guarantees
  test('10. Human-readable text describes probabilities as estimates/predictions, avoiding certainty claims', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.99,
      model_version: INTERACTION_MODEL_VERSION,
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: baseContext });
    const text = explanation.human_readable_text.toLowerCase();

    expect(text).toContain('estimated recovery probability');
    expect(text).not.toContain('guaranteed');
    expect(text).not.toContain('will certainly succeed');
    expect(text).not.toContain('100% success');
  });

  // 11. Sensitive fields are not leaked
  test('11. Does not expose raw credentials, card numbers, or customer PII in context summary or reasons', () => {
    const contextWithSecrets = {
      ...baseContext,
      pan: '4111111111111111',
      cvv: '123',
      apiKey: 'secret_key_abc'
    };

    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      candidate_predictions: samplePredictions
    };

    const explanation = explainDecision({ decision, context: contextWithSecrets });
    const serialized = JSON.stringify(explanation);

    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('secret_key_abc');
    expect(explanation.context_summary.pan).toBeUndefined();
    expect(explanation.context_summary.cvv).toBeUndefined();
  });

  // 12. Explanation layer does not invoke execution service
  test('12. Explanation service has no execution methods and zero database side-effects', () => {
    const service = new RecoveryDecisionExplanationService();

    expect(service.execute).toBeUndefined();
    expect(service.executeRecovery).toBeUndefined();
    expect(service.updateTransaction).toBeUndefined();
    expect(service.chargePayment).toBeUndefined();
  });

  // 13. Service class wrapper verification
  test('13. RecoveryDecisionExplanationService.explain delegates seamlessly to explainDecision', () => {
    const service = new RecoveryDecisionExplanationService();
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.8576,
      model_version: INTERACTION_MODEL_VERSION,
      candidate_predictions: samplePredictions
    };

    const result = service.explain({ decision, context: baseContext });
    expect(result.selected_action).toBe(RecoveryActionType.RETRY);
    expect(result.decision_source).toBe(DECISION_SOURCES.ML);
  });
});
