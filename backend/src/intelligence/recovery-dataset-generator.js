import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATASET_VERSION = 'v1';
export const SCHEMA_VERSION = '6.2.1';
export const GENERATOR_VERSION = '1.0.0';
export const SOURCE_SPECIFICATION_VERSION = '6.2.1';
export const DATASET_FILE_NAME = 'recovery_dataset_v1.csv';

export const PAYMENT_METHODS = ['UPI', 'CARD', 'NET_BANKING'];
export const CURRENCIES = ['INR', 'USD', 'AED'];
export const FAILURE_CATEGORIES = [
  'TEMPORARY_FAILURE',
  'PAYMENT_METHOD_FAILURE',
  'CUSTOMER_ACTION_REQUIRED',
  'UNKNOWN_FAILURE'
];
export const RECOVERY_ACTIONS = ['RETRY', 'ALTERNATE_METHOD', 'CUSTOMER_ACTION', 'ESCALATE'];

export const REQUIRED_FIELDS = [
  'record_id',
  'decision_id',
  'decision_timestamp',
  'transaction_id',
  'attempt_id',
  'transaction_amount',
  'currency',
  'payment_method',
  'failure_category',
  'failure_reason_present',
  'failure_reason_text',
  'attempt_number',
  'prior_failed_attempt_count',
  'prior_temporary_failure_count',
  'prior_payment_method_history',
  'candidate_action',
  'selected_action',
  'action_executed',
  'recovery_success',
  'recovery_outcome',
  'outcome_timestamp',
  'dataset_version',
  'schema_version'
];

export const FEATURE_FIELDS = [
  'record_id',
  'decision_timestamp',
  'transaction_id',
  'attempt_id',
  'transaction_amount',
  'currency',
  'payment_method',
  'failure_category',
  'failure_reason_present',
  'failure_reason_text',
  'attempt_number',
  'prior_failed_attempt_count',
  'prior_temporary_failure_count',
  'prior_payment_method_history',
  'candidate_action',
  'selected_action',
  'action_executed',
  'dataset_version',
  'schema_version'
];

export const OUTCOME_FIELDS = ['recovery_success', 'recovery_outcome', 'outcome_timestamp'];

function createSeededRandom(seed) {
  let state = seed >>> 0;

  return function random() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedChoice(random, weights) {
  const entries = Object.entries(weights);
  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let threshold = random() * totalWeight;

  for (const [value, weight] of entries) {
    threshold -= weight;
    if (threshold <= 0) {
      return value;
    }
  }

  return entries[entries.length - 1][0];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function makeTransactionAmount(random) {
  const skew = 500 + Math.exp(4.4 + (random() * 6.2));
  return Number(clamp(Math.round(skew / 10) * 10, 150, 500000).toFixed(2));
}

function makePriorPaymentMethodHistory(random) {
  const history = [];
  const length = 1 + Math.floor(random() * 3);

  for (let index = 0; index < length; index += 1) {
    history.push(weightedChoice(random, {
      UPI: 0.5,
      CARD: 0.35,
      NET_BANKING: 0.15
    }));
  }

  return JSON.stringify(history);
}

function makeFailureReason(failureCategory, random) {
  const reasonMap = {
    TEMPORARY_FAILURE: [
      'gateway timeout',
      'network instability',
      'bank unavailable',
      'temporary connectivity issue'
    ],
    PAYMENT_METHOD_FAILURE: [
      'card declined',
      'bank rejected payment',
      'upi app unavailable',
      'payment method not supported'
    ],
    CUSTOMER_ACTION_REQUIRED: [
      'otp verification required',
      'kyc verification required',
      'customer consent pending',
      'authentication challenge required'
    ],
    UNKNOWN_FAILURE: [
      'unexpected gateway response',
      'unknown payment exception',
      'provider return code unrecognized',
      'generic payment failure'
    ]
  };

  const options = reasonMap[failureCategory] ?? reasonMap.UNKNOWN_FAILURE;
  return options[Math.floor(random() * options.length)];
}

function calculateActionSuccessProbability({ failureCategory, paymentMethod, candidateAction, attemptNumber, priorFailedAttemptCount, priorTemporaryFailureCount }) {
  const failureBonus = {
    TEMPORARY_FAILURE: 0.3,
    PAYMENT_METHOD_FAILURE: -0.15,
    CUSTOMER_ACTION_REQUIRED: -0.25,
    UNKNOWN_FAILURE: -0.05
  };

  const methodBonus = {
    UPI: 0.06,
    CARD: -0.02,
    NET_BANKING: -0.04
  };

  const actionBonus = {
    RETRY: 0.18,
    ALTERNATE_METHOD: 0.08,
    CUSTOMER_ACTION: -0.12,
    ESCALATE: -0.09
  };

  const retryPenalty = (attemptNumber - 1) * 0.08 + priorFailedAttemptCount * 0.06 + priorTemporaryFailureCount * 0.04;

  let score = 0.42 + (failureBonus[failureCategory] ?? 0) + (methodBonus[paymentMethod] ?? 0) + (actionBonus[candidateAction] ?? 0) - retryPenalty;

  if (failureCategory === 'TEMPORARY_FAILURE' && candidateAction === 'RETRY') {
    score += 0.22;
  }

  if (failureCategory === 'PAYMENT_METHOD_FAILURE' && candidateAction === 'ALTERNATE_METHOD') {
    score += 0.26;
  }

  if (failureCategory === 'CUSTOMER_ACTION_REQUIRED' && candidateAction === 'CUSTOMER_ACTION') {
    score += 0.28;
  }

  if (failureCategory === 'UNKNOWN_FAILURE' && candidateAction === 'ESCALATE') {
    score += 0.16;
  }

  return clamp(score, 0.08, 0.9);
}

function chooseFailureCategory(random) {
  return weightedChoice(random, {
    TEMPORARY_FAILURE: 0.48,
    PAYMENT_METHOD_FAILURE: 0.29,
    CUSTOMER_ACTION_REQUIRED: 0.11,
    UNKNOWN_FAILURE: 0.12
  });
}

function chooseCandidateAction(random, failureCategory) {
  const weights = {
    TEMPORARY_FAILURE: { RETRY: 0.56, ALTERNATE_METHOD: 0.2, CUSTOMER_ACTION: 0.08, ESCALATE: 0.16 },
    PAYMENT_METHOD_FAILURE: { RETRY: 0.1, ALTERNATE_METHOD: 0.58, CUSTOMER_ACTION: 0.12, ESCALATE: 0.2 },
    CUSTOMER_ACTION_REQUIRED: { RETRY: 0.08, ALTERNATE_METHOD: 0.12, CUSTOMER_ACTION: 0.6, ESCALATE: 0.2 },
    UNKNOWN_FAILURE: { RETRY: 0.2, ALTERNATE_METHOD: 0.18, CUSTOMER_ACTION: 0.14, ESCALATE: 0.48 }
  };

  return weightedChoice(random, weights[failureCategory] ?? weights.UNKNOWN_FAILURE);
}

function isValidEnumValue(value, allowedValues) {
  return allowedValues.includes(value);
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export function generateRecoveryDataset({
  seed = 42,
  rowCount = 6000,
  startTimestamp = new Date('2025-01-01T00:00:00.000Z')
} = {}) {
  if (!Number.isInteger(seed) || !Number.isFinite(seed)) {
    throw new Error('Seed must be an integer.');
  }

  if (!Number.isInteger(rowCount) || rowCount <= 0) {
    throw new Error('rowCount must be a positive integer.');
  }

  const random = createSeededRandom(seed);
  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    const paymentMethod = weightedChoice(random, {
      UPI: 0.52,
      CARD: 0.33,
      NET_BANKING: 0.15
    });

    const currency = weightedChoice(random, {
      INR: 0.82,
      USD: 0.12,
      AED: 0.06
    });

    const failureCategory = chooseFailureCategory(random);
    const candidateAction = chooseCandidateAction(random, failureCategory);

    const attemptNumber = Math.max(1, Math.min(5, 1 + Math.floor(random() * 5)));
    const priorFailedAttemptCount = Math.max(0, Math.min(4, attemptNumber - 1, Math.floor(random() * attemptNumber)));
    const priorTemporaryFailureCount = Math.max(0, Math.min(priorFailedAttemptCount, Math.floor(random() * (priorFailedAttemptCount + 1))));

    const decisionTimestamp = new Date(startTimestamp.getTime() + index * 90 * 60 * 1000 + Math.floor(random() * 45 * 60 * 1000));
    const outcomeTimestamp = new Date(decisionTimestamp.getTime() + 30 * 60 * 1000 + Math.floor(random() * 6 * 60 * 60 * 1000));

    const failureReasonText = makeFailureReason(failureCategory, random);
    const probability = calculateActionSuccessProbability({
      failureCategory,
      paymentMethod,
      candidateAction,
      attemptNumber,
      priorFailedAttemptCount,
      priorTemporaryFailureCount
    });

    const recoverySuccess = random() < probability ? 1 : 0;
    const recoveryOutcome = recoverySuccess === 1 ? 'SUCCESS' : 'FAILED';

    const decisionId = `decision_${String(seed + index + 1).padStart(12, '0')}`;
    const row = {
      record_id: `record_${String(index + 1).padStart(8, '0')}`,
      decision_id: decisionId,
      decision_timestamp: decisionTimestamp.toISOString(),
      transaction_id: `txn_${String(seed + index + 1).padStart(12, '0')}`,
      attempt_id: `attempt_${String(seed + index + 1).padStart(12, '0')}`,
      transaction_amount: makeTransactionAmount(random),
      currency,
      payment_method: paymentMethod,
      failure_category: failureCategory,
      failure_reason_present: Boolean(failureReasonText),
      failure_reason_text: failureReasonText,
      attempt_number: attemptNumber,
      prior_failed_attempt_count: priorFailedAttemptCount,
      prior_temporary_failure_count: priorTemporaryFailureCount,
      prior_payment_method_history: makePriorPaymentMethodHistory(random),
      candidate_action: candidateAction,
      selected_action: candidateAction,
      action_executed: true,
      recovery_success: recoverySuccess,
      recovery_outcome: recoveryOutcome,
      outcome_timestamp: outcomeTimestamp.toISOString(),
      dataset_version: DATASET_VERSION,
      schema_version: SCHEMA_VERSION
    };

    rows.push(row);
  }

  return {
    rows,
    metadata: {
      dataset_version: DATASET_VERSION,
      generator_version: GENERATOR_VERSION,
      random_seed: seed,
      generated_at: new Date().toISOString(),
      source_specification_version: SOURCE_SPECIFICATION_VERSION,
      dataset_file_name: DATASET_FILE_NAME,
      row_count: rows.length,
      schema_version: SCHEMA_VERSION,
      configuration: {
        seed,
        rowCount,
        startTimestamp: startTimestamp.toISOString()
      }
    }
  };
}

export function validateRecoveryDataset(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Dataset rows must be a non-empty array.');
  }

  const seen = new Set();

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new Error('Each dataset row must be an object.');
    }

    for (const field of REQUIRED_FIELDS) {
      if (row[field] === undefined || row[field] === null) {
        if (field === 'failure_reason_text' || field === 'selected_action') {
          continue;
        }
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (!isValidEnumValue(row.currency, CURRENCIES)) {
      throw new Error(`Invalid currency: ${row.currency}`);
    }

    if (!isValidEnumValue(row.payment_method, PAYMENT_METHODS)) {
      throw new Error(`Invalid payment method: ${row.payment_method}`);
    }

    if (!isValidEnumValue(row.failure_category, FAILURE_CATEGORIES)) {
      throw new Error(`Invalid failure category: ${row.failure_category}`);
    }

    if (!isValidEnumValue(row.candidate_action, RECOVERY_ACTIONS)) {
      throw new Error(`Invalid action: ${row.candidate_action}`);
    }

    if (row.selected_action !== row.candidate_action) {
      throw new Error('selected_action must match candidate_action for generated historical rows.');
    }

    if (!Number.isFinite(Number(row.transaction_amount)) || Number(row.transaction_amount) <= 0) {
      throw new Error(`transaction_amount must be positive for ${row.record_id}`);
    }

    if (!Number.isInteger(Number(row.attempt_number)) || Number(row.attempt_number) <= 0) {
      throw new Error(`attempt_number must be a positive integer for ${row.record_id}`);
    }

    if (!Number.isInteger(Number(row.prior_failed_attempt_count)) || Number(row.prior_failed_attempt_count) < 0) {
      throw new Error(`prior_failed_attempt_count must be a non-negative integer for ${row.record_id}`);
    }

    if (!Number.isInteger(Number(row.prior_temporary_failure_count)) || Number(row.prior_temporary_failure_count) < 0) {
      throw new Error(`prior_temporary_failure_count must be a non-negative integer for ${row.record_id}`);
    }

    if (![0, 1].includes(Number(row.recovery_success))) {
      throw new Error(`recovery_success must be 0 or 1 for ${row.record_id}`);
    }

    if (!['SUCCESS', 'FAILED'].includes(row.recovery_outcome)) {
      throw new Error(`recovery_outcome must be SUCCESS or FAILED for ${row.record_id}`);
    }

    const decisionTimestamp = new Date(row.decision_timestamp);
    const outcomeTimestamp = new Date(row.outcome_timestamp);

    if (Number.isNaN(decisionTimestamp.getTime()) || Number.isNaN(outcomeTimestamp.getTime())) {
      throw new Error(`Invalid timestamp for ${row.record_id}`);
    }

    if (outcomeTimestamp.getTime() < decisionTimestamp.getTime()) {
      throw new Error(`Outcome timestamp is before decision timestamp for ${row.record_id}`);
    }

    const recordKey = `${row.decision_id}:${row.candidate_action}`;
    if (seen.has(recordKey)) {
      throw new Error(`Duplicate candidate-action row detected: ${recordKey}`);
    }
    seen.add(recordKey);
  }

  const successRate = rows.reduce((sum, row) => sum + Number(row.recovery_success), 0) / rows.length;
  if (successRate <= 0.05 || successRate >= 0.95) {
    throw new Error(`Target distribution appears degenerate: success rate is ${successRate.toFixed(3)}`);
  }

  const actionCounts = rows.reduce((counts, row) => {
    counts[row.candidate_action] = (counts[row.candidate_action] ?? 0) + 1;
    return counts;
  }, {});

  for (const action of RECOVERY_ACTIONS) {
    if (!actionCounts[action] || actionCounts[action] <= 0) {
      throw new Error(`Action distribution missing required action: ${action}`);
    }
  }

  return true;
}

export function writeRecoveryDatasetCsv(rows, outputPath) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Cannot export an empty dataset.');
  }

  const columns = Object.keys(rows[0]);
  const csvLines = [columns.join(',')];

  for (const row of rows) {
    csvLines.push(columns.map((column) => toCsvValue(row[column])).join(','));
  }

  const content = `${csvLines.join('\n')}\n`;
  fs.writeFileSync(outputPath, content, 'utf8');
  return content;
}

export function writeRecoveryDatasetArtifacts({
  rows,
  metadata,
  outputDirectory
}) {
  fs.mkdirSync(outputDirectory, { recursive: true });

  const csvPath = path.join(outputDirectory, DATASET_FILE_NAME);
  const metadataPath = path.join(outputDirectory, 'recovery_dataset_v1.metadata.json');

  const csvContent = writeRecoveryDatasetCsv(rows, csvPath);
  const datasetSha256 = crypto.createHash('sha256').update(csvContent, 'utf8').digest('hex');
  const finalMetadata = {
    ...metadata,
    dataset_file_name: DATASET_FILE_NAME,
    row_count: rows.length,
    dataset_sha256: datasetSha256
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(finalMetadata, null, 2)}\n`, 'utf8');

  return { csvPath, metadataPath, metadata: finalMetadata, datasetSha256 };
}
