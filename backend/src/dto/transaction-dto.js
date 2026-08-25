export function toTransactionResponse(transaction) {
  return {
    id: transaction.id,
    amount: transaction.amount.toString(),
    currency: transaction.currency,
    customerId: transaction.customerId,
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
    paymentAttempts: (transaction.paymentAttempts ?? []).map(toPaymentAttemptResponse),
    recoveryActions: (transaction.recoveryActions ?? []).map(toRecoveryActionResponse)
  };
}

export function toPaymentAttemptResponse(attempt) {
  return {
    id: attempt.id,
    transactionId: attempt.transactionId,
    paymentMethod: attempt.paymentMethod,
    outcome: attempt.status,
    status: attempt.status,
    attemptNumber: attempt.attemptNumber,
    failureCategory: attempt.failureCategory,
    failureReason: attempt.failureReason,
    createdAt: attempt.createdAt.toISOString()
  };
}

export function toRecoveryActionResponse(action) {
  return { id: action.id, transactionId: action.transactionId, attemptId: action.attemptId, actionType: action.actionType, reason: action.reason, status: action.status, createdAt: action.createdAt.toISOString() };
}
