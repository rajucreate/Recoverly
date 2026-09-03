import { ProviderError, ProviderErrorCategory } from './provider-errors.js';

export class RazorpayProvider {
  providerId = 'razorpay';

  async executePayment(_request) {
    throw new ProviderError(
      ProviderErrorCategory.LIVE_EXECUTION_DISABLED,
      'Razorpay live payment execution is disabled in this environment',
      { providerId: this.providerId }
    );
  }
}