import { toPaymentAttemptResponse, toRecoveryActionResponse } from '../dto/transaction-dto.js';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';
import { TransactionStatus } from '../enums/transaction-status.js';
import { adaptPaymentProvider, normalizeProviderResponse } from '../providers/payment-provider.js';

const ATTEMPT_ACTIONS = new Set(['RETRY', 'ALTERNATE_METHOD']);

export class RecoveryExecutionService {
  constructor(transactionRepository, paymentProvider) {
    this.transactionRepository = transactionRepository;
    this.paymentProvider = adaptPaymentProvider(paymentProvider);
  }

  get providerId() {
    return this.paymentProvider.providerId;
  }

  async execute(transactionId, data) {
    return this.transactionRepository.executeInTransaction(async (transactionRepository) => {
      const transaction = await transactionRepository.findByIdForAttempt(transactionId);
      if (!transaction) throw new NotFoundError('Transaction', transactionId);
      if (transaction.status !== TransactionStatus.FAILED) {
        throw new BusinessRuleError('Recovery execution requires a failed transaction', { transactionId, status: transaction.status });
      }

      const recoveryActionRepository = new RecoveryActionRepository(transactionRepository.prisma);
      const action = await recoveryActionRepository.findByIdForTransaction(data.recoveryActionId, transactionId);
      if (!action) throw new NotFoundError('RecoveryAction', data.recoveryActionId);
      if (action.status !== 'RECOMMENDED') {
        throw new BusinessRuleError('Recovery action has already been executed', { recoveryActionId: action.id, status: action.status });
      }

      await this.transitionAction(recoveryActionRepository, action.id, 'RECOMMENDED', 'EXECUTED');

      if (!ATTEMPT_ACTIONS.has(action.actionType)) {
        const executedAction = await recoveryActionRepository.findByIdForTransaction(action.id, transactionId);
        return { attempt: null, recoveryAction: toRecoveryActionResponse(executedAction) };
      }

      const paymentMethod = this.resolvePaymentMethod(action, data.paymentMethod);
      const providerRequest = {
        transactionId,
        recoveryActionId: action.id,
        paymentMethod,
        ...(data.providerRequest ? { providerRequest: data.providerRequest } : {}),
        idempotencyKey: `recovery:${action.id}`
      };
      const providerResult = normalizeProviderResponse(
        await this.paymentProvider.executePayment(providerRequest),
        this.paymentProvider.providerId,
        providerRequest
      );
      const attempt = await transactionRepository.createPaymentAttempt({
        transactionId,
        paymentMethod,
        status: providerResult.outcome,
        failureCategory: providerResult.failureCategory ?? null,
        failureReason: providerResult.failureReason ?? null,
        attemptNumber: transaction._count.paymentAttempts + 1
      });
      await transactionRepository.updateStatus(transactionId, providerResult.outcome === 'SUCCESS' ? TransactionStatus.SUCCESS : TransactionStatus.FAILED);
      const completedStatus = providerResult.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
      await this.transitionAction(recoveryActionRepository, action.id, 'EXECUTED', completedStatus);
      const completedAction = await recoveryActionRepository.findByIdForTransaction(action.id, transactionId);
      return { attempt: toPaymentAttemptResponse(attempt), recoveryAction: toRecoveryActionResponse(completedAction) };
    });
  }

  resolvePaymentMethod(action, requestedPaymentMethod) {
    if (action.actionType === 'RETRY') return action.attempt.paymentMethod;
    if (!requestedPaymentMethod) {
      throw new BusinessRuleError('A different payment method is required for alternate-method recovery', { recoveryActionId: action.id });
    }
    if (requestedPaymentMethod === action.attempt.paymentMethod) {
      throw new BusinessRuleError('Alternate-method recovery must use a different payment method', { recoveryActionId: action.id });
    }
    return requestedPaymentMethod;
  }

  async transitionAction(repository, actionId, fromStatus, toStatus) {
    const transitioned = await repository.transitionStatus(actionId, fromStatus, toStatus);
    if (!transitioned) {
      throw new BusinessRuleError('Recovery action is not in the required state for this transition', { actionId, fromStatus, toStatus });
    }
  }
}
