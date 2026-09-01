import { jest } from '@jest/globals';
import {
  RecoveryDecisionAuditService,
  buildDecisionAuditRecord,
  AUDIT_SCHEMA_VERSION,
  DECISION_POLICY_VERSION,
  SAFETY_REJECTION_REASONS
} from '../src/intelligence/recovery-decision-audit-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { FEATURE_SCHEMA_VERSION, FEATURE_PIPELINE_VERSION } from '../src/intelligence/recovery-feature-pipeline.js';
import { INTERACTION_MODEL_VERSION } from '../src/intelligence/candidate-model-comparison.js';

describe('RecoveryDecisionAuditService (Task 6.7)', () => {
  const baseContext = {
    transaction_id: 'txn-100',
    attempt_id: 'att-100',
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

  const samplePredictions = [
    { candidate_action_type: RecoveryActionType.RETRY, recovery_probability: 0.85, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.ALTERNATE_METHOD, recovery_probability: 0.45, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.CUSTOMER_ACTION, recovery_probability: 0.20, model_version: INTERACTION_MODEL_VERSION },
    { candidate_action_type: RecoveryActionType.ESCALATE, recovery_probability: 0.10, model_version: INTERACTION_MODEL_VERSION }
  ];

  // 1. Valid ML decision audit
  test('1. Creates a complete and valid audit record for an ML decision', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.85,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY as the highest-probability safe recovery action.',
      candidate_predictions: samplePredictions
    };

    const record = buildDecisionAuditRecord({
      decision,
      context: baseContext,
      correlation: { transaction_id: 'txn-100', attempt_id: 'att-100' },
      decisionTimestamp: '2026-09-01T12:00:00.000Z',
      decisionLatencyMs: 1.25
    });

    expect(record.audit_id).toMatch(/^audit_/);
    expect(record.audit_schema_version).toBe(AUDIT_SCHEMA_VERSION);
    expect(record.decision_timestamp).toBe('2026-09-01T12:00:00.000Z');
    expect(record.correlation.transaction_id).toBe('txn-100');
    expect(record.correlation.attempt_id).toBe('att-100');
    expect(record.selected_action).toBe(RecoveryActionType.RETRY);
    expect(record.decision_source).toBe(DECISION_SOURCES.ML);
    expect(record.selected_probability).toBe(0.85);
    expect(record.fallback.is_fallback).toBe(false);
    expect(record.fallback.fallback_reason).toBeNull();
    expect(record.performance.decision_latency_ms).toBe(1.25);
  });

  // 2. Valid RULE fallback audit
  test('2. Creates a complete and valid audit record for a RULE fallback decision', () => {
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

    const record = buildDecisionAuditRecord({
      decision,
      context: { ...baseContext, prior_temporary_failure_count: 2 },
      correlation: { transaction_id: 'txn-200', attempt_id: 'att-200' },
      decisionLatencyMs: 0.45
    });

    expect(record.selected_action).toBe(RecoveryActionType.ESCALATE);
    expect(record.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(record.selected_probability).toBeNull();
    expect(record.fallback.is_fallback).toBe(true);
    expect(record.fallback.fallback_reason).toBe(FALLBACK_REASONS.MODEL_UNAVAILABLE);
    expect(record.fallback.fallback_error).toBe('Model file missing');
    expect(record.versions.model_version).toBeNull();
  });

  // 3. All candidate predictions preserved
  test('3. Preserves all candidate action predictions and their probabilities', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.85,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY',
      candidate_predictions: samplePredictions
    };

    const record = buildDecisionAuditRecord({ decision, context: baseContext });

    expect(record.candidates).toHaveLength(4);
    const candidateMap = Object.fromEntries(record.candidates.map((c) => [c.action_type, c.ml_probability]));
    expect(candidateMap[RecoveryActionType.RETRY]).toBe(0.85);
    expect(candidateMap[RecoveryActionType.ALTERNATE_METHOD]).toBe(0.45);
    expect(candidateMap[RecoveryActionType.CUSTOMER_ACTION]).toBe(0.20);
    expect(candidateMap[RecoveryActionType.ESCALATE]).toBe(0.10);
  });

  // 4. Selected action correctly recorded
  test('4. Correctly records selected recovery action and reason', () => {
    const decision = {
      selected_action: RecoveryActionType.ALTERNATE_METHOD,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.65,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected ALTERNATE_METHOD',
      candidate_predictions: samplePredictions
    };

    const record = buildDecisionAuditRecord({ decision, context: baseContext });
    expect(record.selected_action).toBe(RecoveryActionType.ALTERNATE_METHOD);
    expect(record.decision_reason).toBe('ML selected ALTERNATE_METHOD');
  });

  // 5. Fallback reasons correctly recorded
  test('5. Accurately records specific fallback reason enums (NO_SAFE_CANDIDATE, INVALID_PREDICTION, etc.)', () => {
    const fallbackReasons = [
      FALLBACK_REASONS.MODEL_UNAVAILABLE,
      FALLBACK_REASONS.INVALID_PREDICTION,
      FALLBACK_REASONS.NO_SAFE_CANDIDATE
    ];

    for (const reason of fallbackReasons) {
      const decision = {
        selected_action: RecoveryActionType.ESCALATE,
        decision_source: DECISION_SOURCES.RULE,
        reason: 'Rule selected ESCALATE',
        fallback_reason: reason
      };

      const record = buildDecisionAuditRecord({ decision, context: baseContext });
      expect(record.fallback.is_fallback).toBe(true);
      expect(record.fallback.fallback_reason).toBe(reason);
    }
  });

  // 6. Model/schema/pipeline versions recorded
  test('6. Records all system, pipeline, schema, and model version identifiers', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.85,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY',
      candidate_predictions: samplePredictions
    };

    const record = buildDecisionAuditRecord({ decision, context: baseContext });

    expect(record.versions.model_version).toBe(INTERACTION_MODEL_VERSION);
    expect(record.versions.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(record.versions.feature_pipeline_version).toBe(FEATURE_PIPELINE_VERSION);
    expect(record.versions.policy_version).toBe(DECISION_POLICY_VERSION);
    expect(record.versions.audit_schema_version).toBe(AUDIT_SCHEMA_VERSION);
  });

  // 7. Rejected candidates recorded with specific reasons
  test('7. Identifies and records candidates rejected by policy safety constraints with reason codes', () => {
    // Context where RETRY exceeds limit and ALTERNATE_METHOD has no valid alternative
    const restrictedContext = {
      ...baseContext,
      failure_category: 'PAYMENT_METHOD_FAILURE', // RETRY is not applicable
      payment_method_attempted: 'CARD',
      available_payment_methods: ['CARD'], // ALTERNATE_METHOD is not possible
      prior_temporary_failure_count: 2
    };

    const decision = {
      selected_action: RecoveryActionType.CUSTOMER_ACTION,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.30,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected CUSTOMER_ACTION',
      candidate_predictions: samplePredictions
    };

    const record = buildDecisionAuditRecord({ decision, context: restrictedContext });

    expect(record.rejected_candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: RecoveryActionType.RETRY,
          rejection_reason: SAFETY_REJECTION_REASONS.RETRY_NOT_APPLICABLE_FOR_CATEGORY
        }),
        expect.objectContaining({
          action_type: RecoveryActionType.ALTERNATE_METHOD,
          rejection_reason: SAFETY_REJECTION_REASONS.NO_SAFE_ALTERNATE_METHOD
        })
      ])
    );
  });

  // 8. Deterministic audit output
  test('8. Produces deterministic audit structure for identical inputs except audit_id', () => {
    const decision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.85,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY',
      candidate_predictions: samplePredictions
    };

    const timestamp = '2026-09-01T10:00:00.000Z';
    const record1 = buildDecisionAuditRecord({ decision, context: baseContext, decisionTimestamp: timestamp, decisionLatencyMs: 1.0 });
    const record2 = buildDecisionAuditRecord({ decision, context: baseContext, decisionTimestamp: timestamp, decisionLatencyMs: 1.0 });

    const { audit_id: id1, ...data1 } = record1;
    const { audit_id: id2, ...data2 } = record2;

    expect(data1).toEqual(data2);
    expect(id1).not.toBe(id2);
  });

  // 9. Missing/invalid required decision data rejected
  test('9. Rejects missing or malformed decision and context inputs with descriptive errors', () => {
    expect(() => buildDecisionAuditRecord({ decision: null, context: baseContext })).toThrow(
      'Decision object is required to build an audit record.'
    );
    expect(() => buildDecisionAuditRecord({ decision: {}, context: baseContext })).toThrow(
      'Decision must contain a valid selected_action.'
    );
    expect(() => buildDecisionAuditRecord({ decision: { selected_action: 'RETRY', decision_source: 'INVALID' }, context: baseContext })).toThrow(
      'Decision must specify a valid decision_source (ML or RULE).'
    );
    expect(() => buildDecisionAuditRecord({ decision: { selected_action: 'RETRY', decision_source: 'ML' }, context: null })).toThrow(
      'Context object is required to build an audit record.'
    );
  });

  // 10. Audit layer cannot execute recovery actions
  test('10. Audit service has no execution methods, does not mutate DB, and does not invoke providers', () => {
    const service = new RecoveryDecisionAuditService();

    expect(service.execute).toBeUndefined();
    expect(service.executeRecovery).toBeUndefined();
    expect(service.processPayment).toBeUndefined();
    expect(service.updateTransaction).toBeUndefined();
  });

  // 11. Service ring-buffer recording and querying
  test('11. RecoveryDecisionAuditService manages in-memory buffer with filtering and limits', () => {
    const service = new RecoveryDecisionAuditService({ maxBufferedRecords: 3 });

    const decisionML = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.85,
      candidate_predictions: samplePredictions
    };
    const decisionRule = {
      selected_action: RecoveryActionType.ESCALATE,
      decision_source: DECISION_SOURCES.RULE,
      fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE
    };

    service.record({ decision: decisionML, context: baseContext });
    service.record({ decision: decisionRule, context: baseContext });
    service.record({ decision: decisionML, context: baseContext });

    expect(service.getRecordCount()).toBe(3);

    // Filter by decision_source
    const mlRecords = service.getRecentRecords({ filter: (r) => r.decision_source === DECISION_SOURCES.ML });
    expect(mlRecords).toHaveLength(2);

    const ruleRecords = service.getRecentRecords({ filter: (r) => r.decision_source === DECISION_SOURCES.RULE });
    expect(ruleRecords).toHaveLength(1);

    // Buffer overflow eviction
    service.record({ decision: decisionRule, context: baseContext });
    expect(service.getRecordCount()).toBe(3);

    service.clear();
    expect(service.getRecordCount()).toBe(0);
  });
});
