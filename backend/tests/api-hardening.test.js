import request from 'supertest';
import { jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';

function createMockApp({ throwInitError = false, transaction = null } = {}) {
  const mockPrisma = {
    transaction: {
      create: jest.fn(async ({ data }) => {
        if (throwInitError) {
          throw new Prisma.PrismaClientInitializationError('Can\'t reach database server at `localhost:5432`', '5.0.0');
        }
        return {
          id: 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a',
          amount: data.amount,
          currency: data.currency,
          customerId: data.customerId,
          status: 'PENDING',
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }),
      findUnique: jest.fn(async ({ where }) => {
        if (transaction && where.id === transaction.id) {
          return transaction;
        }
        return null;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn()
    },
    paymentAttempt: {
      create: jest.fn()
    },
    recoveryAction: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn()
    },
    $transaction: jest.fn(async (work) => work(mockPrisma))
  };

  const repository = new TransactionRepository(mockPrisma);
  const transactionService = new TransactionService(repository, new RecoveryDecisionEngine());
  const recoveryExecutionService = new RecoveryExecutionService(repository, new SimulatedPaymentProvider());
  const analyticsService = new RecoveryAnalyticsService({ prisma: mockPrisma });

  return createApp({
    transactionService,
    recoveryExecutionService,
    analyticsService
  });
}

describe('API Hardening & Robustness (Task 6.12)', () => {
  describe('A. Malformed JSON Request Handling', () => {
    test('rejects syntactically invalid JSON with HTTP 400 and safe VALIDATION_ERROR response', async () => {
      const app = createMockApp();
      const response = await request(app)
        .post('/api/transactions')
        .set('Content-Type', 'application/json')
        .send('{"amount": 5000, "currency": "INR", customerId: "unquoted"}');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed JSON in request body'
        }
      });
      expect(response.body.error).not.toHaveProperty('stack');
      expect(response.text).not.toContain('SyntaxError');
    });

    test('rejects truncated JSON with HTTP 400 without exposing parser internals', async () => {
      const app = createMockApp();
      const response = await request(app)
        .post('/api/transactions')
        .set('Content-Type', 'application/json')
        .send('{"amount": 5000, "currency": ');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed JSON in request body'
        }
      });
      expect(response.text).not.toContain('Unexpected end of JSON');
    });
  });

  describe('B. Request Body Size Limits (Payload Too Large)', () => {
    test('rejects JSON payloads exceeding 100kb with HTTP 413 and safe error message', async () => {
      const app = createMockApp();
      // Generate a string exceeding 100kb (e.g. 110kb of dummy customer notes/id)
      const oversizedData = 'x'.repeat(105 * 1024);
      const response = await request(app)
        .post('/api/transactions')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({
          amount: 5000,
          currency: 'INR',
          customerId: oversizedData
        }));

      expect(response.status).toBe(413);
      expect(response.body).toEqual({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body is too large'
        }
      });
      expect(response.body.error).not.toHaveProperty('stack');
    });
  });

  describe('C. Framework Information Disclosure (X-Powered-By)', () => {
    test('verifies X-Powered-By header is disabled across successful and error responses', async () => {
      const app = createMockApp();

      // Normal response
      const normalRes = await request(app).get('/api/analytics/recovery');
      expect(normalRes.headers['x-powered-by']).toBeUndefined();

      // Error response (404)
      const notFoundRes = await request(app).get('/api/nonexistent');
      expect(notFoundRes.headers['x-powered-by']).toBeUndefined();

      // Error response (400)
      const badReqRes = await request(app)
        .post('/api/transactions')
        .set('Content-Type', 'application/json')
        .send('{ invalid }');
      expect(badReqRes.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('D. Unknown Route Handling', () => {
    test('returns consistent HTTP 404 ROUTE_NOT_FOUND response for nonexistent endpoints', async () => {
      const app = createMockApp();
      const response = await request(app).get('/api/unknown/endpoint');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'ROUTE_NOT_FOUND',
          message: 'Route not found',
          details: {
            path: '/api/unknown/endpoint'
          }
        }
      });
    });
  });

  describe('E. Prisma Initialization Error Handling', () => {
    test('maps PrismaClientInitializationError to HTTP 500 PERSISTENCE_ERROR without leaking connection credentials', async () => {
      const app = createMockApp({ throwInitError: true });
      const response = await request(app)
        .post('/api/transactions')
        .send({
          amount: 5000,
          currency: 'INR',
          customerId: 'cust_1'
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: 'PERSISTENCE_ERROR',
          message: 'A database operation failed'
        }
      });
      expect(response.text).not.toContain('localhost');
      expect(response.text).not.toContain('5432');
      expect(response.text).not.toContain('database server');
      expect(response.body.error).not.toHaveProperty('stack');
    });
  });

  describe('F. Regression-Sensitive Existing Behavior', () => {
    test('preserves RFC4122 UUID validation error (400) on transaction routes', async () => {
      const app = createMockApp();
      const response = await request(app).get('/api/transactions/not-a-valid-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.transactionId).toBe('transactionId must be a valid UUID');
    });

    test('preserves resource not found error (404) for nonexistent transactions', async () => {
      const app = createMockApp();
      const response = await request(app).get('/api/transactions/c4c23c30-99e8-4d89-9e12-5a3cbd7c740a');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(response.body.error.message).toBe('Transaction not found');
    });

    test('preserves field validation errors on create transaction', async () => {
      const app = createMockApp();
      const response = await request(app).post('/api/transactions').send({
        amount: -100,
        currency: 'INVALID'
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.amount).toBe('amount must be a positive decimal value');
      expect(response.body.error.details.currency).toBe('currency must be a three-letter uppercase ISO code');
      expect(response.body.error.details.customerId).toBe('customerId is required');
    });

    test('preserves analytics endpoint accessibility', async () => {
      const app = createMockApp();
      const response = await request(app).get('/api/analytics/recovery');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('operational');
      expect(response.body.data).toHaveProperty('model');
      expect(response.body.data).toHaveProperty('benchmark');
    });
  });
});
