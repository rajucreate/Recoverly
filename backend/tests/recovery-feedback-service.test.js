import request from 'supertest';
import { jest } from '@jest/globals';
import {
  RecoveryFeedbackService,
  buildFeedbackRecord,
  feedbackRecordToDatasetRow,
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_OUTCOMES
} from '../src/intelligence/recovery-feedback-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryDecisionAuditService, buildDecisionAuditRecord } from '../src/intelligence/recovery-decision-audit-service.js';
import { INTERACTION_MODEL_VERSION } from '../src/intelligence/candidate-model-comparison.js';
import { DATASET_VERSION, SCHEMA_VERSION } from '../src/intelligence/recovery-dataset-generator.js';
import { createApp } from '../src/app.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { RecoveryDecisionPolicy } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { TransactionStatus } from '../src/enums/transaction-status.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';
import { TransactionController } from '../src/controllers/transaction-controller.js';

describe('RecoveryFeedbackService (Task 6.10)', () => {
  const baseContext = {
    transaction_amount: 4500,
    currency: 'INR',
    payment_method_attempted: 'UPI',
    failure_category: 'TEMPORARY_FAILURE',
    has_failure_reason: true,
    failure_reason_text: 'Bank gateway timeout',
    attempt_number: 1,
    prior_failed_attempt_count: 0,
    prior_temporary_failure_count: 0
  };

  const sampleAuditRecord = buildDecisionAuditRecord({
    decision: {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.88,
      model_version: INTERACTION_MODEL_VERSION,
      reason: 'ML selected RETRY as highest-probability safe action.',
      candidate_predictions: [
        { candidate_action_type: 'RETRY', recovery_probability: 0.88, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'ALTERNATE_METHOD', recovery_probability: 0.45, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'CUSTOMER_ACTION', recovery_probability: 0.20, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'ESCALATE', recovery_probability: 0.10, model_version: INTERACTION_MODEL_VERSION }
      ]
    },
    context: baseContext,
    correlation: {
      transaction_id: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
      attempt_id: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      recovery_action_id: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401'
    },
    decisionTimestamp: '2026-09-01T10:00:00.000Z'
  });

  function buildMockAppEnv({ transactionOverrides = {}, predictionServiceOverride = null } = {}) {
    const testTransactionId = 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a';
    const transaction = {
      id: testTransactionId,
      amount: { toString: () => '5000' },
      currency: 'INR',
      customerId: 'customer-001',
      status: TransactionStatus.PENDING,
      _count: { paymentAttempts: 0 },
      paymentAttempts: [],
      ...transactionOverrides
    };

    const state = {
      transactions: new Map([[transaction.id, transaction]]),
      attempts: [],
      recoveryActions: []
    };

    let sequence = 1;
    const client = {
      transaction: {
        create: jest.fn(async ({ data }) => {
          const record = { ...transaction, ...data, id: testTransactionId, createdAt: new Date() };
          state.transactions.set(record.id, record);
          return record;
        }),
        findUnique: jest.fn(async ({ where, select }) => {
          const record = state.transactions.get(where.id);
          if (!record) return null;
          if (select) {
            return {
              id: record.id,
              status: record.status,
              amount: record.amount,
              currency: record.currency,
              _count: { paymentAttempts: state.attempts.filter((a) => a.transactionId === where.id).length },
              paymentAttempts: state.attempts.filter((a) => a.transactionId === where.id && a.status === 'FAILED')
            };
          }
          return {
            ...record,
            paymentAttempts: state.attempts.filter((a) => a.transactionId === where.id),
            recoveryActions: state.recoveryActions.filter((a) => a.transactionId === where.id)
          };
        }),
        update: jest.fn(async ({ where, data }) => {
          const record = state.transactions.get(where.id);
          const updated = { ...record, ...data };
          state.transactions.set(where.id, updated);
          return updated;
        })
      },
      paymentAttempt: {
        create: jest.fn(async ({ data }) => {
          const attempt = { id: `d4c23c30-99e8-4d89-9e12-5a3cbd7c740${sequence++}`, ...data, createdAt: new Date() };
          state.attempts.push(attempt);
          return attempt;
        })
      },
      recoveryAction: {
        create: jest.fn(async ({ data }) => {
          const action = { id: `a4c23c30-99e8-4d89-9e12-5a3cbd7c740${sequence++}`, ...data, createdAt: new Date() };
          state.recoveryActions.push(action);
          return action;
        }),
        findFirst: jest.fn(async ({ where }) => {
          const action = state.recoveryActions.find((a) => a.id === where.id && a.transactionId === where.transactionId);
          if (!action) return null;
          const attempt = state.attempts.find((att) => att.id === action.attemptId);
          return { ...action, attempt: attempt ? { paymentMethod: attempt.paymentMethod } : null };
        }),
        updateMany: jest.fn(async ({ where, data }) => {
          const action = state.recoveryActions.find((a) => a.id === where.id && a.status === where.status);
          if (action) {
            Object.assign(action, data);
            return { count: 1 };
          }
          return { count: 0 };
        })
      }
    };
    client.prisma = client;
    client.$transaction = jest.fn(async (work) => work(client));

    const repository = {
      prisma: client,
      findByIdForAttempt: jest.fn(async (id) => client.transaction.findUnique({ where: { id }, select: true })),
      findByIdWithHistory: jest.fn(async (id) => client.transaction.findUnique({ where: { id } })),
      create: jest.fn(async (data) => client.transaction.create({ data })),
      createPaymentAttempt: jest.fn(async (data) => client.paymentAttempt.create({ data })),
      updateStatus: jest.fn(async (id, status) => client.transaction.update({ where: { id }, data: { status } })),
      executeInTransaction: jest.fn(async (work) => work(repository))
    };

    const auditService = new RecoveryDecisionAuditService();
    const feedbackService = new RecoveryFeedbackService({ auditService });

    const predictionService = predictionServiceOverride ?? {
      predictAll: jest.fn(() => [
        { candidate_action_type: 'RETRY', recovery_probability: 0.88, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'ALTERNATE_METHOD', recovery_probability: 0.45, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'CUSTOMER_ACTION', recovery_probability: 0.20, model_version: INTERACTION_MODEL_VERSION },
        { candidate_action_type: 'ESCALATE', recovery_probability: 0.10, model_version: INTERACTION_MODEL_VERSION }
      ])
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const transactionService = new TransactionService(repository, new RecoveryDecisionEngine(), predictionService, policy, auditService);
    const recoveryExecutionService = new RecoveryExecutionService(repository, new SimulatedPaymentProvider());

    const app = createApp({
      transactionService,
      recoveryExecutionService,
      predictionService,
      decisionPolicy: policy,
      auditService,
      feedbackService
    });

    return { app, repository, state, auditService, feedbackService, transaction, client };
  }

  // 1. ML decision's original probability/model metadata reaches feedback
  test('1. ML decision original probability and model version metadata reach feedback without heuristic string parsing', async () => {
    const { app, feedbackService, transaction } = buildMockAppEnv();

    const attemptRes = await request(app)
      .post(`/api/transactions/${transaction.id}/attempts`)
      .send({ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'Network timeout' });

    expect(attemptRes.status).toBe(201);
    const recoveryActionId = attemptRes.body.data.recoveryAction.id;

    const execRes = await request(app)
      .post(`/api/transactions/${transaction.id}/recovery/execute`)
      .send({ recoveryActionId, providerOutcome: 'SUCCESS' });

    expect(execRes.status).toBe(200);
    expect(feedbackService.getFeedbackCount()).toBe(1);

    const feedback = feedbackService.getFeedbackForTransaction(transaction.id)[0];
    expect(feedback.decision.decision_source).toBe(DECISION_SOURCES.ML);
    expect(feedback.decision.predicted_recovery_probability).toBe(0.88);
    expect(feedback.decision.model_version).toBe(INTERACTION_MODEL_VERSION);
    expect(feedback.execution.actual_recovery_success).toBe(true);
  });

  // 2. A RULE fallback retains decision_source: RULE
  test('2. RULE fallback retains decision_source: RULE with null probability and null model version', async () => {
    const faultyPredictionService = {
      predictAll: jest.fn(() => {
        throw new Error('ML model offline');
      })
    };
    const { app, feedbackService, transaction } = buildMockAppEnv({ predictionServiceOverride: faultyPredictionService });

    const attemptRes = await request(app)
      .post(`/api/transactions/${transaction.id}/attempts`)
      .send({ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'Network timeout' });

    expect(attemptRes.status).toBe(201);
    const recoveryActionId = attemptRes.body.data.recoveryAction.id;

    const execRes = await request(app)
      .post(`/api/transactions/${transaction.id}/recovery/execute`)
      .send({ recoveryActionId, providerOutcome: 'SUCCESS' });

    expect(execRes.status).toBe(200);
    expect(feedbackService.getFeedbackCount()).toBe(1);

    const feedback = feedbackService.getFeedbackForTransaction(transaction.id)[0];
    expect(feedback.decision.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(feedback.decision.predicted_recovery_probability).toBeNull();
    expect(feedback.decision.model_version).toBeNull();
    expect(feedback.execution.actual_recovery_success).toBe(true);
  });

  // 3. Feedback does NOT infer the source from action.reason
  test('3. Feedback does not infer decision source from human-readable text in action.reason', () => {
    const auditService = new RecoveryDecisionAuditService();
    // Record an audit record where reason is a plain string, but decision_source is explicitly ML
    auditService.record({
      decision: {
        selected_action: RecoveryActionType.RETRY,
        decision_source: DECISION_SOURCES.ML,
        recovery_probability: 0.91,
        model_version: 'custom-ml-v2',
        reason: 'Custom plain text reason with no ML prefix',
        candidate_predictions: [
          { candidate_action_type: 'RETRY', recovery_probability: 0.91, model_version: 'custom-ml-v2' }
        ]
      },
      context: baseContext,
      correlation: {
        transaction_id: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
        attempt_id: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
        recovery_action_id: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401'
      }
    });

    const feedbackService = new RecoveryFeedbackService({ auditService });
    const record = feedbackService.recordFeedback({
      transactionId: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
      recoveryActionId: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      triggerAttemptId: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      executionOutcome: FEEDBACK_OUTCOMES.SUCCESS
    });

    expect(record.decision.decision_source).toBe(DECISION_SOURCES.ML);
    expect(record.decision.predicted_recovery_probability).toBe(0.91);
    expect(record.decision.model_version).toBe('custom-ml-v2');
  });

  // 4. Feedback corresponds to the exact executed recovery action
  test('4. Feedback corresponds to the exact executed recovery action and its outcome', async () => {
    const { app, feedbackService, transaction } = buildMockAppEnv();

    const attemptRes = await request(app)
      .post(`/api/transactions/${transaction.id}/attempts`)
      .send({ paymentMethod: 'CARD', outcome: 'FAILED', failureCategory: 'PAYMENT_METHOD_FAILURE', failureReason: 'Card expired' });

    const recoveryActionId = attemptRes.body.data.recoveryAction.id;

    await request(app)
      .post(`/api/transactions/${transaction.id}/recovery/execute`)
      .send({ recoveryActionId, paymentMethod: 'UPI', providerOutcome: 'SUCCESS' });

    const feedback = feedbackService.getFeedbackForTransaction(transaction.id)[0];
    expect(feedback.correlation.recovery_action_id).toBe(recoveryActionId);
    expect(feedback.decision.selected_action).toBe(RecoveryActionType.ALTERNATE_METHOD);
  });

  // 5. Feedback-service failure does not affect recovery execution
  test('5. Feedback service failure does not cause the execution request to fail', async () => {
    const testValidActionUuid = 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401';
    const testValidAttemptUuid = 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401';
    const mockFeedbackService = {
      recordFeedback: jest.fn(() => {
        throw new Error('Feedback storage failure');
      })
    };

    const mockExecutionService = {
      execute: jest.fn(async () => ({
        attempt: { id: testValidAttemptUuid, status: 'SUCCESS' },
        recoveryAction: { id: testValidActionUuid, attemptId: testValidAttemptUuid, actionType: 'RETRY', status: 'SUCCESS', reason: 'ML selected RETRY' }
      }))
    };

    const controller = new TransactionController(null, mockExecutionService, mockFeedbackService);

    const req = { params: { transactionId: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a' }, body: { recoveryActionId: testValidActionUuid, providerOutcome: 'SUCCESS' } };
    const res = {
      statusCode: null,
      jsonData: null,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.jsonData = data; return this; }
    };

    await controller.executeRecovery(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonData.data.recoveryAction.status).toBe('SUCCESS');
    expect(mockFeedbackService.recordFeedback).toHaveBeenCalled();
  });

  // 6. Non-payment EXECUTED actions produce actual_recovery_success: null
  test('6. Non-payment EXECUTED actions produce actual_recovery_success = null (tri-state semantics)', () => {
    const custFeedback = buildFeedbackRecord({
      transactionId: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
      attemptId: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      recoveryAction: RecoveryActionType.CUSTOMER_ACTION,
      decisionSource: DECISION_SOURCES.ML,
      predictedProbability: 0.35,
      modelVersion: INTERACTION_MODEL_VERSION,
      executionOutcome: FEEDBACK_OUTCOMES.EXECUTED,
      context: baseContext
    });
    expect(custFeedback.execution.execution_outcome).toBe(FEEDBACK_OUTCOMES.EXECUTED);
    expect(custFeedback.execution.actual_recovery_success).toBeNull();

    const escFeedback = buildFeedbackRecord({
      transactionId: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
      attemptId: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      recoveryAction: RecoveryActionType.ESCALATE,
      decisionSource: DECISION_SOURCES.RULE,
      executionOutcome: FEEDBACK_OUTCOMES.EXECUTED,
      context: baseContext
    });
    expect(escFeedback.execution.execution_outcome).toBe(FEEDBACK_OUTCOMES.EXECUTED);
    expect(escFeedback.execution.actual_recovery_success).toBeNull();
  });

  // 7. Existing Phase 1 behavior remains unchanged
  test('7. Existing Phase 1 recovery behavior and response shape remain intact', async () => {
    const { app, transaction } = buildMockAppEnv();

    const attemptRes = await request(app)
      .post(`/api/transactions/${transaction.id}/attempts`)
      .send({ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'Network timeout' });

    expect(attemptRes.status).toBe(201);
    expect(attemptRes.body.data.attempt).toMatchObject({ outcome: 'FAILED', paymentMethod: 'UPI' });
    expect(attemptRes.body.data.recoveryAction).toMatchObject({ actionType: 'RETRY', status: 'RECOMMENDED' });

    const execRes = await request(app)
      .post(`/api/transactions/${transaction.id}/recovery/execute`)
      .send({ recoveryActionId: attemptRes.body.data.recoveryAction.id, providerOutcome: 'SUCCESS' });

    expect(execRes.status).toBe(200);
    expect(execRes.body.data).toMatchObject({
      attempt: expect.objectContaining({ outcome: 'SUCCESS', paymentMethod: 'UPI' }),
      recoveryAction: expect.objectContaining({ actionType: 'RETRY', status: 'SUCCESS' })
    });
  });

  // 8. ML prediction probability remains independent from actual outcome
  test('8. Preserves high predicted probability when actual outcome is failure (semantic invariant)', () => {
    const feedback = buildFeedbackRecord({
      transactionId: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
      attemptId: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7401',
      recoveryAction: RecoveryActionType.RETRY,
      decisionSource: DECISION_SOURCES.ML,
      predictedProbability: 0.95,
      modelVersion: INTERACTION_MODEL_VERSION,
      executionOutcome: FEEDBACK_OUTCOMES.FAILED,
      context: baseContext
    });

    expect(feedback.decision.predicted_recovery_probability).toBe(0.95);
    expect(feedback.execution.actual_recovery_success).toBe(false);
    expect(feedback.decision.predicted_recovery_probability).not.toEqual(feedback.execution.actual_recovery_success);
  });

  // 9. Rejects feedback creation before an actual execution outcome exists
  test('9. Rejects feedback creation before an actual execution outcome exists (e.g. RECOMMENDED)', () => {
    expect(() => {
      buildFeedbackRecord({
        auditRecord: sampleAuditRecord,
        executionResult: {
          recoveryAction: { id: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401', actionType: 'RETRY', status: 'RECOMMENDED' },
          attempt: null
        }
      });
    }).toThrow(/Execution outcome is required and must be a terminal outcome/);
  });

  // 10. Duplicate feedback recording remains idempotent
  test('10. Duplicate feedback recording remains idempotent', () => {
    const service = new RecoveryFeedbackService();

    const input = {
      auditRecord: sampleAuditRecord,
      executionResult: {
        recoveryAction: { id: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401', actionType: 'RETRY', status: 'SUCCESS' },
        attempt: { id: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7402', status: 'SUCCESS' }
      }
    };

    const first = service.recordFeedback(input);
    const second = service.recordFeedback(input);

    expect(service.getFeedbackCount()).toBe(1);
    expect(first.feedback_id).toBe(second.feedback_id);
    expect(first).toBe(second);
  });

  // 11. Malformed/incomplete feedback input is rejected safely
  test.each([
    [null, 'Feedback parameters must be a non-null object'],
    [{}, 'transaction_id is required'],
    [{ transactionId: 'txn-1' }, 'attempt_id'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'INVALID_ACTION', executionOutcome: 'SUCCESS' }, 'Invalid or missing recovery_action'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'RETRY', decisionSource: 'INVALID_SOURCE', executionOutcome: 'SUCCESS' }, 'Invalid decision_source'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'RETRY', decisionSource: 'ML', predictedProbability: 1.5, executionOutcome: 'SUCCESS' }, 'predicted_recovery_probability must be a number between 0 and 1'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'RETRY', decisionSource: 'ML', predictedProbability: -0.1, executionOutcome: 'SUCCESS' }, 'predicted_recovery_probability must be a number between 0 and 1'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'RETRY', decisionSource: 'ML', executionOutcome: 'PENDING' }, 'Execution outcome is required and must be a terminal outcome'],
    [{ transactionId: 'txn-1', attemptId: 'att-1', recoveryAction: 'RETRY', executionOutcome: 'SUCCESS', actualRecoverySuccess: 'not-a-bool' }, 'actual_recovery_success must be a boolean']
  ])('11. Rejects malformed input safely: %s', (invalidInput, expectedError) => {
    expect(() => buildFeedbackRecord(invalidInput)).toThrow(new RegExp(expectedError, 'i'));
  });

  // 12. Transforms feedback records into standard dataset rows
  test('12. Converts feedback records to standard dataset rows matching Phase 2 schema', () => {
    const feedback = buildFeedbackRecord({
      auditRecord: sampleAuditRecord,
      executionResult: {
        recoveryAction: { id: 'a4c23c30-99e8-4d89-9e12-5a3cbd7c7401', actionType: 'RETRY', status: 'SUCCESS', createdAt: '2026-09-01T10:05:00.000Z' },
        attempt: { id: 'd4c23c30-99e8-4d89-9e12-5a3cbd7c7402', status: 'SUCCESS', createdAt: '2026-09-01T10:05:00.000Z' }
      }
    });

    const datasetRow = feedbackRecordToDatasetRow(feedback);

    expect(datasetRow.record_id).toMatch(/^fb_row_/);
    expect(datasetRow.decision_id).toBe(feedback.feedback_id);
    expect(datasetRow.transaction_id).toBe('c4c23c30-99e8-4d89-9e12-5a3cbd7c740a');
    expect(datasetRow.attempt_id).toBe('d4c23c30-99e8-4d89-9e12-5a3cbd7c7401');
    expect(datasetRow.transaction_amount).toBe(4500);
    expect(datasetRow.currency).toBe('INR');
    expect(datasetRow.payment_method).toBe('UPI');
    expect(datasetRow.failure_category).toBe('TEMPORARY_FAILURE');
    expect(datasetRow.failure_reason_present).toBe(true);
    expect(datasetRow.candidate_action).toBe('RETRY');
    expect(datasetRow.selected_action).toBe('RETRY');
    expect(datasetRow.action_executed).toBe(true);
    expect(datasetRow.recovery_success).toBe(1);
    expect(datasetRow.recovery_outcome).toBe('SUCCESS');
    expect(datasetRow.dataset_version).toBe(DATASET_VERSION);
    expect(datasetRow.schema_version).toBe(SCHEMA_VERSION);
  });
});
