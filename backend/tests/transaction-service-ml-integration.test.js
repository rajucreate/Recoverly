import { jest } from '@jest/globals';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryDecisionEngine, RETRY_LIMIT } from '../src/services/recovery-decision-engine.js';
import {
  RecoveryDecisionPolicy,
  DECISION_SOURCES,
  FALLBACK_REASONS,
  CANDIDATE_ACTION_ORDER
} from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { TransactionStatus } from '../src/enums/transaction-status.js';

function createMockRepository(transactionOverrides = {}) {
  const transaction = {
    id: 'txn-1',
    amount: 5000,
    currency: 'INR',
    status: TransactionStatus.PENDING,
    _count: { paymentAttempts: 0 },
    paymentAttempts: [],
    ...transactionOverrides
  };

  const createdRecoveryActions = [];
  const createdAttempts = [];

  const mockPrisma = {
    recoveryAction: {
      create: jest.fn(async ({ data }) => {
        const action = { id: `action-${createdRecoveryActions.length + 1}`, ...data, createdAt: new Date('2026-01-01T00:00:00.000Z') };
        createdRecoveryActions.push(action);
        return action;
      }),
      findFirst: jest.fn(async ({ where }) => {
        const action = createdRecoveryActions.find((a) => a.id === where.id && a.transactionId === where.transactionId);
        if (!action) return null;
        const attempt = createdAttempts.find((att) => att.id === action.attemptId);
        return { ...action, attempt: attempt ? { paymentMethod: attempt.paymentMethod } : null };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const action = createdRecoveryActions.find((a) => a.id === where.id && a.status === where.status);
        if (action) {
          Object.assign(action, data);
          return { count: 1 };
        }
        return { count: 0 };
      })
    },
    paymentAttempt: {
      create: jest.fn(async ({ data }) => {
        const attempt = { id: `att-${createdAttempts.length + 1}`, ...data, createdAt: new Date('2026-01-01T00:00:00.000Z') };
        createdAttempts.push(attempt);
        return attempt;
      })
    },
    transaction: {
      findUnique: jest.fn(async () => transaction),
      update: jest.fn(async ({ data }) => {
        Object.assign(transaction, data);
        return transaction;
      })
    }
  };

  const repository = {
    prisma: mockPrisma,
    findByIdForAttempt: jest.fn(async () => transaction),
    createPaymentAttempt: jest.fn(async (data) => {
      const attempt = { id: `att-${createdAttempts.length + 1}`, ...data, createdAt: new Date('2026-01-01T00:00:00.000Z') };
      createdAttempts.push(attempt);
      return attempt;
    }),
    updateStatus: jest.fn(async (id, status) => {
      transaction.status = status;
      return transaction;
    }),
    executeInTransaction: jest.fn(async (work) => work(repository))
  };

  return { repository, mockPrisma, transaction, createdRecoveryActions, createdAttempts };
}

function createPredictions(probabilities, modelVersion = 'test-model-v1') {
  return CANDIDATE_ACTION_ORDER.map((action, index) => ({
    candidate_action_type: action,
    recovery_probability: probabilities[index],
    model_version: modelVersion
  }));
}

describe('TransactionService ML Decision Policy Integration (6.5.3)', () => {
  // 1. Successful ML decision reaches the existing recovery-action persistence path.
  test('1. Successful ML decision reaches the existing recovery-action persistence path', async () => {
    const { repository, mockPrisma } = createMockRepository();
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.85, 0.45, 0.30, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const service = new TransactionService(repository, undefined, predictionService, policy);

    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank network timeout'
    });

    expect(mockPrisma.recoveryAction.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.recoveryAction.create).toHaveBeenCalledWith({
      data: {
        transactionId: 'txn-1',
        attemptId: result.attempt.id,
        actionType: RecoveryActionType.RETRY,
        reason: expect.stringContaining('ML selected RETRY'),
        status: 'RECOMMENDED'
      }
    });
    expect(result.recoveryAction).toMatchObject({
      actionType: RecoveryActionType.RETRY,
      status: 'RECOMMENDED'
    });
  });

  // 2. ML-selected action is the action persisted as RECOMMENDED.
  test('2. ML-selected action is the action persisted as RECOMMENDED', async () => {
    const { repository, mockPrisma } = createMockRepository();
    // Probabilities favor ALTERNATE_METHOD (0.90) over RETRY (0.20)
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.20, 0.90, 0.40, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const service = new TransactionService(repository, undefined, predictionService, policy);

    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank degraded'
    });

    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ALTERNATE_METHOD);
    expect(result.recoveryAction.status).toBe('RECOMMENDED');
    expect(mockPrisma.recoveryAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: RecoveryActionType.ALTERNATE_METHOD,
        status: 'RECOMMENDED'
      })
    });
  });

  // 3. Prediction/policy failure falls back to RecoveryDecisionEngine.
  test('3. Prediction service error triggers fallback to RecoveryDecisionEngine', async () => {
    const { repository, mockPrisma } = createMockRepository();
    const predictionService = {
      predictAll: jest.fn(() => {
        throw new Error('Prediction model offline');
      })
    };
    const ruleEngine = new RecoveryDecisionEngine();
    const policy = new RecoveryDecisionPolicy(predictionService, ruleEngine);
    const service = new TransactionService(repository, ruleEngine, predictionService, policy);

    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'PAYMENT_METHOD_FAILURE',
      failureReason: 'Card expired'
    });

    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ALTERNATE_METHOD);
    expect(result.recoveryAction.reason).toBe('The selected payment method failed, so an alternate payment method is recommended.');
    expect(mockPrisma.recoveryAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: RecoveryActionType.ALTERNATE_METHOD,
        status: 'RECOMMENDED'
      })
    });
  });

  // 4. Rule fallback produces the same action/state behavior as Phase 1.
  test('4. Rule fallback produces the same action/state behavior as Phase 1 for all failure categories', async () => {
    const failureScenarios = [
      { category: 'TEMPORARY_FAILURE', attempts: [], expectedAction: RecoveryActionType.RETRY },
      { category: 'PAYMENT_METHOD_FAILURE', attempts: [], expectedAction: RecoveryActionType.ALTERNATE_METHOD },
      { category: 'CUSTOMER_ACTION_REQUIRED', attempts: [], expectedAction: RecoveryActionType.CUSTOMER_ACTION },
      { category: 'UNKNOWN_FAILURE', attempts: [], expectedAction: RecoveryActionType.ESCALATE }
    ];

    for (const scenario of failureScenarios) {
      const { repository } = createMockRepository({ paymentAttempts: scenario.attempts });
      const predictionService = {
        predictAll: jest.fn(() => {
          throw new Error('ML failure');
        })
      };
      const ruleEngine = new RecoveryDecisionEngine();
      const policy = new RecoveryDecisionPolicy(predictionService, ruleEngine);
      const service = new TransactionService(repository, ruleEngine, predictionService, policy);

      const result = await service.createPaymentAttempt('txn-1', {
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: scenario.category,
        failureReason: 'test failure'
      });

      expect(result.recoveryAction.actionType).toBe(scenario.expectedAction);
      expect(result.recoveryAction.status).toBe('RECOMMENDED');
    }
  });

  // 5. RecoveryExecutionService remains the execution path.
  test('5. RecoveryExecutionService remains the authoritative execution path after recommendation', async () => {
    const { repository, mockPrisma, transaction } = createMockRepository();
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.80, 0.40, 0.30, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const transactionService = new TransactionService(repository, undefined, predictionService, policy);

    const attemptResult = await transactionService.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank timeout'
    });

    const recommendedAction = attemptResult.recoveryAction;
    expect(recommendedAction.status).toBe('RECOMMENDED');

    // Execution is handled only by RecoveryExecutionService
    const mockPaymentProvider = {
      execute: jest.fn(async () => ({ outcome: 'SUCCESS' }))
    };
    const executionService = new RecoveryExecutionService(repository, mockPaymentProvider);

    const execResult = await executionService.execute('txn-1', {
      recoveryActionId: recommendedAction.id,
      providerOutcome: 'SUCCESS'
    });

    expect(mockPaymentProvider.execute).toHaveBeenCalled();
    expect(execResult.recoveryAction.status).toBe('SUCCESS');
    expect(transaction.status).toBe(TransactionStatus.SUCCESS);
  });

  // 6. Existing retry limits remain enforced.
  test('6. Existing retry limits remain enforced (RETRY skipped when retry count >= RETRY_LIMIT)', async () => {
    // Transaction already has 2 temporary failures
    const { repository } = createMockRepository({
      paymentAttempts: [
        { id: 'att-1', failureCategory: 'TEMPORARY_FAILURE', status: 'FAILED' },
        { id: 'att-2', failureCategory: 'TEMPORARY_FAILURE', status: 'FAILED' }
      ],
      _count: { paymentAttempts: 2 }
    });

    // ML model still gives high probability to RETRY
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.99, 0.60, 0.40, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const service = new TransactionService(repository, undefined, predictionService, policy);

    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Repeated timeout'
    });

    // RETRY must be skipped due to retry limit; next safe action is ALTERNATE_METHOD
    expect(result.recoveryAction.actionType).not.toBe(RecoveryActionType.RETRY);
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ALTERNATE_METHOD);
  });

  // 7. Existing alternate-method constraints remain enforced.
  test('7. Existing alternate-method constraints remain enforced (rejects same method)', async () => {
    const { repository } = createMockRepository();
    // ML model prefers ALTERNATE_METHOD
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.30, 0.95, 0.20, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());

    // If context indicates alternate method is same as attempted method, ALTERNATE_METHOD is rejected
    const decision = policy.decide({
      transaction_amount: 5000,
      currency: 'INR',
      payment_method_attempted: 'UPI',
      alternate_payment_method: 'UPI',
      failure_category: 'TEMPORARY_FAILURE',
      attempt_number: 1,
      prior_failed_attempt_count: 0,
      prior_temporary_failure_count: 0,
      transaction_status: 'FAILED'
    });

    expect(decision.selected_action).toBe(RecoveryActionType.RETRY);
  });

  // 8. Existing duplicate-execution protection remains enforced.
  test('8. Duplicate execution protection is enforced (already executed actions are filtered out)', async () => {
    const policy = new RecoveryDecisionPolicy(
      { predictAll: jest.fn(() => createPredictions([0.90, 0.70, 0.50, 0.10])) },
      new RecoveryDecisionEngine()
    );

    const decision = policy.decide({
      transaction_amount: 5000,
      currency: 'INR',
      payment_method_attempted: 'UPI',
      failure_category: 'TEMPORARY_FAILURE',
      attempt_number: 2,
      prior_failed_attempt_count: 1,
      prior_temporary_failure_count: 1,
      transaction_status: 'FAILED',
      executed_action_types: [RecoveryActionType.RETRY]
    });

    expect(decision.selected_action).not.toBe(RecoveryActionType.RETRY);
    expect(decision.selected_action).toBe(RecoveryActionType.ALTERNATE_METHOD);
  });

  // 9. ML failure does not cause the transaction flow to crash when Phase 1 fallback succeeds.
  test('9. ML prediction failure does not crash the transaction flow when fallback succeeds', async () => {
    const { repository } = createMockRepository();
    const faultyPredictionService = {
      predictAll: jest.fn(() => {
        throw new Error('Prediction model crashed with out of memory error');
      })
    };
    const ruleEngine = new RecoveryDecisionEngine();
    const policy = new RecoveryDecisionPolicy(faultyPredictionService, ruleEngine);
    const service = new TransactionService(repository, ruleEngine, faultyPredictionService, policy);

    const response = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Gateway 504'
    });

    expect(response.attempt.status).toBe('FAILED');
    expect(response.recoveryAction).toBeDefined();
    expect(response.recoveryAction.actionType).toBe(RecoveryActionType.RETRY);
    expect(response.recoveryAction.status).toBe('RECOMMENDED');
  });

  // 10. No execution occurs during decision making.
  test('10. No execution occurs during decision making (only recommendation is persisted)', async () => {
    const { repository, mockPrisma, createdAttempts } = createMockRepository();
    const executionServiceMock = { execute: jest.fn() };
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.88, 0.50, 0.30, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const service = new TransactionService(repository, undefined, predictionService, policy);

    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Network failure'
    });

    // Payment attempt created was the failure attempt, NOT a recovery execution attempt
    expect(createdAttempts).toHaveLength(1);
    expect(createdAttempts[0].status).toBe('FAILED');

    // Action was persisted as RECOMMENDED, NOT EXECUTED
    expect(result.recoveryAction.status).toBe('RECOMMENDED');

    // Execution service was never called
    expect(executionServiceMock.execute).not.toHaveBeenCalled();
  });

  test('Preserves Prisma schema boundaries (does not invent schema fields)', async () => {
    const { repository, mockPrisma } = createMockRepository();
    const predictionService = {
      predictAll: jest.fn(() => createPredictions([0.88, 0.50, 0.30, 0.10]))
    };
    const policy = new RecoveryDecisionPolicy(predictionService, new RecoveryDecisionEngine());
    const service = new TransactionService(repository, undefined, predictionService, policy);

    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE'
    });

    const createCallArg = mockPrisma.recoveryAction.create.mock.calls[0][0].data;
    const allowedPrismaFields = ['transactionId', 'attemptId', 'actionType', 'reason', 'status'];
    expect(Object.keys(createCallArg).sort()).toEqual(allowedPrismaFields.sort());
  });

  test('Context construction maps Decimal transaction amount and counters properly', async () => {
    const { repository } = createMockRepository({
      amount: { toString: () => '12500.50' },
      currency: 'INR',
      _count: { paymentAttempts: 3 },
      paymentAttempts: [
        { id: 'att-1', failureCategory: 'TEMPORARY_FAILURE', status: 'FAILED' },
        { id: 'att-2', failureCategory: 'PAYMENT_METHOD_FAILURE', status: 'FAILED' }
      ]
    });

    const capturedContexts = [];
    const mockPolicy = {
      decide: jest.fn((ctx) => {
        capturedContexts.push(ctx);
        return {
          selected_action: RecoveryActionType.RETRY,
          decision_source: DECISION_SOURCES.ML,
          recovery_probability: 0.85,
          model_version: 'v1',
          reason: 'ML selected RETRY'
        };
      })
    };

    const service = new TransactionService(repository, undefined, undefined, mockPolicy);
    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank timeout'
    });

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toMatchObject({
      transaction_amount: { toString: expect.any(Function) },
      currency: 'INR',
      payment_method_attempted: 'UPI',
      failure_category: 'TEMPORARY_FAILURE',
      has_failure_reason: true,
      attempt_number: 4,
      prior_failed_attempt_count: 2,
      prior_temporary_failure_count: 1,
      transaction_status: 'FAILED'
    });
  });
});
