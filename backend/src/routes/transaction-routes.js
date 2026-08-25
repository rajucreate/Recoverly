import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import { validateTransactionId } from '../middleware/validate-transaction-id.js';

export function createTransactionRouter(controller) {
  const router = Router();
  router.post('/', asyncHandler(controller.create));
  router.post('/:transactionId/attempts', validateTransactionId, asyncHandler(controller.createAttempt));
  router.post('/:transactionId/recovery/execute', validateTransactionId, asyncHandler(controller.executeRecovery));
  router.get('/:transactionId', validateTransactionId, asyncHandler(controller.getById));
  return router;
}
