import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from './recovery-dataset-quality.js';
import { loadFeatureSchema } from './recovery-feature-pipeline.js';
import { FEATURE_PIPELINE_VERSION } from './recovery-feature-pipeline.js';
import {
  BASELINE_MODEL_VERSION,
  calculateOneHotGroupedMetrics,
  calculateMetrics,
  predictProbabilities,
  saveModel,
  trainBaselineModel
} from './baseline-recovery-model.js';

export const INTERACTION_MODEL_VERSION = 'phase2-interaction-logistic-v1';
export const COMPARISON_VERSION = '6.4.2';
const INTERACTION_PREFIXES = [
  'failure_category__',
  'candidate_action_type__',
  'payment_method_attempted__'
];

function interactionColumns(featureColumns) {
  const categoricalColumns = featureColumns.filter((column) => INTERACTION_PREFIXES.some((prefix) => column.startsWith(prefix)));
  const columns = [];
  for (let left = 0; left < categoricalColumns.length; left += 1) {
    for (let right = left + 1; right < categoricalColumns.length; right += 1) {
      columns.push(`${categoricalColumns[left]}__x__${categoricalColumns[right]}`);
    }
  }
  return columns;
}

export function createInteractionSchema(baseSchema) {
  const interactions = interactionColumns(baseSchema.feature_columns);
  return {
    ...baseSchema,
    feature_pipeline_version: `${baseSchema.feature_pipeline_version}+interactions`,
    feature_columns: [...baseSchema.feature_columns, ...interactions],
    interaction_columns: interactions,
    base_feature_schema_version: baseSchema.feature_schema_version
  };
}

export function addInteractions(rows, baseSchema) {
  const interactionNames = interactionColumns(baseSchema.feature_columns);
  return rows.map((row) => {
    const expanded = {};
    const interactionValues = {};
    const categoricalColumns = baseSchema.feature_columns.filter((column) => INTERACTION_PREFIXES.some((prefix) => column.startsWith(prefix)));
    for (let left = 0; left < categoricalColumns.length; left += 1) {
      for (let right = left + 1; right < categoricalColumns.length; right += 1) {
        const name = `${categoricalColumns[left]}__x__${categoricalColumns[right]}`;
        interactionValues[name] = Number(row[categoricalColumns[left]]) * Number(row[categoricalColumns[right]]);
      }
    }
    for (const column of baseSchema.feature_columns) expanded[column] = row[column];
    for (const name of interactionNames) expanded[name] = interactionValues[name] ?? 0;
    if (Object.prototype.hasOwnProperty.call(row, 'recovery_success')) expanded.recovery_success = row.recovery_success;
    return expanded;
  });
}

export function trainInteractionModel(trainRows, baseSchema) {
  const schema = createInteractionSchema(baseSchema);
  const model = trainBaselineModel(addInteractions(trainRows, baseSchema), schema, {
    learningRate: 0.05,
    epochs: 700,
    l2: 0.03
  });
  return {
    ...model,
    model_version: INTERACTION_MODEL_VERSION,
    training_version: COMPARISON_VERSION,
    feature_pipeline_version: FEATURE_PIPELINE_VERSION,
    feature_schema_version: baseSchema.feature_schema_version,
    base_feature_columns: [...baseSchema.feature_columns],
    interaction_columns: schema.interaction_columns,
    feature_columns: schema.feature_columns
  };
}

export function predictInteractionProbabilities(model, rows) {
  return predictProbabilities(model, addInteractions(rows, { feature_columns: model.base_feature_columns }));
}

export function evaluateCandidate(model, validationRows, predictor = predictProbabilities) {
  const probabilities = predictor(model, validationRows);
  return {
    aggregate: calculateMetrics(validationRows, probabilities),
    by_candidate_action: calculateOneHotGroupedMetrics(validationRows, probabilities, 'candidate_action_type'),
    by_failure_category: calculateOneHotGroupedMetrics(validationRows, probabilities, 'failure_category'),
    by_payment_method: calculateOneHotGroupedMetrics(validationRows, probabilities, 'payment_method_attempted'),
    probabilities
  };
}

function selectCandidate(results) {
  const baseline = results.logistic_baseline.evaluation.aggregate;
  const interaction = results.interaction_logistic.evaluation.aggregate;
  const improvesRanking = interaction.roc_auc >= baseline.roc_auc + 0.005 && interaction.pr_auc >= baseline.pr_auc;
  const probabilityQualityIsAcceptable = interaction.log_loss <= baseline.log_loss + 0.01 && interaction.brier_score <= baseline.brier_score + 0.005;
  return improvesRanking && probabilityQualityIsAcceptable ? 'interaction_logistic' : 'logistic_baseline';
}

export { selectCandidate };

export function compareCandidates({ trainPath, validationPath, schemaPath, outputDirectory, datasetVersion = 'v1', splitVersion = '1.0.0' }) {
  const schema = loadFeatureSchema(schemaPath);
  const trainRows = readCsv(trainPath);
  const validationRows = readCsv(validationPath);
  const baselineModel = trainBaselineModel(trainRows, schema);
  const interactionModel = trainInteractionModel(trainRows, schema);
  const baselineEvaluation = evaluateCandidate(baselineModel, validationRows);
  const interactionProbabilities = predictInteractionProbabilities(interactionModel, validationRows);
  const interactionEvaluation = {
    aggregate: calculateMetrics(validationRows, interactionProbabilities),
    by_candidate_action: calculateOneHotGroupedMetrics(validationRows, interactionProbabilities, 'candidate_action_type'),
    by_failure_category: calculateOneHotGroupedMetrics(validationRows, interactionProbabilities, 'failure_category'),
    by_payment_method: calculateOneHotGroupedMetrics(validationRows, interactionProbabilities, 'payment_method_attempted'),
    probabilities: interactionProbabilities
  };
  const results = {
    logistic_baseline: { model: baselineModel, evaluation: baselineEvaluation, feature_count: baselineModel.feature_columns.length },
    interaction_logistic: { model: interactionModel, evaluation: interactionEvaluation, feature_count: interactionModel.feature_columns.length }
  };
  const selectedCandidate = selectCandidate(results);
  const modelDirectory = path.join(outputDirectory, 'models');
  fs.mkdirSync(modelDirectory, { recursive: true });
  saveModel(baselineModel, path.join(modelDirectory, 'recovery_baseline_v1.model.json'));
  saveModel(interactionModel, path.join(modelDirectory, 'recovery_interaction_v1.model.json'));
  const metadata = {
    comparison_version: COMPARISON_VERSION,
    dataset_version: datasetVersion,
    training_split_version: splitVersion,
    feature_schema_version: schema.feature_schema_version,
    training_row_count: trainRows.length,
    validation_row_count: validationRows.length,
    test_set_used: false,
    selected_candidate: selectedCandidate,
    selection_rule: 'Select interaction model only when ROC-AUC improves by >= 0.005, PR-AUC does not decrease, log loss worsens by <= 0.01, and Brier score worsens by <= 0.005; otherwise retain logistic baseline.',
    candidates: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
      model_version: result.model.model_version,
      feature_count: result.feature_count,
      hyperparameters: result.model.hyperparameters,
      evaluation: { aggregate: result.evaluation.aggregate, by_candidate_action: result.evaluation.by_candidate_action, by_failure_category: result.evaluation.by_failure_category, by_payment_method: result.evaluation.by_payment_method }
    }])),
    generated_at: new Date().toISOString(),
    runtime: `node ${process.version}`
  };
    fs.writeFileSync(path.join(modelDirectory, 'candidate-model-comparison.metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { results, metadata, modelDirectory };
}
