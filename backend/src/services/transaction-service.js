import { toPaymentAttemptResponse, toTransactionResponse } from '../dto/transaction-dto.js';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { TransactionStatus } from '../enums/transaction-status.js';
import { RecoveryDecisionEngine } from './recovery-decision-engine.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';
import { RecoveryPredictionService } from '../intelligence/recovery-prediction-service.js';
import { RecoveryDecisionPolicy } from '../intelligence/recovery-decision-policy.js';

export class TransactionService {
  constructor(
    transactionRepository,
    recoveryDecisionEngine = new RecoveryDecisionEngine(),
    predictionService = new RecoveryPredictionService(),
    decisionPolicy = new RecoveryDecisionPolicy(predictionService, recoveryDecisionEngine)
  ) {
    this.transactionRepository = transactionRepository;
    this.recoveryDecisionEngine = recoveryDecisionEngine;
    this.predictionService = predictionService;
    this.decisionPolicy = decisionPolicy;
  }

  async createTransaction(data) {
    const transaction = await this.transactionRepository.create({ ...data, status: TransactionStatus.PENDING });
    return toTransactionResponse(transaction);
  }

  async getTransaction(transactionId) {
    const transaction = await this.transactionRepository.findByIdWithHistory(transactionId);
    if (!transaction) throw new NotFoundError('Transaction', transactionId);
    return toTransactionResponse(transaction);
  }

  async createPaymentAttempt(transactionId, data) {
    return this.transactionRepository.executeInTransaction(async (repository) => {
      const transaction = await repository.findByIdForAttempt(transactionId);
      if (!transaction) throw new NotFoundError('Transaction', transactionId);
      if (transaction.status === TransactionStatus.SUCCESS || transaction.status === TransactionStatus.RECOVERED) {
        throw new BusinessRuleError('Payment attempts cannot be created for a terminal transaction', { transactionId, status: transaction.status });
      }
      if (transaction.status !== TransactionStatus.PENDING && transaction.status !== TransactionStatus.FAILED) {
        throw new BusinessRuleError('Payment attempt would cause an invalid transaction state transition', { transactionId, status: transaction.status });
      }
      if (transaction.status === TransactionStatus.FAILED && data.outcome === 'SUCCESS') {
        throw new BusinessRuleError('A failed transaction can become successful only through recovery execution', { transactionId });
      }

      const attempt = await repository.createPaymentAttempt({
        transactionId,
        paymentMethod: data.paymentMethod,
        status: data.outcome,
        failureCategory: data.failureCategory,
        failureReason: data.failureReason,
        attemptNumber: transaction._count.paymentAttempts + 1
      });
      await repository.updateStatus(transactionId, data.outcome === 'SUCCESS' ? TransactionStatus.SUCCESS : TransactionStatus.FAILED);

      let recoveryAction = null;
      if (data.outcome === 'FAILED') {
        const predictionContext = {
          transaction_amount: transaction.amount,
          currency: transaction.currency,
          payment_method_attempted: data.paymentMethod,
          failure_category: data.failureCategory,
          has_failure_reason: !!data.failureReason,
          attempt_number: transaction._count.paymentAttempts + 1,
          prior_failed_attempt_count: transaction.failedAttempts?.length ?? 0,
          prior_temporary_failure_count: transaction.paymentAttempts?.length ?? 0,
          transaction_status: 'FAILED'
        };

        const decision = this.decisionPolicy.decide(predictionContext);
        recoveryAction = await new RecoveryActionRepository(repository.prisma).create({
          transactionId,
          attemptId: attempt.id,
          actionType: decision.selected_action,
          reason: decision.reason,
          status: 'RECOMMENDED'
        });
      }

      return { attempt: toPaymentAttemptResponse(attempt), recoveryAction };
    });
  }
}
