import { RecoveryJobAttemptStatus } from '../enums/recovery-job-attempt-status.js';

export class RecoveryJobAttemptRepository {
  constructor(prisma) { this.prisma = prisma; }

  updateCompleted(id, claimVersion, data) {
    return this.prisma.recoveryJobAttempt.updateMany({
      where: { id, claimVersion, status: RecoveryJobAttemptStatus.PROCESSING },
      data
    });
  }

  updateFailed(id, claimVersion, failureReason) {
    return this.updateCompleted(id, claimVersion, {
      status: RecoveryJobAttemptStatus.FAILED,
      failureReason,
      completedAt: new Date()
    });
  }
}