import fs from 'node:fs';
import path from 'node:path';
import { generateRecoveryDataset } from '../src/intelligence/recovery-dataset-generator.js';
import {
  FEATURE_PIPELINE_VERSION,
  FEATURE_SCHEMA_VERSION,
  createFeatureSchema,
  loadFeatureSchema,
  transformRows,
  transformSingleDecisionRecord,
  validateFeatureArtifactCompatibility
} from '../src/intelligence/recovery-feature-pipeline.js';

const rootDirectory = path.resolve(process.cwd(), '..');
const dataDirectory = path.join(rootDirectory, 'data', 'phase-2');
const schemaPath = path.join(dataDirectory, 'recovery_features_v1.schema.json');

describe('Finalized training/inference feature pipeline', () => {
  const rawRow = generateRecoveryDataset({ seed: 42, rowCount: 1 }).rows[0];
  const persistedSchema = loadFeatureSchema(schemaPath);

  function inferenceRecord() {
    return {
      transaction_amount: rawRow.transaction_amount,
      currency: rawRow.currency,
      payment_method_attempted: rawRow.payment_method,
      failure_category: rawRow.failure_category,
      has_failure_reason: rawRow.failure_reason_present,
      attempt_number: rawRow.attempt_number,
      prior_failed_attempt_count: rawRow.prior_failed_attempt_count,
      prior_temporary_failure_count: rawRow.prior_temporary_failure_count,
      candidate_action_type: rawRow.candidate_action
    };
  }

  test('single-record output equals batch output using persisted schema', () => {
    const batchRow = transformRows([rawRow], persistedSchema)[0];
    expect(transformSingleDecisionRecord(inferenceRecord(), persistedSchema)).toEqual(batchRow);
  });

  test('identical inference input is deterministic', () => {
    expect(transformSingleDecisionRecord(inferenceRecord(), persistedSchema)).toEqual(transformSingleDecisionRecord(inferenceRecord(), persistedSchema));
  });

  test('persisted schema fixes version and feature ordering', () => {
    const generatedSchema = createFeatureSchema();
    expect(persistedSchema.feature_pipeline_version).toBe(FEATURE_PIPELINE_VERSION);
    expect(persistedSchema.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION);
    expect(persistedSchema.feature_columns).toEqual(generatedSchema.feature_columns);
    expect(Object.keys(transformSingleDecisionRecord(inferenceRecord(), persistedSchema))).toEqual(persistedSchema.feature_columns);
  });

  test('unknown and missing categories remain deterministic', () => {
    const record = { ...inferenceRecord(), currency: 'BTC', payment_method_attempted: null, failure_category: null, candidate_action_type: null, has_failure_reason: null };
    const first = transformSingleDecisionRecord(record, persistedSchema);
    const second = transformSingleDecisionRecord(record, persistedSchema);
    expect(first).toEqual(second);
    expect(Object.entries(first).filter(([key]) => key.startsWith('currency__')).every(([, value]) => value === 0)).toBe(true);
  });

  test('rejects forbidden outcome fields and invalid action values', () => {
    expect(() => transformSingleDecisionRecord({ ...inferenceRecord(), recovery_success: 1 }, persistedSchema)).toThrow('Forbidden post-decision fields');
    expect(() => transformSingleDecisionRecord({ ...inferenceRecord(), candidate_action_type: 'NOT_AN_ACTION' }, persistedSchema)).toThrow('Invalid candidate_action_type');
  });

  test('train, validation, and test metadata use the same pipeline version', () => {
    const featureMetadata = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'recovery_features_v1.metadata.json'), 'utf8'));
    const splitMetadata = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'splits', 'splits.metadata.json'), 'utf8'));
    expect(validateFeatureArtifactCompatibility(persistedSchema, featureMetadata, splitMetadata)).toBe(true);
  });
});
