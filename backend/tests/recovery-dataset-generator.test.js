import { generateRecoveryDataset, validateRecoveryDataset, RECOVERY_ACTIONS, PAYMENT_METHODS, FAILURE_CATEGORIES, FEATURE_FIELDS, OUTCOME_FIELDS } from '../src/intelligence/recovery-dataset-generator.js';

describe('Synthetic recovery dataset generator', () => {
  test('same seed produces deterministic rows', () => {
    const first = generateRecoveryDataset({ seed: 42, rowCount: 250 });
    const second = generateRecoveryDataset({ seed: 42, rowCount: 250 });

    expect(first.rows).toEqual(second.rows);
    expect(first.metadata.random_seed).toBe(42);
  });

  test('different seeds produce different data', () => {
    const first = generateRecoveryDataset({ seed: 42, rowCount: 250 });
    const second = generateRecoveryDataset({ seed: 43, rowCount: 250 });

    expect(first.rows).not.toEqual(second.rows);
  });

  test('generated rows satisfy schema and validation checks', () => {
    const { rows } = generateRecoveryDataset({ seed: 7, rowCount: 300 });

    expect(() => validateRecoveryDataset(rows)).not.toThrow();
    expect(rows).toHaveLength(300);
    expect(rows[0]).toEqual(expect.objectContaining({
      decision_id: expect.any(String),
      transaction_id: expect.any(String),
      attempt_id: expect.any(String),
      payment_method: expect.any(String),
      failure_category: expect.any(String),
      candidate_action: expect.any(String),
      recovery_success: expect.any(Number)
    }));
  });

  test('timestamps are ordered and causal', () => {
    const { rows } = generateRecoveryDataset({ seed: 11, rowCount: 200 });

    for (const row of rows) {
      expect(new Date(row.decision_timestamp).toString()).not.toBe('Invalid Date');
      expect(new Date(row.outcome_timestamp).toString()).not.toBe('Invalid Date');
      expect(new Date(row.outcome_timestamp).getTime()).toBeGreaterThanOrEqual(new Date(row.decision_timestamp).getTime());
    }
  });

  test('candidate actions and target values are valid', () => {
    const { rows } = generateRecoveryDataset({ seed: 2, rowCount: 120 });

    for (const row of rows) {
      expect(RECOVERY_ACTIONS).toContain(row.candidate_action);
      expect(row.selected_action).toBe(row.candidate_action);
      expect([0, 1]).toContain(row.recovery_success);
      expect(row.recovery_outcome).toMatch(/^(SUCCESS|FAILED)$/);
    }
  });

  test('duplicate decision/candidate combinations are prevented', () => {
    const { rows } = generateRecoveryDataset({ seed: 19, rowCount: 400 });
    const keys = new Set();

    for (const row of rows) {
      const key = `${row.decision_id}:${row.candidate_action}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
  });

  test('features exclude post-decision leakage fields', () => {
    expect(FEATURE_FIELDS).toBeDefined();
    expect(OUTCOME_FIELDS).toBeDefined();
    expect(FEATURE_FIELDS.some((field) => OUTCOME_FIELDS.includes(field))).toBe(false);
    expect(OUTCOME_FIELDS).toContain('recovery_success');
    expect(OUTCOME_FIELDS).toContain('outcome_timestamp');
  });
});
