import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { validateTransactionId } from '../middleware/validate-transaction-id.js';

export function createRecoveryJobRouter(controller) {
  const router = Router();
  router.post('/transactions/:transactionId/recovery/jobs', validateTransactionId, asyncHandler(controller.create));
  router.get('/recovery-jobs/:jobId', asyncHandler(controller.getById));
  return router;
}