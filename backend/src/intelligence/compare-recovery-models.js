import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareCandidates } from './candidate-model-comparison.js';

function metricLine(metrics) {
  return `ROC-AUC ${metrics.roc_auc.toFixed(4)} | PR-AUC ${metrics.pr_auc.toFixed(4)} | log loss ${metrics.log_loss.toFixed(4)} | Brier ${metrics.brier_score.toFixed(4)} | accuracy ${metrics.accuracy.toFixed(4)} | precision ${metrics.precision.toFixed(4)} | recall ${metrics.recall.toFixed(4)} | F1 ${metrics.f1.toFixed(4)}`;
}

function renderReport(metadata) {
  const candidates = Object.entries(metadata.candidates);
  const segmentSection = (label, key) => candidates.map(([name, candidate]) => `### ${name} by ${label}\n\n${Object.entries(candidate.evaluation[key]).map(([group, metrics]) => `- ${group}: ${metricLine(metrics)}`).join('\n')}`).join('\n\n');
  return `# Phase 2: Candidate Model Comparison\n\n## 1. Candidate models\n\n- Logistic regression baseline\n- Interaction logistic regression, a small nonlinear interaction extension\n\n## 2. Model configurations\n\n${candidates.map(([name, candidate]) => `- ${name}: ${candidate.feature_count} features; ${JSON.stringify(candidate.hyperparameters)}`).join('\n')}\n\n## 3. Training procedure\n\nBoth candidates use only the 3,600-row training split. Numeric scaling is fitted on training data only. The 1,200-row validation split is used once for comparison. No hyperparameter search is performed and the test split is not read.\n\n## 4. Validation methodology\n\nThe same validation rows, target, threshold, and metric implementation are used for every candidate. Probability quality is prioritized alongside ranking quality.\n\n## 5. Complete metric comparison\n\n| Candidate | ROC-AUC | PR-AUC | Log loss | Brier | Accuracy | Precision | Recall | F1 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${candidates.map(([name, candidate]) => { const m = candidate.evaluation.aggregate; return `| ${name} | ${m.roc_auc.toFixed(4)} | ${m.pr_auc.toFixed(4)} | ${m.log_loss.toFixed(4)} | ${m.brier_score.toFixed(4)} | ${m.accuracy.toFixed(4)} | ${m.precision.toFixed(4)} | ${m.recall.toFixed(4)} | ${m.f1.toFixed(4)} |`; }).join('\n')}\n\n## 6. Probability/calibration analysis\n\n${candidates.map(([name, candidate]) => `- ${name}: mean=${candidate.evaluation.aggregate.probability_distribution.mean.toFixed(4)}, median=${candidate.evaluation.aggregate.probability_distribution.p50.toFixed(4)}, p95=${candidate.evaluation.aggregate.probability_distribution.p95.toFixed(4)}, Brier=${candidate.evaluation.aggregate.brier_score.toFixed(4)}, log loss=${candidate.evaluation.aggregate.log_loss.toFixed(4)}`).join('\n')}\n\nBrier score and log loss are reported as calibration-sensitive checks. This comparison does not introduce a separate calibration framework.\n\n## 7. Action-level comparison\n\n${segmentSection('candidate action', 'by_candidate_action')}\n\n## 8. Failure-category comparison\n\n${segmentSection('failure category', 'by_failure_category')}\n\n## 9. Payment-method comparison\n\n${segmentSection('payment method', 'by_payment_method')}\n\n## 10. Model complexity\n\nThe interaction candidate expands the fixed 19-feature matrix with pairwise products of categorical one-hot columns. It remains deterministic and interpretable, but has ${metadata.candidates.interaction_logistic.feature_count} coefficients compared with ${metadata.candidates.logistic_baseline.feature_count} for the baseline.\n\n## 11. Selected candidate\n\n**${metadata.selected_candidate}**\n\nSelection rule: ${metadata.selection_rule}\n\nSelection was based only on validation results. The selected candidate is not a production model.\n\n## 12. Limitations\n\nThe data is synthetic, the comparison is validation-only, and no causal uplift or production recovery improvement has been established. Segment metrics can be noisy for smaller groups.\n\n## 13. Test-set status\n\nThe test set was not used for training, model selection, threshold selection, or evaluation. It remains untouched for the later final evaluation stage.\n`;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const rootDirectory = path.resolve(scriptDirectory, '../../..');
  const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
  const outputDirectory = dataDirectory;
  const result = compareCandidates({
    trainPath: path.join(dataDirectory, 'splits', 'train.csv'),
    validationPath: path.join(dataDirectory, 'splits', 'validation.csv'),
    schemaPath: path.join(dataDirectory, 'recovery_features_v1.schema.json'),
    outputDirectory
  });
  fs.writeFileSync(path.join(rootDirectory, 'docs', 'phase-2', '6.4.2-candidate-model-comparison.md'), renderReport(result.metadata), 'utf8');
  console.log(`Selected candidate: ${result.metadata.selected_candidate}`);
  console.log(`Comparison metadata: ${path.join(outputDirectory, 'candidate-model-comparison.metadata.json')}`);
  console.log(`Test set used: ${result.metadata.test_set_used}`);
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) main();
