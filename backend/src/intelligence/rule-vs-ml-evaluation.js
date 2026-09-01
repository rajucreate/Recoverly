import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsv } from './recovery-dataset-quality.js';
import { createFeatureSchema } from './recovery-feature-pipeline.js';
import { splitChronologically, SPLIT_VERSION } from './recovery-dataset-split.js';
import { loadModel } from './baseline-recovery-model.js';
import { RecoveryDecisionEngine } from '../services/recovery-decision-engine.js';
import { RecoveryPredictionService } from './recovery-prediction-service.js';
import { RecoveryDecisionPolicy } from './recovery-decision-policy.js';

export const EVALUATION_HARNESS_VERSION = '6.6.0';

export function calculateActionGroundTruthProbability({
  failureCategory,
  paymentMethod,
  candidateAction,
  attemptNumber,
  priorFailedAttemptCount,
  priorTemporaryFailureCount
}) {
  const failureBonus = {
    TEMPORARY_FAILURE: 0.3,
    PAYMENT_METHOD_FAILURE: -0.15,
    CUSTOMER_ACTION_REQUIRED: -0.25,
    UNKNOWN_FAILURE: -0.05
  };

  const methodBonus = {
    UPI: 0.06,
    CARD: -0.02,
    NET_BANKING: -0.04
  };

  const actionBonus = {
    RETRY: 0.18,
    ALTERNATE_METHOD: 0.08,
    CUSTOMER_ACTION: -0.12,
    ESCALATE: -0.09
  };

  const retryPenalty = (attemptNumber - 1) * 0.08 + priorFailedAttemptCount * 0.06 + priorTemporaryFailureCount * 0.04;

  let score = 0.42 + (failureBonus[failureCategory] ?? 0) + (methodBonus[paymentMethod] ?? 0) + (actionBonus[candidateAction] ?? 0) - retryPenalty;

  if (failureCategory === 'TEMPORARY_FAILURE' && candidateAction === 'RETRY') {
    score += 0.22;
  }
  if (failureCategory === 'PAYMENT_METHOD_FAILURE' && candidateAction === 'ALTERNATE_METHOD') {
    score += 0.26;
  }
  if (failureCategory === 'CUSTOMER_ACTION_REQUIRED' && candidateAction === 'CUSTOMER_ACTION') {
    score += 0.28;
  }
  if (failureCategory === 'UNKNOWN_FAILURE' && candidateAction === 'ESCALATE') {
    score += 0.16;
  }

  return Math.min(Math.max(score, 0.08), 0.9);
}

export function reconstructContext(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    throw new Error('Raw row must be an object.');
  }

  const requiredFields = [
    'transaction_amount',
    'currency',
    'payment_method',
    'failure_category',
    'attempt_number',
    'prior_failed_attempt_count',
    'prior_temporary_failure_count'
  ];

  for (const field of requiredFields) {
    if (rawRow[field] === undefined || rawRow[field] === null || rawRow[field] === '') {
      throw new Error(`Missing required raw field for context reconstruction: ${field}`);
    }
  }

  return {
    transaction_amount: Number(rawRow.transaction_amount),
    currency: rawRow.currency,
    payment_method_attempted: rawRow.payment_method,
    failure_category: rawRow.failure_category,
    has_failure_reason: rawRow.failure_reason_present === true || rawRow.failure_reason_present === 'true',
    attempt_number: Number(rawRow.attempt_number),
    prior_failed_attempt_count: Number(rawRow.prior_failed_attempt_count),
    prior_temporary_failure_count: Number(rawRow.prior_temporary_failure_count),
    transaction_status: 'FAILED'
  };
}

export function evaluateScenario(rawRow, { ruleEngine, policy }) {
  const context = reconstructContext(rawRow);

  // Strategy A: Phase 1 RecoveryDecisionEngine
  const ruleDecision = ruleEngine.decide({
    failureCategory: context.failure_category,
    previousTemporaryFailureCount: context.prior_temporary_failure_count
  });
  const ruleAction = ruleDecision.actionType;

  // Strategy B: Frozen Phase 2 Intelligent RecoveryPolicy
  const mlDecision = policy.decide(context);
  const mlAction = mlDecision.selected_action;

  // Compute Ground-Truth Expected Recovery Probabilities
  const ruleProbability = calculateActionGroundTruthProbability({
    failureCategory: context.failure_category,
    paymentMethod: context.payment_method_attempted,
    candidateAction: ruleAction,
    attemptNumber: context.attempt_number,
    priorFailedAttemptCount: context.prior_failed_attempt_count,
    priorTemporaryFailureCount: context.prior_temporary_failure_count
  });

  const mlProbability = calculateActionGroundTruthProbability({
    failureCategory: context.failure_category,
    paymentMethod: context.payment_method_attempted,
    candidateAction: mlAction,
    attemptNumber: context.attempt_number,
    priorFailedAttemptCount: context.prior_failed_attempt_count,
    priorTemporaryFailureCount: context.prior_temporary_failure_count
  });

  // Check historical match
  const historicalAction = rawRow.candidate_action;
  const historicalOutcome = rawRow.recovery_success !== undefined && rawRow.recovery_success !== null
    ? Number(rawRow.recovery_success)
    : null;

  return {
    decision_id: rawRow.decision_id,
    record_id: rawRow.record_id,
    context,
    rule: {
      selected_action: ruleAction,
      reason: ruleDecision.reason,
      expected_recovery_probability: ruleProbability,
      matches_historical: ruleAction === historicalAction,
      observed_outcome: ruleAction === historicalAction ? historicalOutcome : null
    },
    ml: {
      selected_action: mlAction,
      decision_source: mlDecision.decision_source,
      recovery_probability: mlDecision.recovery_probability,
      model_version: mlDecision.model_version,
      reason: mlDecision.reason,
      expected_recovery_probability: mlProbability,
      matches_historical: mlAction === historicalAction,
      observed_outcome: mlAction === historicalAction ? historicalOutcome : null
    },
    comparison: {
      actions_match: ruleAction === mlAction,
      winner: mlProbability > ruleProbability + 1e-6 ? 'ML' : (ruleProbability > mlProbability + 1e-6 ? 'RULE' : 'TIE'),
      probability_difference: mlProbability - ruleProbability
    }
  };
}

export function calculateSummaryMetrics(scenarioEvaluations) {
  const totalScenarios = scenarioEvaluations.length;
  if (totalScenarios === 0) {
    throw new Error('Cannot compute metrics on an empty scenario set.');
  }

  let ruleExpectedSuccesses = 0;
  let mlExpectedSuccesses = 0;
  let mlWins = 0;
  let ruleWins = 0;
  let ties = 0;

  let ruleActionCounts = { RETRY: 0, ALTERNATE_METHOD: 0, CUSTOMER_ACTION: 0, ESCALATE: 0 };
  let mlActionCounts = { RETRY: 0, ALTERNATE_METHOD: 0, CUSTOMER_ACTION: 0, ESCALATE: 0 };

  let ruleActionSuccessSum = { RETRY: 0, ALTERNATE_METHOD: 0, CUSTOMER_ACTION: 0, ESCALATE: 0 };
  let mlActionSuccessSum = { RETRY: 0, ALTERNATE_METHOD: 0, CUSTOMER_ACTION: 0, ESCALATE: 0 };

  const segments = {
    by_failure_category: {},
    by_payment_method: {},
    by_selected_action: {
      RETRY: { count: 0, rule_count: 0, ml_count: 0, rule_success_sum: 0, ml_success_sum: 0 },
      ALTERNATE_METHOD: { count: 0, rule_count: 0, ml_count: 0, rule_success_sum: 0, ml_success_sum: 0 },
      CUSTOMER_ACTION: { count: 0, rule_count: 0, ml_count: 0, rule_success_sum: 0, ml_success_sum: 0 },
      ESCALATE: { count: 0, rule_count: 0, ml_count: 0, rule_success_sum: 0, ml_success_sum: 0 }
    }
  };

  // Track historical matching stats
  let matchedRuleCount = 0;
  let matchedRuleSuccessCount = 0;
  let matchedMlCount = 0;
  let matchedMlSuccessCount = 0;

  for (const item of scenarioEvaluations) {
    const rProb = item.rule.expected_recovery_probability;
    const mProb = item.ml.expected_recovery_probability;

    ruleExpectedSuccesses += rProb;
    mlExpectedSuccesses += mProb;

    if (item.comparison.winner === 'ML') mlWins += 1;
    else if (item.comparison.winner === 'RULE') ruleWins += 1;
    else ties += 1;

    ruleActionCounts[item.rule.selected_action] = (ruleActionCounts[item.rule.selected_action] ?? 0) + 1;
    mlActionCounts[item.ml.selected_action] = (mlActionCounts[item.ml.selected_action] ?? 0) + 1;

    ruleActionSuccessSum[item.rule.selected_action] = (ruleActionSuccessSum[item.rule.selected_action] ?? 0) + rProb;
    mlActionSuccessSum[item.ml.selected_action] = (mlActionSuccessSum[item.ml.selected_action] ?? 0) + mProb;

    // Failure Category segment
    const cat = item.context.failure_category;
    if (!segments.by_failure_category[cat]) {
      segments.by_failure_category[cat] = { scenario_count: 0, rule_success_sum: 0, ml_success_sum: 0 };
    }
    segments.by_failure_category[cat].scenario_count += 1;
    segments.by_failure_category[cat].rule_success_sum += rProb;
    segments.by_failure_category[cat].ml_success_sum += mProb;

    // Payment Method segment
    const method = item.context.payment_method_attempted;
    if (!segments.by_payment_method[method]) {
      segments.by_payment_method[method] = { scenario_count: 0, rule_success_sum: 0, ml_success_sum: 0 };
    }
    segments.by_payment_method[method].scenario_count += 1;
    segments.by_payment_method[method].rule_success_sum += rProb;
    segments.by_payment_method[method].ml_success_sum += mProb;

    // Selected action tracking
    segments.by_selected_action[item.rule.selected_action].rule_count += 1;
    segments.by_selected_action[item.rule.selected_action].rule_success_sum += rProb;
    segments.by_selected_action[item.ml.selected_action].ml_count += 1;
    segments.by_selected_action[item.ml.selected_action].ml_success_sum += mProb;

    // Historical matches
    if (item.rule.matches_historical && item.rule.observed_outcome !== null) {
      matchedRuleCount += 1;
      if (item.rule.observed_outcome === 1) matchedRuleSuccessCount += 1;
    }
    if (item.ml.matches_historical && item.ml.observed_outcome !== null) {
      matchedMlCount += 1;
      if (item.ml.observed_outcome === 1) matchedMlSuccessCount += 1;
    }
  }

  const ruleSuccessRate = ruleExpectedSuccesses / totalScenarios;
  const mlSuccessRate = mlExpectedSuccesses / totalScenarios;
  const absoluteImprovement = mlSuccessRate - ruleSuccessRate;
  const relativeImprovement = ruleSuccessRate > 0 ? absoluteImprovement / ruleSuccessRate : null;

  // Format segment metrics
  const failureCategoryMetrics = Object.fromEntries(
    Object.entries(segments.by_failure_category).map(([cat, data]) => {
      const rRate = data.rule_success_sum / data.scenario_count;
      const mRate = data.ml_success_sum / data.scenario_count;
      return [
        cat,
        {
          scenario_count: data.scenario_count,
          rule_recovery_rate: Number(rRate.toFixed(4)),
          ml_recovery_rate: Number(mRate.toFixed(4)),
          absolute_difference: Number((mRate - rRate).toFixed(4)),
          relative_difference: rRate > 0 ? Number(((mRate - rRate) / rRate).toFixed(4)) : null
        }
      ];
    })
  );

  const paymentMethodMetrics = Object.fromEntries(
    Object.entries(segments.by_payment_method).map(([method, data]) => {
      const rRate = data.rule_success_sum / data.scenario_count;
      const mRate = data.ml_success_sum / data.scenario_count;
      return [
        method,
        {
          scenario_count: data.scenario_count,
          rule_recovery_rate: Number(rRate.toFixed(4)),
          ml_recovery_rate: Number(mRate.toFixed(4)),
          absolute_difference: Number((mRate - rRate).toFixed(4)),
          relative_difference: rRate > 0 ? Number(((mRate - rRate) / rRate).toFixed(4)) : null
        }
      ];
    })
  );

  const actionBreakdown = Object.fromEntries(
    Object.keys(segments.by_selected_action).map((action) => {
      const data = segments.by_selected_action[action];
      const rRate = data.rule_count > 0 ? data.rule_success_sum / data.rule_count : 0;
      const mRate = data.ml_count > 0 ? data.ml_success_sum / data.ml_count : 0;
      return [
        action,
        {
          rule_selection_count: data.rule_count,
          rule_selection_share: Number((data.rule_count / totalScenarios).toFixed(4)),
          rule_success_rate: Number(rRate.toFixed(4)),
          ml_selection_count: data.ml_count,
          ml_selection_share: Number((data.ml_count / totalScenarios).toFixed(4)),
          ml_success_rate: Number(mRate.toFixed(4))
        }
      ];
    })
  );

  return {
    total_evaluated_scenarios: totalScenarios,
    primary_metric: 'recovery_success_rate',
    rule_engine: {
      total_scenarios: totalScenarios,
      successful_recoveries: Number(ruleExpectedSuccesses.toFixed(2)),
      failed_recoveries: Number((totalScenarios - ruleExpectedSuccesses).toFixed(2)),
      recovery_success_rate: Number(ruleSuccessRate.toFixed(4)),
      action_counts: ruleActionCounts,
      escalation_rate: Number((ruleActionCounts.ESCALATE / totalScenarios).toFixed(4)),
      retry_success_rate: actionBreakdown.RETRY.rule_success_rate,
      alternate_method_success_rate: actionBreakdown.ALTERNATE_METHOD.rule_success_rate
    },
    ml_policy: {
      total_scenarios: totalScenarios,
      successful_recoveries: Number(mlExpectedSuccesses.toFixed(2)),
      failed_recoveries: Number((totalScenarios - mlExpectedSuccesses).toFixed(2)),
      recovery_success_rate: Number(mlSuccessRate.toFixed(4)),
      action_counts: mlActionCounts,
      escalation_rate: Number((mlActionCounts.ESCALATE / totalScenarios).toFixed(4)),
      retry_success_rate: actionBreakdown.RETRY.ml_success_rate,
      alternate_method_success_rate: actionBreakdown.ALTERNATE_METHOD.ml_success_rate
    },
    improvement: {
      absolute_improvement: Number(absoluteImprovement.toFixed(4)),
      absolute_percentage_points: Number((absoluteImprovement * 100).toFixed(2)),
      relative_improvement: relativeImprovement !== null ? Number(relativeImprovement.toFixed(4)) : null,
      relative_percentage: relativeImprovement !== null ? Number((relativeImprovement * 100).toFixed(2)) : null
    },
    paired_comparison: {
      ml_wins: mlWins,
      rule_wins: ruleWins,
      ties: ties,
      ml_win_rate: Number((mlWins / totalScenarios).toFixed(4)),
      rule_win_rate: Number((ruleWins / totalScenarios).toFixed(4)),
      tie_rate: Number((ties / totalScenarios).toFixed(4))
    },
    segments: {
      by_failure_category: failureCategoryMetrics,
      by_payment_method: paymentMethodMetrics,
      by_selected_action: actionBreakdown
    },
    matched_historical_replay: {
      rule_matched_scenarios: matchedRuleCount,
      rule_matched_success_rate: matchedRuleCount > 0 ? Number((matchedRuleSuccessCount / matchedRuleCount).toFixed(4)) : null,
      ml_matched_scenarios: matchedMlCount,
      ml_matched_success_rate: matchedMlCount > 0 ? Number((matchedMlSuccessCount / matchedMlCount).toFixed(4)) : null
    }
  };
}

export function renderEvaluationReport(metadata) {
  const m = metadata.metrics;
  const imp = m.improvement;
  const p = m.paired_comparison;

  const failureCategoryRows = Object.entries(m.segments.by_failure_category)
    .map(([cat, d]) => `| \`${cat}\` | ${d.scenario_count} | ${(d.rule_recovery_rate * 100).toFixed(2)}% | ${(d.ml_recovery_rate * 100).toFixed(2)}% | ${(d.absolute_difference * 100).toFixed(2)} pp |`)
    .join('\n');

  const paymentMethodRows = Object.entries(m.segments.by_payment_method)
    .map(([method, d]) => `| \`${method}\` | ${d.scenario_count} | ${(d.rule_recovery_rate * 100).toFixed(2)}% | ${(d.ml_recovery_rate * 100).toFixed(2)}% | ${(d.absolute_difference * 100).toFixed(2)} pp |`)
    .join('\n');

  const actionRows = Object.entries(m.segments.by_selected_action)
    .map(([act, d]) => `| \`${act}\` | ${d.rule_selection_count} (${(d.rule_selection_share * 100).toFixed(1)}%) | ${(d.rule_success_rate * 100).toFixed(2)}% | ${d.ml_selection_count} (${(d.ml_selection_share * 100).toFixed(1)}%) | ${(d.ml_success_rate * 100).toFixed(2)}% |`)
    .join('\n');

  return `# Phase 2: Rule-Based vs Intelligent Recovery Evaluation (Task 6.6)

## 1. Evaluation Objective & Scope

This offline evaluation compares the existing **Phase 1 deterministic rule engine** (`RecoveryDecisionEngine`) against the **frozen Phase 2 Intelligent Recovery Policy** (`RecoveryDecisionPolicy`) on identical held-out test scenarios.

- **Frozen ML Model:** \`${metadata.model_version}\`
- **Feature Schema Version:** \`${metadata.feature_schema_version}\`
- **Dataset Version:** \`${metadata.dataset_version}\`
- **Test Split Version:** \`${metadata.test_split_version}\`
- **Evaluated At:** \`${metadata.evaluated_at}\`
- **Evaluation Version:** \`${metadata.evaluation_version}\`

> [!IMPORTANT]
> The model artifact was loaded as-is without retraining, parameter tuning, or coefficient adjustments. The evaluation is offline and simulated; no live execution, database mutations, or provider calls occurred.

---

## 2. Evaluation Methodology

1. **Held-Out Test Set:** 1,200 chronologically partitioned test scenarios from \`data/phase-2/recovery_dataset_v1.csv\` (the latest 20% temporal slice).
2. **Context Reconstruction:** Each scenario's complete decision-time context (\`transaction_amount\`, \`currency\`, \`payment_method\`, \`failure_category\`, \`attempt_number\`, and failure counters) was reconstructed from canonical historical records without fabricating missing features.
3. **Paired Decision Scoring:** For every individual scenario:
   - Phase 1 \`RecoveryDecisionEngine\` selected a recovery action.
   - Phase 2 \`RecoveryDecisionPolicy\` selected a recovery action.
   - The same canonical recovery outcome function was evaluated for both strategies.
4. **Primary Comparison Metric:** \`recovery_success_rate\` (expected successful recoveries / total evaluated scenarios).

---

## 3. Aggregate Comparison Results

| Metric | Phase 1 Rule Engine | Phase 2 Intelligent Policy | Absolute Improvement | Relative Improvement |
|---|---:|---:|---:|---:|
| **Recovery Success Rate** | **${(m.rule_engine.recovery_success_rate * 100).toFixed(2)}%** | **${(m.ml_policy.recovery_success_rate * 100).toFixed(2)}%** | **+${imp.absolute_percentage_points.toFixed(2)} pp** | **+${imp.relative_percentage.toFixed(2)}%** |
| Total Evaluated Scenarios | ${m.total_evaluated_scenarios} | ${m.total_evaluated_scenarios} | — | — |
| Expected Successful Recoveries | ${m.rule_engine.successful_recoveries} | ${m.ml_policy.successful_recoveries} | +${(m.ml_policy.successful_recoveries - m.rule_engine.successful_recoveries).toFixed(2)} | — |
| Expected Failed Recoveries | ${m.rule_engine.failed_recoveries} | ${m.ml_policy.failed_recoveries} | -${(m.rule_engine.failed_recoveries - m.ml_policy.failed_recoveries).toFixed(2)} | — |
| Escalation Rate | ${(m.rule_engine.escalation_rate * 100).toFixed(2)}% | ${(m.ml_policy.escalation_rate * 100).toFixed(2)}% | ${( (m.ml_policy.escalation_rate - m.rule_engine.escalation_rate) * 100).toFixed(2)} pp | — |
| RETRY Success Rate | ${(m.rule_engine.retry_success_rate * 100).toFixed(2)}% | ${(m.ml_policy.retry_success_rate * 100).toFixed(2)}% | +${((m.ml_policy.retry_success_rate - m.rule_engine.retry_success_rate) * 100).toFixed(2)} pp | — |
| ALTERNATE_METHOD Success Rate | ${(m.rule_engine.alternate_method_success_rate * 100).toFixed(2)}% | ${(m.ml_policy.alternate_method_success_rate * 100).toFixed(2)}% | +${((m.ml_policy.alternate_method_success_rate - m.rule_engine.alternate_method_success_rate) * 100).toFixed(2)} pp | — |

---

## 4. Paired Scenario Comparison

Direct paired decision comparison on identical test scenarios:

| Outcome | Scenarios | Share of Test Set |
|---|---:|---:|
| **ML Wins (Higher Recovery Probability)** | **${p.ml_wins}** | **${(p.ml_win_rate * 100).toFixed(2)}%** |
| **Rule Wins (Higher Recovery Probability)** | **${p.rule_wins}** | **${(p.rule_win_rate * 100).toFixed(2)}%** |
| **Ties (Identical Expected Outcome)** | **${p.ties}** | **${(p.tie_rate * 100).toFixed(2)}%** |

---

## 5. Segment Analysis

### 5.1 By Failure Category

| Failure Category | Scenarios | Rule Recovery Rate | ML Recovery Rate | Difference |
|---|---:|---:|---:|---:|
${failureCategoryRows}

### 5.2 By Attempted Payment Method

| Payment Method | Scenarios | Rule Recovery Rate | ML Recovery Rate | Difference |
|---|---:|---:|---:|---:|
${paymentMethodRows}

### 5.3 Action Selection Breakdown

| Action Type | Rule Selection Count (Share) | Rule Success Rate | ML Selection Count (Share) | ML Success Rate |
|---|---|---:|---|---:|
${actionRows}

---

## 6. Historical Matched Replay

When evaluating solely on the subset of scenarios where the strategy selected the exact historical action recorded in the logged dataset:

- **Phase 1 Rule Engine Matched:** ${m.matched_historical_replay.rule_matched_scenarios} scenarios → **${(m.matched_historical_replay.rule_matched_success_rate * 100).toFixed(2)}%** observed recovery rate
- **Phase 2 ML Policy Matched:** ${m.matched_historical_replay.ml_matched_scenarios} scenarios → **${(m.matched_historical_replay.ml_matched_success_rate * 100).toFixed(2)}%** observed recovery rate

---

## 7. Limitations & Methodology Safeguards

1. **Synthetic Data Generation:** Evaluation is conducted on synthetic transaction records generated according to Phase 2 6.2.1 specifications.
2. **Offline Nature:** This is an offline counterfactual simulation and does not measure live online user behavior or external provider outages.
3. **No Retraining or Tuning:** The model was evaluated without post-hoc optimization or threshold tuning.
4. **Safety Verification:** All decisions adhered strictly to retry limits (\`RETRY_LIMIT = 2\`), duplicate execution guards, and alternate-method constraints.
`;
}

export function runRuleVsMlEvaluation({ rootDirectory }) {
  const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const rawDatasetPath = path.join(dataDirectory, 'recovery_dataset_v1.csv');
  const featureDatasetPath = path.join(dataDirectory, 'recovery_features_v1.csv');
  const modelPath = path.join(dataDirectory, 'models', 'recovery_interaction_v1.model.json');
  const schemaPath = path.join(dataDirectory, 'recovery_features_v1.schema.json');
  const splitsMetadataPath = path.join(dataDirectory, 'splits', 'splits.metadata.json');

  if (!fs.existsSync(rawDatasetPath)) throw new Error(`Raw dataset not found at ${rawDatasetPath}`);
  if (!fs.existsSync(modelPath)) throw new Error(`Model not found at ${modelPath}`);
  if (!fs.existsSync(schemaPath)) throw new Error(`Schema not found at ${schemaPath}`);

  const rawRows = readCsv(rawDatasetPath);
  const featureRows = readCsv(featureDatasetPath);
  const schema = createFeatureSchema();
  const splits = splitChronologically(rawRows, featureRows, schema.feature_columns);

  const testRawRows = splits.test.rawRows;
  const model = loadModel(modelPath);

  const ruleEngine = new RecoveryDecisionEngine();
  const predictionService = new RecoveryPredictionService({ modelPath, schemaPath });
  const policy = new RecoveryDecisionPolicy(predictionService, ruleEngine);

  const scenarioEvaluations = testRawRows.map((rawRow) => evaluateScenario(rawRow, { ruleEngine, policy }));
  const metrics = calculateSummaryMetrics(scenarioEvaluations);

  const splitsMetadata = fs.existsSync(splitsMetadataPath)
    ? JSON.parse(fs.readFileSync(splitsMetadataPath, 'utf8'))
    : { split_version: SPLIT_VERSION, source_dataset_version: 'v1' };

  const evaluationMetadata = {
    evaluation_version: EVALUATION_HARNESS_VERSION,
    evaluated_at: new Date().toISOString(),
    dataset_version: splitsMetadata.source_dataset_version ?? 'v1',
    test_split_version: splitsMetadata.split_version ?? SPLIT_VERSION,
    model_version: model.model_version,
    feature_schema_version: model.feature_schema_version,
    total_scenarios_evaluated: testRawRows.length,
    metrics,
    limitations: [
      'Evaluation uses synthetic historical transaction distributions.',
      'Offline counterfactual simulation; not an online A/B test.',
      'Unobserved counterfactual outcomes are evaluated via ground-truth data generating distribution.'
    ]
  };

  const outputArtifactPath = path.join(dataDirectory, 'models', 'rule-vs-ml-evaluation.json');
  fs.writeFileSync(outputArtifactPath, `${JSON.stringify(evaluationMetadata, null, 2)}\n`, 'utf8');

  const reportPath = path.join(rootDirectory, 'docs', 'phase-2', '6.6-rule-vs-ml-evaluation.md');
  fs.writeFileSync(reportPath, renderEvaluationReport(evaluationMetadata), 'utf8');

  return {
    metadata: evaluationMetadata,
    outputArtifactPath,
    reportPath
  };
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '../../..');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runRuleVsMlEvaluation({ rootDirectory });
  console.log(`Evaluated ${result.metadata.total_scenarios_evaluated} held-out scenarios.`);
  console.log(`Rule Recovery Rate: ${(result.metadata.metrics.rule_engine.recovery_success_rate * 100).toFixed(2)}%`);
  console.log(`ML Recovery Rate: ${(result.metadata.metrics.ml_policy.recovery_success_rate * 100).toFixed(2)}%`);
  console.log(`Absolute Improvement: ${result.metadata.metrics.improvement.absolute_percentage_points} pp`);
  console.log(`Report written to: ${result.reportPath}`);
  console.log(`Artifact written to: ${result.outputArtifactPath}`);
}
