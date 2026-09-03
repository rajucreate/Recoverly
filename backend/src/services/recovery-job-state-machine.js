import { RecoveryJobStatus } from '../enums/recovery-job-status.js';

const VALID_TRANSITIONS = Object.freeze({
  [RecoveryJobStatus.QUEUED]: new Set([RecoveryJobStatus.PROCESSING]),
  [RecoveryJobStatus.PROCESSING]: new Set([
    RecoveryJobStatus.SUCCEEDED,
    RecoveryJobStatus.FAILED,
    RecoveryJobStatus.RETRY_PENDING,
    RecoveryJobStatus.DEAD_LETTER
  ]),
  [RecoveryJobStatus.RETRY_PENDING]: new Set([
    RecoveryJobStatus.QUEUED,
    RecoveryJobStatus.DEAD_LETTER
  ]),
  [RecoveryJobStatus.FAILED]: new Set([RecoveryJobStatus.QUEUED]),
  [RecoveryJobStatus.DEAD_LETTER]: new Set([RecoveryJobStatus.QUEUED]),
  [RecoveryJobStatus.SUCCEEDED]: new Set()
});

export function canTransitionRecoveryJob(fromStatus, toStatus) {
  return VALID_TRANSITIONS[fromStatus]?.has(toStatus) ?? false;
}

export function assertRecoveryJobTransition(fromStatus, toStatus) {
  if (!canTransitionRecoveryJob(fromStatus, toStatus)) {
    throw new Error(`Invalid RecoveryJob transition: ${fromStatus} -> ${toStatus}`);
  }
}

export { VALID_TRANSITIONS };