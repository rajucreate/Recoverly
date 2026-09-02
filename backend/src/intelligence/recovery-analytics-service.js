import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveryActionType } from '../enums/recovery-action.js';
import { DECISION_SOURCES, FALLBACK_REASONS } from './recovery-decision-policy.js';

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
  }

  async getOperationalMetrics() {
    if (!this.prisma) {
      return this._getEmptyOperationalMetrics();
    }

    const [executedPaymentActions, allRecoveryActions, failedTransactions] = await Promise.all([
      this.prisma.recoveryAction.findMany({
        where: {
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
        select: {
          id: true,
          actionType: true,
          status: true
        }
      }),
      this.prisma.transaction.findMany({
        where: {
          paymentAttempts: {
            some: { status: 'FAILED' }
          }
        },
        select: {
          id: true,
          paymentAttempts: {
            select: {
              attemptNumber: true,
              status: true
            }
          },
          recoveryActions: {
            select: {
              status: true
            }
          }
        }
      })
    ]);

    // A. Action-level recovery execution rate
    const actionSuccessCount = executedPaymentActions.filter((a) => a.status === 'SUCCESS').length;
    const actionFailedCount = executedPaymentActions.filter((a) => a.status === 'FAILED').length;
    const actionTotalEligible = actionSuccessCount + actionFailedCount;
    const actionRecoveryRate = actionTotalEligible > 0
      ? round(actionSuccessCount / actionTotalEligible)
      : null;

    // B. Transaction-level recovery resolution rate
    const failedTransactionCount = failedTransactions.length;
    const recoveredTransactionCount = failedTransactions.filter((txn) => {
      const hasSubsequentSuccessAttempt = txn.paymentAttempts.some(
        (att) => att.status === 'SUCCESS' && att.attemptNumber > 1
      );
      const hasSuccessfulRecoveryAction = txn.recoveryActions.some(
        (act) => act.status === 'SUCCESS'
      );
      return hasSubsequentSuccessAttempt || hasSuccessfulRecoveryAction;
    }).length;

    const transactionRecoveryRate = failedTransactionCount > 0
      ? round(recoveredTransactionCount / failedTransactionCount)
      : null;

    // C. Recovery rate by failure category
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

    // D. Recovery rate by payment method
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

    // E. Retry success rate
    const retryActions = executedPaymentActions.filter((a) => a.actionType === RecoveryActionType.RETRY);
    const retrySuccess = retryActions.filter((a) => a.status === 'SUCCESS').length;
    const retryFailed = retryActions.filter((a) => a.status === 'FAILED').length;
    const retryTotal = retrySuccess + retryFailed;
    const retrySuccessRate = retryTotal > 0 ? round(retrySuccess / retryTotal) : null;

    // F. Alternate-method success rate
    const altActions = executedPaymentActions.filter((a) => a.actionType === RecoveryActionType.ALTERNATE_METHOD);
    const altSuccess = altActions.filter((a) => a.status === 'SUCCESS').length;
    const altFailed = altActions.filter((a) => a.status === 'FAILED').length;
    const altTotal = altSuccess + altFailed;
    const alternateMethodSuccessRate = altTotal > 0 ? round(altSuccess / altTotal) : null;

    // G. Escalation rate
    const totalRecommendations = allRecoveryActions.length;
    const escalateCount = allRecoveryActions.filter((a) => a.actionType === RecoveryActionType.ESCALATE).length;
    const escalationRate = totalRecommendations > 0 ? round(escalateCount / totalRecommendations) : null;

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
      }
    };
  }

  getModelMetrics() {
    const feedbackRecords = this.feedbackService?.buffer ?? [];
    const auditRecords = this.auditService?.buffer ?? [];

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
    try {
      if (fs.existsSync(this.benchmarkPath)) {
        const fileContent = fs.readFileSync(this.benchmarkPath, 'utf8');
        return JSON.parse(fileContent);
      }
    } catch {
      // Return null gracefully if benchmark file is unavailable
    }
    return null;
  }

  async getAnalyticsSummary() {
    const [operational, model, benchmark] = await Promise.all([
      this.getOperationalMetrics(),
      Promise.resolve(this.getModelMetrics()),
      Promise.resolve(this.getBenchmarkMetrics())
    ]);

    return {
      operational,
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

    return {
      actionRecoveryRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      transactionRecoveryRate: { rate: null, recoveredCount: 0, failedTransactionCount: 0, totalEligible: 0 },
      byFailureCategory: emptyCategory,
      byPaymentMethod: emptyMethod,
      retrySuccessRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      alternateMethodSuccessRate: { rate: null, successCount: 0, failedCount: 0, totalEligible: 0 },
      escalationRate: { rate: null, escalateCount: 0, totalRecommendations: 0 }
    };
  }
}
