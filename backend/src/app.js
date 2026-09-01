import express from 'express';
import cors from 'cors';
import { prisma } from './config/prisma.js';
import { config } from './config/env.js';
import { TransactionController } from './controllers/transaction-controller.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { TransactionRepository } from './repositories/transaction-repository.js';
import { createTransactionRouter } from './routes/transaction-routes.js';
import { TransactionService } from './services/transaction-service.js';
import { RecoveryExecutionService } from './services/recovery-execution-service.js';
import { SimulatedPaymentProvider } from './providers/simulated-payment-provider.js';
import { RecoveryDecisionAuditService } from './intelligence/recovery-decision-audit-service.js';
import { RecoveryFeedbackService } from './intelligence/recovery-feedback-service.js';

export function createApp({
  transactionService,
  recoveryExecutionService,
  predictionService,
  decisionPolicy,
  auditService,
  feedbackService
} = {}) {
  const audit = auditService ?? new RecoveryDecisionAuditService();
  const feedback = feedbackService ?? new RecoveryFeedbackService({ auditService: audit });
  const service = transactionService ?? new TransactionService(
    new TransactionRepository(prisma),
    undefined,
    predictionService,
    decisionPolicy,
    audit
  );
  const executionService = recoveryExecutionService ?? new RecoveryExecutionService(
    new TransactionRepository(prisma),
    new SimulatedPaymentProvider()
  );
  const app = express();
  app.use(cors({
    origin: config.frontendOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
  }));
  app.use(express.json());
  app.use('/api/transactions', createTransactionRouter(new TransactionController(service, executionService, feedback)));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
