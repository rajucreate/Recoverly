import { jest } from '@jest/globals';
import { TransactionService } from '../src/services/transaction-service.js';
import { TransactionController } from '../src/controllers/transaction-controller.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';
import { TransactionStatus } from '../src/enums/transaction-status.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from '../src/intelligence/recovery-decision-policy.js';
import { INTERACTION_MODEL_VERSION } from '../src/intelligence/candidate-model-comparison.js';

function createMockRepository(transactionOverrides = {}) {
  const transaction = {
    id: 'txn-ui-1',
    amount: 1499,
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
    createPaymentAttempt: jest.fn(async (data) => mockPrisma.paymentAttempt.create({ data })),
    updateStatus: jest.fn(async (id, status) => mockPrisma.transaction.update({ where: { id }, data: { status } })),
    executeInTransaction: jest.fn(async (cb) => cb(repository))
  };

  return { repository, mockPrisma, transaction, createdRecoveryActions, createdAttempts };
}

describe('Intelligent Recovery UI API Integration (Task 6.9)', () => {
  test('1. Failed payment attempt returns ML explanation object with candidate rankings and probabilities', async () => {
    const { repository } = createMockRepository();
    const mockPolicy = {
      decide: jest.fn(() => ({
        selected_action: RecoveryActionType.RETRY,
        decision_source: DECISION_SOURCES.ML,
        recovery_probability: 0.8576,
        model_version: INTERACTION_MODEL_VERSION,
        reason: 'ML selected RETRY as highest probability safe action.',
        candidate_predictions: [
          { candidate_action_type: RecoveryActionType.RETRY, recovery_probability: 0.8576, model_version: INTERACTION_MODEL_VERSION },
          { candidate_action_type: RecoveryActionType.ALTERNATE_METHOD, recovery_probability: 0.4210, model_version: INTERACTION_MODEL_VERSION },
          { candidate_action_type: RecoveryActionType.CUSTOMER_ACTION, recovery_probability: 0.1834, model_version: INTERACTION_MODEL_VERSION },
          { candidate_action_type: RecoveryActionType.ESCALATE, recovery_probability: 0.1120, model_version: INTERACTION_MODEL_VERSION }
        ]
      }))
    };

    const service = new TransactionService(repository, undefined, undefined, mockPolicy);
    const result = await service.createPaymentAttempt('txn-ui-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank network timeout'
    });

    expect(result.attempt).toBeDefined();
    expect(result.recoveryAction).toBeDefined();
    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.RETRY);

    expect(result.explanation).toBeDefined();
    expect(result.explanation.explanation_schema_version).toBe('6.8.0');
    expect(result.explanation.selected_action).toBe(RecoveryActionType.RETRY);
    expect(result.explanation.decision_source).toBe(DECISION_SOURCES.ML);
    expect(result.explanation.human_readable_text).toContain('RETRY was recommended based on machine learning scoring');
    expect(result.explanation.candidate_comparison).toHaveLength(4);
    expect(result.explanation.candidate_comparison[0].predicted_recovery_probability).toBe(0.8576);
  });

  test('2. Failed payment attempt returns RULE fallback explanation when rule fallback engaged', async () => {
    const { repository } = createMockRepository({
      paymentAttempts: [
        { id: 'att-1', failureCategory: 'TEMPORARY_FAILURE', status: 'FAILED' },
        { id: 'att-2', failureCategory: 'TEMPORARY_FAILURE', status: 'FAILED' }
      ],
      _count: { paymentAttempts: 2 }
    });

    const mockPolicy = {
      decide: jest.fn(() => ({
        selected_action: RecoveryActionType.ESCALATE,
        decision_source: DECISION_SOURCES.RULE,
        recovery_probability: null,
        model_version: null,
        reason: 'The automatic retry limit has been reached, so the payment should be escalated.',
        fallback_reason: FALLBACK_REASONS.NO_SAFE_CANDIDATE,
        fallback_error: null,
        candidate_predictions: [
          { candidate_action_type: RecoveryActionType.RETRY, recovery_probability: 0.7210, model_version: INTERACTION_MODEL_VERSION }
        ]
      }))
    };

    const service = new TransactionService(repository, undefined, undefined, mockPolicy);
    const result = await service.createPaymentAttempt('txn-ui-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank timeout again'
    });

    expect(result.recoveryAction.actionType).toBe(RecoveryActionType.ESCALATE);
    expect(result.explanation).toBeDefined();
    expect(result.explanation.decision_source).toBe(DECISION_SOURCES.RULE);
    expect(result.explanation.fallback.is_fallback).toBe(true);
    expect(result.explanation.fallback.fallback_reason).toBe(FALLBACK_REASONS.NO_SAFE_CANDIDATE);
    expect(result.explanation.human_readable_text).toContain('ESCALATE was selected by Phase 1 deterministic rules');
  });

  test('3. Successful payment attempt returns explanation: null', async () => {
    const { repository } = createMockRepository();
    const service = new TransactionService(repository);
    const result = await service.createPaymentAttempt('txn-ui-1', {
      paymentMethod: 'UPI',
      outcome: 'SUCCESS'
    });

    expect(result.attempt.status).toBe('SUCCESS');
    expect(result.recoveryAction).toBeNull();
    expect(result.explanation).toBeNull();
  });

  test('4. TransactionController.createAttempt forwards explanation in response payload', async () => {
    const mockService = {
      createPaymentAttempt: jest.fn(async () => ({
        attempt: { id: 'att-1', attemptNumber: 1, paymentMethod: 'UPI', status: 'FAILED' },
        recoveryAction: { id: 'act-1', actionType: 'RETRY', reason: 'Retry payment', status: 'RECOMMENDED', createdAt: new Date() },
        explanation: {
          explanation_schema_version: '6.8.0',
          selected_action: 'RETRY',
          decision_source: 'ML',
          human_readable_text: 'RETRY recommended by ML'
        }
      }))
    };

    const controller = new TransactionController(mockService, {});
    const req = { params: { transactionId: 'txn-ui-1' }, body: { paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'Network error' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    await controller.createAttempt(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      data: {
        attempt: expect.objectContaining({ id: 'att-1', status: 'FAILED' }),
        recoveryAction: expect.objectContaining({ id: 'act-1', actionType: 'RETRY' }),
        explanation: expect.objectContaining({ selected_action: 'RETRY', decision_source: 'ML' })
      }
    });
  });

  test('5. Execution service is never called during explanation generation', async () => {
    const { repository } = createMockRepository();
    const mockExecutionService = {
      execute: jest.fn()
    };

    const service = new TransactionService(repository);
    await service.createPaymentAttempt('txn-ui-1', {
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Network down'
    });

    expect(mockExecutionService.execute).not.toHaveBeenCalled();
  });
});
