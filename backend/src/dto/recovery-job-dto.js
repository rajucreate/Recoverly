export function toRecoveryJobResponse(job) {
  return {
    jobId: job.jobId,
    recoveryActionId: job.recoveryActionId,
    status: job.status,
    attemptCount: job.attemptCount,
    availableAt: job.availableAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString()
  };
}