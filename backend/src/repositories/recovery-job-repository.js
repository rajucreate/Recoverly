import { RecoveryJobStatus } from '../enums/recovery-job-status.js';
import { RecoveryJobAttemptStatus } from '../enums/recovery-job-attempt-status.js';
import { assertRecoveryJobTransition } from '../services/recovery-job-state-machine.js';

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

  updateStatus(jobId, fromStatus, toStatus, data = {}, claimVersion = null) {
    assertRecoveryJobTransition(fromStatus, toStatus);
    return this.prisma.recoveryJob.updateMany({
      where: { jobId, status: fromStatus, ...(claimVersion === null ? {} : { claimVersion }) },
      data: { ...data, status: toStatus }
    });
  }

  async claimNext(workerId, leaseUntil) {
    const jobs = await this.prisma.$queryRaw`
      SELECT "id"
      FROM "RecoveryJob"
      WHERE "status" = ${RecoveryJobStatus.QUEUED}::"RecoveryJobStatus"
        AND "availableAt" <= CURRENT_TIMESTAMP
      ORDER BY "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (jobs.length === 0) return null;

    const [job] = await this.prisma.$queryRaw`
      UPDATE "RecoveryJob"
      SET "status" = ${RecoveryJobStatus.PROCESSING}::"RecoveryJobStatus",
          "attemptCount" = "attemptCount" + 1,
          "claimVersion" = "claimVersion" + 1,
          "startedAt" = CURRENT_TIMESTAMP,
          "leaseUntil" = ${leaseUntil},
          "lastError" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${jobs[0].id}::uuid
      RETURNING *
    `;
    if (!job) return null;
    const attempt = await this.prisma.recoveryJobAttempt.create({
      data: {
        recoveryJobId: job.id,
        attemptNumber: job.attemptCount,
        workerId,
        claimVersion: job.claimVersion,
        providerIdempotencyKey: job.request.idempotencyKey ?? `recovery:${job.recoveryActionId}`,
        status: RecoveryJobAttemptStatus.PROCESSING
      }
    });
    return { ...job, workerId, executionAttemptId: attempt.id };
  }

  findById(jobId) { return this.prisma.recoveryJob.findUnique({ where: { jobId } }); }

  promoteDueRetries(batchSize) {
    return this.prisma.$executeRaw`
      WITH due_jobs AS (
        SELECT "id"
        FROM "RecoveryJob"
        WHERE "status" = ${RecoveryJobStatus.RETRY_PENDING}::"RecoveryJobStatus"
          AND "availableAt" <= CURRENT_TIMESTAMP
        ORDER BY "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "RecoveryJob"
      SET "status" = ${RecoveryJobStatus.QUEUED}::"RecoveryJobStatus",
          "startedAt" = NULL,
          "leaseUntil" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" IN (SELECT "id" FROM due_jobs)
    `;
  }

  recoverStaleJobs(batchSize) {
    return this.prisma.$executeRaw`
      WITH stale_jobs AS (
        SELECT "id"
        FROM "RecoveryJob"
        WHERE "status" = ${RecoveryJobStatus.PROCESSING}::"RecoveryJobStatus"
          AND "leaseUntil" < CURRENT_TIMESTAMP
        ORDER BY "leaseUntil" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      UPDATE "RecoveryJob"
      SET "status" = CASE
            WHEN "attemptCount" < "maxAttempts" THEN ${RecoveryJobStatus.RETRY_PENDING}::"RecoveryJobStatus"
            ELSE ${RecoveryJobStatus.DEAD_LETTER}::"RecoveryJobStatus"
          END,
          "claimVersion" = "claimVersion" + 1,
          "availableAt" = CURRENT_TIMESTAMP,
          "leaseUntil" = NULL,
          "lastFailureCategory" = 'LEASE_EXPIRED',
          "lastFailureReason" = 'Worker lease expired before execution completed',
          "deadLetteredAt" = CASE
            WHEN "attemptCount" < "maxAttempts" THEN NULL
            ELSE CURRENT_TIMESTAMP
          END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" IN (SELECT "id" FROM stale_jobs)
    `;
  }
}