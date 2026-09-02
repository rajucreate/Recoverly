import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';

export function createAnalyticsRouter(controller) {
  const router = Router();
  router.get('/recovery', asyncHandler(controller.getRecoveryAnalytics));
  return router;
}

