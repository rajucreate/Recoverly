import { jest } from '@jest/globals';
import { RecoveryJobService } from '../src/services/recovery-job-service.js';
import { RecoveryJobStatus } from '../src/enums/recovery-job-status.js';
import { PostgresRecoveryJobQueue } from '../src/queue/postgres-recovery-job-queue.js';
import { RecoveryWorker } from '../src/workers/recovery-worker.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryActionType } from '../src/enums/recovery-action.js';

const transactionId = 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a';
const actionId = 'a4c23c30-99e8-4d89-9e12-5a3cbd7c740a';
const attemptId = 'd4c23c30-99e8-4d89-9e12-5a3cbd7c740a';

function makeJob(overrides = {}) {
  return {
    id: 'j4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
    jobId: 'job-1',
    transactionId,
    recoveryActionId: actionId,
    triggerAttemptId: attemptId,
    request: { transactionId, recoveryActionId: actionId, paymentMethod: 'UPI', providerRequest: { testDirective: 'SUCCESS' }, idempotencyKey: `recovery:${actionId}` },
    status: RecoveryJobStatus.QUEUED,
    attemptCount: 0,
    availableAt: new Date('2026-01-01T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
    leaseUntil: null,
    lastError: null,
    idempotencyKey: `recovery-job:${actionId}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function makeJobPrisma({ existingJob = null } = {}) {
  const job = makeJob();
  return {
    transaction: {
      findUnique: jest.fn(async () => ({
        id: transactionId,
        status: 'FAILED',
        _count: { paymentAttempts: 1 }
      }))
    },
    recoveryAction: {
      findFirst: jest.fn(async () => ({
        id: actionId,
        transactionId,
        attemptId,
        actionType: RecoveryActionType.RETRY,
        status: 'RECOMMENDED',
        attempt: { paymentMethod: 'UPI' }
      }))
    },
    recoveryJob: {
      findUnique: jest.fn(async () => existingJob),
      create: jest.fn(async ({ data }) => ({ ...job, ...data }))
    },
    $transaction: jest.fn(async (work) => work(prisma))
  };
}

function makeTransactionRepository(prisma) {
  return {
    prisma,
    findByIdForAttempt: async (id) => prisma.transaction.findUnique({ where: { id } }),
    executeInTransaction: (work) => work({
      prisma,
      findByIdForAttempt: async (id) => prisma.transaction.findUnique({ where: { id } })
    })
  };
}

let prisma;

describe('RecoveryJobService', () => {
  test('creates one durable queued job without executing a provider', async () => {
    prisma = makeJobPrisma();
    const provider = { executePayment: jest.fn() };
    const service = new RecoveryJobService(makeTransactionRepository(prisma));

    const job = await service.createJob(transactionId, { recoveryActionId: actionId, providerRequest: { testDirective: 'SUCCESS' } });

    expect(job.status).toBe(RecoveryJobStatus.QUEUED);
    expect(job.idempotencyKey).toBe(`recovery-job:${actionId}`);
    expect(provider.executePayment).not.toHaveBeenCalled();
    expect(prisma.recoveryJob.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ idempotencyKey: `recovery-job:${actionId}` }) }));
  });

  test('returns an existing job for a duplicate recovery action', async () => {
    const existing = makeJob({ status: RecoveryJobStatus.QUEUED });
    prisma = makeJobPrisma({ existingJob: existing });
    const service = new RecoveryJobService(makeTransactionRepository(prisma));

    const job = await service.createJob(transactionId, { recoveryActionId: actionId });

    expect(job.jobId).toBe(existing.jobId);
    expect(prisma.recoveryJob.create).not.toHaveBeenCalled();
  });
});

describe('PostgresRecoveryJobQueue', () => {
  test('claims with row locking and acknowledges or fails the claimed job', async () => {
    const job = makeJob({ status: RecoveryJobStatus.PROCESSING, attemptCount: 1 });
    const prisma = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: job.id }])
        .mockResolvedValueOnce([job]),
      recoveryJob: {
        findUnique: jest.fn(async () => job),
        updateMany: jest.fn(async () => ({ count: 1 }))
      },
      $transaction: jest.fn(async (work) => work(prisma))
    };
    const queue = new PostgresRecoveryJobQueue(prisma);

    await expect(queue.claimNext('worker-1')).resolves.toMatchObject({ jobId: job.jobId, workerId: 'worker-1' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.calls[0][0].join(' ')).toContain('FOR UPDATE SKIP LOCKED');
    await expect(queue.acknowledge(job.jobId)).resolves.toEqual({ count: 1 });
    await expect(queue.fail(job.jobId, new Error('provider failed'))).resolves.toEqual({ count: 1 });
  });
});

describe('RecoveryWorker', () => {
  test('executes after claim and records feedback after durable result persistence', async () => {
    const job = makeJob({ status: RecoveryJobStatus.PROCESSING });
    let persisted = false;
    const queue = {
      claimNext: jest.fn(async () => job),
      acknowledge: jest.fn(async () => { expect(persisted).toBe(true); }),
      fail: jest.fn()
    };
    const result = { attempt: { id: 'execution-1', status: 'SUCCESS', createdAt: new Date() }, recoveryAction: { id: actionId, attemptId, actionType: 'RETRY', reason: 'retry', status: 'SUCCESS', createdAt: new Date() } };
    const executionService = { executeQueuedJob: jest.fn(async () => { persisted = true; return result; }) };
    const feedbackService = { recordFeedback: jest.fn(async () => { expect(persisted).toBe(true); }) };
    const worker = new RecoveryWorker(queue, executionService, feedbackService, { workerId: 'worker-1' });

    await expect(worker.processNext()).resolves.toBe(result);
    expect(queue.acknowledge).toHaveBeenCalledWith(job.jobId);
    expect(feedbackService.recordFeedback).toHaveBeenCalled();
  });

  test('marks the job failed when provider execution throws', async () => {
    const job = makeJob({ status: RecoveryJobStatus.PROCESSING });
    const error = new Error('provider unavailable');
    const queue = { claimNext: jest.fn(async () => job), acknowledge: jest.fn(), fail: jest.fn() };
    const worker = new RecoveryWorker(queue, { executeQueuedJob: jest.fn(async () => { throw error; }) }, null);

    await expect(worker.processNext()).resolves.toBeNull();
    expect(queue.fail).toHaveBeenCalledWith(job.jobId, error);
    expect(queue.acknowledge).not.toHaveBeenCalled();
  });

  test('marks the job failed after a durably persisted provider failure', async () => {
    const job = makeJob({ status: RecoveryJobStatus.PROCESSING });
    const queue = { claimNext: jest.fn(async () => job), acknowledge: jest.fn(), fail: jest.fn(async () => undefined) };
    const result = { attempt: { id: 'execution-1', status: 'FAILED', failureReason: 'Card declined', createdAt: new Date() }, recoveryAction: { id: actionId, attemptId, actionType: 'RETRY', reason: 'retry', status: 'FAILED', createdAt: new Date() } };
    const executionService = { executeQueuedJob: jest.fn(async () => result) };
    const feedbackService = { recordFeedback: jest.fn() };
    const worker = new RecoveryWorker(queue, executionService, feedbackService, { workerId: 'worker-1' });

    await expect(worker.processNext()).resolves.toBe(result);
    expect(queue.fail).toHaveBeenCalledWith(job.jobId, expect.objectContaining({ code: 'PROVIDER_EXECUTION_FAILED', message: 'Card declined' }));
    expect(queue.acknowledge).not.toHaveBeenCalled();
    expect(feedbackService.recordFeedback).toHaveBeenCalled();
  });
});

describe('RecoveryExecutionService async boundary', () => {
  test('calls provider before opening result persistence transaction', async () => {
    const callOrder = [];
    const repository = { executeInTransaction: jest.fn() };
    const provider = { providerId: 'fake', executePayment: jest.fn(async () => { callOrder.push('provider'); return { outcome: 'SUCCESS' }; }) };
    const service = new RecoveryExecutionService(repository, provider);

    service.persistProviderResult = jest.fn(async () => { callOrder.push('persistence'); return { attempt: null, recoveryAction: null }; });
    await service.executeQueuedJob({ transactionId, recoveryActionId: actionId, request: { paymentMethod: 'UPI' } });

    expect(provider.executePayment).toHaveBeenCalledWith(expect.objectContaining({ paymentMethod: 'UPI' }));
    expect(callOrder).toEqual(['provider', 'persistence']);
    expect(repository.executeInTransaction).not.toHaveBeenCalled();
  });
});