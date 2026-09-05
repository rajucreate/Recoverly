import crypto from 'node:crypto';
import request from 'supertest';
import { prisma } from '../src/config/prisma.js';
import { createApp } from '../src/app.js';
import { SimulatedPaymentProvider } from '../src/providers/simulated-payment-provider.js';

describe('Batch-Level Revenue Recovery & Monetary Analytics PostgreSQL Integration', () => {
  const createdTransactionIds = new Set();
  let app;
  let simulatedProvider;

  beforeAll(() => {
    simulatedProvider = new SimulatedPaymentProvider();
    app = createApp({ paymentProvider: simulatedProvider });
  });

  afterAll(async () => {
    if (createdTransactionIds.size > 0) {
      await prisma.transaction.deleteMany({
        where: { id: { in: Array.from(createdTransactionIds) } }
      });
    }
  });

  test('End-to-End Batch Monetary Recovery: creates batch, executes recovery, and verifies monetary outcome', async () => {
    // 1. Create 3 transactions in batch + 1 outside transaction
    const resTxn1 = await request(app).post('/api/transactions').send({
      amount: '10000.00',
      currency: 'INR',
      customerId: `batch-cust-${crypto.randomUUID()}`
    });
    expect(resTxn1.status).toBe(201);
    const txn1Id = resTxn1.body.data.id;
    createdTransactionIds.add(txn1Id);

    const resTxn2 = await request(app).post('/api/transactions').send({
      amount: '5000.00',
      currency: 'INR',
      customerId: `batch-cust-${crypto.randomUUID()}`
    });
    expect(resTxn2.status).toBe(201);
    const txn2Id = resTxn2.body.data.id;
    createdTransactionIds.add(txn2Id);

    const resTxn3 = await request(app).post('/api/transactions').send({
      amount: '2000.00',
      currency: 'INR',
      customerId: `batch-cust-${crypto.randomUUID()}`
    });
    expect(resTxn3.status).toBe(201);
    const txn3Id = resTxn3.body.data.id;
    createdTransactionIds.add(txn3Id);

    // Outside transaction (large amount to prove batch isolation)
    const resTxnOutside = await request(app).post('/api/transactions').send({
      amount: '500000.00',
      currency: 'INR',
      customerId: `batch-cust-${crypto.randomUUID()}`
    });
    expect(resTxnOutside.status).toBe(201);
    const txnOutsideId = resTxnOutside.body.data.id;
    createdTransactionIds.add(txnOutsideId);

    // 2. Fail attempt 1 on all transactions
    const resAtt1 = await request(app).post(`/api/transactions/${txn1Id}/attempts`).send({
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Network timeout during debit'
    });
    expect(resAtt1.status).toBe(201);
    const action1Id = resAtt1.body.data.recoveryAction.id;

    const resAtt2 = await request(app).post(`/api/transactions/${txn2Id}/attempts`).send({
      paymentMethod: 'CARD',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Bank gateway downtime'
    });
    expect(resAtt2.status).toBe(201);
    const action2Id = resAtt2.body.data.recoveryAction.id;

    const resAtt3 = await request(app).post(`/api/transactions/${txn3Id}/attempts`).send({
      paymentMethod: 'NET_BANKING',
      outcome: 'FAILED',
      failureCategory: 'CUSTOMER_ACTION_REQUIRED',
      failureReason: 'Mandatory OTP required'
    });
    expect(resAtt3.status).toBe(201);
    const action3Id = resAtt3.body.data.recoveryAction.id;

    // Fail attempt on outside transaction as well
    await request(app).post(`/api/transactions/${txnOutsideId}/attempts`).send({
      paymentMethod: 'UPI',
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
      failureReason: 'Outside failure'
    });

    // 3. Execute recovery:
    // Txn 1: SUCCESS via RETRY
    const rec1 = await request(app).post(`/api/transactions/${txn1Id}/recovery/execute`).send({
      recoveryActionId: action1Id,
      paymentMethod: 'UPI',
      providerOutcome: 'SUCCESS'
    });
    expect(rec1.status).toBe(200);

    // Txn 2: FAILED via RETRY
    const rec2 = await request(app).post(`/api/transactions/${txn2Id}/recovery/execute`).send({
      recoveryActionId: action2Id,
      paymentMethod: 'CARD',
      providerOutcome: 'FAILED'
    });
    expect(rec2.status).toBe(200);

    // Txn 3: failed recovery remains unrecovered.
    const rec3 = await request(app).post(`/api/transactions/${txn3Id}/recovery/execute`).send({
      recoveryActionId: action3Id,
      paymentMethod: 'UPI',
      providerOutcome: 'FAILED'
    });
    expect(rec3.status).toBe(200);

    // 4. Request Batch Analytics for [txn1Id, txn2Id, txn3Id]
    const batchResponse = await request(app).get(
      `/api/analytics/recovery?transactionIds=${txn1Id},${txn2Id},${txn3Id}`
    );

    expect(batchResponse.status).toBe(200);
    expect(batchResponse.body).toHaveProperty('data');
    const { operational, batch } = batchResponse.body.data;

    expect(batch).toBeDefined();
    expect(batch.transactionIds).toEqual([txn1Id, txn2Id, txn3Id]);

    // Monetary assertions:
    // Revenue at risk = 10000 + 5000 + 2000 = 17000.00 (outside 500000 excluded)
    expect(batch.revenueAtRisk).toBe('17000.00');
    // Revenue recovered = 10000.00
    expect(batch.revenueRecovered).toBe('10000.00');
    // Monetary recovery rate = 10000 / 17000 = 0.5882
    expect(batch.monetaryRecoveryRate).toBe(0.5882);
    expect(batch.currency).toBe('INR');

    // Outcome counts:
    expect(batch.successfulRecoveries).toBe(1);
    expect(batch.failedRecoveries).toBe(2);
    expect(batch.stoppedRecoveries).toBe(0);
    expect(batch.pendingRecoveries).toBe(0);

    // Per-Action Breakdown:
    const { byAction } = batch;
    expect(byAction.RETRY.attemptedCount).toBe(2);
    expect(byAction.RETRY.successfulCount).toBe(1);
    expect(byAction.RETRY.failedCount).toBe(1);
    expect(byAction.RETRY.revenueAtRisk).toBe('15000.00');
    expect(byAction.RETRY.revenueRecovered).toBe('10000.00');
    expect(byAction.RETRY.monetaryRecoveryRate).toBe(0.6667);
    expect(byAction.RETRY.transactionRecoveryRate).toBe(0.5);

    expect(byAction.ALTERNATE_METHOD.attemptedCount).toBe(1);
    expect(byAction.ALTERNATE_METHOD.successfulCount).toBe(0);
    expect(byAction.ALTERNATE_METHOD.failedCount).toBe(1);
    expect(byAction.ALTERNATE_METHOD.revenueAtRisk).toBe('2000.00');
    expect(byAction.ALTERNATE_METHOD.revenueRecovered).toBe('0.00');
    expect(byAction.ALTERNATE_METHOD.monetaryRecoveryRate).toBe(0.0);
    expect(byAction.ALTERNATE_METHOD.transactionRecoveryRate).toBe(0.0);

    // Operational metrics match batch scope:
    expect(operational.transactionRecoveryRate.recoveredCount).toBe(1);
    expect(operational.transactionRecoveryRate.failedTransactionCount).toBe(3);
  });
});
