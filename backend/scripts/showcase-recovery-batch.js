import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/config/prisma.js';
import { TransactionRepository } from '../src/repositories/transaction-repository.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { RecoveryExecutionService } from '../src/services/recovery-execution-service.js';
import { RecoveryAnalyticsService } from '../src/intelligence/recovery-analytics-service.js';

// Demo-only, deterministic input generator. Analytics is never precomputed here.
const BATCH_ID = 'recoverly-showcase-v1';
const CUSTOMER_PREFIX = `${BATCH_ID}-customer-`;
const SEED = 20260905;
const COUNT = 500;
const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../data/demo/${BATCH_ID}.json`);

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) { return values[Math.floor(random() * values.length)]; }
function shuffle(random, values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function alternateMethod(method) {
  return ({ UPI: 'CARD', CARD: 'NET_BANKING', NET_BANKING: 'UPI' })[method];
}
function amount(random) {
  // A right-skewed INR checkout distribution, from small everyday payments to larger orders.
  const value = Math.round((149 + (random() ** 2) * 24851) * 100) / 100;
  return value.toFixed(2);
}

class ShowcaseProvider {
  providerId = 'showcase-simulator';
  async executePayment(request) {
    const outcome = request.providerRequest?.showcaseOutcome;
    if (outcome === 'SUCCESS') return { outcome: 'SUCCESS' };
    if (outcome === 'FAILED') {
      return {
        outcome: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        failureReason: 'Synthetic issuer timeout during recovery.',
        retryable: false
      };
    }
    throw new Error('Showcase recovery execution requires a deterministic outcome directive.');
  }
}

// Deliberately make the policy take its existing rule-engine fallback. This keeps
// the selected action tied to the normal failure-category/retry-limit rules,
// without using model output to fabricate a demo outcome.
const unavailablePredictionService = {
  predictAll() { throw new Error('Showcase generator intentionally uses rule fallback.'); }
};

const failureReasons = {
  TEMPORARY_FAILURE: 'Issuer network timeout before authorization completed.',
  PAYMENT_METHOD_FAILURE: 'Selected payment method was declined by the issuing bank.',
  CUSTOMER_ACTION_REQUIRED: 'Additional customer authentication is required.',
  UNKNOWN_FAILURE: 'Gateway returned an unclassified processing error.'
};

async function cleanup() {
  const result = await prisma.transaction.deleteMany({ where: { customerId: { startsWith: CUSTOMER_PREFIX } } });
  await fs.rm(manifestPath, { force: true });
  console.log(JSON.stringify({ batchId: BATCH_ID, deletedTransactions: result.count }, null, 2));
}

async function report() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const summary = await new RecoveryAnalyticsService({ prisma }).getAnalyticsSummary({ transactionIds: manifest.transactionIds });
  const { transactionIds: _transactionIds, ...batchMetrics } = summary.batch;
  console.log(JSON.stringify({ batchId: manifest.batchId, transactionCount: manifest.transactionIds.length, ...batchMetrics }, null, 2));
}

async function verify() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const transactions = await prisma.transaction.findMany({
    where: { id: { in: manifest.transactionIds } },
    select: { id: true, amount: true, paymentAttempts: { select: { status: true, attemptNumber: true } } }
  });
  const recovered = transactions.filter((transaction) => transaction.paymentAttempts.some(
    (attempt) => attempt.status === 'SUCCESS' && attempt.attemptNumber > 1
  ));
  const recoveredAmount = recovered.reduce((sum, transaction) => sum + Number(transaction.amount), 0).toFixed(2);
  const summary = await new RecoveryAnalyticsService({ prisma }).getAnalyticsSummary({ transactionIds: manifest.transactionIds });
  const prefixCount = await prisma.transaction.count({ where: { customerId: { startsWith: CUSTOMER_PREFIX } } });
  const checks = {
    manifestIdsResolved: transactions.length === manifest.transactionIds.length,
    batchIsolation: prefixCount === manifest.transactionIds.length,
    recoveredOnlyFromSubsequentSuccess: recovered.length === summary.batch.successfulRecoveries,
    headlineRecoveredRevenueMatchesSubsequentSuccesses: recoveredAmount === summary.batch.revenueRecovered,
    headlineTransactionsAreUnique: new Set(transactions.map((transaction) => transaction.id)).size === transactions.length
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(`Showcase verification failed: ${JSON.stringify(checks)}`);
  console.log(JSON.stringify({ checks, recoveredTransactionCount: recovered.length, recoveredAmount }, null, 2));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--cleanup')) return cleanup();
  if (args.has('--report')) return report();
  if (args.has('--verify')) return verify();
  if (args.has('--reset')) await cleanup();

  const existing = await prisma.transaction.count({ where: { customerId: { startsWith: CUSTOMER_PREFIX } } });
  if (existing > 0) {
    throw new Error(`Showcase batch already exists (${existing} transactions). Run npm run demo:showcase:reset to replace only this demo batch.`);
  }

  const random = rng(SEED);
  const outcomes = shuffle(random, [
    ...Array(290).fill('RECOVERED'),
    ...Array(75).fill('FAILED'),
    ...Array(75).fill('STOPPED'),
    ...Array(60).fill('PENDING')
  ]);
  const repository = new TransactionRepository(prisma);
  const transactions = new TransactionService(repository, undefined, unavailablePredictionService);
  const execution = new RecoveryExecutionService(repository, new ShowcaseProvider());
  const ids = [];

  for (let index = 0; index < COUNT; index += 1) {
    const intended = outcomes[index];
    const paymentMethod = pick(random, ['UPI', 'UPI', 'CARD', 'CARD', 'NET_BANKING']);
    const failureCategory = intended === 'STOPPED'
      ? pick(random, ['CUSTOMER_ACTION_REQUIRED', 'UNKNOWN_FAILURE'])
      : intended === 'PENDING'
        ? pick(random, ['TEMPORARY_FAILURE', 'PAYMENT_METHOD_FAILURE', 'CUSTOMER_ACTION_REQUIRED', 'UNKNOWN_FAILURE'])
        : pick(random, ['TEMPORARY_FAILURE', 'TEMPORARY_FAILURE', 'PAYMENT_METHOD_FAILURE']);
    const transaction = await transactions.createTransaction({
      amount: amount(random), currency: 'INR', customerId: `${CUSTOMER_PREFIX}${String(index + 1).padStart(4, '0')}`
    });
    ids.push(transaction.id);
    const initial = await transactions.createPaymentAttempt(transaction.id, {
      paymentMethod, outcome: 'FAILED', failureCategory, failureReason: failureReasons[failureCategory]
    });

    if (intended === 'PENDING') continue;
    const action = initial.recoveryAction;
    if (intended === 'STOPPED') {
      await execution.execute(transaction.id, { recoveryActionId: action.id });
      continue;
    }
    await execution.execute(transaction.id, {
      recoveryActionId: action.id,
      paymentMethod: action.actionType === 'ALTERNATE_METHOD' ? alternateMethod(paymentMethod) : undefined,
      providerRequest: { showcaseOutcome: intended === 'RECOVERED' ? 'SUCCESS' : 'FAILED' }
    });
  }

  const analytics = new RecoveryAnalyticsService({ prisma });
  const summary = await analytics.getAnalyticsSummary({ transactionIds: ids });
  const manifest = { batchId: BATCH_ID, seed: SEED, transactionIds: ids };
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const { transactionIds: _transactionIds, ...batchMetrics } = summary.batch;
  console.log(JSON.stringify({ batchId: BATCH_ID, transactionCount: ids.length, manifestPath, analytics: batchMetrics }, null, 2));
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
