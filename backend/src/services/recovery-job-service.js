import crypto from 'node:crypto';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { RecoveryActionType } from '../enums/recovery-action.js';
import { RecoveryJobRepository } from '../repositories/recovery-job-repository.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';
import { TransactionStatus } from '../enums/transaction-status.js';

const PROVIDER_ACTIONS = new Set([RecoveryActionType.RETRY, RecoveryActionType.ALTERNATE_METHOD]);

export class RecoveryJobService {
  constructor(transactionRepository) {
    this.transactionRepository = transactionRepository;
  }

  async createJob(transactionId, data) {
    try {
      return await this.transactionRepository.executeInTransaction(async (repository) => {
      const transaction = await repository.findByIdForAttempt(transactionId);
      if (!transaction) throw new NotFoundError('Transaction', transactionId);
      if (transaction.status !== TransactionStatus.FAILED) {
        throw new BusinessRuleError('Recovery job creation requires a failed transaction', { transactionId, status: transaction.status });
      }
      const action = await new RecoveryActionRepository(repository.prisma).findByIdForTransaction(data.recoveryActionId, transactionId);
      if (!action) throw new NotFoundError('RecoveryAction', data.recoveryActionId);
      if (!PROVIDER_ACTIONS.has(action.actionType)) {
        throw new BusinessRuleError('Only payment recovery actions can be queued', { recoveryActionId: action.id, actionType: action.actionType });
      }

      const jobRepository = new RecoveryJobRepository(repository.prisma);
      const existing = await jobRepository.findByRecoveryActionId(action.id);
      if (existing) return existing;
      if (action.status !== 'RECOMMENDED') {
        throw new BusinessRuleError('Recovery action has already been queued or executed', { recoveryActionId: action.id, status: action.status });
      }

      const jobId = crypto.randomUUID();
      const paymentMethod = action.actionType === RecoveryActionType.RETRY
        ? action.attempt.paymentMethod
        : data.paymentMethod;
      if (!paymentMethod || (action.actionType === RecoveryActionType.ALTERNATE_METHOD && paymentMethod === action.attempt.paymentMethod)) {
        throw new BusinessRuleError('A different payment method is required for alternate-method recovery', { recoveryActionId: action.id });
      }
      return jobRepository.create({
        jobId,
        transactionId,
        recoveryActionId: action.id,
        triggerAttemptId: action.attemptId,
        request: {
          transactionId,
          recoveryActionId: action.id,
          paymentMethod,
          providerRequest: data.providerRequest ?? {},
          idempotencyKey: `recovery:${action.id}`
        },
        idempotencyKey: `recovery-job:${action.id}`
      });
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const existing = await new RecoveryJobRepository(this.transactionRepository.prisma).findByRecoveryActionId(data.recoveryActionId);
      if (existing) return existing;
      throw error;
    }
  }

  async getJob(jobId) {
    const job = await new RecoveryJobRepository(this.transactionRepository.prisma).findByJobId(jobId);
    if (!job) throw new NotFoundError('RecoveryJob', jobId);
    return job;
  }
}