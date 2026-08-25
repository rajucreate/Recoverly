import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';

describe('RecoveryDecisionEngine', () => {
  const engine = new RecoveryDecisionEngine();

  test.each([
    ['TEMPORARY_FAILURE', 0, 'RETRY', 'The failure is classified as temporary, so retrying the payment is recommended.'],
    ['PAYMENT_METHOD_FAILURE', 0, 'ALTERNATE_METHOD', 'The selected payment method failed, so an alternate payment method is recommended.'],
    ['CUSTOMER_ACTION_REQUIRED', 0, 'CUSTOMER_ACTION', 'Customer action is required before another payment attempt can succeed.'],
    ['UNKNOWN_FAILURE', 0, 'ESCALATE', 'The failure could not be classified reliably, so the payment should be escalated.'],
    ['TEMPORARY_FAILURE', 1, 'RETRY', 'The failure is classified as temporary, so retrying the payment is recommended.'],
    ['TEMPORARY_FAILURE', 2, 'ESCALATE', 'The automatic retry limit has been reached, so the payment should be escalated.']
  ])('%s with %i previous temporary failures recommends %s', (failureCategory, previousTemporaryFailureCount, actionType, reason) => {
    expect(engine.decide({ failureCategory, previousTemporaryFailureCount })).toEqual({ actionType, reason });
  });

  test('fails explicitly for an unsupported category', () => {
    expect(() => engine.decide({ failureCategory: 'NOT_A_CATEGORY' })).toThrow('Unsupported failure category');
  });
});
