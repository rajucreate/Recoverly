import fs from 'node:fs';
import { generateRecoveryDataset } from '../src/intelligence/recovery-dataset-generator.js';
import { readCsv, validateQuality } from '../src/intelligence/recovery-dataset-quality.js';

const datasetPath = new URL('../../data/phase-2/recovery_dataset_v1.csv', import.meta.url);
const metadataPath = new URL('../../data/phase-2/recovery_dataset_v1.metadata.json', import.meta.url);

describe('Synthetic recovery dataset quality validation', () => {
  test('validates the checked-in generated dataset', () => {
    const rows = readCsv(datasetPath);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const report = validateQuality(rows, metadata);

    expect(report.ready).toBe(true);
    expect(report.row_count).toBe(6000);
    expect(report.critical_issues).toHaveLength(0);
    expect(report.temporal.ordered).toBe(true);
  });

  test('detects an outcome before its decision', () => {
    const { rows } = generateRecoveryDataset({ seed: 3, rowCount: 100 });
    rows[0].outcome_timestamp = rows[0].decision_timestamp;
    rows[1].outcome_timestamp = '2024-01-01T00:00:00.000Z';

    const report = validateQuality(rows);

    expect(report.ready).toBe(false);
    expect(report.critical_issues.some(({ code }) => code === 'CAUSAL_ORDER')).toBe(true);
  });

  test('detects invalid actions and target values', () => {
    const { rows } = generateRecoveryDataset({ seed: 4, rowCount: 100 });
    rows[0].candidate_action = 'NOT_AN_ACTION';
    rows[0].recovery_success = '2';

    const report = validateQuality(rows);

    expect(report.ready).toBe(false);
    expect(report.critical_issues.some(({ code }) => code === 'INVALID_CATEGORY')).toBe(true);
    expect(report.critical_issues.some(({ code }) => code === 'INVALID_TARGET')).toBe(true);
  });

  test('detects duplicate decision/candidate pairs', () => {
    const { rows } = generateRecoveryDataset({ seed: 5, rowCount: 100 });
    rows[1].decision_id = rows[0].decision_id;
    rows[1].candidate_action = rows[0].candidate_action;

    const report = validateQuality(rows);

    expect(report.ready).toBe(false);
    expect(report.critical_issues.some(({ code }) => code === 'DUPLICATE_DECISION_ACTION')).toBe(true);
  });
});
