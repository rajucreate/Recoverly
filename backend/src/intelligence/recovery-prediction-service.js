import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECOVERY_ACTIONS } from './recovery-dataset-generator.js';
import { loadModel } from './baseline-recovery-model.js';
import { INTERACTION_MODEL_VERSION, predictInteractionProbabilities } from './candidate-model-comparison.js';
import {
  FEATURE_PIPELINE_VERSION,
  FEATURE_SCHEMA_VERSION,
  loadFeatureSchema,
  transformSingleDecisionRecord
} from './recovery-feature-pipeline.js';

export const DEFAULT_MODEL_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/phase-2/models/recovery_interaction_v1.model.json');
export const DEFAULT_SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/phase-2/recovery_features_v1.schema.json');
export const PREDICTION_SERVICE_VERSION = '6.5.1';
const REQUIRED_INPUT_FIELDS = [
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
const FORBIDDEN_INPUT_FIELDS = [
  'recovery_success',
  'recovery_outcome',
  'outcome_timestamp',
  'selected_action',
  'action_executed',
  'final_transaction_status',
  'post_decision_attempts',
  'future_history',
  'transaction_id',
  'decision_id',
  'attempt_id'
];

export class PredictionServiceError extends Error {
  constructor(message, code, cause) {
    super(message, { cause });
    this.name = 'PredictionServiceError';
    this.code = code;
  }
}

function validateModelCompatibility(model, schema) {
  if (model.model_version !== INTERACTION_MODEL_VERSION) {
    throw new PredictionServiceError(`Unsupported model version: ${model.model_version}`, 'MODEL_SCHEMA_INCOMPATIBLE');
  }
  if (model.feature_pipeline_version !== FEATURE_PIPELINE_VERSION || model.feature_schema_version !== FEATURE_SCHEMA_VERSION) {
    throw new PredictionServiceError('Frozen model feature versions are incompatible.', 'MODEL_SCHEMA_INCOMPATIBLE');
  }
  if (JSON.stringify(model.base_feature_columns) !== JSON.stringify(schema.feature_columns)) {
    throw new PredictionServiceError('Frozen model base features do not match the persisted feature schema.', 'MODEL_SCHEMA_INCOMPATIBLE');
  }
  if (!Array.isArray(model.coefficients) || model.coefficients.length !== model.feature_columns.length) {
    throw new PredictionServiceError('Frozen model coefficients are incompatible with its feature columns.', 'MODEL_SCHEMA_INCOMPATIBLE');
  }
}

function loadArtifacts(modelPath, schemaPath) {
  if (!fs.existsSync(modelPath)) throw new PredictionServiceError(`Model artifact not found: ${modelPath}`, 'MODEL_NOT_FOUND');
  if (!fs.existsSync(schemaPath)) throw new PredictionServiceError(`Feature schema not found: ${schemaPath}`, 'SCHEMA_NOT_FOUND');
  let model;
  let schema;
  try {
    model = loadModel(modelPath);
    schema = loadFeatureSchema(schemaPath);
  } catch (error) {
    if (error instanceof PredictionServiceError) throw error;
    throw new PredictionServiceError('Unable to load model or feature schema.', 'MODEL_LOAD_FAILED', error);
  }
  validateModelCompatibility(model, schema);
  return { model, schema };
}

function validateInput(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new PredictionServiceError('Prediction context must be an object.', 'INVALID_INPUT');
  }
  const forbidden = Object.keys(record).filter((field) => FORBIDDEN_INPUT_FIELDS.includes(field));
  if (forbidden.length > 0) throw new PredictionServiceError(`Forbidden post-decision fields supplied: ${forbidden.join(', ')}`, 'INVALID_INPUT');
  const missing = REQUIRED_INPUT_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(record, field));
  if (missing.length > 0) throw new PredictionServiceError(`Missing required decision-time fields: ${missing.join(', ')}`, 'INVALID_INPUT');
  if (!RECOVERY_ACTIONS.includes(record.candidate_action_type)) {
    throw new PredictionServiceError(`Invalid candidate action: ${record.candidate_action_type}`, 'INVALID_INPUT');
  }
}

export class RecoveryPredictionService {
  constructor({ modelPath = DEFAULT_MODEL_PATH, schemaPath = DEFAULT_SCHEMA_PATH, now = () => new Date() } = {}) {
    this.modelPath = modelPath;
    this.schemaPath = schemaPath;
    this.now = now;
    const artifacts = loadArtifacts(modelPath, schemaPath);
    this.model = artifacts.model;
    this.schema = artifacts.schema;
  }

  predict(record) {
    validateInput(record);
    let probability;
    try {
      const featureRow = transformSingleDecisionRecord(record, this.schema);
      probability = predictInteractionProbabilities(this.model, [featureRow])[0];
    } catch (error) {
      if (error instanceof PredictionServiceError) throw error;
      throw new PredictionServiceError('Prediction failed.', 'PREDICTION_FAILED', error);
    }
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new PredictionServiceError('Model returned an invalid probability.', 'INVALID_PREDICTION_OUTPUT');
    }
    return {
      candidate_action_type: record.candidate_action_type,
      recovery_probability: probability,
      model_version: this.model.model_version,
      feature_schema_version: this.model.feature_schema_version,
      feature_pipeline_version: FEATURE_PIPELINE_VERSION,
      predicted_at: this.now().toISOString()
    };
  }

  predictAll(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      throw new PredictionServiceError('Prediction context must be an object.', 'INVALID_INPUT');
    }
    const predictions = [];
    for (const action of RECOVERY_ACTIONS) {
      predictions.push(this.predict({ ...context, candidate_action_type: action }));
    }
    return predictions;
  }
}
