import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../src/intelligence/recovery-dataset-quality.js';
import { loadFeatureSchema } from '../src/intelligence/recovery-feature-pipeline.js';
import { loadModel } from '../src/intelligence/baseline-recovery-model.js';
import { evaluateFrozenModel } from '../src/intelligence/evaluate-final-recovery-model.js';

const dataDirectory = path.resolve(process.cwd(), '../data/phase-2');
const modelPath = path.join(dataDirectory, 'models/recovery_interaction_v1.model.json');
const schemaPath = path.join(dataDirectory, 'recovery_features_v1.schema.json');
const testRows = readCsv(path.join(dataDirectory, 'splits/test.csv'));
const comparisonMetadata = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'models/candidate-model-comparison.metadata.json'), 'utf8'));

describe('Final frozen-model test evaluation', () => {
  test('loads the selected model and validates feature compatibility', () => {
    const model = loadModel(modelPath);
    const schema = loadFeatureSchema(schemaPath);
    const result = evaluateFrozenModel({ model, schema, testRows, validationMetadata: comparisonMetadata.candidates.interaction_logistic.evaluation });

    expect(model.model_version).toBe('phase2-interaction-logistic-v1');
    expect(model.base_feature_columns).toEqual(schema.feature_columns);
    expect(result.test_set_used).toBe(true);
  });

  test('calculates valid test probabilities and metrics', () => {
    const model = loadModel(modelPath);
    const schema = loadFeatureSchema(schemaPath);
    const result = evaluateFrozenModel({ model, schema, testRows, validationMetadata: comparisonMetadata.candidates.interaction_logistic.evaluation });

    expect(result.evaluation.aggregate.row_count).toBe(1200);
    expect(result.evaluation.aggregate.roc_auc).toBeGreaterThanOrEqual(0);
    expect(result.evaluation.aggregate.roc_auc).toBeLessThanOrEqual(1);
    expect(result.evaluation.aggregate.log_loss).toBeGreaterThanOrEqual(0);
    expect(result.evaluation.aggregate.brier_score).toBeGreaterThanOrEqual(0);
    expect(result.evaluation.by_candidate_action.RETRY).toBeDefined();
    expect(result.evaluation.by_failure_category.TEMPORARY_FAILURE).toBeDefined();
    expect(result.evaluation.by_payment_method.UPI).toBeDefined();
  });

  test('evaluation does not mutate or retrain the frozen model', () => {
    const model = loadModel(modelPath);
    const before = JSON.stringify(model);
    const schema = loadFeatureSchema(schemaPath);
    evaluateFrozenModel({ model, schema, testRows, validationMetadata: comparisonMetadata.candidates.interaction_logistic.evaluation });

    expect(JSON.stringify(model)).toBe(before);
    expect(model.hyperparameters).toEqual({ learningRate: 0.05, epochs: 700, l2: 0.03 });
  });

  test('persisted evaluation metadata is consistent', () => {
    const evaluationPath = path.join(dataDirectory, 'models/recovery_interaction_v1.test-evaluation.json');
    const metadata = JSON.parse(fs.readFileSync(evaluationPath, 'utf8'));

    expect(metadata.model_version).toBe('phase2-interaction-logistic-v1');
    expect(metadata.test_row_count).toBe(1200);
    expect(metadata.test_set_used).toBe(true);
    expect(metadata.retrained).toBe(false);
    expect(metadata.tuned).toBe(false);
    expect(metadata.evaluation.aggregate.row_count).toBe(metadata.test_row_count);
  });
});
