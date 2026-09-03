import { ProviderError } from './provider-errors.js';

export const PROVIDER_OUTCOMES = Object.freeze({ SUCCESS: 'SUCCESS', FAILED: 'FAILED' });

export function normalizeProviderResponse(response, providerId, request = {}) {
  if (!response || !PROVIDER_OUTCOMES[response.outcome]) {
    throw new ProviderError('UNKNOWN_PROVIDER_ERROR', 'Provider returned an invalid payment response', { providerId });
  }

  return {
    outcome: response.outcome,
    failureCategory: response.failureCategory ?? null,
    failureReason: response.failureReason ?? null,
    providerId: response.providerId ?? providerId,
    providerPaymentId: response.providerPaymentId ?? null,
    providerRequestId: response.providerRequestId ?? null,
    retryable: response.retryable === true,
    pending: response.pending === true,
    idempotencyKey: response.idempotencyKey ?? request.idempotencyKey ?? null,
    metadata: {
      providerCode: response.metadata?.providerCode ?? null,
      providerStatus: response.metadata?.providerStatus ?? null
    }
  };
}

export function adaptPaymentProvider(provider) {
  if (typeof provider?.executePayment === 'function') return provider;
  if (typeof provider?.execute === 'function') {
    return {
      providerId: provider.providerId ?? 'legacy-provider',
      executePayment: (request) => provider.execute({
        ...request,
        providerOutcome: request.testDirective
      })
    };
  }
  throw new TypeError('Payment provider must implement executePayment(request)');
}