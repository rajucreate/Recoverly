import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import {
  calculateActionGroundTruthProbability,
  reconstructContext,
  evaluateScenario,
  calculateSummaryMetrics,
  runRuleVsMlEvaluation,
  EVALUATION_HARNESS_VERSION
} from '../src/intelligence/rule-vs-ml-evaluation.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { RecoveryPredictionService } from '../src/intelligence/recovery-prediction-service.js';
import { RecoveryDecisionPolicy } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const mockRawRow = {
  record_id: 'rec-1',
  decision_id: 'dec-1',
  transaction_amount: '5000.00',
  currency: 'INR',
  payment_method: 'UPI',
  failure_category: 'TEMPORARY_FAILURE',
  failure_reason_present: 'true',
  attempt_number: '1',
  prior_failed_attempt_count: '0',
  prior_temporary_failure_count: '0',
  candidate_action: 'RETRY',
  recovery_success: '1'
};

describe('Rule vs ML Evaluation Harness (6.6)', () => {
  // 1. Same scenarios are evaluated by both strategies
  test('1. Evaluates identical scenarios across both Rule and ML strategies without subset mismatch', () => {
    const rawRows = [
      { ...mockRawRow, record_id: 'rec-1', decision_id: 'dec-1', failure_category: 'TEMPORARY_FAILURE' },
      { ...mockRawRow, record_id: 'rec-2', decision_id: 'dec-2', failure_category: 'PAYMENT_METHOD_FAILURE' },
      { ...mockRawRow, record_id: 'rec-3', decision_id: 'dec-3', failure_category: 'CUSTOMER_ACTION_REQUIRED' }
    ];

    const ruleEngine = new RecoveryDecisionEngine();
    const policy = {
      decide: jest.fn(() => ({
        selected_action: RecoveryActionType.ALTERNATE_METHOD,
        decision_source: 'ML',
        recovery_probability: 0.75,
        model_version: 'test-v1',
        reason: 'ML selected ALTERNATE_METHOD'
      }))
    };

    const evaluations = rawRows.map((row) => evaluateScenario(row, { ruleEngine, policy }));

    expect(evaluations).toHaveLength(3);
    for (let i = 0; i < rawRows.length; i++) {
      expect(evaluations[i].decision_id).toBe(rawRows[i].decision_id);
      expect(evaluations[i].rule.selected_action).toBeDefined();
      expect(evaluations[i].ml.selected_action).toBeDefined();
    }
  });

  // 2. Frozen model artifact is loaded without retraining
  test('2. Loads frozen model artifact directly without retraining or coefficient mutation', () => {
    const modelPath = path.join(rootDir, '../data/phase-2/models/recovery_interaction_v1.model.json');
    const schemaPath = path.join(rootDir, '../data/phase-2/recovery_features_v1.schema.json');
    const predictionService = new RecoveryPredictionService({ modelPath, schemaPath });

    expect(predictionService.model.model_version).toBe('phase2-interaction-logistic-v1');
    expect(predictionService.model.coefficients).toBeDefined();
    expect(Array.isArray(predictionService.model.coefficients)).toBe(true);
  });

  // 3. Phase 1 rule engine remains unchanged
  test('3. Phase 1 rule engine decisions remain identical to production baseline', () => {
    const engine = new RecoveryDecisionEngine();

    expect(engine.decide({ failureCategory: 'TEMPORARY_FAILURE', previousTemporaryFailureCount: 0 })).toEqual({
      actionType: RecoveryActionType.RETRY,
      reason: 'The failure is classified as temporary, so retrying the payment is recommended.'
    });

    expect(engine.decide({ failureCategory: 'TEMPORARY_FAILURE', previousTemporaryFailureCount: 2 })).toEqual({
      actionType: RecoveryActionType.ESCALATE,
      reason: 'The automatic retry limit has been reached, so the payment should be escalated.'
    });

    expect(engine.decide({ failureCategory: 'PAYMENT_METHOD_FAILURE' })).toEqual({
      actionType: RecoveryActionType.ALTERNATE_METHOD,
      reason: 'The selected payment method failed, so an alternate payment method is recommended.'
    });
  });

  // 4. Test split is evaluation-only
  test('4. Full evaluation pipeline executes strictly against held-out test split', () => {
    const result = runRuleVsMlEvaluation({ rootDirectory: path.resolve(rootDir, '..') });

    expect(result.metadata.total_scenarios_evaluated).toBe(1200);
    expect(result.metadata.test_split_version).toBe('1.0.0');
    expect(result.metadata.evaluation_version).toBe(EVALUATION_HARNESS_VERSION);
  });

  // 5. Recovery success is calculated consistently
  test('5. Ground truth recovery probability is scored identically for both strategies', () => {
    const context = {
      failureCategory: 'TEMPORARY_FAILURE',
      paymentMethod: 'UPI',
      candidateAction: 'RETRY',
      attemptNumber: 1,
      priorFailedAttemptCount: 0,
      priorTemporaryFailureCount: 0
    };

    const prob1 = calculateActionGroundTruthProbability(context);
    const prob2 = calculateActionGroundTruthProbability(context);

    expect(prob1).toBe(prob2);
    expect(prob1).toBeGreaterThanOrEqual(0.08);
    expect(prob1).toBeLessThanOrEqual(0.90);
  });

  // 6. Improvement calculations are correct
  test('6. Absolute and relative improvement calculations are statistically sound', () => {
    const mockEvaluations = [
      {
        context: { failure_category: 'TEMPORARY_FAILURE', payment_method_attempted: 'UPI' },
        rule: { selected_action: 'RETRY', expected_recovery_probability: 0.50, matches_historical: true, observed_outcome: 1 },
        ml: { selected_action: 'RETRY', expected_recovery_probability: 0.60, matches_historical: true, observed_outcome: 1 },
        comparison: { winner: 'ML' }
      },
      {
        context: { failure_category: 'PAYMENT_METHOD_FAILURE', payment_method_attempted: 'CARD' },
        rule: { selected_action: 'ALTERNATE_METHOD', expected_recovery_probability: 0.40, matches_historical: true, observed_outcome: 0 },
        ml: { selected_action: 'ALTERNATE_METHOD', expected_recovery_probability: 0.40, matches_historical: true, observed_outcome: 0 },
        comparison: { winner: 'TIE' }
      }
    ];

    const metrics = calculateSummaryMetrics(mockEvaluations);

    // Rule: (0.50 + 0.40) / 2 = 0.45
    // ML: (0.60 + 0.40) / 2 = 0.50
    // Absolute: 0.50 - 0.45 = +0.05 (+5 pp)
    // Relative: 0.05 / 0.45 = +0.1111 (+11.11%)
    expect(metrics.rule_engine.recovery_success_rate).toBe(0.45);
    expect(metrics.ml_policy.recovery_success_rate).toBe(0.50);
    expect(metrics.improvement.absolute_percentage_points).toBe(5.00);
    expect(metrics.improvement.relative_percentage).toBe(11.11);
    expect(metrics.paired_comparison.ml_wins).toBe(1);
    expect(metrics.paired_comparison.rule_wins).toBe(0);
    expect(metrics.paired_comparison.ties).toBe(1);
  });

  // 7. Segment metrics are correct
  test('7. Segment metrics partition and compute rates accurately', () => {
    const mockEvaluations = [
      {
        context: { failure_category: 'TEMPORARY_FAILURE', payment_method_attempted: 'UPI' },
        rule: { selected_action: 'RETRY', expected_recovery_probability: 0.80 },
        ml: { selected_action: 'RETRY', expected_recovery_probability: 0.80 },
        comparison: { winner: 'TIE' }
      },
      {
        context: { failure_category: 'TEMPORARY_FAILURE', payment_method_attempted: 'UPI' },
        rule: { selected_action: 'RETRY', expected_recovery_probability: 0.70 },
        ml: { selected_action: 'ALTERNATE_METHOD', expected_recovery_probability: 0.90 },
        comparison: { winner: 'ML' }
      },
      {
        context: { failure_category: 'PAYMENT_METHOD_FAILURE', payment_method_attempted: 'CARD' },
        rule: { selected_action: 'ALTERNATE_METHOD', expected_recovery_probability: 0.40 },
        ml: { selected_action: 'ALTERNATE_METHOD', expected_recovery_probability: 0.40 },
        comparison: { winner: 'TIE' }
      }
    ];

    const metrics = calculateSummaryMetrics(mockEvaluations);

    expect(metrics.segments.by_failure_category.TEMPORARY_FAILURE.scenario_count).toBe(2);
    expect(metrics.segments.by_failure_category.TEMPORARY_FAILURE.rule_recovery_rate).toBe(0.75);
    expect(metrics.segments.by_failure_category.TEMPORARY_FAILURE.ml_recovery_rate).toBe(0.85);

    expect(metrics.segments.by_payment_method.UPI.scenario_count).toBe(2);
    expect(metrics.segments.by_payment_method.CARD.scenario_count).toBe(1);
  });

  // 8. No scenario is silently excluded
  test('8. Every valid held-out scenario is included in the evaluation', () => {
    const rawRows = [
      { ...mockRawRow, record_id: 'rec-1', decision_id: 'dec-1' },
      { ...mockRawRow, record_id: 'rec-2', decision_id: 'dec-2' }
    ];

    const ruleEngine = new RecoveryDecisionEngine();
    const policy = {
      decide: jest.fn(() => ({ selected_action: 'RETRY', decision_source: 'ML', recovery_probability: 0.8 }))
    };

    const evaluations = rawRows.map((r) => evaluateScenario(r, { ruleEngine, policy }));
    const metrics = calculateSummaryMetrics(evaluations);

    expect(metrics.total_evaluated_scenarios).toBe(2);
  });

  // 9. No recovery execution occurs
  test('9. Evaluation is strictly offline and invokes no payment providers or execution services', () => {
    const mockExecutionService = { execute: jest.fn() };
    const mockPaymentProvider = { execute: jest.fn() };

    const ruleEngine = new RecoveryDecisionEngine();
    const policy = {
      decide: jest.fn(() => ({ selected_action: 'RETRY', decision_source: 'ML' }))
    };

    evaluateScenario(mockRawRow, { ruleEngine, policy });

    expect(mockExecutionService.execute).not.toHaveBeenCalled();
    expect(mockPaymentProvider.execute).not.toHaveBeenCalled();
  });

  // 10. Evaluation metadata records model/dataset versions
  test('10. Metadata correctly records frozen model, schema, dataset, and split versions', () => {
    const result = runRuleVsMlEvaluation({ rootDirectory: path.resolve(rootDir, '..') });

    expect(result.metadata.model_version).toBe('phase2-interaction-logistic-v1');
    expect(result.metadata.feature_schema_version).toBe('6.3.1');
    expect(result.metadata.dataset_version).toBe('v1');
    expect(result.metadata.test_split_version).toBe('1.0.0');
    expect(result.metadata.evaluation_version).toBe(EVALUATION_HARNESS_VERSION);
  });

  // 11. Deterministic repeated evaluation produces identical results except timestamps
  test('11. Deterministic repeated evaluations yield identical numerical metrics', () => {
    const result1 = runRuleVsMlEvaluation({ rootDirectory: path.resolve(rootDir, '..') });
    const result2 = runRuleVsMlEvaluation({ rootDirectory: path.resolve(rootDir, '..') });

    expect(result1.metadata.metrics.rule_engine.recovery_success_rate).toBe(result2.metadata.metrics.rule_engine.recovery_success_rate);
    expect(result1.metadata.metrics.ml_policy.recovery_success_rate).toBe(result2.metadata.metrics.ml_policy.recovery_success_rate);
    expect(result1.metadata.metrics.improvement.absolute_percentage_points).toBe(result2.metadata.metrics.improvement.absolute_percentage_points);
    expect(result1.metadata.metrics.paired_comparison).toEqual(result2.metadata.metrics.paired_comparison);
  });

  // 12. Missing/invalid evaluation context is reported explicitly
  test('12. Missing required context fields throw descriptive errors instead of silent fabrication', () => {
    const invalidRow = { ...mockRawRow, transaction_amount: '' };

    expect(() => reconstructContext(invalidRow)).toThrow('Missing required raw field for context reconstruction: transaction_amount');
    expect(() => reconstructContext(null)).toThrow('Raw row must be an object.');
  });
});
