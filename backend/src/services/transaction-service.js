import { toPaymentAttemptResponse, toTransactionResponse } from '../dto/transaction-dto.js';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { TransactionStatus } from '../enums/transaction-status.js';
import { RecoveryDecisionEngine } from './recovery-decision-engine.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';

export class TransactionService {
  constructor(transactionRepository, recoveryDecisionEngine = new RecoveryDecisionEngine()) {
    this.transactionRepository = transactionRepository;
    this.recoveryDecisionEngine = recoveryDecisionEngine;
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
        const decision = this.recoveryDecisionEngine.decide({
          failureCategory: data.failureCategory,
          previousTemporaryFailureCount: transaction.paymentAttempts.length
        });
        recoveryAction = await new RecoveryActionRepository(repository.prisma).create({
          transactionId,
          attemptId: attempt.id,
          actionType: decision.actionType,
          reason: decision.reason,
          status: 'RECOMMENDED'
        });
      }

      return { attempt: toPaymentAttemptResponse(attempt), recoveryAction };
    });
  }
}
