import { RecoveryJobRepository } from '../repositories/recovery-job-repository.js';
import { RecoveryJobStatus } from '../enums/recovery-job-status.js';

export class PostgresRecoveryJobQueue {
  constructor(prisma, { leaseDurationMs = 60000, batchSize = 50 } = {}) {
    this.prisma = prisma;
    this.repository = new RecoveryJobRepository(prisma);
    this.leaseDurationMs = leaseDurationMs;
    this.batchSize = batchSize;
  }

  async enqueue(jobId) { return this.repository.findByJobId(jobId); }

  promoteDueRetries(batchSize = this.batchSize) {
    return this.prisma.$transaction(
      (client) => new RecoveryJobRepository(client).promoteDueRetries(batchSize),
      { isolationLevel: 'ReadCommitted' }
    );
  }

  recoverStaleJobs(batchSize = this.batchSize) {
    return this.prisma.$transaction(
      (client) => new RecoveryJobRepository(client).recoverStaleJobs(batchSize),
      { isolationLevel: 'ReadCommitted' }
    );
  }

  claimNext(workerId) {
    const leaseUntil = new Date(Date.now() + this.leaseDurationMs);
    return this.prisma.$transaction(
      (client) => new RecoveryJobRepository(client).claimNext(workerId, leaseUntil),
      { isolationLevel: 'ReadCommitted' }
    );
  }

  acknowledge(jobId, claimVersion = null) {
    return this.repository.updateStatus(jobId, RecoveryJobStatus.PROCESSING, RecoveryJobStatus.SUCCEEDED, {
      completedAt: new Date(),
      leaseUntil: null
    }, claimVersion);
  }

  fail(jobId, error, claimVersion = null) {
    return this.repository.updateStatus(jobId, RecoveryJobStatus.PROCESSING, RecoveryJobStatus.FAILED, {
      completedAt: new Date(),
      leaseUntil: null,
      lastError: error instanceof Error ? error.message : String(error),
      lastFailureCategory: error?.category ?? null,
      lastFailureReason: error instanceof Error ? error.message : String(error)
    }, claimVersion);
  }
}