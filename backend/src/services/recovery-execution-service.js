import { toPaymentAttemptResponse, toRecoveryActionResponse } from '../dto/transaction-dto.js';
import { BusinessRuleError, NotFoundError } from '../errors/app-error.js';
import { RecoveryActionRepository } from '../repositories/recovery-action-repository.js';
import { TransactionStatus } from '../enums/transaction-status.js';
import { adaptPaymentProvider, normalizeProviderResponse } from '../providers/payment-provider.js';
import { RecoveryJobAttemptStatus } from '../enums/recovery-job-attempt-status.js';
import { RecoveryJobAttemptRepository } from '../repositories/recovery-job-attempt-repository.js';
import { RecoveryJobRepository } from '../repositories/recovery-job-repository.js';
import { calculateRetryDelay } from './recovery-backoff.js';
import { isRetryable } from './recovery-retry-policy.js';
import { ProviderErrorCategory, toBusinessFailureCategory } from '../providers/provider-errors.js';

const ATTEMPT_ACTIONS = new Set(['RETRY', 'ALTERNATE_METHOD']);

export class RecoveryExecutionService {
  constructor(transactionRepository, paymentProvider, { retryConfig = {}, now = () => new Date() } = {}) {
    this.transactionRepository = transactionRepository;
    this.paymentProvider = adaptPaymentProvider(paymentProvider);
    this.retryConfig = retryConfig;
    this.now = now;
  }

  get providerId() {
    return this.paymentProvider.providerId;
  }

  async execute(transactionId, data) {
    const prepared = await this.transactionRepository.executeInTransaction(async (transactionRepository) => {
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

      if (!ATTEMPT_ACTIONS.has(action.actionType)) {
        await this.transitionAction(recoveryActionRepository, action.id, 'RECOMMENDED', 'EXECUTED');
        const executedAction = await recoveryActionRepository.findByIdForTransaction(action.id, transactionId);
        return { attempt: null, recoveryAction: toRecoveryActionResponse(executedAction) };
      }

      const paymentMethod = this.resolvePaymentMethod(action, data.paymentMethod);
      return {
        transaction,
        action,
        paymentMethod,
        providerRequest: {
          transactionId,
          recoveryActionId: action.id,
          paymentMethod,
          ...(data.providerRequest ? { providerRequest: data.providerRequest } : {}),
          idempotencyKey: `recovery:${action.id}`
        }
      };
    });

    if (prepared.attempt === null) return prepared;

    const providerResult = normalizeProviderResponse(
      await this.paymentProvider.executePayment(prepared.providerRequest),
      this.paymentProvider.providerId,
      prepared.providerRequest
    );
    return this.persistProviderResult(prepared, providerResult);
  }

  async executeQueuedJob(job) {
    let providerResult;
    try {
      providerResult = normalizeProviderResponse(
        await this.paymentProvider.executePayment(job.request),
        this.paymentProvider.providerId,
        job.request
      );
    } catch (error) {
      const providerError = error instanceof Error ? error : new Error(String(error));
      providerError.providerExecutionFailure = true;
      throw providerError;
    }
    return this.persistProviderResult({
      jobId: job.jobId,
      transactionId: job.transactionId,
      recoveryActionId: job.recoveryActionId,
      paymentMethod: job.request.paymentMethod,
      executionAttemptId: job.executionAttemptId,
      claimVersion: job.claimVersion,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts
    }, providerResult);
  }

  async persistProviderFailure(job, error) {
    const category = error?.category ?? ProviderErrorCategory.UNKNOWN_PROVIDER_ERROR;
    return this.persistProviderResult({
      jobId: job.jobId,
      transactionId: job.transactionId,
      recoveryActionId: job.recoveryActionId,
      paymentMethod: job.request.paymentMethod,
      executionAttemptId: job.executionAttemptId,
      claimVersion: job.claimVersion,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts
    }, {
      outcome: 'FAILED',
      failureCategory: error?.failureCategory ?? toBusinessFailureCategory(category),
      failureReason: error instanceof Error ? error.message : String(error),
      providerId: error?.providerId ?? this.paymentProvider.providerId,
      providerRequestId: error?.providerRequestId ?? null,
      providerPaymentId: error?.providerPaymentId ?? null,
      retryable: isRetryable(error),
      pending: false,
      idempotencyKey: job.request.idempotencyKey,
      metadata: {
        providerCode: error?.providerCode ?? null,
        providerStatus: error?.providerStatus ?? null
      }
    });
  }

  async persistProviderResult(execution, providerResult) {
    const transactionId = execution.transactionId ?? execution.providerRequest?.transactionId;
    const recoveryActionId = execution.recoveryActionId ?? execution.providerRequest?.recoveryActionId;
    const paymentMethod = execution.paymentMethod ?? execution.providerRequest?.paymentMethod;
    return this.transactionRepository.executeInTransaction(async (transactionRepository) => {
      const transaction = await transactionRepository.findByIdForAttempt(transactionId);
      if (!transaction) throw new NotFoundError('Transaction', transactionId);
      const recoveryActionRepository = new RecoveryActionRepository(transactionRepository.prisma);
      const action = await recoveryActionRepository.findByIdForTransaction(recoveryActionId, transactionId);
      if (!action) throw new NotFoundError('RecoveryAction', recoveryActionId);
      if (action.status !== 'RECOMMENDED') {
        throw new BusinessRuleError('Recovery action has already been executed', { recoveryActionId, status: action.status });
      }

      const attempt = await transactionRepository.createPaymentAttempt({
        transactionId,
        paymentMethod,
        status: providerResult.outcome,
        failureCategory: providerResult.failureCategory ?? null,
        failureReason: providerResult.failureReason ?? null,
        attemptNumber: transaction._count.paymentAttempts + 1
      });
      await transactionRepository.updateStatus(transactionId, providerResult.outcome === 'SUCCESS' ? TransactionStatus.SUCCESS : TransactionStatus.FAILED);
      const isQueuedExecution = !!execution.executionAttemptId;
      const retryableFailure = isQueuedExecution && providerResult.outcome === 'FAILED' && providerResult.retryable === true;
      const attemptsRemain = retryableFailure && execution.attemptCount < (execution.maxAttempts ?? 3);
      const completedStatus = providerResult.outcome === 'SUCCESS' || !retryableFailure || !attemptsRemain ? (providerResult.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILED') : null;
      if (completedStatus) await this.transitionAction(recoveryActionRepository, recoveryActionId, 'RECOMMENDED', completedStatus);
      if (execution.executionAttemptId) {
        const attemptUpdate = await new RecoveryJobAttemptRepository(transactionRepository.prisma).updateCompleted(
          execution.executionAttemptId,
          execution.claimVersion,
          {
            status: providerResult.outcome === 'SUCCESS' ? RecoveryJobAttemptStatus.SUCCEEDED : RecoveryJobAttemptStatus.FAILED,
            completedAt: new Date(),
            providerId: providerResult.providerId,
            providerRequestId: providerResult.providerRequestId,
            providerPaymentId: providerResult.providerPaymentId,
            failureCategory: providerResult.failureCategory,
            failureReason: providerResult.failureReason
          }
        );
        if (attemptUpdate.count !== 1) {
          throw new BusinessRuleError('Recovery job attempt claim is no longer current', { recoveryActionId, claimVersion: execution.claimVersion });
        }
      }
      let jobStatus = null;
      if (isQueuedExecution && providerResult.outcome === 'FAILED' && retryableFailure) {
        const failureDetails = {
          lastFailureCategory: providerResult.failureCategory,
          lastFailureReason: providerResult.failureReason
        };
        if (attemptsRemain) {
          const delay = calculateRetryDelay(execution.attemptCount, this.retryConfig);
          const retryAt = new Date(this.now().getTime() + delay);
          const scheduled = await new RecoveryJobRepository(transactionRepository.prisma).updateStatus(
            execution.jobId,
            'PROCESSING',
            'RETRY_PENDING',
            { availableAt: retryAt, leaseUntil: null, ...failureDetails },
            execution.claimVersion
          );
          if (scheduled.count !== 1) throw new BusinessRuleError('Recovery job claim is no longer current', { recoveryActionId, claimVersion: execution.claimVersion });
          jobStatus = 'RETRY_PENDING';
        } else {
          const deadLettered = await new RecoveryJobRepository(transactionRepository.prisma).updateStatus(
            execution.jobId,
            'PROCESSING',
            'DEAD_LETTER',
            { completedAt: this.now(), leaseUntil: null, deadLetteredAt: this.now(), ...failureDetails },
            execution.claimVersion
          );
          if (deadLettered.count !== 1) throw new BusinessRuleError('Recovery job claim is no longer current', { recoveryActionId, claimVersion: execution.claimVersion });
          jobStatus = 'DEAD_LETTER';
        }
      }
      const completedAction = await recoveryActionRepository.findByIdForTransaction(recoveryActionId, transactionId);
      return { attempt: toPaymentAttemptResponse(attempt), recoveryAction: toRecoveryActionResponse(completedAction), jobStatus };
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
