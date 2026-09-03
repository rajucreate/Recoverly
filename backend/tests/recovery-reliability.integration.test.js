import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import { PostgresRecoveryJobQueue } from '../src/queue/postgres-recovery-job-queue.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';

const createdTransactionIds = new Set();

async function createJob({ status = 'QUEUED', maxAttempts = 3, availableAt = new Date(), leaseUntil = null } = {}) {
  const transaction = await prisma.transaction.create({
    data: { amount: '100.00', currency: 'INR', customerId: `reliability-${crypto.randomUUID()}`, status: 'FAILED' }
  });
  createdTransactionIds.add(transaction.id);
  const triggerAttempt = await prisma.paymentAttempt.create({
    data: {
      transactionId: transaction.id,
      paymentMethod: 'UPI',
      status: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'reliability test',
      attemptNumber: 1
    }
  });
  const action = await prisma.recoveryAction.create({
    data: { transactionId: transaction.id, attemptId: triggerAttempt.id, actionType: 'RETRY', reason: 'reliability test' }
  });
  const job = await prisma.recoveryJob.create({
    data: {
      jobId: `job-${crypto.randomUUID()}`,
      transactionId: transaction.id,
      recoveryActionId: action.id,
      triggerAttemptId: triggerAttempt.id,
      request: { transactionId: transaction.id, recoveryActionId: action.id, paymentMethod: 'UPI', idempotencyKey: `recovery:${action.id}` },
      status,
      maxAttempts,
      availableAt,
      leaseUntil,
      idempotencyKey: `recovery-job:${action.id}`
    }
  });
  return { transaction, triggerAttempt, action, job };
}

describe('Recovery reliability PostgreSQL integration', () => {
  const queue = new PostgresRecoveryJobQueue(prisma, { leaseDurationMs: 60000, batchSize: 10 });

  afterEach(async () => {
    if (createdTransactionIds.size > 0) {
      await prisma.transaction.deleteMany({ where: { id: { in: [...createdTransactionIds] } } });
      createdTransactionIds.clear();
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('only one concurrent worker claims a queued job and creates one attempt', async () => {
    const { job } = await createJob();
    const claims = await Promise.all([queue.claimNext('worker-a'), queue.claimNext('worker-b')]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await prisma.recoveryJobAttempt.count({ where: { recoveryJobId: job.id } })).toBe(1);
    expect((await prisma.recoveryJob.findUnique({ where: { id: job.id } })).claimVersion).toBe(1);
  });

  test('promotes only due retry jobs and never creates attempts', async () => {
    const due = await createJob({ status: 'RETRY_PENDING', availableAt: new Date(Date.now() - 1000) });
    const future = await createJob({ status: 'RETRY_PENDING', availableAt: new Date(Date.now() + 86400000) });

    await queue.promoteDueRetries();

    expect((await prisma.recoveryJob.findUnique({ where: { id: due.job.id } })).status).toBe('QUEUED');
    expect((await prisma.recoveryJob.findUnique({ where: { id: future.job.id } })).status).toBe('RETRY_PENDING');
    expect(await prisma.recoveryJobAttempt.count({ where: { recoveryJobId: due.job.id } })).toBe(0);
  });

  test('recovers stale jobs with fencing and dead-letters exhausted jobs', async () => {
    const retryable = await createJob({ status: 'PROCESSING', leaseUntil: new Date(Date.now() - 1000), maxAttempts: 3 });
    const exhausted = await createJob({ status: 'PROCESSING', leaseUntil: new Date(Date.now() - 1000), maxAttempts: 1 });
    await prisma.recoveryJob.update({ where: { id: exhausted.job.id }, data: { attemptCount: 1 } });
    await queue.recoverStaleJobs();

    const retryableRow = await prisma.recoveryJob.findUnique({ where: { id: retryable.job.id } });
    const exhaustedRow = await prisma.recoveryJob.findUnique({ where: { id: exhausted.job.id } });
    expect(retryableRow).toMatchObject({ status: 'RETRY_PENDING', claimVersion: 1, lastFailureCategory: 'LEASE_EXPIRED' });
    expect(exhaustedRow).toMatchObject({ status: 'DEAD_LETTER', claimVersion: 1 });
    expect(await prisma.recoveryJobAttempt.count({ where: { recoveryJobId: retryable.job.id } })).toBe(0);
  });

  test('persists retryable failure atomically and preserves the recovery action recommendation', async () => {
    const testCase = await createJob();
    const claim = await queue.claimNext('worker-retry');
    const service = new RecoveryExecutionService(new TransactionRepository(prisma), {
      providerId: 'test-provider',
      executePayment: async () => ({ outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'timeout', retryable: true })
    }, { retryConfig: { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, random: () => 0.5 }, now: () => new Date() });

    const result = await service.executeQueuedJob(claim);
    const job = await prisma.recoveryJob.findUnique({ where: { id: testCase.job.id } });
    const action = await prisma.recoveryAction.findUnique({ where: { id: testCase.action.id } });
    const attempt = await prisma.recoveryJobAttempt.findUnique({ where: { id: claim.executionAttemptId } });
    expect(result.attempt.status).toBe('FAILED');
    expect(job.status).toBe('RETRY_PENDING');
    expect(action.status).toBe('RECOMMENDED');
    expect(attempt).toMatchObject({ status: 'FAILED', attemptNumber: 1, providerId: 'test-provider', failureReason: 'timeout' });
    expect(job.availableAt.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('terminal failure completes the job as FAILED and retry exhaustion becomes DEAD_LETTER', async () => {
    const terminalCase = await createJob();
    const exhaustedCase = await createJob({ maxAttempts: 1 });
    const terminalClaim = await queue.claimNext('worker-terminal');
    const exhaustedClaim = await queue.claimNext('worker-exhausted');
    const service = new RecoveryExecutionService(new TransactionRepository(prisma), {
      providerId: 'test-provider',
      executePayment: async () => ({ outcome: 'FAILED', failureCategory: 'PAYMENT_METHOD_FAILURE', failureReason: 'declined', retryable: false })
    });

    await service.executeQueuedJob(terminalClaim);
    const retryableService = new RecoveryExecutionService(new TransactionRepository(prisma), {
      providerId: 'test-provider',
      executePayment: async () => ({ outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'timeout', retryable: true })
    });
    await retryableService.executeQueuedJob(exhaustedClaim);
    await queue.fail(terminalClaim.jobId, new Error('declined'), terminalClaim.claimVersion);
    const terminal = await prisma.recoveryJob.findUnique({ where: { id: terminalCase.job.id } });
    const exhausted = await prisma.recoveryJob.findUnique({ where: { id: exhaustedCase.job.id } });
    expect(terminal.status).toBe('FAILED');
    expect(exhausted.status).toBe('DEAD_LETTER');
  });

  test('retryable provider exception is durably scheduled without an immediate retry', async () => {
    const testCase = await createJob();
    const claim = await queue.claimNext('worker-exception');
    const service = new RecoveryExecutionService(new TransactionRepository(prisma), {
      providerId: 'test-provider',
      executePayment: async () => {
        const error = new Error('provider timeout');
        error.category = 'TIMEOUT';
        throw error;
      }
    }, { retryConfig: { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0, random: () => 0.5 }, now: () => new Date() });

    let result;
    try {
      await service.executeQueuedJob(claim);
    } catch (error) {
      result = await service.persistProviderFailure(claim, error);
    }

    const job = await prisma.recoveryJob.findUnique({ where: { id: testCase.job.id } });
    expect(result.jobStatus).toBe('RETRY_PENDING');
    expect(job.status).toBe('RETRY_PENDING');
  });
});