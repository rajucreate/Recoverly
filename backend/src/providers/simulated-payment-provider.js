export class SimulatedPaymentProvider {
  async execute({ providerOutcome }) {
    if (providerOutcome === 'SUCCESS') return { outcome: 'SUCCESS' };
    if (providerOutcome === 'FAILED') {
      return { outcome: 'FAILED', failureCategory: 'UNKNOWN_FAILURE', failureReason: 'The simulated payment provider declined the recovery attempt.' };
    }
    throw new Error(`Unsupported simulated provider outcome: ${providerOutcome}`);
  }
}
