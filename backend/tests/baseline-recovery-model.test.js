import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../src/intelligence/recovery-dataset-quality.js';
import { loadFeatureSchema } from '../src/intelligence/recovery-feature-pipeline.js';
import { calculateMetrics, predictProbabilities, trainBaselineModel } from '../src/intelligence/baseline-recovery-model.js';

const dataDirectory = path.resolve(process.cwd(), '../data/phase-2');
const schema = loadFeatureSchema(path.join(dataDirectory, 'recovery_features_v1.schema.json'));
const trainRows = readCsv(path.join(dataDirectory, 'splits/train.csv'));
const validationRows = readCsv(path.join(dataDirectory, 'splits/validation.csv'));

describe('Baseline recovery prediction model', () => {
  test('uses exactly the finalized feature schema and separate target', () => {
    const model = trainBaselineModel(trainRows, schema);

    expect(model.feature_columns).toEqual(schema.feature_columns);
    expect(model.feature_columns).not.toContain('recovery_success');
    expect(model.target).toBe('recovery_success');
  });

  test('training and predictions are deterministic', () => {
    const first = trainBaselineModel(trainRows, schema);
    const second = trainBaselineModel(trainRows, schema);

    expect(first).toEqual(second);
    expect(predictProbabilities(first, validationRows)).toEqual(predictProbabilities(second, validationRows));
  });

  test('probabilities and metrics are valid', () => {
    const model = trainBaselineModel(trainRows, schema);
    const probabilities = predictProbabilities(model, validationRows);
    const metrics = calculateMetrics(validationRows, probabilities);

    expect(probabilities).toHaveLength(validationRows.length);
    expect(probabilities.every((probability) => probability >= 0 && probability <= 1)).toBe(true);
    expect(metrics.roc_auc).toBeGreaterThanOrEqual(0);
    expect(metrics.roc_auc).toBeLessThanOrEqual(1);
    expect(metrics.log_loss).toBeGreaterThanOrEqual(0);
    expect(metrics.brier_score).toBeGreaterThanOrEqual(0);
  });

  test('persisted baseline artifacts exist and record test-set isolation', () => {
    const modelPath = path.join(dataDirectory, 'models/recovery_baseline_v1.model.json');
    const metadataPath = path.join(dataDirectory, 'models/recovery_baseline_v1.metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    expect(fs.existsSync(modelPath)).toBe(true);
    expect(fs.existsSync(metadataPath)).toBe(true);
    expect(metadata.training_row_count).toBe(3600);
    expect(metadata.validation_row_count).toBe(1200);
    expect(metadata.test_set_used).toBe(false);
    expect(metadata.evaluation.by_candidate_action).toBeDefined();
    expect(metadata.evaluation.by_failure_category).toBeDefined();
    expect(metadata.evaluation.by_payment_method).toBeDefined();
  });
});
