export class RecoveryLeaseReaper {
  constructor(queue, { pollingIntervalMs = 1000, batchSize = 50 } = {}) {
    this.queue = queue;
    this.pollingIntervalMs = pollingIntervalMs;
    this.batchSize = batchSize;
    this.timer = null;
  }

  async runOnce() {
    await this.queue.recoverStaleJobs(this.batchSize);
    await this.queue.promoteDueRetries(this.batchSize);
  }

  start() {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.pollingIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}