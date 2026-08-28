import fs from 'node:fs';
import path from 'node:path';
import { CURRENCIES, FAILURE_CATEGORIES, PAYMENT_METHODS, RECOVERY_ACTIONS } from './recovery-dataset-generator.js';
import { readCsv } from './recovery-dataset-quality.js';

export const FEATURE_PIPELINE_VERSION = '1.0.0';
export const FEATURE_SCHEMA_VERSION = '6.3.1';
export const UNKNOWN_CATEGORY = '__UNKNOWN__';
export const REQUIRED_INFERENCE_FIELDS = [
  'transaction_amount',
  'currency',
  'payment_method_attempted',
  'failure_category',
  'has_failure_reason',
  'attempt_number',
  'prior_failed_attempt_count',
  'prior_temporary_failure_count',
  'candidate_action_type'
];

const CATEGORICAL_FEATURES = [
  { name: 'currency', sourceColumn: 'currency', categories: CURRENCIES },
  { name: 'payment_method_attempted', sourceColumn: 'payment_method', categories: PAYMENT_METHODS },
  { name: 'failure_category', sourceColumn: 'failure_category', categories: FAILURE_CATEGORIES },
  { name: 'candidate_action_type', sourceColumn: 'candidate_action', categories: RECOVERY_ACTIONS }
];

const NUMERIC_FEATURES = [
  { name: 'transaction_amount', sourceColumn: 'transaction_amount' },
  { name: 'attempt_number', sourceColumn: 'attempt_number' },
  { name: 'prior_failed_attempt_count', sourceColumn: 'prior_failed_attempt_count' },
  { name: 'prior_temporary_failure_count', sourceColumn: 'prior_temporary_failure_count' }
];

const BOOLEAN_FEATURES = [
  { name: 'has_failure_reason', sourceColumn: 'failure_reason_present' }
];

export const FORBIDDEN_FEATURE_COLUMNS = [
  'recovery_success',
  'recovery_outcome',
  'outcome_timestamp',
  'selected_action',
  'action_executed',
  'record_id',
  'decision_id',
  'transaction_id',
  'attempt_id'
];

function normalizeCategory(value, categories) {
  return categories.includes(value) ? value : UNKNOWN_CATEGORY;
}

function parseNumber(value, featureName) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${featureName}: ${value}`);
  return parsed;
}

function parseBoolean(value, featureName) {
  if (value === true || value === 'true' || value === 1 || value === '1') return 1;
  if (value === false || value === 'false' || value === 0 || value === '0' || value === null || value === undefined || value === '') return 0;
  throw new Error(`Invalid boolean value for ${featureName}: ${value}`);
}

export function createFeatureSchema() {
  const fields = [];

  for (const feature of NUMERIC_FEATURES) {
    fields.push({
      feature_name: feature.name,
      source_column: feature.sourceColumn,
      type: 'numeric',
      transformation: 'numeric passthrough',
      encoded_representation: 'single numeric column',
      allowed_categories: null,
      missing_value_behavior: 'replace missing with 0',
      unknown_category_behavior: 'not applicable'
    });
  }

  for (const feature of BOOLEAN_FEATURES) {
    fields.push({
      feature_name: feature.name,
      source_column: feature.sourceColumn,
      type: 'boolean',
      transformation: 'boolean to integer',
      encoded_representation: '0 or 1',
      allowed_categories: null,
      missing_value_behavior: 'replace missing with 0',
      unknown_category_behavior: 'invalid values rejected'
    });
  }

  for (const feature of CATEGORICAL_FEATURES) {
    for (const category of feature.categories) {
      fields.push({
        feature_name: `${feature.name}__${category}`,
        source_column: feature.sourceColumn,
        type: 'categorical',
        transformation: 'one-hot encoding',
        encoded_representation: '0 or 1',
        allowed_categories: [...feature.categories],
        missing_value_behavior: `map missing to ${UNKNOWN_CATEGORY}`,
        unknown_category_behavior: `map unknown to ${UNKNOWN_CATEGORY}; all known-category columns become 0`
      });
    }
  }

  return {
    feature_pipeline_version: FEATURE_PIPELINE_VERSION,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    feature_columns: fields.map((field) => field.feature_name),
    fields,
    forbidden_source_columns: FORBIDDEN_FEATURE_COLUMNS,
    categorical_unknown_token: UNKNOWN_CATEGORY,
    fitting_policy: 'No data-derived parameters are fitted; fixed approved vocabularies are used.'
  };
}

export function fitFeaturePipeline(trainingRows) {
  if (!Array.isArray(trainingRows) || trainingRows.length === 0) {
    throw new Error('Training rows must be a non-empty array.');
  }

  return createFeatureSchema();
}

export function loadFeatureSchema(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const expectedSchema = createFeatureSchema();
  if (schema.feature_pipeline_version !== FEATURE_PIPELINE_VERSION || schema.feature_schema_version !== FEATURE_SCHEMA_VERSION) {
    throw new Error('Feature schema version is incompatible with this pipeline.');
  }
  if (JSON.stringify(schema.feature_columns) !== JSON.stringify(expectedSchema.feature_columns)) {
    throw new Error('Persisted feature schema column ordering is incompatible with this pipeline.');
  }
  if (schema.forbidden_source_columns?.some((column) => schema.feature_columns.includes(column))) {
    throw new Error('Persisted feature schema contains a forbidden feature column.');
  }
  return schema;
}

export function validateFeatureArtifactCompatibility(schema, featureMetadata, splitMetadata) {
  if (schema.feature_pipeline_version !== FEATURE_PIPELINE_VERSION || schema.feature_schema_version !== FEATURE_SCHEMA_VERSION) {
    throw new Error('Feature artifact schema version mismatch.');
  }
  if (featureMetadata.feature_pipeline_version !== schema.feature_pipeline_version || featureMetadata.feature_schema_version !== schema.feature_schema_version) {
    throw new Error('Feature metadata does not match the feature schema.');
  }
  if (splitMetadata.source_feature_pipeline_version !== schema.feature_pipeline_version) {
    throw new Error('Split metadata does not match the feature pipeline version.');
  }
  return true;
}

export function validateRawFeatureRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Raw feature rows must be a non-empty array.');

  const requiredSourceColumns = [
    'transaction_amount',
    'currency',
    'payment_method',
    'failure_category',
    'failure_reason_present',
    'attempt_number',
    'prior_failed_attempt_count',
    'prior_temporary_failure_count',
    'candidate_action'
  ];

  const missingColumns = requiredSourceColumns.filter((column) => !Object.prototype.hasOwnProperty.call(rows[0], column));
  if (missingColumns.length > 0) throw new Error(`Missing required raw feature columns: ${missingColumns.join(', ')}`);

  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object') throw new Error(`Raw row ${index + 1} must be an object.`);
    for (const feature of NUMERIC_FEATURES) parseNumber(row[feature.sourceColumn], feature.name);
    parseBoolean(row.failure_reason_present, 'has_failure_reason');
  }

  return true;
}

function transformRawRow(row, schema) {
  const transformed = {};
  for (const feature of NUMERIC_FEATURES) transformed[feature.name] = parseNumber(row[feature.sourceColumn], feature.name);
  transformed.has_failure_reason = parseBoolean(row.failure_reason_present, 'has_failure_reason');

  for (const feature of CATEGORICAL_FEATURES) {
    const value = normalizeCategory(row[feature.sourceColumn], feature.categories);
    for (const category of feature.categories) transformed[`${feature.name}__${category}`] = value === category ? 1 : 0;
  }

  const orderedRow = {};
  for (const column of schema.feature_columns) orderedRow[column] = transformed[column] ?? 0;
  return orderedRow;
}

export function transformRows(rows, schema = createFeatureSchema()) {
  validateRawFeatureRows(rows);
  const featureRows = rows.map((row) => transformRawRow(row, schema));
  validateFeatureRows(featureRows, schema);
  return featureRows;
}

export function transformSingleDecisionRecord(record, schema = createFeatureSchema()) {
  if (!record || typeof record !== 'object') throw new Error('Inference record must be an object.');
  const suppliedForbidden = Object.keys(record).filter((field) => FORBIDDEN_FEATURE_COLUMNS.includes(field));
  if (suppliedForbidden.length > 0) throw new Error(`Forbidden post-decision fields supplied: ${suppliedForbidden.join(', ')}`);
  if (record.candidate_action_type !== undefined && record.candidate_action_type !== null && !RECOVERY_ACTIONS.includes(record.candidate_action_type)) {
    throw new Error(`Invalid candidate_action_type: ${record.candidate_action_type}`);
  }

  const rawRecord = {
    transaction_amount: record.transaction_amount,
    currency: record.currency,
    payment_method: record.payment_method_attempted,
    failure_category: record.failure_category,
    failure_reason_present: record.has_failure_reason,
    attempt_number: record.attempt_number,
    prior_failed_attempt_count: record.prior_failed_attempt_count,
    prior_temporary_failure_count: record.prior_temporary_failure_count,
    candidate_action: record.candidate_action_type
  };

  validateRawFeatureRows([rawRecord]);
  const featureRow = transformRawRow(rawRecord, schema);
  validateFeatureRows([featureRow], schema);
  return featureRow;
}

export function validateFeatureRows(featureRows, schema = createFeatureSchema()) {
  if (!Array.isArray(featureRows)) throw new Error('Feature matrix must be an array.');
  const expectedColumns = schema.feature_columns;

  for (const [index, row] of featureRows.entries()) {
    if (Object.keys(row).join('|') !== expectedColumns.join('|')) throw new Error(`Feature ordering mismatch at row ${index + 1}.`);
    for (const value of Object.values(row)) {
      if (!Number.isFinite(Number(value))) throw new Error(`Non-numeric encoded value at row ${index + 1}.`);
    }
  }

  return true;
}

function toCsvValue(value) {
  const stringValue = String(value ?? '');
  return stringValue.includes(',') || stringValue.includes('"') ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
}

export function writeFeatureMatrixCsv(featureRows, outputPath, schema = createFeatureSchema()) {
  validateFeatureRows(featureRows, schema);
  const content = [
    schema.feature_columns.join(','),
    ...featureRows.map((row) => schema.feature_columns.map((column) => toCsvValue(row[column])).join(','))
  ].join('\n') + '\n';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');
  return content;
}

export function writeFeatureArtifacts({ featureRows, schema, outputDirectory, sourceDataset }) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const featurePath = path.join(outputDirectory, 'recovery_features_v1.csv');
  const schemaPath = path.join(outputDirectory, 'recovery_features_v1.schema.json');
  const metadataPath = path.join(outputDirectory, 'recovery_features_v1.metadata.json');
  writeFeatureMatrixCsv(featureRows, featurePath, schema);
  fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    feature_pipeline_version: FEATURE_PIPELINE_VERSION,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    source_dataset: sourceDataset,
    row_count: featureRows.length,
    feature_column_count: schema.feature_columns.length,
    feature_file_name: 'recovery_features_v1.csv',
    feature_schema_file_name: 'recovery_features_v1.schema.json'
  }, null, 2)}\n`, 'utf8');
  return { featurePath, schemaPath, metadataPath };
}

export function loadAndTransformDataset(inputPath, outputDirectory, schemaPath) {
  const rows = readCsv(inputPath);
  const schema = schemaPath ? loadFeatureSchema(schemaPath) : fitFeaturePipeline(rows);
  const featureRows = transformRows(rows, schema);
  return { ...writeFeatureArtifacts({ featureRows, schema, outputDirectory, sourceDataset: path.basename(inputPath) }), rows: featureRows, schema };
}
