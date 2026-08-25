import { ValidationError } from '../errors/app-error.js';

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateCreateTransaction(input) {
  const errors = {};
  const amount = input?.amount;

  if (amount === undefined || amount === null || amount === '') errors.amount = 'amount is required';
  else if (!isPositiveDecimal(amount)) errors.amount = 'amount must be a positive decimal value';
  if (typeof input?.currency !== 'string' || !CURRENCY_PATTERN.test(input.currency)) errors.currency = 'currency must be a three-letter uppercase ISO code';
  if (typeof input?.customerId !== 'string' || !input.customerId.trim()) errors.customerId = 'customerId is required';

  if (Object.keys(errors).length > 0) throw new ValidationError('Request validation failed', errors);
  return { amount: String(amount), currency: input.currency, customerId: input.customerId.trim() };
}

export function validateUuid(value) {
  if (!UUID_PATTERN.test(value)) throw new ValidationError('Request validation failed', { transactionId: 'transactionId must be a valid UUID' });
}

const PAYMENT_METHODS = new Set(['UPI', 'CARD', 'NET_BANKING']);
const OUTCOMES = new Set(['SUCCESS', 'FAILED']);
const FAILURE_CATEGORIES = new Set(['TEMPORARY_FAILURE', 'PAYMENT_METHOD_FAILURE', 'CUSTOMER_ACTION_REQUIRED', 'UNKNOWN_FAILURE']);

export function validateCreatePaymentAttempt(input) {
  const errors = {};
  const { paymentMethod, outcome, failureCategory, failureReason } = input ?? {};

  if (!PAYMENT_METHODS.has(paymentMethod)) errors.paymentMethod = 'paymentMethod must be UPI, CARD, or NET_BANKING';
  if (!OUTCOMES.has(outcome)) errors.outcome = 'outcome must be SUCCESS or FAILED';

  if (outcome === 'FAILED') {
    if (!FAILURE_CATEGORIES.has(failureCategory)) errors.failureCategory = 'failureCategory is required and must be valid for a failed attempt';
    if (typeof failureReason !== 'string' || !failureReason.trim()) errors.failureReason = 'failureReason is required for a failed attempt';
  }
  if (outcome === 'SUCCESS') {
    if (failureCategory !== undefined && failureCategory !== null) errors.failureCategory = 'failureCategory must be absent or null for a successful attempt';
    if (failureReason !== undefined && failureReason !== null) errors.failureReason = 'failureReason must be absent or null for a successful attempt';
  }

  if (Object.keys(errors).length > 0) throw new ValidationError('Request validation failed', errors);
  return {
    paymentMethod,
    outcome,
    failureCategory: outcome === 'FAILED' ? failureCategory : null,
    failureReason: outcome === 'FAILED' ? failureReason.trim() : null
  };
}

export function validateRecoveryExecution(input) {
  const errors = {};
  const { recoveryActionId, paymentMethod, providerOutcome } = input ?? {};
  if (typeof recoveryActionId !== 'string' || !UUID_PATTERN.test(recoveryActionId)) errors.recoveryActionId = 'recoveryActionId must be a valid UUID';
  if (paymentMethod !== undefined && !PAYMENT_METHODS.has(paymentMethod)) errors.paymentMethod = 'paymentMethod must be UPI, CARD, or NET_BANKING';
  if (providerOutcome !== undefined && !OUTCOMES.has(providerOutcome)) errors.providerOutcome = 'providerOutcome must be SUCCESS or FAILED';
  if (Object.keys(errors).length > 0) throw new ValidationError('Request validation failed', errors);
  return { recoveryActionId, paymentMethod, providerOutcome };
}

function isPositiveDecimal(value) {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) && Number(value) > 0;
}
