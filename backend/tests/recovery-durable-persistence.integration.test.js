import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import { prisma } from '../src/config/prisma.js';
import { RecoveryDecisionAuditRepository } from '../src/repositories/recovery-decision-audit-repository.js';
import { RecoveryDecisionAuditService, buildDecisionAuditRecord } from '../src/intelligence/recovery-decision-audit-service.js';
import { RecoveryFeedbackService, buildFeedbackRecord, FEEDBACK_OUTCOMES } from '../src/intelligence/recovery-feedback-service.js';
import { explainDecision } from '../src/intelligence/recovery-decision-explanation.js';
import { DECISION_SOURCES } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';

const createdTransactionIds = new Set();

async function createRecoveryCase() {
  const transaction = await prisma.transaction.create({
    data: { amount: '1250.5000', currency: 'INR', customerId: `durable-test-${crypto.randomUUID()}`, status: 'FAILED' }
  });
  createdTransactionIds.add(transaction.id);
  const triggerAttempt = await prisma.paymentAttempt.create({
    data: {
      transactionId: transaction.id,
      paymentMethod: 'UPI',
      status: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'durable integration test failure',
      attemptNumber: 1
    }
  });
  const action = await prisma.recoveryAction.create({
    data: {
      transactionId: transaction.id,
      attemptId: triggerAttempt.id,
      actionType: 'RETRY',
      reason: 'durable integration test action'
    }
  });
  return { transaction, triggerAttempt, action };
}

function createAuditInput(testCase) {
  const context = {
    transaction_amount: 1250.5,
    currency: 'INR',
    payment_method_attempted: 'UPI',
    failure_category: 'TEMPORARY_FAILURE',
    has_failure_reason: true,
    attempt_number: 1,
    prior_failed_attempt_count: 0,
    prior_temporary_failure_count: 0,
    transaction_status: 'FAILED'
  };
  const decision = {
    selected_action: RecoveryActionType.RETRY,
    decision_source: DECISION_SOURCES.ML,
    recovery_probability: 0.73,
    model_version: 'durable-test-model',
    reason: 'Durable test selected RETRY.',
    candidate_predictions: [
      { candidate_action_type: 'RETRY', recovery_probability: 0.73, model_version: 'durable-test-model' },
      { candidate_action_type: 'ALTERNATE_METHOD', recovery_probability: 0.31, model_version: 'durable-test-model' }
    ]
  };
  const auditRecord = buildDecisionAuditRecord({
    decision,
    context,
    correlation: {
      transaction_id: testCase.transaction.id,
      attempt_id: testCase.triggerAttempt.id,
      recovery_action_id: testCase.action.id
    },
    decisionTimestamp: '2026-09-03T10:00:00.000Z',
    decisionLatencyMs: 2.5
  });
  return { auditRecord, explanation: explainDecision({ auditRecord }) };
}

function createFeedbackInput(testCase, outcome, auditRecord = null) {
  const normalizedOutcome = Array.isArray(outcome) ? outcome[0] : outcome;
  return {
    feedback_id: `feedback_${crypto.randomUUID()}`,
    transactionId: testCase.transaction.id,
    triggerAttemptId: testCase.triggerAttempt.id,
    recoveryActionId: testCase.action.id,
    executionAttemptId: null,
    recoveryAction: RecoveryActionType.RETRY,
    decisionSource: DECISION_SOURCES.ML,
    predictedRecoveryProbability: 0.73,
    modelVersion: 'durable-test-model',
    execution_outcome: normalizedOutcome,
    outcome_timestamp: '2026-09-03T10:05:00.000Z',
    feedback_timestamp: '2026-09-03T10:06:00.000Z',
    auditRecord,
    context: {
      transaction_amount: 1250.5,
      currency: 'INR',
      payment_method_attempted: 'UPI',
      failure_category: 'TEMPORARY_FAILURE',
      has_failure_reason: true,
      failure_reason_text: 'durable integration test failure',
      attempt_number: 1,
      prior_failed_attempt_count: 0,
      prior_temporary_failure_count: 0
    }
  };
}

describe('Phase 3.1 durable PostgreSQL persistence', () => {
  beforeAll(async () => {
    await prisma.$connect();
    await expect(prisma.recoveryDecisionAudit.count()).resolves.toBeGreaterThanOrEqual(0);
    await expect(prisma.recoveryFeedback.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  afterAll(async () => {
    if (createdTransactionIds.size > 0) {
      await prisma.transaction.deleteMany({ where: { id: { in: [...createdTransactionIds] } } });
    }
    await prisma.$disconnect();
  });

  test('persists and retrieves a complete audit across fresh service instances', async () => {
    const testCase = await createRecoveryCase();
    const { auditRecord, explanation } = createAuditInput(testCase);
    const writer = new RecoveryDecisionAuditService({ prisma });
    await writer.persist(auditRecord, explanation);

    const reader = new RecoveryDecisionAuditService({ prisma });
    const stored = await reader.findByRecoveryActionId(testCase.action.id, testCase.transaction.id);

    expect(stored).toMatchObject({
      audit_id: auditRecord.audit_id,
      selected_action: 'RETRY',
      decision_source: 'ML',
      selected_probability: 0.73,
      explanation,
      correlation: {
        transaction_id: testCase.transaction.id,
        attempt_id: testCase.triggerAttempt.id,
        recovery_action_id: testCase.action.id
      }
    });
    expect(stored.explanation.explanation_schema_version).toBe(explanation.explanation_schema_version);
    expect(stored.versions).toEqual(auditRecord.versions);
  });

  test('rolls back the audit row and compatibility cache with the surrounding transaction', async () => {
    const auditService = new RecoveryDecisionAuditService({ prisma });
    const auditRepository = new RecoveryDecisionAuditRepository(prisma);
    const transactionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    const auditRecord = buildDecisionAuditRecord({
      decision: { selected_action: 'RETRY', decision_source: 'RULE', reason: 'rollback test' },
      context: { transaction_status: 'FAILED', failure_category: 'TEMPORARY_FAILURE' },
      correlation: { transaction_id: transactionId, attempt_id: attemptId, recovery_action_id: actionId }
    });
    const explanation = explainDecision({ auditRecord });

    await expect(prisma.$transaction(async (transactionClient) => {
      await transactionClient.transaction.create({
        data: { id: transactionId, amount: '1250.5000', currency: 'INR', customerId: `rollback-test-${transactionId}`, status: 'FAILED' }
      });
      await transactionClient.paymentAttempt.create({
        data: {
          id: attemptId,
          transactionId,
          paymentMethod: 'UPI',
          status: 'FAILED',
          failureCategory: 'TEMPORARY_FAILURE',
          attemptNumber: 1
        }
      });
      await transactionClient.recoveryAction.create({
        data: { id: actionId, transactionId, attemptId, actionType: 'RETRY', reason: 'rollback test' }
      });
      await auditRepository.create(auditRecord, explanation, transactionClient);
      throw new Error('deliberate durable audit rollback');
    })).rejects.toThrow('deliberate durable audit rollback');

    expect(auditService.buffer).toHaveLength(0);
    await expect(prisma.recoveryDecisionAudit.findUnique({ where: { auditId: auditRecord.audit_id } })).resolves.toBeNull();
  });

  test.each([[FEEDBACK_OUTCOMES.SUCCESS], [FEEDBACK_OUTCOMES.FAILED], [FEEDBACK_OUTCOMES.EXECUTED]])(
    'persists %s feedback and deduplicates after a fresh service instance',
    async (outcome) => {
      const testCase = await createRecoveryCase();
      const input = createFeedbackInput(testCase, outcome);
      const writer = new RecoveryFeedbackService({ prisma });
      await writer.recordFeedback(input);

      const reader = new RecoveryFeedbackService({ prisma });
      const firstRead = await reader.getFeedbackForTransaction(testCase.transaction.id);
      await reader.recordFeedback(input);
      const rows = await prisma.recoveryFeedback.findMany({ where: { transactionId: testCase.transaction.id } });

      expect(firstRead).toHaveLength(1);
      expect(firstRead[0].execution.execution_outcome).toBe(outcome);
      expect(rows).toHaveLength(1);
      expect((await reader.getFeedbackForTransaction(testCase.transaction.id))).toHaveLength(1);
    }
  );

  test('concurrent identical feedback writes remain idempotent in PostgreSQL', async () => {
    const testCase = await createRecoveryCase();
    const input = createFeedbackInput(testCase, FEEDBACK_OUTCOMES.SUCCESS);
    const service = new RecoveryFeedbackService({ prisma });
    const results = await Promise.all([...Array(8)].map(() => service.recordFeedback(input)));
    const rows = await prisma.recoveryFeedback.findMany({ where: { transactionId: testCase.transaction.id } });

    expect(results).toHaveLength(8);
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((record) => record.feedback_id))).toEqual(new Set([input.feedback_id]));
  });

  test('fresh analytics service derives runtime metrics from durable records, not buffers', async () => {
    const testCase = await createRecoveryCase();
    const { auditRecord, explanation } = createAuditInput(testCase);
    await new RecoveryDecisionAuditRepository(prisma).create(auditRecord, explanation);
    await new RecoveryFeedbackService({ prisma }).recordFeedback(createFeedbackInput(testCase, FEEDBACK_OUTCOMES.SUCCESS, auditRecord));

    const analytics = new RecoveryAnalyticsService({
      prisma,
      auditService: new RecoveryDecisionAuditService({ prisma }),
      feedbackService: new RecoveryFeedbackService({ prisma })
    });
    const metrics = await analytics.getModelMetrics();
    const durableFeedbackCount = await prisma.recoveryFeedback.count({
      where: { decisionSource: 'ML', actualRecoverySuccess: { not: null } }
    });

    expect(analytics.auditService.buffer).toHaveLength(0);
    expect(analytics.feedbackService.buffer).toHaveLength(0);
    expect(metrics.runtimePerformance.sampleCount).toBe(durableFeedbackCount);
    expect(metrics.runtimePerformance.sampleCount).toBeGreaterThanOrEqual(1);
    expect(metrics.trafficShare.totalDecisions).toBeGreaterThanOrEqual(1);
  });

  test('enforces foreign keys for valid and invalid durable references', async () => {
    const testCase = await createRecoveryCase();
    const { auditRecord, explanation } = createAuditInput(testCase);
    await expect(new RecoveryDecisionAuditRepository(prisma).create(auditRecord, explanation)).resolves.toBeDefined();

    const invalidAudit = buildDecisionAuditRecord({
      decision: { selected_action: 'RETRY', decision_source: 'RULE', reason: 'invalid FK test' },
      context: { transaction_status: 'FAILED' },
      correlation: { transaction_id: crypto.randomUUID(), attempt_id: crypto.randomUUID() }
    });
    await expect(new RecoveryDecisionAuditRepository(prisma).create(invalidAudit, explainDecision({ auditRecord: invalidAudit })))
      .rejects.toMatchObject({ code: 'P2003' });
  });
});