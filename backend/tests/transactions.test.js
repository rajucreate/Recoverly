import request from 'supertest';
import { jest } from '@jest/globals';
import { createApp } from '../src/app.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryDecisionEngine } from '../src/services/recovery-decision-engine.js';
import { RecoveryDecisionPolicy } from '../src/intelligence/recovery-decision-policy.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';

const transactionId = 'c4c23c30-99e8-4d89-9e12-5a3cbd7c740a';
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const payloads = {
  success: { paymentMethod: 'UPI', outcome: 'SUCCESS' },
  failedUpi: { paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', failureReason: 'Bank unavailable' },
  failedCard: { paymentMethod: 'CARD', outcome: 'FAILED', failureCategory: 'PAYMENT_METHOD_FAILURE', failureReason: 'Card declined' }
};

function makeTransaction(status = 'PENDING') {
  return { id: transactionId, amount: { toString: () => '5000' }, currency: 'INR', customerId: 'customer-001', status, createdAt, updatedAt: createdAt };
}

function buildApp({ transaction = makeTransaction(), failUpdate = false, failRecoveryAction = false, failRecoveryCompletion = false } = {}) {
  const state = { transactions: new Map(transaction ? [[transaction.id, transaction]] : []), attempts: [], recoveryActions: [] };
  let sequence = 1;
  const client = {
    transaction: {
      create: jest.fn(async ({ data }) => {
        const record = { ...makeTransaction(data.status), ...data, id: transactionId, createdAt, updatedAt: createdAt };
        state.transactions.set(record.id, record);
        return record;
      }),
      findUnique: jest.fn(async ({ where, select }) => {
        const record = state.transactions.get(where.id);
        if (!record) return null;
        if (select) return {
          id: record.id,
          status: record.status,
          _count: { paymentAttempts: state.attempts.filter((attempt) => attempt.transactionId === where.id).length },
          paymentAttempts: state.attempts.filter((attempt) => attempt.transactionId === where.id && attempt.status === 'FAILED' && attempt.failureCategory === 'TEMPORARY_FAILURE')
        };
        return { ...record, paymentAttempts: state.attempts.filter((attempt) => attempt.transactionId === where.id), recoveryActions: state.recoveryActions.filter((action) => action.transactionId === where.id) };
      }),
      update: jest.fn(async ({ where, data }) => {
        if (failUpdate) throw new Error('simulated update failure');
        const record = state.transactions.get(where.id);
        const updated = { ...record, ...data, updatedAt: createdAt };
        state.transactions.set(where.id, updated);
        return updated;
      })
    },
    paymentAttempt: {
      create: jest.fn(async ({ data }) => {
        const attempt = { id: `d4c23c30-99e8-4d89-9e12-5a3cbd7c740${sequence++}`, ...data, createdAt };
        state.attempts.push(attempt);
        return attempt;
      })
    },
    recoveryAction: {
      create: jest.fn(async ({ data }) => {
        if (failRecoveryAction) throw new Error('simulated recovery action failure');
        if (state.recoveryActions.some((action) => action.attemptId === data.attemptId)) throw new Error('unique constraint failed');
        const action = { id: `a4c23c30-99e8-4d89-9e12-5a3cbd7c740${sequence++}`, ...data, createdAt };
        state.recoveryActions.push(action);
        return action;
      }),
      findFirst: jest.fn(async ({ where }) => {
        const action = state.recoveryActions.find((item) => item.id === where.id && item.transactionId === where.transactionId);
        if (!action) return null;
        return { ...action, attempt: state.attempts.find((attempt) => attempt.id === action.attemptId) ? { paymentMethod: state.attempts.find((attempt) => attempt.id === action.attemptId).paymentMethod } : null };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        if (failUpdate || (failRecoveryCompletion && (data.status === 'SUCCESS' || data.status === 'FAILED'))) throw new Error('simulated update failure');
        const index = state.recoveryActions.findIndex((action) => action.id === where.id);
        if (index < 0 || state.recoveryActions[index].status !== where.status) return { count: 0 };
        state.recoveryActions[index] = { ...state.recoveryActions[index], ...data };
        return { count: 1 };
      })
    }
  };
  client.$transaction = jest.fn(async (work) => {
    const snapshot = { transactions: new Map(state.transactions), attempts: [...state.attempts], recoveryActions: [...state.recoveryActions] };
    try { return await work(client); } catch (error) { state.transactions = snapshot.transactions; state.attempts = snapshot.attempts; state.recoveryActions = snapshot.recoveryActions; throw error; }
  });
  const repository = new TransactionRepository(client);
  const decisionPolicy = new RecoveryDecisionPolicy(
    { predictAll: () => { throw new Error('ML model bypassed in Phase 1 regression test'); } },
    new RecoveryDecisionEngine()
  );
  const app = createApp({
    transactionService: new TransactionService(repository, new RecoveryDecisionEngine(), undefined, decisionPolicy),
    recoveryExecutionService: new RecoveryExecutionService(repository, new SimulatedPaymentProvider())
  });
  return { app, client, state };
}

describe('Transaction APIs', () => {
  test('creates a valid pending transaction', async () => {
    const { app, client } = buildApp({ transaction: null });
    const response = await request(app).post('/api/transactions').send({ amount: 5000, currency: 'INR', customerId: 'customer-001' });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ amount: '5000', status: 'PENDING' });
    expect(client.transaction.create).toHaveBeenCalled();
  });

  test('rejects invalid transaction input', async () => {
    const { app } = buildApp();
    const response = await request(app).post('/api/transactions').send({ amount: 0 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('creates a successful UPI attempt and updates the transaction', async () => {
    const { app, state } = buildApp();
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.success);
    expect(response.status).toBe(201);
    expect(response.body.data.attempt).toMatchObject({ paymentMethod: 'UPI', outcome: 'SUCCESS', attemptNumber: 1, failureCategory: null, failureReason: null });
    expect(response.body.data.recoveryAction).toBeNull();
    expect(state.transactions.get(transactionId).status).toBe('SUCCESS');
  });

  test('creates failed UPI and CARD attempts and marks the transaction failed', async () => {
    const { app, state } = buildApp();
    const upi = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect(upi.status).toBe(201);
    expect(upi.body.data.attempt).toMatchObject({ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'TEMPORARY_FAILURE', attemptNumber: 1 });
    expect(upi.body.data.recoveryAction).toMatchObject({ actionType: 'RETRY', status: 'RECOMMENDED' });
    const card = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedCard);
    expect(card.status).toBe(201);
    expect(card.body.data.attempt).toMatchObject({ paymentMethod: 'CARD', outcome: 'FAILED', attemptNumber: 2 });
    expect(card.body.data.recoveryAction).toMatchObject({ actionType: 'ALTERNATE_METHOD' });
    expect(state.transactions.get(transactionId).status).toBe('FAILED');
  });

  test.each([
    [{ paymentMethod: 'UPI', outcome: 'FAILED', failureReason: 'No category' }, 'failureCategory'],
    [{ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory: 'UNKNOWN_FAILURE' }, 'failureReason'],
    [{ paymentMethod: 'UPI', outcome: 'SUCCESS', failureCategory: 'UNKNOWN_FAILURE' }, 'failureCategory'],
    [{ paymentMethod: 'CASH', outcome: 'SUCCESS' }, 'paymentMethod'],
    [{ paymentMethod: 'UPI', outcome: 'PENDING' }, 'outcome']
  ])('rejects invalid attempt input', async (body, field) => {
    const { app } = buildApp();
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.details[field]).toEqual(expect.any(String));
  });

  test('returns 404 for a non-existent transaction', async () => {
    const { app } = buildApp({ transaction: null });
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.success);
    expect(response.status).toBe(404);
  });

  test('rejects a malformed transaction id', async () => {
    const { app } = buildApp();
    const response = await request(app).post('/api/transactions/not-a-uuid/attempts').send(payloads.success);
    expect(response.status).toBe(400);
  });

  test('rejects an attempt on a successful transaction', async () => {
    const { app } = buildApp({ transaction: makeTransaction('SUCCESS') });
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('rejects a direct success attempt after the transaction has failed', async () => {
    const { app, state } = buildApp();
    await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.success);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(state.attempts).toHaveLength(1);
    expect(state.transactions.get(transactionId).status).toBe('FAILED');
  });

  test('treats RECOVERED as terminal until that state is introduced by a later phase', async () => {
    const { app } = buildApp({ transaction: makeTransaction('RECOVERED') });
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('atomically rolls back an attempt when its status update fails', async () => {
    const { app, state } = buildApp({ failUpdate: true });
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect(response.status).toBe(500);
    expect(state.attempts).toHaveLength(0);
    expect(state.transactions.get(transactionId).status).toBe('PENDING');
  });

  test('atomically rolls back the attempt and transaction update when recovery action persistence fails', async () => {
    const { app, state } = buildApp({ failRecoveryAction: true });
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect(response.status).toBe(500);
    expect(state.attempts).toHaveLength(0);
    expect(state.recoveryActions).toHaveLength(0);
    expect(state.transactions.get(transactionId).status).toBe('PENDING');
  });

  test('persists recovery actions with the correct transaction and attempt, enforcing retry policy', async () => {
    const { app, state } = buildApp();
    const first = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const second = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const third = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    expect([first, second, third].map(({ body }) => body.data.recoveryAction.actionType)).toEqual(['RETRY', 'RETRY', 'ESCALATE']);
    expect(state.recoveryActions).toHaveLength(3);
    expect(state.recoveryActions[0]).toMatchObject({ transactionId, attemptId: first.body.data.attempt.id, status: 'RECOMMENDED' });
  });

  test('does not allow a second recovery action for the same payment attempt', async () => {
    const { app, client } = buildApp();
    const response = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const action = response.body.data.recoveryAction;
    await expect(client.recoveryAction.create({ data: {
      transactionId,
      attemptId: action.attemptId,
      actionType: action.actionType,
      reason: action.reason,
      status: action.status
    } })).rejects.toThrow('unique constraint failed');
  });

  test('returns payment attempt history from transaction retrieval', async () => {
    const { app } = buildApp();
    await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const response = await request(app).get(`/api/transactions/${transactionId}`);
    expect(response.status).toBe(200);
    expect(response.body.data.paymentAttempts).toHaveLength(1);
    expect(response.body.data.paymentAttempts[0]).toMatchObject({ attemptNumber: 1, paymentMethod: 'UPI' });
  });

  test('executes a RETRY recovery successfully using the original payment method and preserves history', async () => {
    const { app, state } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: failed.body.data.recoveryAction.id, providerOutcome: 'SUCCESS' });
    expect(response.status).toBe(200);
    expect(response.body.data.attempt).toMatchObject({ paymentMethod: 'UPI', outcome: 'SUCCESS', attemptNumber: 2 });
    expect(response.body.data.recoveryAction.status).toBe('SUCCESS');
    expect(state.transactions.get(transactionId).status).toBe('SUCCESS');
    expect(state.attempts).toHaveLength(2);
  });

  test('records a failed RETRY recovery attempt and marks the action and transaction failed', async () => {
    const { app, state } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: failed.body.data.recoveryAction.id, providerOutcome: 'FAILED' });
    expect(response.status).toBe(200);
    expect(response.body.data.attempt).toMatchObject({ outcome: 'FAILED', attemptNumber: 2, failureCategory: 'UNKNOWN_FAILURE' });
    expect(response.body.data.recoveryAction.status).toBe('FAILED');
    expect(state.transactions.get(transactionId).status).toBe('FAILED');
  });

  test('executes ALTERNATE_METHOD only with a different method', async () => {
    const { app, state } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedCard);
    const actionId = failed.body.data.recoveryAction.id;
    const sameMethod = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: actionId, paymentMethod: 'CARD', providerOutcome: 'SUCCESS' });
    expect(sameMethod.status).toBe(409);
    expect(state.recoveryActions[0].status).toBe('RECOMMENDED');
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: actionId, paymentMethod: 'UPI', providerOutcome: 'SUCCESS' });
    expect(response.status).toBe(200);
    expect(response.body.data.attempt).toMatchObject({ paymentMethod: 'UPI', outcome: 'SUCCESS' });
  });

  test.each([
    ['CUSTOMER_ACTION_REQUIRED', 'CUSTOMER_ACTION'],
    ['UNKNOWN_FAILURE', 'ESCALATE']
  ])('%s recovery is marked executed without creating an attempt', async (failureCategory, actionType) => {
    const { app, state } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send({ paymentMethod: 'UPI', outcome: 'FAILED', failureCategory, failureReason: 'Recovery requires follow-up' });
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: failed.body.data.recoveryAction.id });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ attempt: null, recoveryAction: { actionType, status: 'EXECUTED' } });
    expect(state.attempts).toHaveLength(1);
  });

  test('rejects duplicate recovery execution', async () => {
    const { app } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const body = { recoveryActionId: failed.body.data.recoveryAction.id, providerOutcome: 'SUCCESS' };
    expect((await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send(body)).status).toBe(200);
    const duplicate = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send(body);
    expect(duplicate.status).toBe(409);
  });

  test('rejects a recovery action that does not belong to the transaction', async () => {
    const { app, state } = buildApp();
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    state.recoveryActions[0].transactionId = 'b4c23c30-99e8-4d89-9e12-5a3cbd7c740a';
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: failed.body.data.recoveryAction.id, providerOutcome: 'SUCCESS' });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'RESOURCE_NOT_FOUND', message: 'RecoveryAction not found' });
  });

  test.each([
    [{ recoveryActionId: 'not-a-uuid' }, 'recoveryActionId'],
    [{ recoveryActionId: null }, 'recoveryActionId'],
    [{ recoveryActionId: transactionId, paymentMethod: null }, 'paymentMethod'],
    [{ recoveryActionId: transactionId, providerOutcome: 'MAYBE' }, 'providerOutcome']
  ])('validates malformed recovery execution data', async (body, field) => {
    const { app } = buildApp();
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.details[field]).toEqual(expect.any(String));
  });

  test('rejects recovery execution unless the transaction is failed', async () => {
    const { app } = buildApp();
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: transactionId, providerOutcome: 'SUCCESS' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  test('rolls back recovery execution when transaction persistence fails', async () => {
    const { app, state } = buildApp({ failRecoveryCompletion: true });
    const failed = await request(app).post(`/api/transactions/${transactionId}/attempts`).send(payloads.failedUpi);
    const response = await request(app).post(`/api/transactions/${transactionId}/recovery/execute`).send({ recoveryActionId: failed.body.data.recoveryAction.id, providerOutcome: 'SUCCESS' });
    expect(response.status).toBe(500);
    expect(state.attempts).toHaveLength(1);
    expect(state.recoveryActions[0].status).toBe('RECOMMENDED');
    expect(state.transactions.get(transactionId).status).toBe('FAILED');
  });
});
