import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCsv } from '../src/intelligence/recovery-dataset-quality.js';
import { loadFeatureSchema } from '../src/intelligence/recovery-feature-pipeline.js';
import { compareCandidates, selectCandidate, trainInteractionModel, predictInteractionProbabilities } from '../src/intelligence/candidate-model-comparison.js';
import { trainBaselineModel, predictProbabilities } from '../src/intelligence/baseline-recovery-model.js';

const dataDirectory = path.resolve(process.cwd(), '../data/phase-2');
const schema = loadFeatureSchema(path.join(dataDirectory, 'recovery_features_v1.schema.json'));
const trainRows = readCsv(path.join(dataDirectory, 'splits/train.csv'));
const validationRows = readCsv(path.join(dataDirectory, 'splits/validation.csv'));

describe('Candidate model comparison', () => {
  test('trains nonlinear candidate with valid deterministic probabilities', () => {
    const first = trainInteractionModel(trainRows, schema);
    const second = trainInteractionModel(trainRows, schema);

    expect(first).toEqual(second);
    expect(first.feature_columns.length).toBeGreaterThan(schema.feature_columns.length);
    expect(predictInteractionProbabilities(first, validationRows).every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  test('selection rule considers ranking and probability quality', () => {
    const baseline = { evaluation: { aggregate: { roc_auc: 0.8, pr_auc: 0.7, log_loss: 0.5, brier_score: 0.2 } } };
    const improved = { evaluation: { aggregate: { roc_auc: 0.81, pr_auc: 0.71, log_loss: 0.501, brier_score: 0.201 } } };
    const poorProbability = { evaluation: { aggregate: { roc_auc: 0.82, pr_auc: 0.72, log_loss: 0.7, brier_score: 0.3 } } };

    expect(selectCandidate({ logistic_baseline: baseline, interaction_logistic: improved })).toBe('interaction_logistic');
    expect(selectCandidate({ logistic_baseline: baseline, interaction_logistic: poorProbability })).toBe('logistic_baseline');
  });

  test('comparison creates separate artifacts and metadata without test usage', () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-comparison-'));
    const result = compareCandidates({
      trainPath: path.join(dataDirectory, 'splits/train.csv'),
      validationPath: path.join(dataDirectory, 'splits/validation.csv'),
      schemaPath: path.join(dataDirectory, 'recovery_features_v1.schema.json'),
      outputDirectory
    });

    expect(fs.existsSync(path.join(outputDirectory, 'models/recovery_baseline_v1.model.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDirectory, 'models/recovery_interaction_v1.model.json'))).toBe(true);
    expect(result.metadata.test_set_used).toBe(false);
    expect(result.metadata.training_row_count).toBe(3600);
    expect(result.metadata.validation_row_count).toBe(1200);
    expect(Object.keys(result.metadata.candidates)).toEqual(['logistic_baseline', 'interaction_logistic']);
    expect(result.metadata.candidates.interaction_logistic.evaluation.by_candidate_action.RETRY).toBeDefined();
  });

  test('baseline and candidate use the same feature target separation', () => {
    const baseline = trainBaselineModel(trainRows, schema);
    const candidate = trainInteractionModel(trainRows, schema);

    expect(baseline.target).toBe('recovery_success');
    expect(candidate.target).toBe('recovery_success');
    expect(baseline.feature_columns).not.toContain('recovery_success');
    expect(candidate.feature_columns).not.toContain('recovery_success');
    expect(predictProbabilities(baseline, validationRows)).toHaveLength(1200);
  });
});
