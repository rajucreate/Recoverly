import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from './recovery-dataset-quality.js';
import { loadFeatureSchema, FEATURE_SCHEMA_VERSION } from './recovery-feature-pipeline.js';

export const BASELINE_MODEL_VERSION = 'phase2-logistic-baseline-v1';
export const BASELINE_TRAINING_VERSION = '6.4.1';
export const TARGET_FIELD = 'recovery_success';
const DEFAULT_OPTIONS = Object.freeze({ learningRate: 0.08, epochs: 1200, l2: 0.01 });
const NUMERIC_COLUMNS = ['transaction_amount', 'attempt_number', 'prior_failed_attempt_count', 'prior_temporary_failure_count'];
const EPSILON = 1e-15;

function assertFeatureColumns(rows, featureColumns, requireTarget = true) {
  if (!rows.length) throw new Error('Model dataset must contain rows.');
  const actual = Object.keys(rows[0]);
  const hasExpectedFeatures = featureColumns.every((column, index) => actual[index] === column);
  const hasTarget = actual.at(-1) === TARGET_FIELD;
  const expectedLength = requireTarget === null ? featureColumns.length + (hasTarget ? 1 : 0) : featureColumns.length + (requireTarget ? 1 : 0);
  if (!hasExpectedFeatures || actual.length !== expectedLength || (requireTarget === true && !hasTarget) || (requireTarget === false && hasTarget)) {
    throw new Error('Dataset columns do not match the feature schema plus recovery_success target.');
  }
}

function numericRows(rows, featureColumns) {
  return rows.map((row, rowIndex) => featureColumns.map((column) => {
    const value = Number(row[column]);
    if (!Number.isFinite(value)) throw new Error(`Invalid feature value ${column} at row ${rowIndex + 1}.`);
    return value;
  }));
}

function targets(rows) {
  return rows.map((row, index) => {
    const value = Number(row[TARGET_FIELD]);
    if (![0, 1].includes(value)) throw new Error(`Invalid target at row ${index + 1}.`);
    return value;
  });
}

function fitScaler(features, featureColumns) {
  const means = featureColumns.map((column, index) => NUMERIC_COLUMNS.includes(column) ? features.reduce((sum, row) => sum + row[index], 0) / features.length : 0);
  const scales = featureColumns.map((column, index) => {
    if (!NUMERIC_COLUMNS.includes(column)) return 1;
    const variance = features.reduce((sum, row) => sum + ((row[index] - means[index]) ** 2), 0) / features.length;
    return Math.sqrt(variance) || 1;
  });
  return { means, scales };
}

function applyScaler(features, scaler) {
  return features.map((row) => row.map((value, index) => (value - scaler.means[index]) / scaler.scales[index]));
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function predictMatrix(features, weights, intercept) {
  return features.map((row) => sigmoid(intercept + row.reduce((sum, value, index) => sum + value * weights[index], 0)));
}

export function trainBaselineModel(trainRows, featureSchema, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const featureColumns = featureSchema.feature_columns;
  assertFeatureColumns(trainRows, featureColumns);
  const rawFeatures = numericRows(trainRows, featureColumns);
  const labels = targets(trainRows);
  const scaler = fitScaler(rawFeatures, featureColumns);
  const features = applyScaler(rawFeatures, scaler);
  const weights = Array(featureColumns.length).fill(0);
  let intercept = 0;

  for (let epoch = 0; epoch < settings.epochs; epoch += 1) {
    const probabilities = predictMatrix(features, weights, intercept);
    const errors = probabilities.map((probability, index) => probability - labels[index]);
    let interceptGradient = errors.reduce((sum, error) => sum + error, 0) / features.length;
    intercept -= settings.learningRate * interceptGradient;
    for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
      const gradient = features.reduce((sum, row, rowIndex) => sum + errors[rowIndex] * row[featureIndex], 0) / features.length + settings.l2 * weights[featureIndex];
      weights[featureIndex] -= settings.learningRate * gradient;
    }
  }

  return {
    model_version: BASELINE_MODEL_VERSION,
    training_version: BASELINE_TRAINING_VERSION,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    feature_columns: [...featureColumns],
    target: TARGET_FIELD,
    numeric_scaling: { columns: NUMERIC_COLUMNS, means: scaler.means, scales: scaler.scales, fit_on: 'training_split_only' },
    coefficients: weights,
    intercept,
    hyperparameters: settings,
    training_row_count: trainRows.length
  };
}

export function predictProbabilities(model, rows) {
  assertFeatureColumns(rows, model.feature_columns, null);
  const rawFeatures = numericRows(rows, model.feature_columns);
  return predictMatrix(applyScaler(rawFeatures, model.numeric_scaling), model.coefficients, model.intercept).map((value) => Math.min(1 - EPSILON, Math.max(EPSILON, value)));
}

function rankPairs(probabilities, labels) {
  return probabilities.map((probability, index) => ({ probability, label: labels[index], index })).sort((left, right) => right.probability - left.probability || left.index - right.index);
}

export function calculateMetrics(rows, probabilities) {
  const labels = targets(rows);
  const threshold = 0.5;
  const predicted = probabilities.map((probability) => probability >= threshold ? 1 : 0);
  const confusion = { true_positive: 0, true_negative: 0, false_positive: 0, false_negative: 0 };
  predicted.forEach((value, index) => {
    if (value === 1 && labels[index] === 1) confusion.true_positive += 1;
    if (value === 0 && labels[index] === 0) confusion.true_negative += 1;
    if (value === 1 && labels[index] === 0) confusion.false_positive += 1;
    if (value === 0 && labels[index] === 1) confusion.false_negative += 1;
  });

  const positives = labels.filter((label) => label === 1).length;
  const negatives = labels.length - positives;
  let concordant = 0;
  let tied = 0;
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = 0; right < labels.length; right += 1) {
      if (labels[left] !== 1 || labels[right] !== 0) continue;
      if (probabilities[left] > probabilities[right]) concordant += 1;
      if (probabilities[left] === probabilities[right]) tied += 1;
    }
  }

  const ranked = rankPairs(probabilities, labels);
  let positiveSeen = 0;
  let averagePrecision = 0;
  ranked.forEach((item, index) => {
    if (item.label === 1) {
      positiveSeen += 1;
      averagePrecision += positiveSeen / (index + 1);
    }
  });

  const precision = confusion.true_positive + confusion.false_positive === 0 ? 0 : confusion.true_positive / (confusion.true_positive + confusion.false_positive);
  const recall = positives === 0 ? 0 : confusion.true_positive / positives;
  const accuracy = (confusion.true_positive + confusion.true_negative) / labels.length;
  const logLoss = -labels.reduce((sum, label, index) => sum + label * Math.log(probabilities[index]) + (1 - label) * Math.log(1 - probabilities[index]), 0) / labels.length;
  const brier = labels.reduce((sum, label, index) => sum + (probabilities[index] - label) ** 2, 0) / labels.length;

  return {
    row_count: rows.length,
    roc_auc: positives && negatives ? (concordant + tied / 2) / (positives * negatives) : null,
    pr_auc: positives ? averagePrecision / positives : null,
    accuracy,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall),
    log_loss: logLoss,
    brier_score: brier,
    confusion_matrix: confusion,
    probability_distribution: {
      min: Math.min(...probabilities),
      max: Math.max(...probabilities),
      mean: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length,
      p50: [...probabilities].sort((left, right) => left - right)[Math.floor(probabilities.length * 0.5)],
      p95: [...probabilities].sort((left, right) => left - right)[Math.floor(probabilities.length * 0.95)]
    }
  };
}

export function calculateGroupedMetrics(rows, probabilities, field) {
  const groups = {};
  rows.forEach((row, index) => {
    groups[row[field]] ??= { rows: [], probabilities: [] };
    groups[row[field]].rows.push(row);
    groups[row[field]].probabilities.push(probabilities[index]);
  });
  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([value, group]) => [value, calculateMetrics(group.rows, group.probabilities)]));
}

export function calculateOneHotGroupedMetrics(rows, probabilities, prefix) {
  const groups = {};
  rows.forEach((row, index) => {
    const categoryColumn = Object.keys(row).find((column) => column.startsWith(`${prefix}__`) && Number(row[column]) === 1);
    const category = categoryColumn ? categoryColumn.slice(prefix.length + 2) : '__UNKNOWN__';
    groups[category] ??= { rows: [], probabilities: [] };
    groups[category].rows.push(row);
    groups[category].probabilities.push(probabilities[index]);
  });
  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([value, group]) => [value, calculateMetrics(group.rows, group.probabilities)]));
}

export function saveModel(model, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
}

export function loadModel(modelPath) {
  return JSON.parse(fs.readFileSync(modelPath, 'utf8'));
}

export function trainAndEvaluate({ trainPath, validationPath, schemaPath, modelPath, metadataPath, datasetVersion = 'v1', splitVersion = '1.0.0' }) {
  const schema = loadFeatureSchema(schemaPath);
  const trainRows = readCsv(trainPath);
  const validationRows = readCsv(validationPath);
  const model = trainBaselineModel(trainRows, schema);
  const validationProbabilities = predictProbabilities(model, validationRows);
  const evaluation = {
    aggregate: calculateMetrics(validationRows, validationProbabilities),
    by_candidate_action: calculateOneHotGroupedMetrics(validationRows, validationProbabilities, 'candidate_action_type'),
    by_failure_category: calculateOneHotGroupedMetrics(validationRows, validationProbabilities, 'failure_category'),
    by_payment_method: calculateOneHotGroupedMetrics(validationRows, validationProbabilities, 'payment_method_attempted')
  };
  saveModel(model, modelPath);
  const metadata = {
    model_version: model.model_version,
    training_version: BASELINE_TRAINING_VERSION,
    feature_schema_version: model.feature_schema_version,
    dataset_version: datasetVersion,
    training_split_version: splitVersion,
    training_row_count: trainRows.length,
    validation_row_count: validationRows.length,
    test_set_used: false,
    trained_at: new Date().toISOString(),
    runtime: `node ${process.version}`,
    evaluation
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { model, metadata };
}
