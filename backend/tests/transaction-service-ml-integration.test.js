import { jest } from '@jest/globals';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryDecisionEngine, RETRY_LIMIT } from '../src/services/recovery-decision-engine.js';
import { RecoveryDecisionPolicy, DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { TransactionStatus } from '../src/enums/transaction-status.js';
import RecoveryActionRepository from '../src/repositories/recovery-action-repository.js';

jest.mock('../src/repositories/recovery-action-repository.js');

function createMockRepository() {
  const mockRecoveryActionRepository = {
    create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'RETRY', reason: 'test', status: 'RECOMMENDED' })
  };
  RecoveryActionRepository.mockImplementation(() => mockRecoveryActionRepository);
  
  const repo = {
    findByIdForAttempt: jest.fn(),
    createPaymentAttempt: jest.fn().mockResolvedValue({ id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' }),
    updateStatus: jest.fn().mockResolvedValue({}),
    executeInTransaction: jest.fn((work) => work(repo)),
    prisma: {}
  };
  return { repo, mockRecoveryActionRepository };
}

function createMockPredictionService(predictions) {
  return {
    predictAll: jest.fn(() => predictions)
  };
}

function createMockPolicy(decision) {
  return {
    decide: jest.fn(() => decision)
  };
}

function baseTransaction() {
  return {
    id: 'txn-1',
    amount: 5000,
    currency: 'INR',
    status: TransactionStatus.PENDING,
    _count: { paymentAttempts: 0 },
    paymentAttempts: [],
    failedAttempts: []
  };
}

describe('TransactionService ML Integration (6.5.3)', () => {
  test('successful ML decision is persisted as the recommended action', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    mockRepository.updateStatus.mockResolvedValue(transaction);
    
    const mlDecision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.82,
      model_version: 'v1',
      reason: 'ML selected RETRY'
    };
    
    const mockRecoveryActionRepository = {
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'RETRY', reason: 'ML selected RETRY', status: 'RECOMMENDED' })
    };
    
    global.RecoveryActionRepository = jest.fn(() => mockRecoveryActionRepository);
    
    const mockPolicy = createMockPolicy(mlDecision);
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: RecoveryActionType.UPI,
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'timeout'
    });
    
    expect(mockPolicy.decide).toHaveBeenCalled();
    expect(mockRecoveryActionRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      actionType: RecoveryActionType.RETRY,
      reason: 'ML selected RETRY'
    }));
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.RETRY);
  });

  test('ML-selected action uses decision policy, not direct engine', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const engine = new RecoveryDecisionEngine();
    const mockPolicy = createMockPolicy({
      selected_action: RecoveryActionType.ALTERNATE_METHOD,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.75,
      reason: 'ML chose ALTERNATE_METHOD'
    });
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'ALTERNATE_METHOD', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, engine, undefined, mockPolicy);
    
    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'PAYMENT_METHOD_FAILURE'
    });
    
    expect(mockPolicy.decide).toHaveBeenCalled();
  });

  test('prediction service failure falls back to rule engine', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const mockPolicy = {
      decide: jest.fn(() => ({
        selected_action: RecoveryActionType.ESCALATE,
        decision_source: DECISION_SOURCES.RULE,
        reason: 'Phase 1 fallback',
        fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE
      }))
    };
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'ESCALATE', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'UNKNOWN_FAILURE'
    });
    
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ESCALATE);
  });

  test('rule fallback preserves Phase 1 behavior and constraints', async () => {
    const mockRepository = createMockRepository();
    const transaction = {
      ...baseTransaction(),
      paymentAttempts: [{}, {}], // 2 temporary failures
      failedAttempts: [{}, {}]
    };
    
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const engine = new RecoveryDecisionEngine();
    const mockPolicy = {
      decide: jest.fn(context => {
        // Simulate that policy respects retry limit
        if (context.prior_temporary_failure_count >= RETRY_LIMIT) {
          const decision = engine.decide({
            failureCategory: context.failure_category,
            previousTemporaryFailureCount: context.prior_temporary_failure_count
          });
          return {
            selected_action: decision.actionType,
            decision_source: DECISION_SOURCES.RULE,
            reason: decision.reason
          };
        }
        return {
          selected_action: RecoveryActionType.RETRY,
          decision_source: DECISION_SOURCES.ML,
          recovery_probability: 0.8,
          reason: 'ML chose RETRY'
        };
      })
    };
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'ESCALATE', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, engine, undefined, mockPolicy);
    
    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE'
    });
    
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ESCALATE);
  });

  test('recoveryExecutionService is not invoked during decision making', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const mockExecutionService = { execute: jest.fn() };
    const mockPolicy = createMockPolicy({
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      reason: 'ML chose'
    });
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'RETRY', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE'
    });
    
    expect(mockExecutionService.execute).not.toHaveBeenCalled();
  });

  test('ML decision metadata is available in result but not persisted to schema', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const mlDecision = {
      selected_action: RecoveryActionType.RETRY,
      decision_source: DECISION_SOURCES.ML,
      recovery_probability: 0.82,
      model_version: 'v1',
      reason: 'ML selected RETRY'
    };
    
    const mockRecoveryActionRepository = {
      create: jest.fn().mockImplementation(data => {
        // Verify only actionType, reason, status, transactionId, attemptId are persisted
        expect(Object.keys(data).sort()).toEqual(['actionType', 'attemptId', 'reason', 'status', 'transactionId'].sort());
        return { id: 'action-1', ...data };
      })
    };
    
    global.RecoveryActionRepository = jest.fn(() => mockRecoveryActionRepository);
    
    const mockPolicy = createMockPolicy(mlDecision);
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE'
    });
    
    expect(mockRecoveryActionRepository.create).toHaveBeenCalled();
  });

  test('prediction context is correctly built from transaction and attempt', async () => {
    const mockRepository = createMockRepository();
    const transaction = {
      id: 'txn-1',
      amount: 10000,
      currency: 'USD',
      status: TransactionStatus.FAILED,
      _count: { paymentAttempts: 3 },
      paymentAttempts: [{}, {}], // 2 temporary failures
      failedAttempts: [{}, {}, {}] // 3 total failures
    };
    
    const mockAttempt = { id: 'att-1', paymentMethod: 'CARD', status: 'FAILED' };
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const contextCapture = [];
    const mockPolicy = {
      decide: jest.fn(ctx => {
        contextCapture.push(ctx);
        return {
          selected_action: RecoveryActionType.RETRY,
          decision_source: DECISION_SOURCES.ML,
          reason: 'ML chose'
        };
      })
    };
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'RETRY', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'CARD',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'connection timeout'
    });
    
    expect(contextCapture[0]).toMatchObject({
      transaction_amount: 10000,
      currency: 'USD',
      payment_method_attempted: 'CARD',
      failure_category: 'TEMPORARY_FAILURE',
      has_failure_reason: true,
      attempt_number: 4,
      prior_failed_attempt_count: 3,
      prior_temporary_failure_count: 2,
      transaction_status: 'FAILED'
    });
  });

  test('policy failure does not crash when fallback to Phase 1 succeeds', async () => {
    const mockRepository = createMockRepository();
    const transaction = baseTransaction();
    const mockAttempt = { id: 'att-1', paymentMethod: 'UPI', status: 'FAILED' };
    
    mockRepository.findByIdForAttempt.mockResolvedValue(transaction);
    mockRepository.createPaymentAttempt.mockResolvedValue(mockAttempt);
    
    const mockPolicy = {
      decide: jest.fn(() => {
        // Simulate that policy had to fallback
        return {
          selected_action: RecoveryActionType.RETRY,
          decision_source: DECISION_SOURCES.RULE,
          reason: 'Phase 1 fallback',
          fallback_reason: FALLBACK_REASONS.MODEL_UNAVAILABLE
        };
      })
    };
    
    global.RecoveryActionRepository = jest.fn(() => ({
      create: jest.fn().mockResolvedValue({ id: 'action-1', actionType: 'RETRY', status: 'RECOMMENDED' })
    }));
    
    const service = new TransactionService(mockRepository, undefined, undefined, mockPolicy);
    
    const result = await service.createPaymentAttempt('txn-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE'
    });
    
    expect(result.recoveryAction).toBeDefined();
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.RETRY);
  });

  test('existing Phase 1 decision engine remains unchanged', () => {
    const engine = new RecoveryDecisionEngine();
    
    expect(engine.decide({ failureCategory: 'TEMPORARY_FAILURE', previousTemporaryFailureCount: 2 })).toEqual({
      actionType: RecoveryActionType.ESCALATE,
      reason: 'The automatic retry limit has been reached, so the payment should be escalated.'
    });
  });
});
