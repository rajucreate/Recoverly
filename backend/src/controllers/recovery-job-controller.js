import { toRecoveryJobResponse } from '../dto/recovery-job-dto.js';
import { validateRecoveryExecution } from '../utils/validation.js';

export class RecoveryJobController {
  constructor(jobService, queue, providerRequestAdapter = (input) => input) {
    this.jobService = jobService;
    this.queue = queue;
    this.providerRequestAdapter = providerRequestAdapter;
  }

  create = async (req, res) => {
    const input = this.providerRequestAdapter(validateRecoveryExecution(req.body));
    const job = await this.jobService.createJob(req.params.transactionId, input);
    await this.queue.enqueue(job.jobId);
    const currentJob = await this.jobService.getJob(job.jobId);
    res.status(202).json({ data: toRecoveryJobResponse(currentJob) });
  };

  getById = async (req, res) => {
    const job = await this.jobService.getJob(req.params.jobId);
    res.status(200).json({ data: toRecoveryJobResponse(job) });
  };
}