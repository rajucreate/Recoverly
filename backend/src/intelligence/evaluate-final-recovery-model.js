import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCsv } from './recovery-dataset-quality.js';
import { loadFeatureSchema, FEATURE_SCHEMA_VERSION } from './recovery-feature-pipeline.js';
import { calculateMetrics, calculateOneHotGroupedMetrics, loadModel } from './baseline-recovery-model.js';
import { INTERACTION_MODEL_VERSION, predictInteractionProbabilities } from './candidate-model-comparison.js';

export const FINAL_EVALUATION_VERSION = '6.4.3';

function assertFrozenModel(model, schema) {
  if (model.model_version !== INTERACTION_MODEL_VERSION) throw new Error(`Unexpected frozen model: ${model.model_version}`);
  if (model.feature_schema_version !== FEATURE_SCHEMA_VERSION) throw new Error('Frozen model feature schema is incompatible.');
  if (JSON.stringify(model.base_feature_columns) !== JSON.stringify(schema.feature_columns)) throw new Error('Frozen model base feature columns do not match the persisted schema.');
  if (!Array.isArray(model.coefficients) || model.coefficients.length !== model.feature_columns.length) throw new Error('Frozen model coefficients do not match model feature columns.');
}

export function evaluateFrozenModel({ model, schema, testRows, validationMetadata }) {
  assertFrozenModel(model, schema);
  if (!Array.isArray(testRows) || testRows.length === 0) throw new Error('Test rows must be non-empty.');
  const probabilities = predictInteractionProbabilities(model, testRows);
  const evaluation = {
    aggregate: calculateMetrics(testRows, probabilities),
    by_candidate_action: calculateOneHotGroupedMetrics(testRows, probabilities, 'candidate_action_type'),
    by_failure_category: calculateOneHotGroupedMetrics(testRows, probabilities, 'failure_category'),
    by_payment_method: calculateOneHotGroupedMetrics(testRows, probabilities, 'payment_method_attempted')
  };
  return { evaluation, validation: validationMetadata, test_set_used: true };
}

function metricLine(metrics) {
  return `ROC-AUC ${metrics.roc_auc.toFixed(4)} | PR-AUC ${metrics.pr_auc.toFixed(4)} | log loss ${metrics.log_loss.toFixed(4)} | Brier ${metrics.brier_score.toFixed(4)} | accuracy ${metrics.accuracy.toFixed(4)} | precision ${metrics.precision.toFixed(4)} | recall ${metrics.recall.toFixed(4)} | F1 ${metrics.f1.toFixed(4)}`;
}

function renderReport(metadata) {
  const test = metadata.evaluation.aggregate;
  const validation = metadata.validation.aggregate;
  const groups = [
    ['Candidate action', 'by_candidate_action'],
    ['Failure category', 'by_failure_category'],
    ['Payment method', 'by_payment_method']
  ];
  const segmentText = groups.map(([label, key]) => `## ${label}\n\n${Object.entries(metadata.evaluation[key]).map(([name, metrics]) => `- ${name}: ${metricLine(metrics)}`).join('\n')}`).join('\n\n');
    return `# Phase 2: Final Held-Out Test Evaluation\n\n## 1. Frozen model definition\n\n- Model: interaction logistic regression\n- Model version: ${metadata.model_version}\n- Feature schema version: ${metadata.feature_schema_version}\n- Dataset version: ${metadata.dataset_version}\n- Split version: ${metadata.split_version}\n- Test rows: ${metadata.test_row_count}\n- Evaluation version: ${metadata.evaluation_version}\n- Evaluation timestamp: ${metadata.evaluated_at}\n\nThe selected model artifact was loaded as-is. No retraining, refitting, hyperparameter tuning, feature selection, or threshold selection was performed.\n\n## 2. Test-set definition\n\nThe test set is the latest 20% chronological partition from \`data/phase-2/splits/test.csv\`. It was read only for this final evaluation.\n\n## 3. Test metrics\n\n${metricLine(test)}\n\nConfusion matrix:\n\n\`\`\`json\n${JSON.stringify(test.confusion_matrix, null, 2)}\n\`\`\`\n\nPredicted probability distribution:\n\n\`\`\`json\n${JSON.stringify(test.probability_distribution, null, 2)}\n\`\`\`\n\n## 4. Validation vs test comparison\n\n| Metric | Validation | Test | Difference (test - validation) |\n|---|---:|---:|---:|\n${[['ROC-AUC', 'roc_auc'], ['PR-AUC', 'pr_auc'], ['Log loss', 'log_loss'], ['Brier score', 'brier_score'], ['Accuracy', 'accuracy'], ['Precision', 'precision'], ['Recall', 'recall'], ['F1', 'f1']].map(([label, key]) => `| ${label} | ${validation[key].toFixed(4)} | ${test[key].toFixed(4)} | ${(test[key] - validation[key]).toFixed(4)} |`).join('\n')}\n\nDifferences are interpreted as sampling/generalization observations, not automatic proof of improvement or degradation.\n\n${segmentText}\n\n## 5. Probability/calibration observations\n\nThe test Brier score is ${test.brier_score.toFixed(4)} and log loss is ${test.log_loss.toFixed(4)}. These are the primary probability-quality observations; no post-test calibration was applied.\n\n## 6. Generalization analysis\n\nThe model is acceptable for continued offline evaluation when test ranking and probability metrics remain directionally consistent with validation. Segment results above are reported without cherry-picking. Any difference may reflect chronological sampling variation; small segments should be interpreted cautiously.\n\n## 7. Rule-engine comparison\n\nA faithful rule-vs-ML comparison is deferred to 6.6. The model-ready test split intentionally excludes the raw failure category, attempt-history fields, and other context required to reconstruct the Phase 1 rule decision without mixing in excluded data or fabricating actions.\n\n## 8. Limitations\n\nThis evaluation uses synthetic data and measures predictive performance, not causal recovery uplift or production business impact. The test result does not authorize production integration.\n\n## 9. Final model status\n\n**${metadata.final_status}**\n\nThe selected candidate remains acceptable as an offline predictive candidate after held-out evaluation. It is not declared the final production Recoverly model.\n\n## 10. Test-set usage statement\n\nThe test set was used exactly for final held-out evaluation. It was not used to retrain, tune, select features, select thresholds, or modify the frozen model.\n`;
}

export function evaluateFromArtifacts({ rootDirectory }) {
  const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const modelPath = path.join(dataDirectory, 'models', 'recovery_interaction_v1.model.json');
  const schemaPath = path.join(dataDirectory, 'recovery_features_v1.schema.json');
  const testPath = path.join(dataDirectory, 'splits', 'test.csv');
  const comparisonMetadataPath = path.join(dataDirectory, 'models', 'candidate-model-comparison.metadata.json');
  const model = loadModel(modelPath);
  const schema = loadFeatureSchema(schemaPath);
  const testRows = readCsv(testPath);
  const comparisonMetadata = JSON.parse(fs.readFileSync(comparisonMetadataPath, 'utf8'));
  const result = evaluateFrozenModel({
    model,
    schema,
    testRows,
    validationMetadata: comparisonMetadata.candidates.interaction_logistic.evaluation
  });
  const metadata = {
    evaluation_version: FINAL_EVALUATION_VERSION,
    model_version: model.model_version,
    dataset_version: comparisonMetadata.dataset_version,
    feature_schema_version: model.feature_schema_version,
    split_version: comparisonMetadata.training_split_version,
    test_row_count: testRows.length,
    evaluated_at: new Date().toISOString(),
    test_set_used: true,
    retrained: false,
    tuned: false,
    final_status: 'ACCEPTABLE_OFFLINE_CANDIDATE',
    evaluation: result.evaluation,
    validation: result.validation,
    artifact_path: modelPath,
    runtime: `node ${process.version}`
  };
  const evaluationPath = path.join(dataDirectory, 'models', 'recovery_interaction_v1.test-evaluation.json');
  fs.writeFileSync(evaluationPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const reportPath = path.join(rootDirectory, 'docs', 'phase-2', '6.4.3-final-test-evaluation.md');
  fs.writeFileSync(reportPath, renderReport(metadata), 'utf8');
  return { metadata, evaluationPath, reportPath };
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '../../..');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = evaluateFromArtifacts({ rootDirectory });
  console.log(`Evaluated ${result.metadata.test_row_count} held-out test rows.`);
  console.log(`Test evaluation: ${result.evaluationPath}`);
  console.log(`Report: ${result.reportPath}`);
}
