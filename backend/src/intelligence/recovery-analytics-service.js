import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { RecoveryActionType } from '../enums/recovery-action.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from './recovery-decision-policy.js';
import { ValidationError, NotFoundError } from '../errors/app-error.js';

export const DEFAULT_BENCHMARK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/phase-2/models/rule-vs-ml-evaluation.json'
);

const FAILURE_CATEGORIES = Object.freeze([
  'TEMPORARY_FAILURE',
  'PAYMENT_METHOD_FAILURE',
  'CUSTOMER_ACTION_REQUIRED',
  'UNKNOWN_FAILURE'
]);

const PAYMENT_METHODS = Object.freeze([
  'UPI',
  'CARD',
  'NET_BANKING'
]);

function round(value, decimals = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function calculateMedian(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function toDecimal(value) {
  if (value === null || value === undefined) return new Prisma.Decimal(0);
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(value.toString());
}

export class RecoveryAnalyticsService {
  constructor({
    prisma = null,
    transactionRepository = null,
    feedbackService = null,
    auditService = null,
    benchmarkPath = null
  } = {}) {
    this.prisma = prisma || transactionRepository?.prisma || null;
    this.feedbackService = feedbackService;
    this.auditService = auditService;
    this.benchmarkPath = benchmarkPath || DEFAULT_BENCHMARK_PATH;
    this.cachedBenchmark = undefined;
  }

  async getOperationalMetrics(options = {}) {
    if (!this.prisma) {
      return this._getEmptyOperationalMetrics();
    }

    const transactionIds = Array.isArray(options) ? options : (options?.transactionIds ?? null);
    const hasBatchFilter = Array.isArray(transactionIds) && transactionIds.length > 0;

    let currencies = new Set();
    if (hasBatchFilter) {
      const existingTxns = await this.prisma.transaction.findMany({
        where: { id: { in: transactionIds } },
        select: { id: true, currency: true }
      });
      const foundMap = new Set((existingTxns || []).map((t) => t.id));
      const missingId = transactionIds.find((id) => !foundMap.has(id));
      if (missingId) {
        throw new NotFoundError('Transaction', missingId);
      }
      currencies = new Set((existingTxns || []).map((t) => t.currency).filter(Boolean));
    }

    const actionWhere = hasBatchFilter
      ? { transactionId: { in: transactionIds } }
      : {};

    const [executedPaymentActions, allRecoveryActions, failedTransactions] = await Promise.all([
      this.prisma.recoveryAction.findMany({
        where: {
          ...actionWhere,
          actionType: { in: [RecoveryActionType.RETRY, RecoveryActionType.ALTERNATE_METHOD] },
          status: { in: ['SUCCESS', 'FAILED'] }
        },
        include: {
          attempt: {
            select: {
              failureCategory: true,
              paymentMethod: true
            }
          }
        }
      }),
      this.prisma.recoveryAction.findMany({
        where: actionWhere,
        select: {
          id: true,
          actionType: true,
          status: true,
          transactionId: true
        }
      }),
      this.prisma.transaction.findMany({
        where: {
          ...(hasBatchFilter ? { id: { in: transactionIds } } : {}),
          paymentAttempts: {
            some: { status: 'FAILED' }
          }
        },
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          paymentAttempts: {
            select: {
              attemptNumber: true,
              status: true
            }
          },
          recoveryActions: {
            select: {
              id: true,
              actionType: true,
              status: true
            }
          },
          recoveryJobs: {
            select: {
              id: true,
              status: true
            }
          }
        }
      })
    ]);

    if (!hasBatchFilter) {
      currencies = new Set(failedTransactions.map((t) => t.currency).filter(Boolean));
    }

    const hasMixedCurrencies = currencies.size > 1;

    if (hasBatchFilter && hasMixedCurrencies) {
      throw new ValidationError('Request validation failed', {
        currency: 'Mixed currencies cannot be aggregated in a single monetary recovery summary'
      });
    }

    const batchCurrency = currencies.size === 1
      ? Array.from(currencies)[0]
      : (failedTransactions.length > 0 ? failedTransactions[0].currency : null);

    // A. Action-level recovery execution rate
    const actionSuccessCount = executedPaymentActions.filter((a) => a.status === 'SUCCESS').length;
    const actionFailedCount = executedPaymentActions.filter((a) => a.status === 'FAILED').length;
    const actionTotalEligible = actionSuccessCount + actionFailedCount;
    const actionRecoveryRate = actionTotalEligible > 0
      ? round(actionSuccessCount / actionTotalEligible)
      : null;

    // B. Transaction-level recovery resolution rate
    const failedTransactionCount = failedTransactions.length;
    const isTxnRecovered = (txn) => {
      const hasSubsequentSuccessAttempt = (txn.paymentAttempts || []).some(
        (att) => att.status === 'SUCCESS' && att.attemptNumber > 1
      );
      return hasSubsequentSuccessAttempt;
    };

    // Preserve the legacy operational resolution metric. Monetary recovery below is
    // deliberately stricter and uses only isTxnRecovered.
    const isOperationallyResolved = (txn) => isTxnRecovered(txn) ||
      (txn.recoveryActions || []).some((action) => action.status === 'SUCCESS');

    const recoveredTransactions = failedTransactions.filter(isOperationallyResolved);
    const recoveredTransactionCount = recoveredTransactions.length;

    const transactionRecoveryRate = failedTransactionCount > 0
      ? round(recoveredTransactionCount / failedTransactionCount)
      : null;

    // C. Monetary metrics calculation with Decimal precision
    let revenueAtRiskDec = new Prisma.Decimal(0);
    let revenueRecoveredDec = new Prisma.Decimal(0);

    let successfulRecoveries = 0;
    let failedRecoveries = 0;
    let stoppedRecoveries = 0;
    let pendingRecoveries = 0;

    for (const txn of failedTransactions) {
      const amountDec = toDecimal(txn.amount);
      revenueAtRiskDec = revenueAtRiskDec.add(amountDec);

      if (isTxnRecovered(txn)) {
        revenueRecoveredDec = revenueRecoveredDec.add(amountDec);
        successfulRecoveries += 1;
      } else {
        const actions = txn.recoveryActions || [];
        const jobs = txn.recoveryJobs || [];

        const hasPendingAction = actions.some((a) => a.status === 'RECOMMENDED');
        const hasActiveJob = jobs.some((j) => ['QUEUED', 'PROCESSING', 'RETRY_PENDING'].includes(j.status));
        const hasStoppedAction = actions.some((a) => ['CUSTOMER_ACTION', 'ESCALATE'].includes(a.actionType) && a.status === 'EXECUTED');
        const hasDeadLetterJob = jobs.some((j) => j.status === 'DEAD_LETTER');
        const hasFailedPaymentAction = actions.some((a) => ['RETRY', 'ALTERNATE_METHOD'].includes(a.actionType) && a.status === 'FAILED');

        if (hasStoppedAction || hasDeadLetterJob) {
          stoppedRecoveries += 1;
        } else if (hasFailedPaymentAction && !hasPendingAction && !hasActiveJob) {
          failedRecoveries += 1;
        } else if (hasPendingAction || hasActiveJob || actions.length === 0) {
          pendingRecoveries += 1;
        } else {
          stoppedRecoveries += 1;
        }
      }
    }

    const monetaryRecoveryRate = revenueAtRiskDec.isZero()
      ? null
      : round(revenueRecoveredDec.dividedBy(revenueAtRiskDec).toNumber(), 4);

    // D. Per-recovery-action performance breakdown
    const actionTypes = [
      RecoveryActionType.RETRY,
      RecoveryActionType.ALTERNATE_METHOD,
      RecoveryActionType.CUSTOMER_ACTION,
      RecoveryActionType.ESCALATE
    ];

    const byAction = {};
    for (const actionType of actionTypes) {
      const typeActions = allRecoveryActions.filter((a) => a.actionType === actionType);

      let attemptedCount = 0;
      let successfulCount = 0;
      let failedCount = 0;
      let stoppedCount = 0;

      if (actionType === RecoveryActionType.RETRY || actionType === RecoveryActionType.ALTERNATE_METHOD) {
        const executed = typeActions.filter((a) => ['SUCCESS', 'FAILED'].includes(a.status));
        attemptedCount = executed.length;
        successfulCount = executed.filter((a) => a.status === 'SUCCESS').length;
        failedCount = executed.filter((a) => a.status === 'FAILED').length;
        stoppedCount = 0;
      } else {
        const executed = typeActions.filter((a) => a.status === 'EXECUTED');
        attemptedCount = executed.length;
        successfulCount = 0;
        failedCount = 0;
        stoppedCount = executed.length;
      }

      const actionTxns = failedTransactions.filter((txn) =>
        (txn.recoveryActions || []).some((a) => a.actionType === actionType)
      );

      let actionRevenueAtRiskDec = new Prisma.Decimal(0);
      let actionRevenueRecoveredDec = new Prisma.Decimal(0);

      for (const txn of actionTxns) {
        const amountDec = toDecimal(txn.amount);
        actionRevenueAtRiskDec = actionRevenueAtRiskDec.add(amountDec);

        const hasSubsequentSuccess = isTxnRecovered(txn);

        if (hasSubsequentSuccess) {
          actionRevenueRecoveredDec = actionRevenueRecoveredDec.add(amountDec);
        }
      }

      const actionMonetaryRate = actionRevenueAtRiskDec.isZero()
        ? null
        : round(actionRevenueRecoveredDec.dividedBy(actionRevenueAtRiskDec).toNumber(), 4);

      const actionTransactionRate = attemptedCount > 0
        ? round(successfulCount / attemptedCount, 4)
        : null;

      byAction[actionType] = {
        attemptedCount,
        successfulCount,
        failedCount,
        stoppedCount,
        revenueAtRisk: actionRevenueAtRiskDec.toFixed(2),
        revenueRecovered: actionRevenueRecoveredDec.toFixed(2),
        monetaryRecoveryRate: actionMonetaryRate,
        transactionRecoveryRate: actionTransactionRate
      };
    }

    // E. Recovery rate by failure category
    const byFailureCategory = {};
    for (const category of FAILURE_CATEGORIES) {
      const categoryActions = executedPaymentActions.filter(
        (a) => a.attempt?.failureCategory === category
      );
      const catSuccess = categoryActions.filter((a) => a.status === 'SUCCESS').length;
      const catFailed = categoryActions.filter((a) => a.status === 'FAILED').length;
      const catTotal = catSuccess + catFailed;
      byFailureCategory[category] = {
        rate: catTotal > 0 ? round(catSuccess / catTotal) : null,
        successCount: catSuccess,
        failedCount: catFailed,
        totalEligible: catTotal
      };
    }

    // F. Recovery rate by payment method
    const byPaymentMethod = {};
    for (const method of PAYMENT_METHODS) {
      const methodActions = executedPaymentActions.filter(
        (a) => a.attempt?.paymentMethod === method
      );
      const mSuccess = methodActions.filter((a) => a.status === 'SUCCESS').length;
      const mFailed = methodActions.filter((a) => a.status === 'FAILED').length;
      const mTotal = mSuccess + mFailed;
      byPaymentMethod[method] = {
        rate: mTotal > 0 ? round(mSuccess / mTotal) : null,
        successCount: mSuccess,
        failedCount: mFailed,
        totalEligible: mTotal
      };
    }

    // G. Retry success rate
    const retryActions = executedPaymentActions.filter((a) => a.actionType === RecoveryActionType.RETRY);
    const retrySuccess = retryActions.filter((a) => a.status === 'SUCCESS').length;
    const retryFailed = retryActions.filter((a) => a.status === 'FAILED').length;
    const retryTotal = retrySuccess + retryFailed;
    const retrySuccessRate = retryTotal > 0 ? round(retrySuccess / retryTotal) : null;

    // H. Alternate-method success rate
    const altActions = executedPaymentActions.filter((a) => a.actionType === RecoveryActionType.ALTERNATE_METHOD);
    const altSuccess = altActions.filter((a) => a.status === 'SUCCESS').length;
    const altFailed = altActions.filter((a) => a.status === 'FAILED').length;
    const altTotal = altSuccess + altFailed;
    const alternateMethodSuccessRate = altTotal > 0 ? round(altSuccess / altTotal) : null;

    // I. Escalation rate
    const totalRecommendations = allRecoveryActions.length;
    const escalateCount = allRecoveryActions.filter((a) => a.actionType === RecoveryActionType.ESCALATE).length;
    const escalationRate = totalRecommendations > 0 ? round(escalateCount / totalRecommendations) : null;

    const unavailableMonetaryBreakdown = Object.fromEntries(
      Object.entries(byAction).map(([actionType, metrics]) => [actionType, {
        ...metrics,
        revenueAtRisk: null,
        revenueRecovered: null,
        monetaryRecoveryRate: null
      }])
    );

    const monetary = {
      currency: hasMixedCurrencies ? null : batchCurrency,
      revenueAtRisk: hasMixedCurrencies ? null : revenueAtRiskDec.toFixed(2),
      revenueRecovered: hasMixedCurrencies ? null : revenueRecoveredDec.toFixed(2),
      monetaryRecoveryRate: hasMixedCurrencies ? null : monetaryRecoveryRate,
      successfulRecoveries,
      failedRecoveries,
      stoppedRecoveries,
      pendingRecoveries,
      byAction: hasMixedCurrencies ? unavailableMonetaryBreakdown : byAction
    };

    return {
      actionRecoveryRate: {
        rate: actionRecoveryRate,
        successCount: actionSuccessCount,
        failedCount: actionFailedCount,
        totalEligible: actionTotalEligible
      },
      transactionRecoveryRate: {
        rate: transactionRecoveryRate,
        recoveredCount: recoveredTransactionCount,
        failedTransactionCount: failedTransactionCount,
        totalEligible: failedTransactionCount
      },
      byFailureCategory,
      byPaymentMethod,
      retrySuccessRate: {
        rate: retrySuccessRate,
        successCount: retrySuccess,
        failedCount: retryFailed,
        totalEligible: retryTotal
      },
      alternateMethodSuccessRate: {
        rate: alternateMethodSuccessRate,
        successCount: altSuccess,
        failedCount: altFailed,
        totalEligible: altTotal
      },
      escalationRate: {
        rate: escalationRate,
        escalateCount,
        totalRecommendations
      },
      monetary
    };
  }

  getModelMetrics() {
    if (this.feedbackService?.repository || this.auditService?.repository) {
      return Promise.all([
        this.feedbackService?.repository?.findMany({ orderBy: { feedbackTimestamp: 'asc' } }) ?? [],
        this.auditService?.repository?.findMany({ orderBy: { decisionTimestamp: 'asc' } }) ?? []
      ]).then(([feedbackRecords, auditRecords]) => this._calculateModelMetrics(feedbackRecords, auditRecords));
    }
    return this._calculateModelMetrics(this.feedbackService?.buffer ?? [], this.auditService?.buffer ?? []);
  }

  _calculateModelMetrics(feedbackRecords, auditRecords) {

    // A. Prediction confidence (from audit records or feedback records where decision_source is ML)
    // Gather all distinct ML decisions with valid probabilities
    const mlProbabilities = [];
    const seenMlDecisions = new Set();

    for (const record of auditRecords) {
      if (record.decision_source === DECISION_SOURCES.ML && typeof record.selected_probability === 'number') {
        const prob = record.selected_probability;
        if (Number.isFinite(prob) && prob >= 0 && prob <= 1) {
          const key = record.correlation.recovery_action_id || record.correlation.attempt_id || record.audit_id;
          if (!seenMlDecisions.has(key)) {
            seenMlDecisions.add(key);
            mlProbabilities.push(prob);
          }
        }
      }
    }

    for (const record of feedbackRecords) {
      if (record.decision?.decision_source === DECISION_SOURCES.ML && typeof record.decision?.predicted_recovery_probability === 'number') {
        const prob = record.decision.predicted_recovery_probability;
        if (Number.isFinite(prob) && prob >= 0 && prob <= 1) {
          const key = record.correlation?.recovery_action_id || record.correlation?.trigger_attempt_id || record.feedback_id || String(Math.random());
          if (!seenMlDecisions.has(key)) {
            seenMlDecisions.add(key);
            mlProbabilities.push(prob);
          }
        }
      }
    }

    const bins = {
      '0.0-0.2': 0,
      '0.2-0.4': 0,
      '0.4-0.6': 0,
      '0.6-0.8': 0,
      '0.8-1.0': 0
    };

    let confidenceMean = null;
    let confidenceMin = null;
    let confidenceMax = null;
    let confidenceMedian = null;

    if (mlProbabilities.length > 0) {
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;

      for (const p of mlProbabilities) {
        sum += p;
        if (p < min) min = p;
        if (p > max) max = p;

        if (p < 0.2) bins['0.0-0.2'] += 1;
        else if (p < 0.4) bins['0.2-0.4'] += 1;
        else if (p < 0.6) bins['0.4-0.6'] += 1;
        else if (p < 0.8) bins['0.6-0.8'] += 1;
        else bins['0.8-1.0'] += 1;
      }

      confidenceMean = round(sum / mlProbabilities.length);
      confidenceMin = round(min);
      confidenceMax = round(max);
      confidenceMedian = round(calculateMedian(mlProbabilities));
    }

    // B. Runtime model performance (strictly ML records with binary actual_recovery_success outcome)
    let brierSum = 0;
    let correctCount = 0;
    let evalCount = 0;

    for (const record of feedbackRecords) {
      const p = record.decision?.predicted_recovery_probability;
      const isMl = record.decision?.decision_source === DECISION_SOURCES.ML;
      const hasValidProb = typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
      const hasBinaryOutcome = typeof record.execution?.actual_recovery_success === 'boolean';

      if (isMl && hasValidProb && hasBinaryOutcome) {
        const y = record.execution.actual_recovery_success ? 1.0 : 0.0;

        brierSum += (p - y) ** 2;

        const predictedPositive = p >= 0.5;
        const actualPositive = y === 1.0;
        if (predictedPositive === actualPositive) {
          correctCount += 1;
        }
        evalCount += 1;
      }
    }

    const brierScore = evalCount > 0 ? round(brierSum / evalCount) : null;
    const accuracy = evalCount > 0 ? round(correctCount / evalCount) : null;

    // C. Runtime traffic share (source breakdown)
    // Use all observed decisions from audit buffer (or feedback buffer if audit is empty)
    const sourceRecords = auditRecords.length > 0 ? auditRecords : feedbackRecords.map((f) => ({
      decision_source: f.decision.decision_source,
      fallback: f.decision.fallback
    }));

    let mlCount = 0;
    let ruleCount = 0;
    const fallbackReasons = {
      [FALLBACK_REASONS.MODEL_UNAVAILABLE]: 0,
      [FALLBACK_REASONS.INVALID_PREDICTION]: 0,
      [FALLBACK_REASONS.NO_SAFE_CANDIDATE]: 0
    };

    for (const record of sourceRecords) {
      const src = record.decision_source;
      if (src === DECISION_SOURCES.ML) {
        mlCount += 1;
      } else if (src === DECISION_SOURCES.RULE) {
        ruleCount += 1;
        const reason = record.fallback?.fallback_reason;
        if (reason && fallbackReasons[reason] !== undefined) {
          fallbackReasons[reason] += 1;
        }
      }
    }

    const totalDecisions = mlCount + ruleCount;
    const mlShare = totalDecisions > 0 ? round(mlCount / totalDecisions) : null;
    const ruleShare = totalDecisions > 0 ? round(ruleCount / totalDecisions) : null;

    return {
      predictionConfidence: {
        sampleCount: mlProbabilities.length,
        mean: confidenceMean,
        min: confidenceMin,
        max: confidenceMax,
        median: confidenceMedian,
        distributionBins: bins
      },
      runtimePerformance: {
        sampleCount: evalCount,
        brierScore,
        accuracy,
        accuracyThreshold: 0.5
      },
      trafficShare: {
        totalDecisions,
        mlCount,
        mlShare,
        ruleCount,
        ruleShare,
        fallbackReasons
      }
    };
  }

  getBenchmarkMetrics() {
    if (this.cachedBenchmark !== undefined) {
      return this.cachedBenchmark;
    }
    try {
      if (fs.existsSync(this.benchmarkPath)) {
        const fileContent = fs.readFileSync(this.benchmarkPath, 'utf8');
        this.cachedBenchmark = JSON.parse(fileContent);
        return this.cachedBenchmark;
      }
    } catch {
      // Return null gracefully if benchmark file is unavailable
    }
    this.cachedBenchmark = null;
    return null;
  }

  async getAnalyticsSummary(options = {}) {
    const transactionIds = Array.isArray(options) ? options : (options?.transactionIds ?? null);
    const [operational, model, benchmark] = await Promise.all([
      this.getOperationalMetrics({ transactionIds }),
      this.getModelMetrics(),
      Promise.resolve(this.getBenchmarkMetrics())
    ]);

    return {
      operational,
      batch: transactionIds && transactionIds.length > 0 ? {
        transactionIds,
        ...operational.monetary
      } : null,
      model,
      benchmark
    };
  }

  _getEmptyOperationalMetrics() {
    const emptyCategory = {};
    for (const c of FAILURE_CATEGORIES) {
      emptyCategory[c] = { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 };
    }
    const emptyMethod = {};
    for (const m of PAYMENT_METHODS) {
      emptyMethod[m] = { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 };
    }
    const emptyByAction = {};
    for (const actionType of [RecoveryActionType.RETRY, RecoveryActionType.ALTERNATE_METHOD, RecoveryActionType.CUSTOMER_ACTION, RecoveryActionType.ESCALATE]) {
      emptyByAction[actionType] = {
        attemptedCount: 0,
        successfulCount: 0,
        failedCount: 0,
        stoppedCount: 0,
        revenueAtRisk: '0.00',
        revenueRecovered: '0.00',
        monetaryRecoveryRate: null,
        transactionRecoveryRate: null
      };
    }

    return {
      actionRecoveryRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      transactionRecoveryRate: { rate: null, recoveredCount: 0, failedTransactionCount: 0, totalEligible: 0 },
      byFailureCategory: emptyCategory,
      byPaymentMethod: emptyMethod,
      retrySuccessRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      alternateMethodSuccessRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      escalationRate: { rate: null, escalateCount: 0, totalRecommendations: 0 },
      monetary: {
        currency: null,
        revenueAtRisk: '0.00',
        revenueRecovered: '0.00',
        monetaryRecoveryRate: null,
        successfulRecoveries: 0,
        failedRecoveries: 0,
        stoppedRecoveries: 0,
        pendingRecoveries: 0,
        byAction: emptyByAction
      }
    };
  }
}
