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

export function createApp({ transactionService, recoveryExecutionService } = {}) {
  const service = transactionService ?? new TransactionService(new TransactionRepository(prisma));
  const executionService = recoveryExecutionService ?? new RecoveryExecutionService(new TransactionRepository(prisma), new SimulatedPaymentProvider());
  const app = express();
  app.use(cors({
    origin: config.frontendOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
  }));
  app.use(express.json());
  app.use('/api/transactions', createTransactionRouter(new TransactionController(service, executionService)));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
