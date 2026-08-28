import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from './recovery-dataset-quality.js';
import { createFeatureSchema, validateFeatureRows } from './recovery-feature-pipeline.js';

export const SPLIT_VERSION = '1.0.0';
export const SPLIT_PROPORTIONS = Object.freeze({ train: 0.6, validation: 0.2, test: 0.2 });
export const TARGET_FIELD = 'recovery_success';

function csvValue(value) {
  const stringValue = String(value ?? '');
  return stringValue.includes(',') || stringValue.includes('"') ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

function countBy(rows, field) {
  return rows.reduce((counts, row) => {
    counts[row[field]] = (counts[row[field]] ?? 0) + 1;
    return counts;
  }, {});
}

function distribution(rows, field) {
  const counts = countBy(rows, field);
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) => [value, {
    count,
    percentage: Number((count / rows.length * 100).toFixed(2))
  }]));
}

export function validateSplitInputs(rawRows, featureRows, featureColumns = createFeatureSchema().feature_columns) {
  if (!Array.isArray(rawRows) || !Array.isArray(featureRows) || rawRows.length === 0) throw new Error('Raw and feature rows must be non-empty arrays.');
  if (rawRows.length !== featureRows.length) throw new Error(`Raw/feature row count mismatch: ${rawRows.length} vs ${featureRows.length}.`);
  if (!rawRows.every((row) => row.decision_timestamp && row.recovery_success !== null && row.recovery_success !== undefined)) throw new Error('Every raw row must contain a decision timestamp and recovery_success target.');
  if (featureColumns.includes(TARGET_FIELD)) throw new Error('Target must not be present in feature columns.');

  const forbidden = ['transaction_id', 'decision_id', 'attempt_id', 'decision_timestamp', 'action_executed', 'recovery_outcome', 'outcome_timestamp'];
  const foundForbidden = featureColumns.filter((column) => forbidden.includes(column));
  if (foundForbidden.length > 0) throw new Error(`Forbidden fields in feature matrix: ${foundForbidden.join(', ')}`);
  validateFeatureRows(featureRows, { feature_columns: featureColumns });
  return true;
}

function splitCount(total, proportion) {
  return Math.floor(total * proportion);
}

export function splitChronologically(rawRows, featureRows, featureColumns = createFeatureSchema().feature_columns) {
  validateSplitInputs(rawRows, featureRows, featureColumns);
  const indexedRows = rawRows.map((raw, index) => ({ raw, features: featureRows[index], index }));
  indexedRows.sort((left, right) => {
    const difference = new Date(left.raw.decision_timestamp).getTime() - new Date(right.raw.decision_timestamp).getTime();
    return difference || left.index - right.index;
  });

  if (indexedRows.some(({ raw }) => Number.isNaN(new Date(raw.decision_timestamp).getTime()))) throw new Error('Invalid decision timestamp in split input.');

  const trainEnd = splitCount(indexedRows.length, SPLIT_PROPORTIONS.train);
  const validationEnd = trainEnd + splitCount(indexedRows.length, SPLIT_PROPORTIONS.validation);
  const partitions = {
    train: indexedRows.slice(0, trainEnd),
    validation: indexedRows.slice(trainEnd, validationEnd),
    test: indexedRows.slice(validationEnd)
  };

  const result = {};
  for (const [name, partition] of Object.entries(partitions)) {
    result[name] = {
      rows: partition.map(({ raw, features }) => ({ ...features, [TARGET_FIELD]: Number(raw[TARGET_FIELD]) })),
      rawRows: partition.map(({ raw }) => raw)
    };
  }

  validateSplits(result, featureColumns);
  return result;
}

export function validateSplits(splits, featureColumns = createFeatureSchema().feature_columns) {
  const names = ['train', 'validation', 'test'];
  const allKeys = new Set();
  let totalRows = 0;
  let previousLastTimestamp = null;

  for (const name of names) {
    const split = splits[name];
    if (!split || split.rows.length === 0 || split.rows.length !== split.rawRows.length) throw new Error(`Invalid or empty ${name} split.`);
    const expectedColumns = [...featureColumns, TARGET_FIELD];
    for (const row of split.rows) {
      if (Object.keys(row).join('|') !== expectedColumns.join('|')) throw new Error(`${name} contains invalid feature ordering or columns.`);
      if (![0, 1].includes(Number(row[TARGET_FIELD]))) throw new Error(`${name} contains an invalid target.`);
    }

    const timestamps = split.rawRows.map((row) => new Date(row.decision_timestamp).getTime());
    const firstTimestamp = timestamps[0];
    const lastTimestamp = timestamps[timestamps.length - 1];
    if (timestamps.some((timestamp, index) => Number.isNaN(timestamp) || (index > 0 && timestamp < timestamps[index - 1]))) throw new Error(`${name} timestamps are not chronological.`);
    if (previousLastTimestamp !== null && firstTimestamp <= previousLastTimestamp) throw new Error(`${name} overlaps the previous temporal split.`);
    previousLastTimestamp = lastTimestamp;

    for (const raw of split.rawRows) {
      const key = `${raw.decision_id}:${raw.candidate_action}`;
      if (allKeys.has(key)) throw new Error(`Split overlap detected for ${key}.`);
      allKeys.add(key);
    }
    totalRows += split.rows.length;
  }

  if (totalRows !== allKeys.size) throw new Error('Split row counts do not reconcile.');
  return true;
}

export function createSplitMetadata(splits, sourceDatasetVersion, sourceFeatureVersion) {
  return {
    split_version: SPLIT_VERSION,
    source_dataset_version: sourceDatasetVersion,
    source_feature_pipeline_version: sourceFeatureVersion,
    proportions: SPLIT_PROPORTIONS,
    generated_at: new Date().toISOString(),
    random_seed: null,
    splits: Object.fromEntries(Object.entries(splits).map(([name, split]) => [name, {
      row_count: split.rows.length,
      start_timestamp: split.rawRows[0].decision_timestamp,
      end_timestamp: split.rawRows[split.rawRows.length - 1].decision_timestamp,
      recovery_success: distribution(split.rows, TARGET_FIELD),
      candidate_action: distribution(split.rawRows, 'candidate_action'),
      failure_category: distribution(split.rawRows, 'failure_category'),
      payment_method: distribution(split.rawRows, 'payment_method')
    }]))
  };
}

export function writeSplitArtifacts(splits, outputDirectory, metadata, featureColumns = createFeatureSchema().feature_columns) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const name of ['train', 'validation', 'test']) {
    const rows = splits[name].rows;
    const content = [
      [...featureColumns, TARGET_FIELD].join(','),
      ...rows.map((row) => [...featureColumns, TARGET_FIELD].map((column) => csvValue(row[column])).join(','))
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(outputDirectory, `${name}.csv`), content, 'utf8');
  }
  const metadataPath = path.join(outputDirectory, 'splits.metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadataPath;
}

export function loadAndSplitDataset(rawPath, featurePath, outputDirectory, sourceMetadata = {}, featureMetadata = {}) {
  const rawRows = readCsv(rawPath);
  const featureRows = readCsv(featurePath);
  const featureColumns = createFeatureSchema().feature_columns;
  const splits = splitChronologically(rawRows, featureRows, featureColumns);
  const metadata = createSplitMetadata(splits, sourceMetadata.dataset_version ?? 'unknown', featureMetadata.feature_pipeline_version ?? 'unknown');
  writeSplitArtifacts(splits, outputDirectory, metadata, featureColumns);
  return { splits, metadata };
}
