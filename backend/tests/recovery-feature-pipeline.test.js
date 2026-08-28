import { generateRecoveryDataset } from '../src/intelligence/recovery-dataset-generator.js';
import { createFeatureSchema, fitFeaturePipeline, transformRows, validateFeatureRows } from '../src/intelligence/recovery-feature-pipeline.js';

describe('Recovery feature engineering pipeline', () => {
  const rawRows = generateRecoveryDataset({ seed: 42, rowCount: 20 }).rows;

  test('transformation is deterministic and preserves row count', () => {
    const schema = fitFeaturePipeline(rawRows);
    const first = transformRows(rawRows, schema);
    const second = transformRows(rawRows, schema);

    expect(first).toEqual(second);
    expect(first).toHaveLength(rawRows.length);
    expect(Object.keys(first[0])).toEqual(schema.feature_columns);
  });

  test('uses stable one-hot categorical encoding', () => {
    const schema = createFeatureSchema();
    const rows = transformRows([{
      transaction_amount: '100', currency: 'INR', payment_method: 'UPI', failure_category: 'TEMPORARY_FAILURE', failure_reason_present: 'true',
      attempt_number: '1', prior_failed_attempt_count: '0', prior_temporary_failure_count: '0', candidate_action: 'RETRY'
    }], schema);

    expect(rows[0].currency__INR).toBe(1);
    expect(rows[0].currency__USD).toBe(0);
    expect(rows[0].payment_method_attempted__UPI).toBe(1);
    expect(rows[0].candidate_action_type__RETRY).toBe(1);
    expect(rows[0].has_failure_reason).toBe(1);
  });

  test('maps unknown and missing categories to all-zero known one-hot columns', () => {
    const schema = createFeatureSchema();
    const row = transformRows([{
      transaction_amount: null, currency: 'BTC', payment_method: null, failure_category: 'NEW_FAILURE', failure_reason_present: null,
      attempt_number: null, prior_failed_attempt_count: null, prior_temporary_failure_count: null, candidate_action: 'NEW_ACTION'
    }], schema)[0];

    expect(row.transaction_amount).toBe(0);
    expect(row.has_failure_reason).toBe(0);
    expect(Object.entries(row).filter(([key]) => key.startsWith('currency__')).every(([, value]) => value === 0)).toBe(true);
    expect(Object.entries(row).filter(([key]) => key.startsWith('candidate_action_type__')).every(([, value]) => value === 0)).toBe(true);
  });

  test('excludes targets, identifiers, and post-decision fields', () => {
    const schema = createFeatureSchema();
    const forbidden = ['recovery_success', 'recovery_outcome', 'outcome_timestamp', 'transaction_id', 'decision_id', 'action_executed'];

    expect(schema.feature_columns.some((column) => forbidden.includes(column))).toBe(false);
    expect(() => validateFeatureRows(transformRows(rawRows, schema), schema)).not.toThrow();
  });

  test('rejects missing required raw feature columns', () => {
    expect(() => transformRows([{ transaction_amount: 10 }])).toThrow('Missing required raw feature columns');
  });
});
