import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecoveryPredictionService, PredictionServiceError } from '../src/intelligence/recovery-prediction-service.js';
import { loadModel } from '../src/intelligence/baseline-recovery-model.js';

const rootDirectory = path.resolve(process.cwd(), '..');
const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
const modelPath = path.join(dataDirectory, 'models', 'recovery_interaction_v1.model.json');
const schemaPath = path.join(dataDirectory, 'recovery_features_v1.schema.json');

function context(action = 'RETRY') {
  return {
    transaction_amount: 5000,
    currency: 'INR',
    payment_method_attempted: 'UPI',
    failure_category: 'TEMPORARY_FAILURE',
    has_failure_reason: true,
    attempt_number: 1,
    prior_failed_attempt_count: 0,
    prior_temporary_failure_count: 0,
    candidate_action_type: action
  };
}

describe('Internal recovery prediction service', () => {
  test('returns a valid single-action prediction with frozen metadata', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath, now: () => new Date('2026-01-01T00:00:00.000Z') });
    const prediction = service.predict(context());

    expect(prediction.candidate_action_type).toBe('RETRY');
    expect(prediction.recovery_probability).toBeGreaterThanOrEqual(0);
    expect(prediction.recovery_probability).toBeLessThanOrEqual(1);
    expect(prediction.model_version).toBe('phase2-interaction-logistic-v1');
    expect(prediction.feature_schema_version).toBe('6.3.1');
    expect(prediction.feature_pipeline_version).toBe('1.0.0');
    expect(prediction.predicted_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('predicts all supported actions in deterministic order', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath });
    const predictions = service.predictAll(context());

    expect(predictions.map(({ candidate_action_type }) => candidate_action_type)).toEqual(['RETRY', 'ALTERNATE_METHOD', 'CUSTOMER_ACTION', 'ESCALATE']);
    expect(predictions.every(({ recovery_probability }) => recovery_probability >= 0 && recovery_probability <= 1)).toBe(true);
  });

  test('identical inputs produce identical predictions apart from prediction time', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath, now: () => new Date('2026-01-01T00:00:00.000Z') });
    expect(service.predict(context())).toEqual(service.predict(context()));
  });

  test('rejects missing fields, invalid actions, malformed numbers, and forbidden fields', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath });
    const missing = { ...context() };
    delete missing.failure_category;

    expect(() => service.predict(missing)).toThrow(PredictionServiceError);
    expect(() => service.predict(missing)).toThrow('Missing required decision-time fields');
    expect(() => service.predict({ ...context(), candidate_action_type: 'INVALID' })).toThrow('Invalid candidate action');
    expect(() => service.predict({ ...context(), transaction_amount: 'not-a-number' })).toThrow('Prediction failed');
    expect(() => service.predict({ ...context(), recovery_success: 1 })).toThrow('Forbidden post-decision fields');
  });

  test('handles missing and unknown values through the finalized feature pipeline', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath });
    const prediction = service.predict({ ...context(), transaction_amount: null, currency: 'BTC', payment_method_attempted: null, failure_category: null, has_failure_reason: null });

    expect(prediction.recovery_probability).toBeGreaterThanOrEqual(0);
    expect(prediction.recovery_probability).toBeLessThanOrEqual(1);
  });

  test('rejects incompatible schema and missing model artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recoverly-prediction-'));
    const incompatibleModelPath = path.join(directory, 'model.json');
    const model = loadModel(modelPath);
    fs.writeFileSync(incompatibleModelPath, JSON.stringify({ ...model, feature_schema_version: 'wrong' }));

    expect(() => new RecoveryPredictionService({ modelPath: incompatibleModelPath, schemaPath })).toThrow('incompatible');
    expect(() => new RecoveryPredictionService({ modelPath: path.join(directory, 'missing.json'), schemaPath })).toThrow('not found');
  });

  test('reports invalid model output without invoking any recovery action', () => {
    const service = new RecoveryPredictionService({ modelPath, schemaPath });
    service.model.coefficients = service.model.coefficients.map(() => Number.NaN);

    expect(() => service.predict(context())).toThrow('invalid probability');
  });
});
