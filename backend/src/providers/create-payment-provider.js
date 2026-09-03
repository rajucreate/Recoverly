import { config } from '../config/env.js';
import { RazorpayProvider } from './razorpay-provider.js';
import { SimulatorProvider } from './simulated-payment-provider.js';

export function createPaymentProvider(providerName = config.provider) {
  if (providerName === 'simulator') return new SimulatorProvider();
  if (providerName === 'razorpay') return new RazorpayProvider();
  throw new Error(`Unsupported payment provider configuration: ${providerName}`);
}