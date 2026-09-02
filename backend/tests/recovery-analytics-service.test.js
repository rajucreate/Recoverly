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
        if (select && select.actionType) {
          // Query for all recommendations
          return Promise.resolve(
            (allRecoveryActions || recoveryActions).map((a) => ({
              id: a.id,
              actionType: a.actionType,
              status: a.status
            }))
          );
        }
        // Query for executed payment recovery actions
        return Promise.resolve(
          recoveryActions.filter((a) => {
            const matchesAction = ['RETRY', 'ALTERNATE_METHOD'].includes(a.actionType);
            const matchesStatus = ['SUCCESS', 'FAILED'].includes(a.status);
            return matchesAction && matchesStatus;
          })
        );
      })
    },
    transaction: {
      findMany: jest.fn().mockResolvedValue(transactions)
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
    expect(model.trafficShare.totalDecisions).toBe(0);
    expect(benchmark).not.toBeNull();
  });
});
