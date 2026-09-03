import { ProviderErrorCategory } from '../providers/provider-errors.js';

const RETRYABLE_FAILURES = new Set([
  ProviderErrorCategory.TIMEOUT,
  ProviderErrorCategory.NETWORK_ERROR,
  ProviderErrorCategory.RATE_LIMITED,
  ProviderErrorCategory.PROVIDER_UNAVAILABLE
]);

export function getProviderFailureCategory(providerFailure) {
  if (typeof providerFailure === 'string') return providerFailure;
  return providerFailure?.category ?? providerFailure?.providerCategory ?? null;
}

export function isRetryable(providerFailure) {
  return RETRYABLE_FAILURES.has(getProviderFailureCategory(providerFailure));
}

export function isTerminal(providerFailure) {
  return !isRetryable(providerFailure);
}

export { RETRYABLE_FAILURES };