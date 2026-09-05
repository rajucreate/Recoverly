import { jest } from '@jest/globals';
import request from 'supertest';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';
import { RecoveryFeedbackService } from '../src/intelligence/recovery-feedback-service.js';
import { RecoveryDecisionAuditService } from '../src/intelligence/recovery-decision-audit-service.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { createApp } from '../src/app.js';

function createMockPrisma({
  recoveryActions = [],
  allRecoveryActions = null,
  transactions = []
} = {}) {
  return {
    recoveryAction: {
      findMany: jest.fn().mockImplementation(({ where, select }) => {
        let items = (select && select.actionType)
          ? (allRecoveryActions || recoveryActions).map((a) => ({
              id: a.id,
              actionType: a.actionType,
              status: a.status,
              transactionId: a.transactionId
            }))
          : recoveryActions.filter((a) => {
              const matchesAction = ['RETRY', 'ALTERNATE_METHOD'].includes(a.actionType);
              const matchesStatus = ['SUCCESS', 'FAILED'].includes(a.status);
              return matchesAction && matchesStatus;
            });

        if (where?.transactionId?.in) {
          const allowedTxnIds = new Set(where.transactionId.in);
          items = items.filter((a) => !a.transactionId || allowedTxnIds.has(a.transactionId));
        }
        return Promise.resolve(items);
      })
    },
    transaction: {
      findMany: jest.fn().mockImplementation(({ where, select }) => {
        let items = transactions;
        if (where?.id?.in) {
          const allowedIds = new Set(where.id.in);
          items = items.filter((t) => allowedIds.has(t.id));
        }
        if (where?.paymentAttempts?.some?.status === 'FAILED') {
          items = items.filter((t) => (t.paymentAttempts || []).some((p) => p.status === 'FAILED'));
        }
        return Promise.resolve(items);
      })
    }
  };
}


describe('RecoveryAnalyticsService Unit Tests', () => {
  test('1. Normal recovery-rate calculations for actions and transactions', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_3', actionType: 'ALTERNATE_METHOD', status: 'FAILED', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } },
        { id: 'act_4', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ],
      transactions: [
        {
          id: 'txn_1',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ status: 'SUCCESS' }]
        },
        {
          id: 'txn_2',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'FAILED' }],
          recoveryActions: [{ status: 'FAILED' }]
        },
        {
          id: 'txn_3',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ status: 'SUCCESS' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    // 3 successes out of 4 executed payment actions = 0.75
    expect(op.actionRecoveryRate.rate).toBe(0.75);
    expect(op.actionRecoveryRate.successCount).toBe(3);
    expect(op.actionRecoveryRate.failedCount).toBe(1);
    expect(op.actionRecoveryRate.totalEligible).toBe(4);

    // 2 recovered out of 3 failed transactions = 0.6667
    expect(op.transactionRecoveryRate.rate).toBe(0.6667);
    expect(op.transactionRecoveryRate.recoveredCount).toBe(2);
    expect(op.transactionRecoveryRate.failedTransactionCount).toBe(3);
  });

  test('2. Zero denominator produces structured null values instead of NaN or 0', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [],
      transactions: []
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.actionRecoveryRate.rate).toBeNull();
    expect(op.actionRecoveryRate.totalEligible).toBe(0);
    expect(op.transactionRecoveryRate.rate).toBeNull();
    expect(op.transactionRecoveryRate.totalEligible).toBe(0);
    expect(op.retrySuccessRate.rate).toBeNull();
    expect(op.alternateMethodSuccessRate.rate).toBeNull();
    expect(op.escalationRate.rate).toBeNull();
  });

  test('3. Only FAILED outcomes produce 0.0 rate with non-null value', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: 'txn_1',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ status: 'FAILED' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.actionRecoveryRate.rate).toBe(0);
    expect(op.actionRecoveryRate.successCount).toBe(0);
    expect(op.actionRecoveryRate.failedCount).toBe(2);
    expect(op.transactionRecoveryRate.rate).toBe(0);
  });

  test('4. Only SUCCESS outcomes produce 1.0 rate', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ],
      transactions: [
        {
          id: 'txn_1',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ status: 'SUCCESS' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.actionRecoveryRate.rate).toBe(1);
    expect(op.actionRecoveryRate.successCount).toBe(2);
    expect(op.transactionRecoveryRate.rate).toBe(1);
  });

  test('5. CUSTOMER_ACTION and ESCALATE with EXECUTED are excluded from payment recovery denominator', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'CUSTOMER_ACTION', status: 'EXECUTED', attempt: { failureCategory: 'CUSTOMER_ACTION_REQUIRED', paymentMethod: 'CARD' } },
        { id: 'act_3', actionType: 'ESCALATE', status: 'EXECUTED', attempt: { failureCategory: 'UNKNOWN_FAILURE', paymentMethod: 'NET_BANKING' } }
      ],
      allRecoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS' },
        { id: 'act_2', actionType: 'CUSTOMER_ACTION', status: 'EXECUTED' },
        { id: 'act_3', actionType: 'ESCALATE', status: 'EXECUTED' }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    // CUSTOMER_ACTION and ESCALATE are not in payment recovery actions
    expect(op.actionRecoveryRate.totalEligible).toBe(1);
    expect(op.actionRecoveryRate.rate).toBe(1);
  });

  test('6. Null actual_recovery_success is strictly excluded from runtime model evaluation', () => {
    const feedbackService = new RecoveryFeedbackService();

    // 1 successful ML payment outcome, 1 failed ML payment outcome, 1 non-payment ML action (actual_recovery_success: null)
    feedbackService.buffer.push(
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.8 },
        execution: { execution_outcome: 'SUCCESS', actual_recovery_success: true }
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.2 },
        execution: { execution_outcome: 'FAILED', actual_recovery_success: false }
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.6 },
        execution: { execution_outcome: 'EXECUTED', actual_recovery_success: null }
      }
    );

    const analytics = new RecoveryAnalyticsService({ feedbackService });
    const model = analytics.getModelMetrics();

    // The null record must NOT be counted in runtimePerformance sampleCount
    expect(model.runtimePerformance.sampleCount).toBe(2);
    // (0.8 - 1)^2 + (0.2 - 0)^2 = 0.04 + 0.04 = 0.08 / 2 = 0.04
    expect(model.runtimePerformance.brierScore).toBe(0.04);
    expect(model.runtimePerformance.accuracy).toBe(1.0);
  });

  test('7. Failure-category segmentation calculates accurate rates per category', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_3', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.byFailureCategory.TEMPORARY_FAILURE.rate).toBe(0.5);
    expect(op.byFailureCategory.TEMPORARY_FAILURE.totalEligible).toBe(2);
    expect(op.byFailureCategory.PAYMENT_METHOD_FAILURE.rate).toBe(1.0);
    expect(op.byFailureCategory.PAYMENT_METHOD_FAILURE.totalEligible).toBe(1);
    expect(op.byFailureCategory.CUSTOMER_ACTION_REQUIRED.rate).toBeNull();
    expect(op.byFailureCategory.UNKNOWN_FAILURE.rate).toBeNull();
  });

  test('8. Payment-method segmentation calculates accurate rates per payment method', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_3', actionType: 'ALTERNATE_METHOD', status: 'FAILED', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.byPaymentMethod.UPI.rate).toBe(1.0);
    expect(op.byPaymentMethod.UPI.totalEligible).toBe(2);
    expect(op.byPaymentMethod.CARD.rate).toBe(0.0);
    expect(op.byPaymentMethod.CARD.totalEligible).toBe(1);
    expect(op.byPaymentMethod.NET_BANKING.rate).toBeNull();
  });

  test('9. Retry calculation considers only RETRY actions', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_3', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.retrySuccessRate.rate).toBe(0.5);
    expect(op.retrySuccessRate.successCount).toBe(1);
    expect(op.retrySuccessRate.failedCount).toBe(1);
    expect(op.retrySuccessRate.totalEligible).toBe(2);
  });

  test('10. Alternate-method calculation considers only ALTERNATE_METHOD actions', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } },
        { id: 'act_3', actionType: 'ALTERNATE_METHOD', status: 'SUCCESS', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.alternateMethodSuccessRate.rate).toBe(1.0);
    expect(op.alternateMethodSuccessRate.successCount).toBe(2);
    expect(op.alternateMethodSuccessRate.totalEligible).toBe(2);
  });

  test('11. Escalation denominator includes all generated recommendations', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [],
      allRecoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'RECOMMENDED' },
        { id: 'act_2', actionType: 'ALTERNATE_METHOD', status: 'RECOMMENDED' },
        { id: 'act_3', actionType: 'CUSTOMER_ACTION', status: 'RECOMMENDED' },
        { id: 'act_4', actionType: 'ESCALATE', status: 'RECOMMENDED' }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.escalationRate.rate).toBe(0.25);
    expect(op.escalationRate.escalateCount).toBe(1);
    expect(op.escalationRate.totalRecommendations).toBe(4);
  });

  test('12. ML-only confidence calculations with median and distribution bins', () => {
    const auditService = new RecoveryDecisionAuditService();
    auditService.record({
      decision: { selected_action: 'RETRY', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.15 },
      context: { failure_category: 'TEMPORARY_FAILURE' },
      correlation: { transaction_id: 't1', attempt_id: 'a1', recovery_action_id: 'r1' }
    });
    auditService.record({
      decision: { selected_action: 'RETRY', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.45 },
      context: { failure_category: 'TEMPORARY_FAILURE' },
      correlation: { transaction_id: 't2', attempt_id: 'a2', recovery_action_id: 'r2' }
    });
    auditService.record({
      decision: { selected_action: 'ALTERNATE_METHOD', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.75 },
      context: { failure_category: 'PAYMENT_METHOD_FAILURE' },
      correlation: { transaction_id: 't3', attempt_id: 'a3', recovery_action_id: 'r3' }
    });
    auditService.record({
      decision: { selected_action: 'ALTERNATE_METHOD', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.95 },
      context: { failure_category: 'PAYMENT_METHOD_FAILURE' },
      correlation: { transaction_id: 't4', attempt_id: 'a4', recovery_action_id: 'r4' }
    });

    const analytics = new RecoveryAnalyticsService({ auditService });
    const model = analytics.getModelMetrics();

    expect(model.predictionConfidence.sampleCount).toBe(4);
    // (0.15 + 0.45 + 0.75 + 0.95) / 4 = 2.30 / 4 = 0.575
    expect(model.predictionConfidence.mean).toBe(0.575);
    expect(model.predictionConfidence.min).toBe(0.15);
    expect(model.predictionConfidence.max).toBe(0.95);
    // median of [0.15, 0.45, 0.75, 0.95] = (0.45 + 0.75) / 2 = 0.6
    expect(model.predictionConfidence.median).toBe(0.6);
    expect(model.predictionConfidence.distributionBins['0.0-0.2']).toBe(1);
    expect(model.predictionConfidence.distributionBins['0.4-0.6']).toBe(1);
    expect(model.predictionConfidence.distributionBins['0.6-0.8']).toBe(1);
    expect(model.predictionConfidence.distributionBins['0.8-1.0']).toBe(1);
  });

  test('13. RULE records are strictly excluded from ML confidence and calibration metrics', () => {
    const auditService = new RecoveryDecisionAuditService();
    auditService.record({
      decision: { selected_action: 'ESCALATE', decision_source: DECISION_SOURCES.RULE },
      context: { failure_category: 'UNKNOWN_FAILURE' },
      correlation: { transaction_id: 't1', attempt_id: 'a1', recovery_action_id: 'r1' }
    });

    const feedbackService = new RecoveryFeedbackService();
    feedbackService.buffer.push({
      decision: { decision_source: DECISION_SOURCES.RULE, predicted_recovery_probability: null },
      execution: { execution_outcome: 'FAILED', actual_recovery_success: false }
    });

    const analytics = new RecoveryAnalyticsService({ auditService, feedbackService });
    const model = analytics.getModelMetrics();

    expect(model.predictionConfidence.sampleCount).toBe(0);
    expect(model.predictionConfidence.mean).toBeNull();
    expect(model.runtimePerformance.sampleCount).toBe(0);
    expect(model.runtimePerformance.brierScore).toBeNull();
    expect(model.runtimePerformance.accuracy).toBeNull();
  });

  test('14. Brier score calculation matches MSE of probability forecasts', () => {
    const feedbackService = new RecoveryFeedbackService();
    feedbackService.buffer.push(
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.9 },
        execution: { execution_outcome: 'SUCCESS', actual_recovery_success: true }
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.7 },
        execution: { execution_outcome: 'FAILED', actual_recovery_success: false }
      }
    );

    const analytics = new RecoveryAnalyticsService({ feedbackService });
    const model = analytics.getModelMetrics();

    // Sample 1: (0.9 - 1.0)^2 = 0.01
    // Sample 2: (0.7 - 0.0)^2 = 0.49
    // Mean = (0.01 + 0.49) / 2 = 0.25
    expect(model.runtimePerformance.sampleCount).toBe(2);
    expect(model.runtimePerformance.brierScore).toBe(0.25);
  });

  test('15. Binary accuracy at 0.5 threshold evaluates directional prediction correctness', () => {
    const feedbackService = new RecoveryFeedbackService();
    feedbackService.buffer.push(
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.8 },
        execution: { execution_outcome: 'SUCCESS', actual_recovery_success: true } // Correct (predict >= 0.5, actual = 1)
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.3 },
        execution: { execution_outcome: 'FAILED', actual_recovery_success: false } // Correct (predict < 0.5, actual = 0)
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: 0.6 },
        execution: { execution_outcome: 'FAILED', actual_recovery_success: false } // Incorrect (predict >= 0.5, actual = 0)
      }
    );

    const analytics = new RecoveryAnalyticsService({ feedbackService });
    const model = analytics.getModelMetrics();

    // 2 correct out of 3 = 0.6667
    expect(model.runtimePerformance.accuracy).toBe(0.6667);
  });

  test('16. Empty feedback and audit buffers return clean nulls and valid structures without errors', () => {
    const analytics = new RecoveryAnalyticsService({
      feedbackService: new RecoveryFeedbackService(),
      auditService: new RecoveryDecisionAuditService()
    });

    const model = analytics.getModelMetrics();
    expect(model.predictionConfidence.sampleCount).toBe(0);
    expect(model.predictionConfidence.mean).toBeNull();
    expect(model.predictionConfidence.min).toBeNull();
    expect(model.predictionConfidence.max).toBeNull();
    expect(model.predictionConfidence.median).toBeNull();
    expect(model.runtimePerformance.sampleCount).toBe(0);
    expect(model.runtimePerformance.brierScore).toBeNull();
    expect(model.runtimePerformance.accuracy).toBeNull();
    expect(model.trafficShare.totalDecisions).toBe(0);
    expect(model.trafficShare.mlShare).toBeNull();
    expect(model.trafficShare.ruleShare).toBeNull();
  });

  test('17. Invalid/missing predictions are safely rejected from confidence and calibration', () => {
    const feedbackService = new RecoveryFeedbackService();
    feedbackService.buffer.push(
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: null },
        execution: { execution_outcome: 'SUCCESS', actual_recovery_success: true }
      },
      {
        decision: { decision_source: DECISION_SOURCES.ML, predicted_recovery_probability: NaN },
        execution: { execution_outcome: 'FAILED', actual_recovery_success: false }
      }
    );

    const analytics = new RecoveryAnalyticsService({ feedbackService });
    const model = analytics.getModelMetrics();

    expect(model.predictionConfidence.sampleCount).toBe(0);
    expect(model.runtimePerformance.sampleCount).toBe(0);
  });

  test('18. Offline benchmark metrics load accurately from frozen JSON artifact', () => {
    const analytics = new RecoveryAnalyticsService();
    const benchmark = analytics.getBenchmarkMetrics();

    expect(benchmark).not.toBeNull();
    expect(benchmark.evaluation_version).toBe('6.6.0');
    expect(benchmark.model_version).toBe('phase2-interaction-logistic-v1');
    expect(benchmark.total_scenarios_evaluated).toBe(1200);
    expect(benchmark.metrics.rule_engine.recovery_success_rate).toBe(0.5433);
    expect(benchmark.metrics.ml_policy.recovery_success_rate).toBe(0.5473);
  });

  test('19. Runtime ML vs RULE traffic share computes counts and proportions accurately', () => {
    const auditService = new RecoveryDecisionAuditService();
    auditService.record({
      decision: { selected_action: 'RETRY', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.8 },
      context: { failure_category: 'TEMPORARY_FAILURE' },
      correlation: { transaction_id: 't1', attempt_id: 'a1', recovery_action_id: 'r1' }
    });
    auditService.record({
      decision: { selected_action: 'RETRY', decision_source: DECISION_SOURCES.ML, recovery_probability: 0.85 },
      context: { failure_category: 'TEMPORARY_FAILURE' },
      correlation: { transaction_id: 't2', attempt_id: 'a2', recovery_action_id: 'r2' }
    });
    auditService.record({
      decision: {
        selected_action: 'ESCALATE',
        decision_source: DECISION_SOURCES.RULE,
        fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE
      },
      context: { failure_category: 'UNKNOWN_FAILURE' },
      correlation: { transaction_id: 't3', attempt_id: 'a3', recovery_action_id: 'r3' }
    });

    const analytics = new RecoveryAnalyticsService({ auditService });
    const model = analytics.getModelMetrics();

    expect(model.trafficShare.totalDecisions).toBe(3);
    expect(model.trafficShare.mlCount).toBe(2);
    expect(model.trafficShare.mlShare).toBe(0.6667);
    expect(model.trafficShare.ruleCount).toBe(1);
    expect(model.trafficShare.ruleShare).toBe(0.3333);
    expect(model.trafficShare.fallbackReasons[FALLBACK_REASONS.MODEL_UNAVAILABLE]).toBe(1);
  });

  test('20. Runtime traffic share is strictly labeled as trafficShare and NOT counterfactual lift', () => {
    const analytics = new RecoveryAnalyticsService();
    const model = analytics.getModelMetrics();

    expect(model).toHaveProperty('trafficShare');
    expect(model).not.toHaveProperty('ruleVsMlPerformance');
    expect(model).not.toHaveProperty('modelLift');
  });

  test('21. Monetary aggregation: calculates revenue at risk, recovered, and rate without floating-point error', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', transactionId: 'txn_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', transactionId: 'txn_2', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: 'txn_1',
          amount: '5000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_1', actionType: 'RETRY', status: 'SUCCESS' }]
        },
        {
          id: 'txn_2',
          amount: '3000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_2', actionType: 'RETRY', status: 'FAILED' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.monetary.currency).toBe('INR');
    expect(op.monetary.revenueAtRisk).toBe('8000.00');
    expect(op.monetary.revenueRecovered).toBe('5000.00');
    // 5000 / 8000 = 0.625
    expect(op.monetary.monetaryRecoveryRate).toBe(0.625);
    expect(op.monetary.successfulRecoveries).toBe(1);
    expect(op.monetary.failedRecoveries).toBe(1);
  });

  test('22. Duplicate attempts: transaction amount is counted strictly once despite multiple attempts', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', transactionId: 'txn_dup', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', transactionId: 'txn_dup', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: 'txn_dup',
          amount: '2500.0000',
          currency: 'INR',
          paymentAttempts: [
            { attemptNumber: 1, status: 'FAILED' },
            { attemptNumber: 2, status: 'FAILED' },
            { attemptNumber: 3, status: 'SUCCESS' }
          ],
          recoveryActions: [
            { id: 'act_1', actionType: 'RETRY', status: 'FAILED' },
            { id: 'act_2', actionType: 'RETRY', status: 'SUCCESS' }
          ]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.monetary.revenueAtRisk).toBe('2500.00');
    expect(op.monetary.revenueRecovered).toBe('2500.00');
    expect(op.monetary.monetaryRecoveryRate).toBe(1.0);
    expect(op.monetary.successfulRecoveries).toBe(1);
    expect(op.monetary.failedRecoveries).toBe(0);
  });

  test('23. Batch isolation: outside transactions are strictly excluded from batch monetary evaluation', async () => {
    const idBatch1 = 'a0000000-0000-4000-8000-000000000001';
    const idBatch2 = 'a0000000-0000-4000-8000-000000000002';
    const idOutside = 'a0000000-0000-4000-8000-000000000099';

    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', transactionId: idBatch1, actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_2', transactionId: idBatch2, actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_outside', transactionId: idOutside, actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: idBatch1,
          amount: '1000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_1', actionType: 'RETRY', status: 'SUCCESS' }]
        },
        {
          id: idBatch2,
          amount: '2000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_2', actionType: 'RETRY', status: 'FAILED' }]
        },
        {
          id: idOutside,
          amount: '50000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_outside', actionType: 'RETRY', status: 'SUCCESS' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics({ transactionIds: [idBatch1, idBatch2] });

    // Should only aggregate idBatch1 (1000) and idBatch2 (2000) -> 3000 at risk, 1000 recovered
    expect(op.monetary.revenueAtRisk).toBe('3000.00');
    expect(op.monetary.revenueRecovered).toBe('1000.00');
    expect(op.monetary.monetaryRecoveryRate).toBe(0.3333);
    expect(op.monetary.successfulRecoveries).toBe(1);
    expect(op.monetary.failedRecoveries).toBe(1);
    expect(op.transactionRecoveryRate.failedTransactionCount).toBe(2);
  });

  test('24. Per-action performance breakdown attributes revenue and resolution correctly per action type', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_retry', transactionId: 'txn_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_alt', transactionId: 'txn_2', actionType: 'ALTERNATE_METHOD', status: 'FAILED', attempt: { failureCategory: 'PAYMENT_METHOD_FAILURE', paymentMethod: 'CARD' } },
        { id: 'act_cust', transactionId: 'txn_3', actionType: 'CUSTOMER_ACTION', status: 'EXECUTED', attempt: { failureCategory: 'CUSTOMER_ACTION_REQUIRED', paymentMethod: 'NET_BANKING' } },
        { id: 'act_esc', transactionId: 'txn_4', actionType: 'ESCALATE', status: 'EXECUTED', attempt: { failureCategory: 'UNKNOWN_FAILURE', paymentMethod: 'CARD' } }
      ],
      allRecoveryActions: [
        { id: 'act_retry', transactionId: 'txn_1', actionType: 'RETRY', status: 'SUCCESS' },
        { id: 'act_alt', transactionId: 'txn_2', actionType: 'ALTERNATE_METHOD', status: 'FAILED' },
        { id: 'act_cust', transactionId: 'txn_3', actionType: 'CUSTOMER_ACTION', status: 'EXECUTED' },
        { id: 'act_esc', transactionId: 'txn_4', actionType: 'ESCALATE', status: 'EXECUTED' }
      ],
      transactions: [
        {
          id: 'txn_1',
          amount: '1200.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_retry', actionType: 'RETRY', status: 'SUCCESS' }]
        },
        {
          id: 'txn_2',
          amount: '800.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_alt', actionType: 'ALTERNATE_METHOD', status: 'FAILED' }]
        },
        {
          id: 'txn_3',
          amount: '500.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_cust', actionType: 'CUSTOMER_ACTION', status: 'EXECUTED' }]
        },
        {
          id: 'txn_4',
          amount: '300.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_esc', actionType: 'ESCALATE', status: 'EXECUTED' }]
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    const { byAction } = op.monetary;
    expect(byAction.RETRY.attemptedCount).toBe(1);
    expect(byAction.RETRY.successfulCount).toBe(1);
    expect(byAction.RETRY.revenueAtRisk).toBe('1200.00');
    expect(byAction.RETRY.revenueRecovered).toBe('1200.00');
    expect(byAction.RETRY.monetaryRecoveryRate).toBe(1.0);

    expect(byAction.ALTERNATE_METHOD.attemptedCount).toBe(1);
    expect(byAction.ALTERNATE_METHOD.failedCount).toBe(1);
    expect(byAction.ALTERNATE_METHOD.revenueAtRisk).toBe('800.00');
    expect(byAction.ALTERNATE_METHOD.revenueRecovered).toBe('0.00');
    expect(byAction.ALTERNATE_METHOD.monetaryRecoveryRate).toBe(0.0);

    expect(byAction.CUSTOMER_ACTION.attemptedCount).toBe(1);
    expect(byAction.CUSTOMER_ACTION.stoppedCount).toBe(1);
    expect(byAction.CUSTOMER_ACTION.revenueAtRisk).toBe('500.00');
    expect(byAction.CUSTOMER_ACTION.revenueRecovered).toBe('0.00');

    expect(byAction.ESCALATE.attemptedCount).toBe(1);
    expect(byAction.ESCALATE.stoppedCount).toBe(1);
    expect(byAction.ESCALATE.revenueAtRisk).toBe('300.00');
    expect(byAction.ESCALATE.revenueRecovered).toBe('0.00');
  });

  test('25. Pending/stopped classification distinguishes pending recommendations from failed/stopped work', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [],
      allRecoveryActions: [
        { id: 'act_pending', transactionId: 'txn_pending', actionType: 'RETRY', status: 'RECOMMENDED' },
        { id: 'act_stopped', transactionId: 'txn_stopped', actionType: 'ESCALATE', status: 'EXECUTED' }
      ],
      transactions: [
        {
          id: 'txn_pending',
          amount: '1000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_pending', actionType: 'RETRY', status: 'RECOMMENDED' }],
          recoveryJobs: [{ status: 'QUEUED' }]
        },
        {
          id: 'txn_stopped',
          amount: '2000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_stopped', actionType: 'ESCALATE', status: 'EXECUTED' }],
          recoveryJobs: []
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const op = await analytics.getOperationalMetrics();

    expect(op.monetary.pendingRecoveries).toBe(1);
    expect(op.monetary.stoppedRecoveries).toBe(1);
    expect(op.monetary.successfulRecoveries).toBe(0);
    expect(op.monetary.failedRecoveries).toBe(0);
  });

  test('26. Mixed currency batches safely reject aggregation with ValidationError', async () => {
    const idInr = 'a0000000-0000-4000-8000-000000000001';
    const idUsd = 'a0000000-0000-4000-8000-000000000002';

    const mockPrisma = createMockPrisma({
      transactions: [
        {
          id: idInr,
          amount: '1000.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: []
        },
        {
          id: idUsd,
          amount: '50.0000',
          currency: 'USD',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: []
        }
      ]
    });

    const analytics = new RecoveryAnalyticsService({ prisma: mockPrisma });
    await expect(analytics.getOperationalMetrics({ transactionIds: [idInr, idUsd] }))
      .rejects.toMatchObject({
        message: 'Request validation failed',
        details: { currency: 'Mixed currencies cannot be aggregated in a single monetary recovery summary' }
      });
  });

  test('27. SUCCESS recovery action without a subsequent successful payment attempt recovers no revenue', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_success_only', transactionId: 'txn_success_only', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: 'txn_success_only',
          amount: '1000.00',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_success_only', actionType: 'RETRY', status: 'SUCCESS' }],
          recoveryJobs: []
        }
      ]
    });

    const op = await new RecoveryAnalyticsService({ prisma: mockPrisma }).getOperationalMetrics();

    // Action execution analytics remain legacy-compatible, but money requires a later payment success.
    expect(op.actionRecoveryRate.rate).toBe(1);
    expect(op.transactionRecoveryRate.recoveredCount).toBe(1);
    expect(op.monetary.revenueRecovered).toBe('0.00');
    expect(op.monetary.successfulRecoveries).toBe(0);
  });

  test('28. SUCCEEDED recovery job without a qualifying successful payment attempt recovers no revenue', async () => {
    const mockPrisma = createMockPrisma({
      transactions: [
        {
          id: 'txn_job_succeeded_only',
          amount: '2000.00',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_job_succeeded_only', actionType: 'RETRY', status: 'EXECUTED' }],
          recoveryJobs: [{ id: 'job_succeeded_only', status: 'SUCCEEDED' }]
        }
      ]
    });

    const op = await new RecoveryAnalyticsService({ prisma: mockPrisma }).getOperationalMetrics();

    expect(op.monetary.revenueRecovered).toBe('0.00');
    expect(op.monetary.successfulRecoveries).toBe(0);
    expect(op.transactionRecoveryRate.recoveredCount).toBe(0);
  });

  test('29. Global mixed-currency data leaves monetary totals unavailable while retaining non-monetary analytics', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_inr', transactionId: 'txn_inr', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } },
        { id: 'act_usd', transactionId: 'txn_usd', actionType: 'RETRY', status: 'FAILED', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      transactions: [
        {
          id: 'txn_inr', amount: '1000.00', currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_inr', actionType: 'RETRY', status: 'SUCCESS' }]
        },
        {
          id: 'txn_usd', amount: '50.00', currency: 'USD',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: [{ id: 'act_usd', actionType: 'RETRY', status: 'FAILED' }]
        }
      ]
    });

    const op = await new RecoveryAnalyticsService({ prisma: mockPrisma }).getOperationalMetrics();

    expect(op.actionRecoveryRate).toMatchObject({ rate: 0.5, successCount: 1, failedCount: 1 });
    expect(op.transactionRecoveryRate).toMatchObject({ rate: 0.5, recoveredCount: 1, failedTransactionCount: 2 });
    expect(op.monetary.currency).toBeNull();
    expect(op.monetary.revenueAtRisk).toBeNull();
    expect(op.monetary.revenueRecovered).toBeNull();
    expect(op.monetary.monetaryRecoveryRate).toBeNull();
    expect(op.monetary.byAction.RETRY.revenueAtRisk).toBeNull();
    expect(op.monetary.byAction.RETRY.revenueRecovered).toBeNull();
  });
});


describe('Recovery Analytics API Integration Tests', () => {
  test('GET /api/analytics/recovery returns 200 with structured operational, model, and benchmark data', async () => {
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      allRecoveryActions: [
        { id: 'act_1', actionType: 'RETRY', status: 'SUCCESS' }
      ],
      transactions: [
        {
          id: 'txn_1',
          amount: '500.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ status: 'SUCCESS' }]
        }
      ]
    });

    const auditService = new RecoveryDecisionAuditService();
    const feedbackService = new RecoveryFeedbackService({ auditService });
    const analyticsService = new RecoveryAnalyticsService({
      prisma: mockPrisma,
      feedbackService,
      auditService
    });

    const app = createApp({ analyticsService, auditService, feedbackService });
    const response = await request(app).get('/api/analytics/recovery');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('data');
    expect(response.body.data).toHaveProperty('operational');
    expect(response.body.data).toHaveProperty('model');
    expect(response.body.data).toHaveProperty('benchmark');

    const { operational, model, benchmark } = response.body.data;
    expect(operational.actionRecoveryRate.rate).toBe(1);
    expect(operational.transactionRecoveryRate.rate).toBe(1);
    expect(operational.monetary.revenueAtRisk).toBe('500.00');
    expect(operational.monetary.revenueRecovered).toBe('500.00');
    expect(model.trafficShare.totalDecisions).toBe(0);
    expect(benchmark).not.toBeNull();
  });

  test('GET /api/analytics/recovery?transactionIds=... filters batch scope and returns batch property', async () => {
    const id1 = '00000000-0000-4000-8000-000000000001';
    const id2 = '00000000-0000-4000-8000-000000000002';
    const mockPrisma = createMockPrisma({
      recoveryActions: [
        { id: 'act_1', transactionId: id1, actionType: 'RETRY', status: 'SUCCESS', attempt: { failureCategory: 'TEMPORARY_FAILURE', paymentMethod: 'UPI' } }
      ],
      allRecoveryActions: [
        { id: 'act_1', transactionId: id1, actionType: 'RETRY', status: 'SUCCESS' }
      ],
      transactions: [
        {
          id: id1,
          amount: '1500.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }, { attemptNumber: 2, status: 'SUCCESS' }],
          recoveryActions: [{ id: 'act_1', actionType: 'RETRY', status: 'SUCCESS' }]
        },
        {
          id: id2,
          amount: '2500.0000',
          currency: 'INR',
          paymentAttempts: [{ attemptNumber: 1, status: 'FAILED' }],
          recoveryActions: []
        }
      ]
    });

    const analyticsService = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const app = createApp({ analyticsService });

    const response = await request(app).get(`/api/analytics/recovery?transactionIds=${id1},${id2}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('batch');
    expect(response.body.data.batch.transactionIds).toEqual([id1, id2]);
    expect(response.body.data.batch.revenueAtRisk).toBe('4000.00');
    expect(response.body.data.batch.revenueRecovered).toBe('1500.00');
    expect(response.body.data.batch.monetaryRecoveryRate).toBe(0.375);
  });

  test('GET /api/analytics/recovery rejects malformed UUID with 400 ValidationError', async () => {
    const analyticsService = new RecoveryAnalyticsService({ prisma: createMockPrisma() });
    const app = createApp({ analyticsService });

    const response = await request(app).get('/api/analytics/recovery?transactionIds=invalid-uuid-123');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /api/analytics/recovery returns 404 NotFoundError when transactionId does not exist', async () => {
    const idNonexistent = '99999999-9999-4999-8999-999999999999';
    const mockPrisma = createMockPrisma({ transactions: [] });
    const analyticsService = new RecoveryAnalyticsService({ prisma: mockPrisma });
    const app = createApp({ analyticsService });

    const response = await request(app).get(`/api/analytics/recovery?transactionIds=${idNonexistent}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
