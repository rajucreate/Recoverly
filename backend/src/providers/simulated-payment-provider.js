import { normalizeProviderResponse } from './payment-provider.js';

export class SimulatorProvider {
  providerId = 'simulator';

  async executePayment(request) {
    const testDirective = request.providerRequest?.testDirective;
    if (testDirective === 'SUCCESS') return normalizeProviderResponse({ outcome: 'SUCCESS' }, this.providerId, request);
    if (testDirective === 'FAILED') {
      return normalizeProviderResponse({
        outcome: 'FAILED',
        failureCategory: 'UNKNOWN_FAILURE',
        failureReason: 'The simulated payment provider declined the recovery attempt.'
      }, this.providerId, request);
    }
    throw new Error(`Unsupported simulated provider outcome: ${testDirective}`);
  }
}

export class SimulatedPaymentProvider extends SimulatorProvider {
  async execute({ providerOutcome }) {
    return this.executePayment({ providerRequest: { testDirective: providerOutcome } });
  }
}
