export const ProviderErrorCategory = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_DECLINED: 'PROVIDER_DECLINED',
  PAYMENT_METHOD_ERROR: 'PAYMENT_METHOD_ERROR',
  CUSTOMER_ACTION_REQUIRED: 'CUSTOMER_ACTION_REQUIRED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTHENTICATION_FAILURE: 'AUTHENTICATION_FAILURE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  UNKNOWN_PROVIDER_ERROR: 'UNKNOWN_PROVIDER_ERROR',
  LIVE_EXECUTION_DISABLED: 'LIVE_EXECUTION_DISABLED'
});

const RETRYABLE_CATEGORIES = new Set([
  ProviderErrorCategory.TIMEOUT,
  ProviderErrorCategory.NETWORK_ERROR,
  ProviderErrorCategory.RATE_LIMITED,
  ProviderErrorCategory.PROVIDER_UNAVAILABLE
]);

const BUSINESS_FAILURE_CATEGORIES = Object.freeze({
  [ProviderErrorCategory.TIMEOUT]: 'TEMPORARY_FAILURE',
  [ProviderErrorCategory.NETWORK_ERROR]: 'TEMPORARY_FAILURE',
  [ProviderErrorCategory.RATE_LIMITED]: 'TEMPORARY_FAILURE',
  [ProviderErrorCategory.PROVIDER_UNAVAILABLE]: 'TEMPORARY_FAILURE',
  [ProviderErrorCategory.PROVIDER_DECLINED]: 'UNKNOWN_FAILURE',
  [ProviderErrorCategory.PAYMENT_METHOD_ERROR]: 'PAYMENT_METHOD_FAILURE',
  [ProviderErrorCategory.CUSTOMER_ACTION_REQUIRED]: 'CUSTOMER_ACTION_REQUIRED',
  [ProviderErrorCategory.INVALID_REQUEST]: 'UNKNOWN_FAILURE',
  [ProviderErrorCategory.AUTHENTICATION_FAILURE]: 'UNKNOWN_FAILURE',
  [ProviderErrorCategory.LIVE_EXECUTION_DISABLED]: 'UNKNOWN_FAILURE',
  [ProviderErrorCategory.UNKNOWN_PROVIDER_ERROR]: 'UNKNOWN_FAILURE'
});

export class ProviderError extends Error {
  constructor(category, message, { providerId = null, providerCode = null, providerStatus = null, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.category = category;
    this.providerId = providerId;
    this.providerCode = providerCode;
    this.providerStatus = providerStatus;
    this.retryable = RETRYABLE_CATEGORIES.has(category);
    this.failureCategory = BUSINESS_FAILURE_CATEGORIES[category] ?? 'UNKNOWN_FAILURE';
  }
}

export function isRetryableProviderError(category) {
  return RETRYABLE_CATEGORIES.has(category);
}

export function toBusinessFailureCategory(category) {
  return BUSINESS_FAILURE_CATEGORIES[category] ?? 'UNKNOWN_FAILURE';
}