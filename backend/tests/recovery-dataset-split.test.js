import { generateRecoveryDataset } from '../src/intelligence/recovery-dataset-generator.js';
import { createFeatureSchema, transformRows } from '../src/intelligence/recovery-feature-pipeline.js';
import { createSplitMetadata, splitChronologically, validateSplits } from '../src/intelligence/recovery-dataset-split.js';

describe('Chronological recovery dataset split', () => {
  function makeData(rowCount = 20) {
    const rawRows = generateRecoveryDataset({ seed: 42, rowCount }).rows;
    const schema = createFeatureSchema();
    return { rawRows, featureRows: transformRows(rawRows, schema), featureColumns: schema.feature_columns };
  }

  test('creates non-overlapping chronological partitions', () => {
    const { rawRows, featureRows, featureColumns } = makeData(20);
    const splits = splitChronologically(rawRows, featureRows, featureColumns);

    expect(splits.train.rows).toHaveLength(12);
    expect(splits.validation.rows).toHaveLength(4);
    expect(splits.test.rows).toHaveLength(4);
    expect(new Date(splits.train.rawRows.at(-1).decision_timestamp).getTime()).toBeLessThan(new Date(splits.validation.rawRows[0].decision_timestamp).getTime());
    expect(new Date(splits.validation.rawRows.at(-1).decision_timestamp).getTime()).toBeLessThan(new Date(splits.test.rawRows[0].decision_timestamp).getTime());
  });

  test('same input produces identical split rows', () => {
    const first = makeData(30);
    const second = makeData(30);
    const firstSplits = splitChronologically(first.rawRows, first.featureRows, first.featureColumns);
    const secondSplits = splitChronologically(second.rawRows, second.featureRows, second.featureColumns);

    expect(firstSplits.train.rows).toEqual(secondSplits.train.rows);
    expect(firstSplits.validation.rows).toEqual(secondSplits.validation.rows);
    expect(firstSplits.test.rows).toEqual(secondSplits.test.rows);
  });

  test('preserves counts and keeps target separate from features', () => {
    const { rawRows, featureRows, featureColumns } = makeData(25);
    const splits = splitChronologically(rawRows, featureRows, featureColumns);
    const allRows = [...splits.train.rows, ...splits.validation.rows, ...splits.test.rows];

    expect(allRows).toHaveLength(rawRows.length);
    expect(Object.keys(allRows[0])).toEqual([...featureColumns, 'recovery_success']);
    expect(featureColumns).not.toContain('recovery_success');
    expect(() => validateSplits(splits, featureColumns)).not.toThrow();
  });

  test('reports distributions and temporal metadata', () => {
    const { rawRows, featureRows, featureColumns } = makeData(20);
    const splits = splitChronologically(rawRows, featureRows, featureColumns);
    const metadata = createSplitMetadata(splits, 'v1', '1.0.0');

    expect(metadata.splits.train.recovery_success).toBeDefined();
    expect(metadata.splits.validation.candidate_action).toBeDefined();
    expect(metadata.splits.test.failure_category).toBeDefined();
    expect(metadata.splits.test.payment_method).toBeDefined();
    expect(metadata.random_seed).toBeNull();
  });

  test('rejects forbidden fields in feature matrix', () => {
    const { rawRows, featureRows, featureColumns } = makeData(20);
    expect(() => splitChronologically(rawRows, featureRows, featureColumns.concat('transaction_id'))).toThrow('Forbidden fields');
  });
});
