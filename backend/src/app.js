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
import { createPaymentProvider } from './providers/create-payment-provider.js';
import { createProviderRequestAdapter } from './providers/provider-request-adapter.js';
import { RecoveryPredictionService } from './intelligence/recovery-prediction-service.js';
import { RecoveryDecisionAuditService } from './intelligence/recovery-decision-audit-service.js';
import { RecoveryFeedbackService } from './intelligence/recovery-feedback-service.js';
import { RecoveryAnalyticsService } from './intelligence/recovery-analytics-service.js';
import { AnalyticsController } from './controllers/analytics-controller.js';
import { createAnalyticsRouter } from './routes/analytics-routes.js';
import { RecoveryJobService } from './services/recovery-job-service.js';
import { PostgresRecoveryJobQueue } from './queue/postgres-recovery-job-queue.js';
import { RecoveryWorker } from './workers/recovery-worker.js';
import { RecoveryLeaseReaper } from './workers/recovery-lease-reaper.js';
import { RecoveryJobController } from './controllers/recovery-job-controller.js';
import { createRecoveryJobRouter } from './routes/recovery-job-routes.js';

export function createApp({
  transactionService,
  recoveryExecutionService,
  paymentProvider,
  predictionService,
  decisionPolicy,
  auditService,
  feedbackService,
  analyticsService,
  recoveryJobService,
  recoveryJobQueue,
  recoveryWorker,
  recoveryLeaseReaper
} = {}) {
  const useDurableDefaults = !transactionService && !recoveryExecutionService && !auditService && !feedbackService;
  const audit = auditService ?? new RecoveryDecisionAuditService({ prisma: useDurableDefaults ? prisma : null });
  const feedback = feedbackService ?? new RecoveryFeedbackService({
    auditService: audit,
    prisma: useDurableDefaults ? prisma : null
  });
  const predictor = predictionService !== undefined
    ? predictionService
    : (decisionPolicy ? null : new RecoveryPredictionService());
  const service = transactionService ?? new TransactionService(
    new TransactionRepository(prisma),
    undefined,
    predictor,
    decisionPolicy,
    audit
  );
  const executionService = recoveryExecutionService ?? new RecoveryExecutionService(
    new TransactionRepository(prisma),
    paymentProvider ?? createPaymentProvider(),
    {
      retryConfig: {
        baseDelayMs: config.recoveryRetryBaseDelayMs,
        maxDelayMs: config.recoveryRetryMaxDelayMs,
        jitterRatio: config.recoveryRetryJitterRatio
      }
    }
  );
  const providerRequestAdapter = createProviderRequestAdapter(paymentProvider?.providerId ?? executionService.providerId);
  const analytics = analyticsService ?? new RecoveryAnalyticsService({
    prisma,
    feedbackService: feedback,
    auditService: audit
  });
  const jobService = recoveryJobService ?? new RecoveryJobService(new TransactionRepository(prisma), {
    maxAttempts: config.recoveryMaxAttempts
  });
  const jobQueue = recoveryJobQueue ?? new PostgresRecoveryJobQueue(prisma, {
    leaseDurationMs: config.recoveryLeaseDurationMs,
    batchSize: config.recoveryBatchSize
  });
  const worker = recoveryWorker ?? new RecoveryWorker(jobQueue, executionService, feedback, {
    pollIntervalMs: config.recoveryPollingIntervalMs,
    batchSize: config.recoveryBatchSize
  });
  const reaper = recoveryLeaseReaper ?? new RecoveryLeaseReaper(jobQueue, {
    pollingIntervalMs: config.recoveryPollingIntervalMs,
    batchSize: config.recoveryBatchSize
  });
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(cors({
    origin: config.frontendOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/transactions', createTransactionRouter(new TransactionController(service, executionService, feedback, providerRequestAdapter)));
  app.use('/api/analytics', createAnalyticsRouter(new AnalyticsController(analytics)));
  app.use('/api', createRecoveryJobRouter(new RecoveryJobController(jobService, jobQueue, providerRequestAdapter)));
  app.use(notFoundHandler);
  app.use(errorHandler);
  app.locals.recoveryWorker = worker;
  app.locals.recoveryLeaseReaper = reaper;
  return app;
}
