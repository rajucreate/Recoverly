import { RecoveryJobStatus } from '../enums/recovery-job-status.js';

export class RecoveryJobRepository {
  constructor(prisma) { this.prisma = prisma; }

  create(data) { return this.prisma.recoveryJob.create({ data }); }

  findByJobId(jobId) {
    return this.prisma.recoveryJob.findUnique({
      where: { jobId },
      include: { recoveryAction: true, triggerAttempt: true }
    });
  }

  findByRecoveryActionId(recoveryActionId) {
    return this.prisma.recoveryJob.findUnique({ where: { recoveryActionId } });
  }

  updateStatus(jobId, fromStatus, data) {
    return this.prisma.recoveryJob.updateMany({
      where: { jobId, status: fromStatus },
      data
    });
  }

  async claimNext(workerId, leaseUntil) {
    const jobs = await this.prisma.$queryRaw`
      SELECT "id"
      FROM "RecoveryJob"
      WHERE "status" = ${RecoveryJobStatus.QUEUED}
        AND "availableAt" <= CURRENT_TIMESTAMP
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (jobs.length === 0) return null;

    const [job] = await this.prisma.$queryRaw`
      UPDATE "RecoveryJob"
      SET "status" = ${RecoveryJobStatus.PROCESSING},
          "attemptCount" = "attemptCount" + 1,
          "startedAt" = CURRENT_TIMESTAMP,
          "leaseUntil" = ${leaseUntil},
          "lastError" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${jobs[0].id}
      RETURNING *
    `;
    return job ? { ...job, workerId } : null;
  }

  findById(jobId) { return this.prisma.recoveryJob.findUnique({ where: { jobId } }); }
}