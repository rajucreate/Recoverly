import { jest } from '@jest/globals';
import { adaptPaymentProvider, normalizeProviderResponse } from '../src/providers/payment-provider.js';
import {
  ProviderError,
  ProviderErrorCategory,
  isRetryableProviderError,
  toBusinessFailureCategory
} from '../src/providers/provider-errors.js';
import { SimulatorProvider, SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';
import { RazorpayProvider } from '../src/providers/razorpay-provider.js';
import { createPaymentProvider } from '../src/providers/create-payment-provider.js';
import { createProviderRequestAdapter } from '../src/providers/provider-request-adapter.js';

describe('Payment provider abstraction', () => {
  test('normalizes a provider success response with stable defaults', () => {
    const result = normalizeProviderResponse({ outcome: 'SUCCESS' }, 'fake', { idempotencyKey: 'key-1' });

    expect(result).toEqual({
      outcome: 'SUCCESS',
      failureCategory: null,
      failureReason: null,
      providerId: 'fake',
      providerPaymentId: null,
      providerRequestId: null,
      retryable: false,
      pending: false,
      idempotencyKey: 'key-1',
      metadata: { providerCode: null, providerStatus: null }
    });
  });

  test('normalizes a provider failure response', () => {
    const result = normalizeProviderResponse({
      outcome: 'FAILED',
      failureCategory: 'PAYMENT_METHOD_FAILURE',
      failureReason: 'Card declined',
      providerPaymentId: 'pay-1',
      providerRequestId: 'req-1',
      metadata: { providerCode: 'card_declined', providerStatus: 'failed' }
    }, 'fake');

    expect(result).toMatchObject({
      outcome: 'FAILED',
      failureCategory: 'PAYMENT_METHOD_FAILURE',
      failureReason: 'Card declined',
      providerId: 'fake',
      providerPaymentId: 'pay-1',
      providerRequestId: 'req-1',
      metadata: { providerCode: 'card_declined', providerStatus: 'failed' }
    });
  });

  test('simulator normalizes success and failure directives', async () => {
    const provider = new SimulatorProvider();

    await expect(provider.executePayment({ providerRequest: { testDirective: 'SUCCESS' }, idempotencyKey: 'success-key' })).resolves.toMatchObject({
      outcome: 'SUCCESS', providerId: 'simulator', idempotencyKey: 'success-key'
    });
    await expect(provider.executePayment({ providerRequest: { testDirective: 'FAILED' } })).resolves.toMatchObject({
      outcome: 'FAILED', providerId: 'simulator', failureCategory: 'UNKNOWN_FAILURE', retryable: false
    });
    await expect(provider.executePayment({ providerRequest: { testDirective: 'OTHER' } })).rejects.toThrow('Unsupported simulated provider outcome');
  });

  test('legacy simulator class remains compatible', async () => {
    await expect(new SimulatedPaymentProvider().execute({ providerOutcome: 'SUCCESS' })).resolves.toMatchObject({
      outcome: 'SUCCESS', providerId: 'simulator'
    });
  });

  test.each([
    [ProviderErrorCategory.TIMEOUT, true, 'TEMPORARY_FAILURE'],
    [ProviderErrorCategory.NETWORK_ERROR, true, 'TEMPORARY_FAILURE'],
    [ProviderErrorCategory.RATE_LIMITED, true, 'TEMPORARY_FAILURE'],
    [ProviderErrorCategory.PROVIDER_DECLINED, false, 'UNKNOWN_FAILURE'],
    [ProviderErrorCategory.PAYMENT_METHOD_ERROR, false, 'PAYMENT_METHOD_FAILURE'],
    [ProviderErrorCategory.CUSTOMER_ACTION_REQUIRED, false, 'CUSTOMER_ACTION_REQUIRED'],
    [ProviderErrorCategory.INVALID_REQUEST, false, 'UNKNOWN_FAILURE'],
    [ProviderErrorCategory.AUTHENTICATION_FAILURE, false, 'UNKNOWN_FAILURE'],
    [ProviderErrorCategory.PROVIDER_UNAVAILABLE, true, 'TEMPORARY_FAILURE'],
    [ProviderErrorCategory.UNKNOWN_PROVIDER_ERROR, false, 'UNKNOWN_FAILURE'],
    [ProviderErrorCategory.LIVE_EXECUTION_DISABLED, false, 'UNKNOWN_FAILURE']
  ])('classifies %s as retryable=%s and %s', (category, retryable, businessCategory) => {
    const error = new ProviderError(category, 'provider failure');

    expect(error.retryable).toBe(retryable);
    expect(isRetryableProviderError(category)).toBe(retryable);
    expect(toBusinessFailureCategory(category)).toBe(businessCategory);
  });

  test('Razorpay provider has a stable id and fails closed without a network client', async () => {
    const provider = new RazorpayProvider();
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(provider.executePayment({
      transactionId: 'txn-1', paymentMethod: 'UPI', idempotencyKey: 'key-1'
    })).rejects.toMatchObject({
      name: 'ProviderError',
      category: ProviderErrorCategory.LIVE_EXECUTION_DISABLED,
      providerId: 'razorpay',
      retryable: false
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('composition selects explicit providers and rejects unknown values', () => {
    expect(createPaymentProvider('simulator')).toBeInstanceOf(SimulatorProvider);
    expect(createPaymentProvider('razorpay')).toBeInstanceOf(RazorpayProvider);
    expect(() => createPaymentProvider('unknown')).toThrow('Unsupported payment provider configuration');
  });

  test('simulator request adapter isolates the legacy API directive', () => {
    const request = createProviderRequestAdapter('simulator')({
      recoveryActionId: 'action-1', paymentMethod: 'UPI', providerOutcome: 'SUCCESS'
    });

    expect(request).toEqual({
      recoveryActionId: 'action-1', paymentMethod: 'UPI', providerRequest: { testDirective: 'SUCCESS' }
    });
    expect(createProviderRequestAdapter('razorpay')({ providerOutcome: 'SUCCESS' })).toEqual({});
  });

  test('legacy execute providers are adapted to the neutral executePayment contract', async () => {
    const legacyProvider = { execute: jest.fn(async ({ providerOutcome }) => ({ outcome: providerOutcome })) };
    const provider = adaptPaymentProvider(legacyProvider);

    await expect(provider.executePayment({ testDirective: 'SUCCESS' })).resolves.toEqual({ outcome: 'SUCCESS' });
    expect(legacyProvider.execute).toHaveBeenCalledWith(expect.objectContaining({ providerOutcome: 'SUCCESS' }));
  });
});