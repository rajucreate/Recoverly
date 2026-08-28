import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trainAndEvaluate } from './baseline-recovery-model.js';

function formatMetrics(metrics) {
  return `rows=${metrics.row_count}, ROC-AUC=${metrics.roc_auc?.toFixed(4) ?? 'n/a'}, PR-AUC=${metrics.pr_auc?.toFixed(4) ?? 'n/a'}, accuracy=${metrics.accuracy.toFixed(4)}, precision=${metrics.precision.toFixed(4)}, recall=${metrics.recall.toFixed(4)}, F1=${metrics.f1.toFixed(4)}, log loss=${metrics.log_loss.toFixed(4)}, Brier=${metrics.brier_score.toFixed(4)}`;
}

function renderReport(metadata) {
  const sections = [
    ['Candidate action', metadata.evaluation.by_candidate_action],
    ['Failure category', metadata.evaluation.by_failure_category],
    ['Payment method', metadata.evaluation.by_payment_method]
  ];
  return `# Phase 2: Baseline Recovery Prediction Model\n\n## Model\n\n- Model: deterministic logistic regression\n- Version: ${metadata.model_version}\n- Version task: ${metadata.training_version}\n- Feature schema: ${metadata.feature_schema_version}\n- Dataset version: ${metadata.dataset_version}\n- Training split: ${metadata.training_split_version}\n- Training rows: ${metadata.training_row_count}\n- Validation rows: ${metadata.validation_row_count}\n- Test set used: ${metadata.test_set_used}\n- Trained at: ${metadata.trained_at}\n- Runtime: ${metadata.runtime}\n\n## Training procedure\n\nThe model uses fixed full-batch gradient descent with training-only numeric standardization, 1,200 epochs, learning rate 0.08, and L2 coefficient 0.01. No test data is loaded.\n\n## Feature inputs and target\n\nExactly the 19 finalized feature columns are used as inputs. \`recovery_success\` is the separate binary target. IDs, timestamps, outcomes, and executed-action fields are excluded.\n\n## Validation metrics\n\n${formatMetrics(metadata.evaluation.aggregate)}\n\nConfusion matrix:\n\n\`\`\`json\n${JSON.stringify(metadata.evaluation.aggregate.confusion_matrix, null, 2)}\n\`\`\`\n\nProbability distribution:\n\n\`\`\`json\n${JSON.stringify(metadata.evaluation.aggregate.probability_distribution, null, 2)}\n\`\`\`\n\n${sections.map(([title, groups]) => `## By ${title}\n\n${Object.entries(groups).map(([value, metrics]) => `- ${value}: ${formatMetrics(metrics)}`).join('\\n')}`).join('\\n\\n')}\n\n## Artifact and reproducibility\n\n- Model artifact: \`data/phase-2/models/recovery_baseline_v1.model.json\`\n- Metadata: \`data/phase-2/models/recovery_baseline_v1.metadata.json\`\n- Reproduce with: \`node src/intelligence/train-baseline-recovery-model.js\`\n\nThe model contains coefficients, intercept, feature ordering, training-only scaler parameters, and fixed hyperparameters. Re-running with the same artifacts produces the same coefficients and validation predictions; only the training timestamp changes.\n\n## Limitations and baseline role\n\nThis model uses synthetic data and establishes a transparent reference point only. It does not demonstrate improvement over the Phase 1 rules, does not select a production threshold, does not evaluate the test set, and is not integrated into production or exposed through an API.\n`;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, '../../..');
  const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const modelDirectory = path.join(dataDirectory, 'models');
  const modelPath = path.join(modelDirectory, 'recovery_baseline_v1.model.json');
  const metadataPath = path.join(modelDirectory, 'recovery_baseline_v1.metadata.json');
  const reportPath = path.join(rootDirectory, 'docs', 'phase-2', '6.4.1-baseline-model.md');
  const result = trainAndEvaluate({
    trainPath: path.join(dataDirectory, 'splits', 'train.csv'),
    validationPath: path.join(dataDirectory, 'splits', 'validation.csv'),
    schemaPath: path.join(dataDirectory, 'recovery_features_v1.schema.json'),
    modelPath,
    metadataPath
  });

  fs.writeFileSync(reportPath, renderReport(result.metadata), 'utf8');
  console.log(`Model: ${modelPath}`);
  console.log(`Metadata: ${metadataPath}`);
  console.log(`Validation: ${formatMetrics(result.metadata.evaluation.aggregate)}`);
  console.log('Test set used: false');
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();
