export class RecoveryWorker {
  constructor(queue, executionService, feedbackService, { pollIntervalMs = 1000, workerId = `recovery-worker-${process.pid}` } = {}) {
    this.queue = queue;
    this.executionService = executionService;
    this.feedbackService = feedbackService;
    this.pollIntervalMs = pollIntervalMs;
    this.workerId = workerId;
    this.timer = null;
    this.processing = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.processNext(); }, this.pollIntervalMs);
    void this.processNext();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async processNext() {
    if (this.processing) return null;
    this.processing = true;
    try {
      const job = await this.queue.claimNext(this.workerId);
      if (!job) return null;
      try {
        const result = await this.executionService.executeQueuedJob(job);
        if (result.attempt?.status === 'FAILED') {
          const error = new Error(result.attempt.failureReason ?? 'Provider execution failed');
          error.code = 'PROVIDER_EXECUTION_FAILED';
          error.category = result.attempt.failureCategory ?? null;
          if (job.claimVersion === undefined) await this.queue.fail(job.jobId, error);
          else await this.queue.fail(job.jobId, error, job.claimVersion);
        } else {
          if (job.claimVersion === undefined) await this.queue.acknowledge(job.jobId);
          else await this.queue.acknowledge(job.jobId, job.claimVersion);
        }
        await this.recordFeedback(job, result);
        return result;
      } catch (error) {
        if (this.executionService.markQueuedAttemptFailed) {
          try { await this.executionService.markQueuedAttemptFailed(job, error); } catch { /* Preserve the job failure path. */ }
        }
        if (job.claimVersion === undefined) await this.queue.fail(job.jobId, error);
        else await this.queue.fail(job.jobId, error, job.claimVersion);
        return null;
      }
    } finally {
      this.processing = false;
    }
  }

  async recordFeedback(job, result) {
    if (!this.feedbackService || !result?.recoveryAction) return;
    const action = result.recoveryAction;
    const attempt = result.attempt;
    try {
      await this.feedbackService.recordFeedback({
        transactionId: job.transactionId,
        attemptId: action.attemptId,
        recoveryActionId: action.id,
        executionAttemptId: attempt?.id ?? null,
        recoveryAction: action.actionType,
        decisionReason: action.reason,
        executionOutcome: attempt ? attempt.status : action.status,
        outcomeTimestamp: attempt?.createdAt ?? action.createdAt,
        executionResult: result
      });
    } catch {
      // Feedback is observational and must not change a completed job.
    }
  }
}