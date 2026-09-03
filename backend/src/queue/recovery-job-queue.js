export class RecoveryJobQueue {
  async enqueue(_jobId) {}
  async claimNext(_workerId) { throw new Error('RecoveryJobQueue.claimNext() is not implemented'); }
  async acknowledge(_jobId) { throw new Error('RecoveryJobQueue.acknowledge() is not implemented'); }
  async fail(_jobId, _error) { throw new Error('RecoveryJobQueue.fail() is not implemented'); }
}