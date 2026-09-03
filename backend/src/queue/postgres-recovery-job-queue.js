import { RecoveryJobRepository } from '../repositories/recovery-job-repository.js';
import { RecoveryJobStatus } from '../enums/recovery-job-status.js';

export class PostgresRecoveryJobQueue {
  constructor(prisma, { leaseDurationMs = 60000 } = {}) {
    this.prisma = prisma;
    this.repository = new RecoveryJobRepository(prisma);
    this.leaseDurationMs = leaseDurationMs;
  }

  async enqueue(jobId) { return this.repository.findByJobId(jobId); }

  claimNext(workerId) {
    const leaseUntil = new Date(Date.now() + this.leaseDurationMs);
    return this.prisma.$transaction(
      (client) => new RecoveryJobRepository(client).claimNext(workerId, leaseUntil),
      { isolationLevel: 'ReadCommitted' }
    );
  }

  acknowledge(jobId) {
    return this.repository.updateStatus(jobId, RecoveryJobStatus.PROCESSING, {
      status: RecoveryJobStatus.SUCCEEDED,
      completedAt: new Date(),
      leaseUntil: null
    });
  }

  fail(jobId, error) {
    return this.repository.updateStatus(jobId, RecoveryJobStatus.PROCESSING, {
      status: RecoveryJobStatus.FAILED,
      completedAt: new Date(),
      leaseUntil: null,
      lastError: error instanceof Error ? error.message : String(error)
    });
  }
}