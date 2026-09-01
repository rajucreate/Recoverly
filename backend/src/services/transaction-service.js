import { toPaymentAttemptResponse, toTransactionResponse } from '../dto/transaction-dto.js';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { TransactionStatus } from '../enums/transaction-status.js';
import { RecoveryDecisionEngine } from './recovery-decision-engine.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';
import { RecoveryPredictionService } from '../intelligence/recovery-prediction-service.js';
import { RecoveryDecisionPolicy } from '../intelligence/recovery-decision-policy.js';
import { explainDecision } from '../intelligence/recovery-decision-explanation.js';
import { buildDecisionAuditRecord } from '../intelligence/recovery-decision-audit-service.js';

export class TransactionService {
  constructor(
    transactionRepository,
    recoveryDecisionEngine,
    predictionService,
    decisionPolicy,
    auditService = null
  ) {
    this.transactionRepository = transactionRepository;
    this.recoveryDecisionEngine = recoveryDecisionEngine ?? new RecoveryDecisionEngine();
    this.predictionService = predictionService ?? new RecoveryPredictionService();
    this.decisionPolicy = decisionPolicy ?? new RecoveryDecisionPolicy(this.predictionService, this.recoveryDecisionEngine);
    this.auditService = auditService;
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
      let explanation = null;
      if (data.outcome === 'FAILED') {
        const failedAttempts = Array.isArray(transaction.failedAttempts)
          ? transaction.failedAttempts
          : (Array.isArray(transaction.paymentAttempts) ? transaction.paymentAttempts : []);
        const temporaryFailures = Array.isArray(transaction.paymentAttempts)
          ? transaction.paymentAttempts.filter((a) => !a.failureCategory || a.failureCategory === 'TEMPORARY_FAILURE')
          : [];

        const predictionContext = {
          transaction_amount: transaction.amount,
          currency: transaction.currency,
          payment_method_attempted: data.paymentMethod,
          failure_category: data.failureCategory,
          has_failure_reason: !!data.failureReason,
          attempt_number: (transaction._count?.paymentAttempts ?? 0) + 1,
          prior_failed_attempt_count: failedAttempts.length,
          prior_temporary_failure_count: temporaryFailures.length,
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

        const auditRecord = buildDecisionAuditRecord({
          decision,
          context: predictionContext,
          correlation: {
            transaction_id: transactionId,
            attempt_id: attempt.id,
            recovery_action_id: recoveryAction.id
          }
        });

        if (this.auditService) {
          this.auditService.record(auditRecord);
        }

        explanation = explainDecision({
          auditRecord
        });
      }

      return { attempt: toPaymentAttemptResponse(attempt), recoveryAction, explanation };
    });
  }
}
