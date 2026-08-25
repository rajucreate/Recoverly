

import { FailureCategory } from '../enums/failure-category.js';
import { RecoveryActionType } from '../enums/recovery-action.js';

const RETRY_LIMIT = 2;

const DECISIONS = Object.freeze({
  [FailureCategory.PAYMENT_METHOD_FAILURE]: {
    actionType: RecoveryActionType.ALTERNATE_METHOD,
    reason: 'The selected payment method failed, so an alternate payment method is recommended.'
  },
  [FailureCategory.CUSTOMER_ACTION_REQUIRED]: {
    actionType: RecoveryActionType.CUSTOMER_ACTION,
    reason: 'Customer action is required before another payment attempt can succeed.'
  },
  [FailureCategory.UNKNOWN_FAILURE]: {
    actionType: RecoveryActionType.ESCALATE,
    reason: 'The failure could not be classified reliably, so the payment should be escalated.'
  }
});

export class RecoveryDecisionEngine {
  decide({ failureCategory, previousTemporaryFailureCount = 0 }) {
    if (failureCategory === FailureCategory.TEMPORARY_FAILURE) {
      if (previousTemporaryFailureCount >= RETRY_LIMIT) {
        return {
          actionType: RecoveryActionType.ESCALATE,
          reason: 'The automatic retry limit has been reached, so the payment should be escalated.'
        };
      }
      return {
        actionType: RecoveryActionType.RETRY,
        reason: 'The failure is classified as temporary, so retrying the payment is recommended.'
      };
    }

    const decision = DECISIONS[failureCategory];
    if (!decision) throw new Error(`Unsupported failure category: ${failureCategory}`);
    return decision;
  }
}

export { RETRY_LIMIT };
