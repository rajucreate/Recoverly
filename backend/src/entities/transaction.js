export const transactionRelations = Object.freeze({
  paymentAttempts: { orderBy: { createdAt: 'asc' } },
  recoveryActions: { orderBy: { createdAt: 'asc' } }
});
