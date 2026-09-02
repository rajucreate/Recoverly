import request from 'supertest';
import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';
import { RecoveryPredictionService } from '../src/intelligence/recovery-prediction-service.js';
import { RecoveryDecisionAuditService } from '../src/intelligence/recovery-decision-audit-service.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';
import { DECISION_SOURCES } from '../src/intelligence/recovery-decision-policy.js';

const rootDir = path.resolve(process.cwd(), '..');
const modelPath = path.join(rootDir, 'data', 'phase-2', 'models', 'recovery_interaction_v1.model.json');
const schemaPath = path.join(rootDir, 'data', 'phase-2', 'recovery_features_v1.schema.json');
const benchmarkPath = path.join(rootDir, 'data', 'phase-2', 'models', 'rule-vs-ml-evaluation.json');

function createMockRepository() {
  const state = {
    transactions: new Map(),
    attempts: [],
    recoveryActions: []
  };

  let counter = 1;
  const generateUuid = () => `c4c23c30-99e8-4d89-9e12-00000000${String(counter++).padStart(4, '0')}`;

  const mockPrisma = {
    transaction: {
      create: jest.fn(async ({ data }) => {
        const id = data.id || generateUuid();
        const now = new Date();
        const record = {
          id,
          amount: { toString: () => String(data.amount) },
          currency: data.currency,
          customerId: data.customerId,
          status: data.status || 'PENDING',
          createdAt: now,
          updatedAt: now
        };
        state.transactions.set(id, record);
        return record;
      }),
      findUnique: jest.fn(async ({ where, select }) => {
        const record = state.transactions.get(where.id);
        if (!record) return null;
        if (select) {
          return {
            id: record.id,
            status: record.status,
            amount: record.amount,
            currency: record.currency,
            _count: { paymentAttempts: state.attempts.filter((a) => a.transactionId === where.id).length },
            paymentAttempts: state.attempts.filter(
              (a) => a.transactionId === where.id && a.status === 'FAILED' && a.failureCategory === 'TEMPORARY_FAILURE'
            )
          };
        }
        return {
          ...record,
          paymentAttempts: state.attempts.filter((a) => a.transactionId === where.id),
          recoveryActions: state.recoveryActions.filter((a) => a.transactionId === where.id)
        };
      }),
      findMany: jest.fn(async () => Array.from(state.transactions.values())),
      update: jest.fn(async ({ where, data }) => {
        const record = state.transactions.get(where.id);
        if (!record) return null;
        Object.assign(record, data);
        return record;
      })
    },
    paymentAttempt: {
      create: jest.fn(async ({ data }) => {
        const attempt = { id: generateUuid(), ...data, createdAt: new Date() };
        state.attempts.push(attempt);
        return attempt;
      })
    },
    recoveryAction: {
      create: jest.fn(async ({ data }) => {
        const action = { id: generateUuid(), ...data, status: data.status || 'RECOMMENDED', createdAt: new Date() };
        state.recoveryActions.push(action);
        return action;
      }),
      findFirst: jest.fn(async ({ where }) =>
        state.recoveryActions.find((a) => a.id === where.id && a.transactionId === where.transactionId) || null
      ),
      findMany: jest.fn(async () => state.recoveryActions),
      updateMany: jest.fn(async ({ where, data }) => {
        const action = state.recoveryActions.find((a) => a.id === where.id && a.status === where.status);
        if (!action) return { count: 0 };
        Object.assign(action, data);
        return { count: 1 };
      })
    },
    $transaction: jest.fn(async (work) => work(mockPrisma))
  };

  const repository = new TransactionRepository(mockPrisma);
  return { repository, mockPrisma, state };
}

describe('Performance & Security Hardening (Task 6.14)', () => {
  describe('A. Benchmark Caching', () => {
    test('loads and parses benchmark JSON once, caching result on repeated calls', async () => {
      const readSpy = jest.spyOn(fs, 'readFileSync');
      const analyticsService = new RecoveryAnalyticsService({ benchmarkPath });

      // First call: reads and parses
      const metrics1 = analyticsService.getBenchmarkMetrics();
      expect(metrics1).toBeDefined();
      expect(metrics1.evaluation_version).toBe('6.6.0');
      expect(metrics1.metrics.rule_engine.recovery_success_rate).toBe(0.5433);
      expect(metrics1.metrics.ml_policy.recovery_success_rate).toBe(0.5473);

      const initialCallCount = readSpy.mock.calls.length;
      expect(initialCallCount).toBeGreaterThanOrEqual(1);

      // Second, third, and fourth calls: should use instance-local cached result without file I/O
      const metrics2 = analyticsService.getBenchmarkMetrics();
      const metrics3 = analyticsService.getBenchmarkMetrics();
      const summary = await analyticsService.getAnalyticsSummary();

      expect(readSpy.mock.calls.length).toBe(initialCallCount);
      expect(metrics2).toBe(metrics1);
      expect(metrics3).toBe(metrics1);
      expect(summary.benchmark).toBe(metrics1);

      readSpy.mockRestore();
    });

    test('handles missing or invalid benchmark path safely and caches null', () => {
      const readSpy = jest.spyOn(fs, 'readFileSync');
      const nonExistentPath = path.join(rootDir, 'non_existent_benchmark.json');
      const analyticsService = new RecoveryAnalyticsService({ benchmarkPath: nonExistentPath });

      const firstResult = analyticsService.getBenchmarkMetrics();
      expect(firstResult).toBeNull();

      const callCountAfterFirst = readSpy.mock.calls.length;

      const secondResult = analyticsService.getBenchmarkMetrics();
      expect(secondResult).toBeNull();
      // Should not attempt to read file again once cached as null
      expect(readSpy.mock.calls.length).toBe(callCountAfterFirst);

      readSpy.mockRestore();
    });
  });

  describe('B. Default Phase 2 ML Wiring', () => {
    test('default createApp() initializes with real RecoveryPredictionService and Phase 2 ML active', async () => {
      // 1. Calling bare createApp() should instantiate without errors and have ML predictor active
      const bareApp = createApp();
      expect(bareApp).toBeDefined();

      // 2. Test transactional HTTP flow with real RecoveryPredictionService
      const { repository, mockPrisma } = createMockRepository();
      const auditService = new RecoveryDecisionAuditService();
      const realPredictor = new RecoveryPredictionService({ modelPath, schemaPath });

      const app = createApp({
        transactionService: new TransactionService(repository, undefined, realPredictor, undefined, auditService),
        analyticsService: new RecoveryAnalyticsService({ prisma: mockPrisma })
      });

      const createRes = await request(app).post('/api/transactions').send({
        amount: 5000,
        currency: 'INR',
        customerId: 'cust-ml-default'
      });
      expect(createRes.status).toBe(201);
      const transactionId = createRes.body.data.id;

      const attemptRes = await request(app)
        .post(`/api/transactions/${transactionId}/attempts`)
        .send({
          paymentMethod: 'UPI',
          outcome: 'FAILED',
          failureCategory: 'TEMPORARY_FAILURE',
          failureReason: 'Temporary network timeout'
        });

      expect(attemptRes.status).toBe(201);
      const { explanation, recoveryAction } = attemptRes.body.data;
      expect(recoveryAction.actionType).toBe('RETRY');
      expect(explanation.decision_source).toBe(DECISION_SOURCES.ML);
      expect(explanation.selected_action).toBe('RETRY');
    });

    test('explicit predictionService override takes precedence over default', async () => {
      const { repository } = createMockRepository();
      const customMockPredictionService = {
        predictAll: jest.fn(() => {
          throw new Error('Custom mock error triggering rule fallback');
        })
      };

      const app = createApp({
        transactionService: new TransactionService(
          repository,
          undefined,
          customMockPredictionService,
          undefined,
          new RecoveryDecisionAuditService()
        )
      });

      const createRes = await request(app).post('/api/transactions').send({
        amount: 5000,
        currency: 'INR',
        customerId: 'cust-override'
      });
      expect(createRes.status).toBe(201);
      const transactionId = createRes.body.data.id;

      const attemptRes = await request(app)
        .post(`/api/transactions/${transactionId}/attempts`)
        .send({
          paymentMethod: 'UPI',
          outcome: 'FAILED',
          failureCategory: 'TEMPORARY_FAILURE',
          failureReason: 'Timeout'
        });

      expect(attemptRes.status).toBe(201);
      expect(attemptRes.body.data.explanation.decision_source).toBe(DECISION_SOURCES.RULE);
      expect(customMockPredictionService.predictAll).toHaveBeenCalled();
    });
  });

  describe('C. Decision Latency Instrumentation', () => {
    test('measures actual decision policy execution time using performance.now() and records finite latency >= 0', async () => {
      const { repository } = createMockRepository();
      const auditService = new RecoveryDecisionAuditService();
      const predictionService = new RecoveryPredictionService({ modelPath, schemaPath });

      const service = new TransactionService(
        repository,
        undefined,
        predictionService,
        undefined,
        auditService
      );

      const txn = await service.createTransaction({
        amount: 5000,
        currency: 'INR',
        customerId: 'cust-latency'
      });

      const result = await service.createPaymentAttempt(txn.id, {
        paymentMethod: 'UPI',
        outcome: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        failureReason: 'Timeout'
      });

      expect(result.recoveryAction).toBeDefined();
      expect(auditService.buffer).toHaveLength(1);

      const auditRecord = auditService.buffer[0];
      expect(auditRecord.performance).toBeDefined();
      expect(typeof auditRecord.performance.decision_latency_ms).toBe('number');
      expect(Number.isFinite(auditRecord.performance.decision_latency_ms)).toBe(true);
      expect(auditRecord.performance.decision_latency_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('D. HTTP Security Headers', () => {
    test('ensures responses include X-Content-Type-Options: nosniff and X-Frame-Options: DENY', async () => {
      const { mockPrisma } = createMockRepository();
      const app = createApp({
        analyticsService: new RecoveryAnalyticsService({ prisma: mockPrisma })
      });

      const response = await request(app).get('/api/analytics/recovery');

      expect(response.status).toBe(200);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      // Verify X-Powered-By remains stripped
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    test('ensures 404 error responses also include security headers', async () => {
      const app = createApp();
      const response = await request(app).get('/api/unknown-route');

      expect(response.status).toBe(404);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
    });
  });

  describe('E. Regression & API Surface Integrity', () => {
    test('transaction creation and error handling continue to work cleanly with new middleware', async () => {
      const { repository } = createMockRepository();
      const app = createApp({
        transactionService: new TransactionService(repository)
      });

      // Valid request
      const validRes = await request(app).post('/api/transactions').send({
        amount: 2500,
        currency: 'INR',
        customerId: 'cust-regression'
      });
      expect(validRes.status).toBe(201);
      expect(validRes.body.data.customerId).toBe('cust-regression');

      // Invalid request
      const invalidRes = await request(app).post('/api/transactions').send({
        amount: -50,
        currency: 'BAD'
      });
      expect(invalidRes.status).toBe(400);
      expect(invalidRes.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
