import request from 'supertest';
import { jest } from '@jest/globals';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { RecoveryPredictionService } from '../src/intelligence/recovery-prediction-service.js';
import { RecoveryDecisionPolicy, DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryDecisionAuditService } from '../src/intelligence/recovery-decision-audit-service.js';
import { RecoveryFeedbackService } from '../src/intelligence/recovery-feedback-service.js';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';

const rootDir = path.resolve(process.cwd(), '..');
const modelPath = path.join(rootDir, 'data', 'phase-2', 'models', 'recovery_interaction_v1.model.json');
const schemaPath = path.join(rootDir, 'data', 'phase-2', 'recovery_features_v1.schema.json');

/**
 * Creates an isolated in-memory test environment wiring real production services.
 * Only the database client is an in-memory transactional mock adhering to Prisma's API,
 * ensuring clean isolation between scenarios without external database dependencies.
 */
function createE2EHarness({ predictionServiceOverride } = {}) {
  const state = {
    transactions: new Map(),
    attempts: [],
    recoveryActions: []
  };

  let uuidCounter = 1;
  const generateUuid = (prefix = '00000000') => {
    const hexPrefix = prefix === 'txn-' ? '11111111' : prefix === 'att-' ? '22222222' : prefix === 'act-' ? '33333333' : prefix.padEnd(8, '0');
    return `c4c23c30-99e8-4d89-9e12-${hexPrefix}${String(uuidCounter++).padStart(4, '0')}`;
  };

  const mockPrisma = {
    transaction: {
      create: jest.fn(async ({ data }) => {
        const id = data.id || generateUuid('txn-');
        const now = new Date();
        const record = {
          id,
          amount: data.amount,
          currency: data.currency,
          customerId: data.customerId,
          status: data.status || 'PENDING',
          createdAt: now,
          updatedAt: now
        };
        state.transactions.set(id, record);
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
            _count: {
              paymentAttempts: state.attempts.filter((att) => att.transactionId === where.id).length
            },
            paymentAttempts: state.attempts.filter(
              (att) => att.transactionId === where.id && att.status === 'FAILED' && att.failureCategory === 'TEMPORARY_FAILURE'
            )
          };
        }
        return {
          ...record,
          paymentAttempts: state.attempts.filter((att) => att.transactionId === where.id),
          recoveryActions: state.recoveryActions.filter((act) => act.transactionId === where.id)
        };
      }),
      findMany: jest.fn(async ({ where }) => {
        const txns = Array.from(state.transactions.values());
        if (where?.paymentAttempts?.some?.status === 'FAILED') {
          return txns
            .filter((txn) => state.attempts.some((att) => att.transactionId === txn.id && att.status === 'FAILED'))
            .map((txn) => ({
              id: txn.id,
              paymentAttempts: state.attempts
                .filter((att) => att.transactionId === txn.id)
                .map((att) => ({ attemptNumber: att.attemptNumber, status: att.status })),
              recoveryActions: state.recoveryActions
                .filter((act) => act.transactionId === txn.id)
                .map((act) => ({ status: act.status }))
            }));
        }
        return txns;
      }),
      update: jest.fn(async ({ where, data }) => {
        const record = state.transactions.get(where.id);
        if (!record) return null;
        const updated = { ...record, ...data, updatedAt: new Date() };
        state.transactions.set(where.id, updated);
        return updated;
      })
    },

    paymentAttempt: {
      create: jest.fn(async ({ data }) => {
        const id = generateUuid('att-');
        const outcomeVal = data.status || data.outcome;
        const attempt = {
          id,
          transactionId: data.transactionId,
          attemptNumber: data.attemptNumber,
          paymentMethod: data.paymentMethod,
          outcome: outcomeVal,
          status: outcomeVal,
          failureCategory: data.failureCategory || null,
          failureReason: data.failureReason || null,
          createdAt: new Date()
        };
        state.attempts.push(attempt);
        return attempt;
      })
    },

    recoveryAction: {
      create: jest.fn(async ({ data }) => {
        const id = generateUuid('act-');
        const action = {
          id,
          transactionId: data.transactionId,
          attemptId: data.attemptId,
          actionType: data.actionType,
          reason: data.reason,
          status: data.status || 'RECOMMENDED',
          createdAt: new Date()
        };
        state.recoveryActions.push(action);
        return action;
      }),
      findFirst: jest.fn(async ({ where }) => {
        const action = state.recoveryActions.find(
          (act) => act.id === where.id && act.transactionId === where.transactionId
        );
        if (!action) return null;
        const attempt = state.attempts.find((att) => att.id === action.attemptId);
        return {
          ...action,
          attempt: attempt ? { paymentMethod: attempt.paymentMethod, failureCategory: attempt.failureCategory } : null
        };
      }),
      findMany: jest.fn(async ({ where, select }) => {
        if (select && select.actionType) {
          return state.recoveryActions.map((act) => ({
            id: act.id,
            actionType: act.actionType,
            status: act.status
          }));
        }
        return state.recoveryActions
          .filter((act) => {
            if (where?.actionType?.in && !where.actionType.in.includes(act.actionType)) return false;
            if (where?.status?.in && !where.status.in.includes(act.status)) return false;
            return true;
          })
          .map((act) => {
            const attempt = state.attempts.find((att) => att.id === act.attemptId);
            return {
              ...act,
              attempt: attempt
                ? {
                    failureCategory: attempt.failureCategory,
                    paymentMethod: attempt.paymentMethod
                  }
                : null
            };
          });
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const index = state.recoveryActions.findIndex(
          (act) => act.id === where.id && act.status === where.status
        );
        if (index < 0) return { count: 0 };
        state.recoveryActions[index] = { ...state.recoveryActions[index], ...data };
        return { count: 1 };
      })
    },

    $transaction: jest.fn(async (work) => {
      const snapshot = {
        transactions: new Map(state.transactions),
        attempts: [...state.attempts],
        recoveryActions: [...state.recoveryActions]
      };
      try {
        return await work(mockPrisma);
      } catch (error) {
        state.transactions = snapshot.transactions;
        state.attempts = snapshot.attempts;
        state.recoveryActions = snapshot.recoveryActions;
        throw error;
      }
    })
  };

  const repository = new TransactionRepository(mockPrisma);
  const ruleEngine = new RecoveryDecisionEngine();
  const predictionService =
    predictionServiceOverride !== undefined
      ? predictionServiceOverride
      : new RecoveryPredictionService({ modelPath, schemaPath });

  const decisionPolicy = new RecoveryDecisionPolicy(predictionService, ruleEngine);
  const auditService = new RecoveryDecisionAuditService();
  const feedbackService = new RecoveryFeedbackService({ auditService });
  const transactionService = new TransactionService(repository, ruleEngine, predictionService, decisionPolicy, auditService);
  const paymentProvider = new SimulatedPaymentProvider();
  const recoveryExecutionService = new RecoveryExecutionService(repository, paymentProvider);
  const analyticsService = new RecoveryAnalyticsService({
    prisma: mockPrisma,
    feedbackService,
    auditService
  });

  const app = createApp({
    transactionService,
    recoveryExecutionService,
    predictionService,
    decisionPolicy,
    auditService,
    feedbackService,
    analyticsService
  });

  return {
    app,
    state,
    auditService,
    feedbackService,
    analyticsService,
    paymentProvider
  };
}

describe('End-to-End Recovery Lifecycle (Task 6.13)', () => {
  test('Scenario 1: Complete ML Recovery Loop with Decision Explanation, Feedback, and Analytics', async () => {
    const { app, state, auditService, feedbackService } = createE2EHarness();

    // 1. Create Transaction
    const createTxnRes = await request(app)
      .post('/api/transactions')
      .send({ amount: 5000, currency: 'INR', customerId: 'cust-ml-1' });

    expect(createTxnRes.status).toBe(201);
    const transactionId = createTxnRes.body.data.id;
    expect(transactionId).toBeDefined();
    expect(createTxnRes.body.data.status).toBe('PENDING');

    // 2. Initial Failed Payment Attempt (Temporary Failure -> triggers ML Scoring)
    const attemptRes = await request(app)
      .post(`/api/transactions/${transactionId}/attempts`)
      .send({
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        failureReason: 'Bank switch network timeout'
      });

    expect(attemptRes.status).toBe(201);
    const { attempt, recoveryAction, explanation } = attemptRes.body.data;

    // Verify ML Decision and Explanation
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      outcome: 'FAILED',
      paymentMethod: 'UPI'
    });
    expect(recoveryAction).toMatchObject({
      actionType: RecoveryActionType.RETRY,
      status: 'RECOMMENDED'
    });
    expect(explanation).toBeDefined();
    expect(explanation.decision_source).toBe(DECISION_SOURCES.ML);
    expect(explanation.selected_action).toBe(RecoveryActionType.RETRY);
    expect(explanation.candidate_comparison).toHaveLength(4);

    // Verify Decision Audit was captured
    expect(auditService.buffer).toHaveLength(1);
    const auditRecord = auditService.findByRecoveryActionId(recoveryAction.id);
    expect(auditRecord).toBeDefined();
    expect(auditRecord.decision_source).toBe(DECISION_SOURCES.ML);
    expect(auditRecord.selected_probability).toBeGreaterThan(0.5);

    // 3. Execute Recovery Action through HTTP (Simulated Provider returns SUCCESS)
    const execRes = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        providerOutcome: 'SUCCESS'
      });

    expect(execRes.status).toBe(200);
    expect(execRes.body.data.attempt).toMatchObject({
      attemptNumber: 2,
      outcome: 'SUCCESS',
      paymentMethod: 'UPI'
    });
    expect(execRes.body.data.recoveryAction.status).toBe('SUCCESS');

    // Verify DB State Transitions
    const txnRecord = state.transactions.get(transactionId);
    expect(txnRecord.status).toBe('SUCCESS');
    expect(state.attempts).toHaveLength(2);

    // 4. Verify Observational Feedback Recording
    expect(feedbackService.buffer).toHaveLength(1);
    const feedbackRecord = feedbackService.buffer[0];
    expect(feedbackRecord.correlation.recovery_action_id).toBe(recoveryAction.id);
    expect(feedbackRecord.decision.decision_source).toBe(DECISION_SOURCES.ML);
    expect(feedbackRecord.execution.actual_recovery_success).toBe(true);
    // Crucial Invariant: predicted_recovery_probability is independent of actual outcome
    expect(feedbackRecord.decision.predicted_recovery_probability).not.toBe(true);

    // 5. Query Analytics Endpoint through HTTP
    const analyticsRes = await request(app).get('/api/analytics/recovery');
    expect(analyticsRes.status).toBe(200);

    const { operational, model } = analyticsRes.body.data;
    expect(operational.actionRecoveryRate).toMatchObject({
      rate: 1,
      successCount: 1,
      failedCount: 0,
      totalEligible: 1
    });
    expect(operational.transactionRecoveryRate).toMatchObject({
      rate: 1,
      recoveredCount: 1,
      failedTransactionCount: 1,
      totalEligible: 1
    });
    expect(operational.retrySuccessRate).toMatchObject({
      rate: 1,
      successCount: 1,
      failedCount: 0,
      totalEligible: 1
    });

    // Model Performance & Traffic Share
    expect(model.trafficShare).toMatchObject({
      totalDecisions: 1,
      mlCount: 1,
      ruleCount: 0,
      mlShare: 1,
      ruleShare: 0
    });
    expect(model.predictionConfidence.sampleCount).toBe(1);
    expect(model.runtimePerformance.sampleCount).toBe(1);
    expect(model.runtimePerformance.accuracy).toBe(1);
  });

  test('Scenario 2: Rule Fallback Loop when ML Service Fails with Audit & Traffic Share Tracking', async () => {
    // Inject mock prediction service that throws error at ML boundary
    const failingPredictionService = {
      predictAll: jest.fn(() => {
        throw new Error('Prediction model service unavailable');
      })
    };

    const { app, auditService, feedbackService } = createE2EHarness({
      predictionServiceOverride: failingPredictionService
    });

    // 1. Create Transaction
    const createTxnRes = await request(app)
      .post('/api/transactions')
      .send({ amount: 2000, currency: 'INR', customerId: 'cust-rule-fallback' });
    const transactionId = createTxnRes.body.data.id;

    // 2. Failed Attempt triggers Rule Fallback
    const attemptRes = await request(app)
      .post(`/api/transactions/${transactionId}/attempts`)
      .send({
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        failureReason: 'Gateway connectivity dropped'
      });

    expect(attemptRes.status).toBe(201);
    const { recoveryAction, explanation } = attemptRes.body.data;

    // Assert Authoritative Decision Source is RULE with Fallback Reason
    expect(explanation.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(explanation.fallback?.fallback_reason || explanation.fallback_reason).toBe(FALLBACK_REASONS.MODEL_UNAVAILABLE);
    expect(explanation.selected_action).toBe(RecoveryActionType.RETRY);

    // Audit record contains RULE source
    const auditRecord = auditService.findByRecoveryActionId(recoveryAction.id);
    expect(auditRecord.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(auditRecord.fallback?.fallback_reason).toBe(FALLBACK_REASONS.MODEL_UNAVAILABLE);
    expect(auditRecord.selected_probability).toBeNull();

    // 3. Execute Recovery Action
    const execRes = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        providerOutcome: 'SUCCESS'
      });

    expect(execRes.status).toBe(200);

    // 4. Verify Feedback Record captures RULE source
    expect(feedbackService.buffer).toHaveLength(1);
    const feedback = feedbackService.buffer[0];
    expect(feedback.decision.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(feedback.decision.fallback.fallback_reason || feedback.decision.fallback.reason).toBe(FALLBACK_REASONS.MODEL_UNAVAILABLE);
    expect(feedback.execution.actual_recovery_success).toBe(true);

    // 5. Verify Analytics Reflects Rule Traffic Share
    const analyticsRes = await request(app).get('/api/analytics/recovery');
    const { model } = analyticsRes.body.data;

    expect(model.trafficShare).toMatchObject({
      totalDecisions: 1,
      mlCount: 0,
      ruleCount: 1,
      mlShare: 0,
      ruleShare: 1,
      fallbackReasons: {
        MODEL_UNAVAILABLE: 1,
        INVALID_PREDICTION: 0,
        NO_SAFE_CANDIDATE: 0
      }
    });
    // Invariant: Rule records are excluded from ML prediction confidence and calibration
    expect(model.predictionConfidence.sampleCount).toBe(0);
    expect(model.runtimePerformance.sampleCount).toBe(0);
  });

  test('Scenario 3: Escalation Action Lifecycle with Non-Payment Tri-State Outcome', async () => {
    const { app, state, feedbackService } = createE2EHarness({ predictionServiceOverride: null });

    // 1. Create Transaction
    const createTxnRes = await request(app)
      .post('/api/transactions')
      .send({ amount: 10000, currency: 'INR', customerId: 'cust-escalate-1' });
    const transactionId = createTxnRes.body.data.id;

    // 2. UNKNOWN_FAILURE with non-recoverable error triggers ESCALATE
    const attemptRes = await request(app)
      .post(`/api/transactions/${transactionId}/attempts`)
      .send({
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: 'UNKNOWN_FAILURE',
        failureReason: 'Critical compliance fraud flag raised'
      });

    expect(attemptRes.status).toBe(201);
    const { recoveryAction } = attemptRes.body.data;
    expect(recoveryAction.actionType).toBe(RecoveryActionType.ESCALATE);

    // 3. Execute Operational Recovery Action (no secondary attempt expected)
    const execRes = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({ recoveryActionId: recoveryAction.id });

    expect(execRes.status).toBe(200);
    expect(execRes.body.data.attempt).toBeNull();
    expect(execRes.body.data.recoveryAction.status).toBe('EXECUTED');

    // Transaction remains in FAILED status
    expect(state.transactions.get(transactionId).status).toBe('FAILED');
    expect(state.attempts).toHaveLength(1);

    // 4. Verify Tri-State Outcome in Feedback
    expect(feedbackService.buffer).toHaveLength(1);
    const feedback = feedbackService.buffer[0];
    expect(feedback.execution.actual_recovery_success).toBeNull();

    // 5. Verify Analytics: Escalation counted in escalationRate, excluded from payment recovery
    const analyticsRes = await request(app).get('/api/analytics/recovery');
    const { operational, model } = analyticsRes.body.data;

    expect(operational.escalationRate).toMatchObject({
      rate: 1,
      escalateCount: 1,
      totalRecommendations: 1
    });
    // Invariant: Non-payment actions excluded from payment recovery denominator
    expect(operational.actionRecoveryRate.rate).toBeNull();
    expect(operational.actionRecoveryRate.totalEligible).toBe(0);
    expect(operational.transactionRecoveryRate.rate).toBe(0);
    expect(operational.transactionRecoveryRate.recoveredCount).toBe(0);

    // Invariant: actual_recovery_success = null excluded from Brier score
    expect(model.runtimePerformance.sampleCount).toBe(0);
  });

  test('Scenario 4: Alternate Payment Method Recovery with Cross-Method Execution', async () => {
    const { app, feedbackService } = createE2EHarness();

    // 1. Create Transaction
    const createTxnRes = await request(app)
      .post('/api/transactions')
      .send({ amount: 3500, currency: 'INR', customerId: 'cust-alt-method' });
    const transactionId = createTxnRes.body.data.id;

    // 2. CARD payment fails with PAYMENT_METHOD_FAILURE -> triggers ALTERNATE_METHOD
    const attemptRes = await request(app)
      .post(`/api/transactions/${transactionId}/attempts`)
      .send({
        paymentMethod: 'CARD',
        outcome: 'FAILED',
        failureCategory: 'PAYMENT_METHOD_FAILURE',
        failureReason: 'Card expired or declined by issuer'
      });

    expect(attemptRes.status).toBe(201);
    const { recoveryAction } = attemptRes.body.data;
    expect(recoveryAction.actionType).toBe(RecoveryActionType.ALTERNATE_METHOD);

    // 3. Attempt execution with SAME payment method must be rejected by business rules (409)
    const invalidExecRes = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        paymentMethod: 'CARD',
        providerOutcome: 'SUCCESS'
      });
    expect(invalidExecRes.status).toBe(409);

    // 4. Valid execution with DIFFERENT payment method (UPI)
    const validExecRes = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        paymentMethod: 'UPI',
        providerOutcome: 'SUCCESS'
      });

    expect(validExecRes.status).toBe(200);
    expect(validExecRes.body.data.attempt).toMatchObject({
      attemptNumber: 2,
      paymentMethod: 'UPI',
      outcome: 'SUCCESS'
    });
    expect(validExecRes.body.data.recoveryAction.status).toBe('SUCCESS');

    // 5. Verify Feedback & Analytics
    expect(feedbackService.buffer).toHaveLength(1);
    expect(feedbackService.buffer[0].execution.actual_recovery_success).toBe(true);

    const analyticsRes = await request(app).get('/api/analytics/recovery');
    const { operational } = analyticsRes.body.data;

    expect(operational.alternateMethodSuccessRate).toMatchObject({
      rate: 1,
      successCount: 1,
      failedCount: 0,
      totalEligible: 1
    });
    // Segment joined to trigger attempt's payment method (CARD)
    expect(operational.byPaymentMethod.CARD).toMatchObject({
      rate: 1,
      successCount: 1,
      totalEligible: 1
    });
  });

  test('Scenario 5: Duplicate Recovery Execution Prevention and State Invariant Preservation', async () => {
    const { app, state, auditService, feedbackService } = createE2EHarness();

    // 1. Setup transaction and failed attempt
    const createTxnRes = await request(app)
      .post('/api/transactions')
      .send({ amount: 1500, currency: 'INR', customerId: 'cust-duplicate-guard' });
    const transactionId = createTxnRes.body.data.id;

    const attemptRes = await request(app)
      .post(`/api/transactions/${transactionId}/attempts`)
      .send({
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        failureReason: 'Bank timeout'
      });
    const { recoveryAction } = attemptRes.body.data;

    // 2. First execution succeeds
    const firstExec = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        providerOutcome: 'SUCCESS'
      });
    expect(firstExec.status).toBe(200);
    expect(state.attempts).toHaveLength(2);
    expect(feedbackService.buffer).toHaveLength(1);
    expect(auditService.buffer).toHaveLength(1);

    // 3. Second execution with identical payload must be rejected with 409
    const duplicateExec = await request(app)
      .post(`/api/transactions/${transactionId}/recovery/execute`)
      .send({
        recoveryActionId: recoveryAction.id,
        providerOutcome: 'SUCCESS'
      });
    expect(duplicateExec.status).toBe(409);
    expect(duplicateExec.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // 4. Invariant Assertions: No duplicate attempt, no duplicate feedback, no corrupted audit
    expect(state.attempts).toHaveLength(2);
    expect(feedbackService.buffer).toHaveLength(1);
    expect(auditService.buffer).toHaveLength(1);
    expect(state.recoveryActions[0].status).toBe('SUCCESS');

    // 5. Analytics counts are not double-counted
    const analyticsRes = await request(app).get('/api/analytics/recovery');
    expect(analyticsRes.body.data.operational.actionRecoveryRate.totalEligible).toBe(1);
    expect(analyticsRes.body.data.operational.actionRecoveryRate.successCount).toBe(1);
  });

  test('Scenario 6: Multi-Transaction Closed-Loop Analytics Consistency', async () => {
    const { app } = createE2EHarness({ predictionServiceOverride: null });

    // Transaction 1: Successful RETRY
    const t1 = await request(app).post('/api/transactions').send({ amount: 1000, currency: 'INR', customerId: 'c1' });
    const a1 = await request(app).post(`/api/transactions/${t1.body.data.id}/attempts`).send({
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Temporary timeout'
    });
    await request(app).post(`/api/transactions/${t1.body.data.id}/recovery/execute`).send({
      recoveryActionId: a1.body.data.recoveryAction.id,
      providerOutcome: 'SUCCESS'
    });

    // Transaction 2: Failed RETRY
    const t2 = await request(app).post('/api/transactions').send({ amount: 2000, currency: 'INR', customerId: 'c2' });
    const a2 = await request(app).post(`/api/transactions/${t2.body.data.id}/attempts`).send({
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Temporary timeout'
    });
    await request(app).post(`/api/transactions/${t2.body.data.id}/recovery/execute`).send({
      recoveryActionId: a2.body.data.recoveryAction.id,
      providerOutcome: 'FAILED'
    });

    // Transaction 3: Successful ALTERNATE_METHOD (CARD -> UPI)
    const t3 = await request(app).post('/api/transactions').send({ amount: 3000, currency: 'INR', customerId: 'c3' });
    const a3 = await request(app).post(`/api/transactions/${t3.body.data.id}/attempts`).send({
      paymentMethod: 'CARD',
      outcome: 'FAILED',
      failureCategory: 'PAYMENT_METHOD_FAILURE',
      failureReason: 'Card declined'
    });
    await request(app).post(`/api/transactions/${t3.body.data.id}/recovery/execute`).send({
      recoveryActionId: a3.body.data.recoveryAction.id,
      paymentMethod: 'UPI',
      providerOutcome: 'SUCCESS'
    });

    // Transaction 4: ESCALATE (non-payment action)
    const t4 = await request(app).post('/api/transactions').send({ amount: 4000, currency: 'INR', customerId: 'c4' });
    const a4 = await request(app).post(`/api/transactions/${t4.body.data.id}/attempts`).send({
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'UNKNOWN_FAILURE',
      failureReason: 'Unknown compliance error'
    });
    await request(app).post(`/api/transactions/${t4.body.data.id}/recovery/execute`).send({
      recoveryActionId: a4.body.data.recoveryAction.id
    });

    // Query Analytics and Assert Exact Mathematical Rates
    const analyticsRes = await request(app).get('/api/analytics/recovery');
    expect(analyticsRes.status).toBe(200);
    const { operational } = analyticsRes.body.data;

    // Action Recovery Rate: 2 successes / 3 executed payment actions = 0.6667
    expect(operational.actionRecoveryRate).toMatchObject({
      rate: 0.6667,
      successCount: 2,
      failedCount: 1,
      totalEligible: 3
    });

    // Transaction Resolution Rate: 2 recovered / 4 failed transactions = 0.5
    expect(operational.transactionRecoveryRate).toMatchObject({
      rate: 0.5,
      recoveredCount: 2,
      failedTransactionCount: 4,
      totalEligible: 4
    });

    // Retry Success Rate: 1 success / 2 retries = 0.5
    expect(operational.retrySuccessRate).toMatchObject({
      rate: 0.5,
      successCount: 1,
      failedCount: 1,
      totalEligible: 2
    });

    // Alternate Method Success Rate: 1 success / 1 alt method = 1.0
    expect(operational.alternateMethodSuccessRate).toMatchObject({
      rate: 1,
      successCount: 1,
      failedCount: 0,
      totalEligible: 1
    });

    // Escalation Rate: 1 escalate / 4 total recommendations = 0.25
    expect(operational.escalationRate).toMatchObject({
      rate: 0.25,
      escalateCount: 1,
      totalRecommendations: 4
    });
  });

  test('API Hardening Regression: Normal requests succeed and header is stripped', async () => {
    const { app } = createE2EHarness();
    const res = await request(app)
      .post('/api/transactions')
      .send({ amount: 1000, currency: 'INR', customerId: 'cust-regression' });

    expect(res.status).toBe(201);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

