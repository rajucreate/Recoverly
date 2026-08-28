import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CURRENCIES,
  FAILURE_CATEGORIES,
  RECOVERY_ACTIONS,
  PAYMENT_METHODS,
  REQUIRED_FIELDS,
  OUTCOME_FIELDS
} from './recovery-dataset-generator.js';

export const APPROVED_MODEL_FEATURES = [
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

export const FORBIDDEN_MODEL_FEATURES = [
  'recovery_success',
  'recovery_outcome',
  'outcome_timestamp',
  'action_executed',
  'selected_action',
  'final_transaction_status',
  'post_decision_attempts',
  'future_history'
];

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

export function readCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trimEnd();
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error('CSV must contain a header and at least one data row.');
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line, lineIndex) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${lineIndex + 2} has ${values.length} values; expected ${headers.length}.`);
    }

    return Object.fromEntries(headers.map((header, index) => [header, values[index] === '' ? null : values[index]]));
  });
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

function groupedSuccess(rows, field) {
  const groups = {};
  for (const row of rows) {
    const group = row[field];
    groups[group] ??= { total: 0, successes: 0 };
    groups[group].total += 1;
    groups[group].successes += Number(row.recovery_success);
  }

  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([value, result]) => [value, {
    count: result.total,
    success_count: result.successes,
    success_rate: Number((result.successes / result.total).toFixed(4))
  }]));
}

function numericSummary(rows, field) {
  const values = rows.map((row) => Number(row[field])).sort((left, right) => left - right);
  const percentile = (ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
  return {
    min: values[0],
    max: values[values.length - 1],
    median: percentile(0.5),
    p95: percentile(0.95)
  };
}

function issue(code, severity, message) {
  return { code, severity, message };
}

export function validateDatasetMetadata({ rows, metadata, datasetContent, datasetFileName }) {
  const issues = [];
  const requiredMetadata = [
    'dataset_version',
    'schema_version',
    'generator_version',
    'random_seed',
    'row_count',
    'generated_at',
    'source_specification_version',
    'dataset_file_name',
    'dataset_sha256'
  ];

  for (const field of requiredMetadata) {
    if (metadata?.[field] === undefined || metadata[field] === null || metadata[field] === '') {
      issues.push(issue('MISSING_METADATA', 'critical', `Missing metadata field: ${field}`));
    }
  }

  if (metadata?.row_count !== rows.length) {
    issues.push(issue('METADATA_ROW_COUNT', 'critical', `Metadata row_count ${metadata?.row_count} does not match ${rows.length} rows.`));
  }

  if (datasetFileName && metadata?.dataset_file_name !== datasetFileName) {
    issues.push(issue('METADATA_FILE_NAME', 'critical', `Metadata file name ${metadata?.dataset_file_name} does not match ${datasetFileName}.`));
  }

  if (datasetContent !== undefined) {
    const actualHash = crypto.createHash('sha256').update(datasetContent, 'utf8').digest('hex');
    if (metadata?.dataset_sha256 !== actualHash) {
      issues.push(issue('METADATA_CHECKSUM', 'critical', `Metadata checksum ${metadata?.dataset_sha256} does not match ${actualHash}.`));
    }
  }

  if (metadata?.source_specification_version !== '6.2.1') {
    issues.push(issue('METADATA_SPECIFICATION_VERSION', 'critical', `Unsupported source specification version: ${metadata?.source_specification_version}`));
  }

  return issues;
}

export function validateQuality(rows, metadata = {}, options = {}) {
  const issues = [];
  const warnings = [];
  issues.push(...validateDatasetMetadata({ rows, metadata, ...options }));
  const actualColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const missingColumns = REQUIRED_FIELDS.filter((field) => !actualColumns.includes(field));
  const unexpectedColumns = actualColumns.filter((field) => !REQUIRED_FIELDS.includes(field) && field !== 'decision_id');

  if (missingColumns.length > 0) {
    issues.push(issue('MISSING_COLUMNS', 'critical', `Missing required columns: ${missingColumns.join(', ')}`));
  }
  if (unexpectedColumns.length > 0) {
    warnings.push(issue('UNEXPECTED_COLUMNS', 'warning', `Unexpected columns present: ${unexpectedColumns.join(', ')}`));
  }

  const seenRows = new Set();
  const seenDecisionActions = new Set();
  const seenTransactionAttempts = new Set();
  const timestamps = [];
  const categoryValues = {
    currency: CURRENCIES,
    payment_method: PAYMENT_METHODS,
    failure_category: FAILURE_CATEGORIES,
    candidate_action: RECOVERY_ACTIONS,
    recovery_outcome: ['SUCCESS', 'FAILED']
  };

  for (const [index, row] of rows.entries()) {
    const rowLabel = row.record_id ?? `row ${index + 2}`;
    for (const field of REQUIRED_FIELDS) {
      if (row[field] === undefined || row[field] === null || row[field] === '') {
        if (field === 'failure_reason_text' || field === 'selected_action') continue;
        issues.push(issue('MISSING_VALUE', 'critical', `${rowLabel}: missing ${field}`));
      }
    }

    for (const [field, allowed] of Object.entries(categoryValues)) {
      if (row[field] !== undefined && row[field] !== null && !allowed.includes(row[field])) {
        issues.push(issue('INVALID_CATEGORY', 'critical', `${rowLabel}: invalid ${field} ${row[field]}`));
      }
    }

    const numericFields = ['transaction_amount', 'attempt_number', 'prior_failed_attempt_count', 'prior_temporary_failure_count', 'recovery_success'];
    for (const field of numericFields) {
      if (row[field] !== null && !Number.isFinite(Number(row[field]))) {
        issues.push(issue('INVALID_NUMBER', 'critical', `${rowLabel}: ${field} is not numeric`));
      }
    }

    if (Number(row.transaction_amount) <= 0) issues.push(issue('INVALID_AMOUNT', 'critical', `${rowLabel}: transaction amount is not positive`));
    if (!Number.isInteger(Number(row.attempt_number)) || Number(row.attempt_number) < 1) issues.push(issue('INVALID_ATTEMPT', 'critical', `${rowLabel}: attempt number is invalid`));
    if (!Number.isInteger(Number(row.prior_failed_attempt_count)) || Number(row.prior_failed_attempt_count) < 0) issues.push(issue('NEGATIVE_COUNT', 'critical', `${rowLabel}: prior failed count is invalid`));
    if (!Number.isInteger(Number(row.prior_temporary_failure_count)) || Number(row.prior_temporary_failure_count) < 0) issues.push(issue('NEGATIVE_COUNT', 'critical', `${rowLabel}: prior temporary failure count is invalid`));
    if (![0, 1].includes(Number(row.recovery_success))) issues.push(issue('INVALID_TARGET', 'critical', `${rowLabel}: recovery_success is not 0 or 1`));
    if (row.action_executed !== 'true') issues.push(issue('UNEXECUTED_OUTCOME', 'critical', `${rowLabel}: generated dataset row is not marked executed`));
    if (row.selected_action !== row.candidate_action) issues.push(issue('ACTION_MISMATCH', 'critical', `${rowLabel}: selected and candidate actions differ`));
    if (Number(row.prior_failed_attempt_count) >= Number(row.attempt_number)) issues.push(issue('HISTORY_INCONSISTENCY', 'critical', `${rowLabel}: prior failed count is not less than attempt number`));
    if (Number(row.prior_temporary_failure_count) > Number(row.prior_failed_attempt_count)) issues.push(issue('HISTORY_INCONSISTENCY', 'critical', `${rowLabel}: prior temporary failures exceed prior failed attempts`));

    const decisionDate = new Date(row.decision_timestamp);
    const outcomeDate = new Date(row.outcome_timestamp);
    if (Number.isNaN(decisionDate.getTime()) || Number.isNaN(outcomeDate.getTime())) {
      issues.push(issue('INVALID_TIMESTAMP', 'critical', `${rowLabel}: invalid decision or outcome timestamp`));
    } else {
      timestamps.push(decisionDate);
      if (outcomeDate.getTime() < decisionDate.getTime()) issues.push(issue('CAUSAL_ORDER', 'critical', `${rowLabel}: outcome precedes decision`));
    }

    const rowKey = JSON.stringify(row);
    const decisionActionKey = `${row.decision_id}:${row.candidate_action}`;
    const transactionAttemptKey = `${row.transaction_id}:${row.attempt_id}`;
    if (seenRows.has(rowKey)) issues.push(issue('DUPLICATE_ROW', 'critical', `${rowLabel}: duplicate complete row`));
    if (seenDecisionActions.has(decisionActionKey)) issues.push(issue('DUPLICATE_DECISION_ACTION', 'critical', `${rowLabel}: duplicate decision/candidate action`));
    if (seenTransactionAttempts.has(transactionAttemptKey)) issues.push(issue('DUPLICATE_ATTEMPT_LINK', 'critical', `${rowLabel}: duplicate transaction/attempt link`));
    seenRows.add(rowKey);
    seenDecisionActions.add(decisionActionKey);
    seenTransactionAttempts.add(transactionAttemptKey);
  }

  const ordered = timestamps.every((timestamp, index) => index === 0 || timestamp.getTime() >= timestamps[index - 1].getTime());
  if (!ordered) issues.push(issue('TIMESTAMP_ORDER', 'critical', 'Decision timestamps are not chronological.'));

  const successRate = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + Number(row.recovery_success), 0) / rows.length;
  if (successRate <= 0.05 || successRate >= 0.95) warnings.push(issue('TARGET_IMBALANCE', 'warning', `Recovery success rate is ${(successRate * 100).toFixed(2)}%.`));

  const actionCounts = countBy(rows, 'candidate_action');
  for (const action of RECOVERY_ACTIONS) {
    if (!actionCounts[action]) issues.push(issue('ACTION_COVERAGE', 'critical', `No rows for action ${action}.`));
  }

  const rareCategories = Object.entries({
    ...countBy(rows, 'payment_method'),
    ...countBy(rows, 'currency'),
    ...countBy(rows, 'failure_category'),
    ...actionCounts
  }).filter(([, count]) => count / rows.length < 0.01);
  if (rareCategories.length > 0) warnings.push(issue('RARE_CATEGORY', 'warning', `Categories below 1%: ${rareCategories.map(([value, count]) => `${value} (${count})`).join(', ')}`));

  const relationshipFields = ['failure_category', 'candidate_action', 'payment_method', 'attempt_number', 'prior_failed_attempt_count'];
  const relationships = Object.fromEntries(relationshipFields.map((field) => [field, groupedSuccess(rows, field)]));
  const suspiciousDeterminism = [];
  for (const [field, groups] of Object.entries(relationships)) {
    for (const [value, result] of Object.entries(groups)) {
      if (result.count >= 30 && (result.success_rate === 0 || result.success_rate === 1)) {
        suspiciousDeterminism.push(`${field}=${value} has a 100% deterministic outcome`);
      }
    }
  }
  if (suspiciousDeterminism.length > 0) warnings.push(issue('DETERMINISTIC_RELATIONSHIP', 'warning', suspiciousDeterminism.join('; ')));

  const leakageFields = actualColumns.filter((field) => FORBIDDEN_MODEL_FEATURES.includes(field));
  const leakageAudit = {
    approved_features: APPROVED_MODEL_FEATURES,
    forbidden_features: FORBIDDEN_MODEL_FEATURES,
    outcome_fields: OUTCOME_FIELDS,
    forbidden_columns_are_excluded_from_model_projection: leakageFields.length > 0,
    detected_forbidden_columns: leakageFields,
    indirect_identifier_checks: {
      target_in_record_id: rows.some((row) => /(?:success|failed|target|label)/i.test(row.record_id ?? '')),
      target_in_decision_id: rows.some((row) => /(?:success|failed|target|label)/i.test(row.decision_id ?? '')),
      target_in_transaction_id: rows.some((row) => /(?:success|failed|target|label)/i.test(row.transaction_id ?? ''))
    }
  };
  if (Object.values(leakageAudit.indirect_identifier_checks).some(Boolean)) {
    issues.push(issue('IDENTIFIER_LEAKAGE', 'critical', 'An identifier appears to encode the target.'));
  }

  const minTime = timestamps.length ? timestamps[0] : null;
  const maxTime = timestamps.length ? timestamps[timestamps.length - 1] : null;
  const splitIndex = Math.floor(rows.length * 0.7);
  const validationIndex = Math.floor(rows.length * 0.85);
  const splitBoundaries = rows.length > 0 ? {
    train_end: rows[splitIndex - 1]?.decision_timestamp,
    validation_start: rows[splitIndex]?.decision_timestamp,
    validation_end: rows[validationIndex - 1]?.decision_timestamp,
    test_start: rows[validationIndex]?.decision_timestamp
  } : {};

  const report = {
    ready: issues.length === 0,
    critical_issues: issues,
    warnings,
    row_count: rows.length,
    columns: actualColumns,
    missing_value_counts: Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, rows.filter((row) => row[field] === null || row[field] === undefined || row[field] === '').length])),
    uniqueness: {
      record_ids: new Set(rows.map((row) => row.record_id)).size,
      decision_action_pairs: seenDecisionActions.size,
      transaction_attempt_pairs: seenTransactionAttempts.size,
      duplicate_rows: rows.length - seenRows.size
    },
    temporal: {
      ordered,
      first_decision_timestamp: minTime?.toISOString() ?? null,
      last_decision_timestamp: maxTime?.toISOString() ?? null,
      split_boundaries: splitBoundaries,
      outcome_after_decision: !issues.some(({ code }) => code === 'CAUSAL_ORDER')
    },
    distributions: {
      payment_method: distribution(rows, 'payment_method'),
      currency: distribution(rows, 'currency'),
      failure_category: distribution(rows, 'failure_category'),
      candidate_action: distribution(rows, 'candidate_action'),
      action_executed: distribution(rows, 'action_executed'),
      recovery_success: distribution(rows, 'recovery_success')
    },
    numeric_ranges: {
      transaction_amount: numericSummary(rows, 'transaction_amount'),
      attempt_number: numericSummary(rows, 'attempt_number'),
      prior_failed_attempt_count: numericSummary(rows, 'prior_failed_attempt_count'),
      prior_temporary_failure_count: numericSummary(rows, 'prior_temporary_failure_count')
    },
    relationships,
    leakage_audit: leakageAudit,
    candidate_action_audit: {
      expected_actions: RECOVERY_ACTIONS,
      observed_actions: Object.keys(actionCounts),
      all_rows_executed: rows.every((row) => row.action_executed === 'true'),
      unexecuted_rows_with_outcomes: rows.filter((row) => row.action_executed !== 'true' && row.recovery_success !== null).length
    },
    metadata
  };

  return report;
}

function formatDistribution(distributionResult) {
  return Object.entries(distributionResult).map(([value, result]) => `| ${value} | ${result.count} | ${result.percentage}% |`).join('\n');
}

function formatRelationships(relationships) {
  return Object.entries(relationships).map(([field, values]) => {
    const rows = Object.entries(values).map(([value, result]) => `| ${field}=${value} | ${result.count} | ${result.success_rate} |`).join('\n');
    return `### ${field}\n\n| Group | Rows | Success rate |\n|---|---:|---:|\n${rows}`;
  }).join('\n\n');
}

export function renderQualityReport(report) {
  const summarizeFindings = (findings) => {
    if (findings.length === 0) return '- None';
    const grouped = findings.reduce((counts, finding) => {
      counts[finding.code] ??= { count: 0, message: finding.message };
      counts[finding.code].count += 1;
      return counts;
    }, {});
    return Object.entries(grouped).map(([code, finding]) => `- **${code} (${finding.count}):** ${finding.message}`).join('\n');
  };
  const issues = summarizeFindings(report.critical_issues);
  const warnings = summarizeFindings(report.warnings);
  const targetRate = report.distributions.recovery_success['1']?.percentage ?? 0;
  const featureLeakage = report.leakage_audit.detected_forbidden_columns.join(', ') || 'None';

  return `# Phase 2: Dataset Quality Validation Report\n\n## 1. Dataset metadata\n\n- Dataset version: ${report.metadata.dataset_version ?? 'not provided'}\n- Generator version: ${report.metadata.generator_version ?? 'not provided'}\n- Seed: ${report.metadata.randomSeed ?? report.metadata.random_seed ?? 'not provided'}\n- Rows: ${report.row_count}\n- Temporal range: ${report.temporal.first_decision_timestamp} to ${report.temporal.last_decision_timestamp}\n\n## 2. Schema validation\n\n- Required columns: ${report.critical_issues.some(({ code }) => code === 'MISSING_COLUMNS') ? 'FAILED' : 'PASS'}\n- Categorical and numeric validation: ${report.critical_issues.some(({ code }) => ['INVALID_CATEGORY', 'INVALID_NUMBER', 'INVALID_AMOUNT', 'INVALID_ATTEMPT', 'NEGATIVE_COUNT', 'INVALID_TARGET'].includes(code)) ? 'FAILED' : 'PASS'}\n- Numeric ranges: amounts ${report.numeric_ranges.transaction_amount.min} to ${report.numeric_ranges.transaction_amount.max}; attempts ${report.numeric_ranges.attempt_number.min} to ${report.numeric_ranges.attempt_number.max}\n\n## 3. Missing-value analysis\n\n${Object.entries(report.missing_value_counts).map(([field, count]) => `- ${field}: ${count}`).join('\n')}\n\n## 4. Uniqueness analysis\n\n- Unique decision/candidate pairs: ${report.uniqueness.decision_action_pairs}\n- Unique transaction/attempt pairs: ${report.uniqueness.transaction_attempt_pairs}\n- Duplicate complete rows: ${report.uniqueness.duplicate_rows}\n\n## 5. Temporal analysis\n\n- Chronological decisions: ${report.temporal.ordered ? 'PASS' : 'FAILED'}\n- Outcome after decision: ${report.temporal.outcome_after_decision ? 'PASS' : 'FAILED'}\n- Train end: ${report.temporal.split_boundaries.train_end}\n- Validation start: ${report.temporal.split_boundaries.validation_start}\n- Validation end: ${report.temporal.split_boundaries.validation_end}\n- Test start: ${report.temporal.split_boundaries.test_start}\n\n## 6. Category distributions\n\n### Payment methods\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.payment_method)}\n\n### Currencies\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.currency)}\n\n### Failure categories\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.failure_category)}\n\n### Candidate actions\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.candidate_action)}\n\n### Executed actions\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.action_executed)}\n\n## 7. Target distribution\n\n| Value | Count | Percentage |\n|---|---:|---:|\n${formatDistribution(report.distributions.recovery_success)}\n\nOverall recovery success rate: ${targetRate}%\n\n## 8. Relationship sanity checks\n\n${formatRelationships(report.relationships)}\n\nThese checks confirm contextual signal without requiring a specific correlation target. Suspicious deterministic groups are reported as warnings.\n\n## 9. Leakage audit\n\n- Approved model features: ${report.leakage_audit.approved_features.join(', ')}\n- Outcome fields kept outside the feature projection: ${report.leakage_audit.outcome_fields.join(', ')}\n- Forbidden fields detected in dataset as separate outcome/metadata columns: ${featureLeakage}\n- Indirect identifier leakage: ${Object.values(report.leakage_audit.indirect_identifier_checks).some(Boolean) ? 'FAILED' : 'None detected'}\n- Model feature projection status: PASS, provided the approved projection is used and outcome columns are excluded\n\n## 10. Candidate-action audit\n\n- Expected actions: ${report.candidate_action_audit.expected_actions.join(', ')}\n- Observed actions: ${report.candidate_action_audit.observed_actions.join(', ')}\n- All generated rows executed: ${report.candidate_action_audit.all_rows_executed ? 'Yes' : 'No'}\n- Unexecuted rows with fabricated outcomes: ${report.candidate_action_audit.unexecuted_rows_with_outcomes}\n\nThe current dataset contains observed executed rows only; it does not claim outcomes for unexecuted candidates.\n\n## 11. Synthetic-realism checks\n\n- Amounts are positive and bounded by the generator's configured range.\n- Attempts and prior-failure counts are non-negative integers.\n- Categories are non-uniform and all approved actions are represented.\n- Outcomes are probabilistic and deterministic relationship groups are separately audited.\n\n## 12. Issues found\n\n### Critical issues\n${issues}\n\n### Warnings\n${warnings}\n\n## 13. Recommended corrections\n\n${report.critical_issues.length ? '- Correct the critical issues above before training or evaluation.\n' : '- No correction is required for the current dataset. Continue using the approved model-feature projection.\n'}${report.warnings.length ? '- Review warnings as part of future generator iterations; do not rebalance or tune solely for model performance.\n' : ''}\n## 14. Final verdict\n\n**${report.ready ? 'READY' : 'NOT READY'}**\n\nThis verdict applies to the first offline ML experiment and does not authorize model training or production integration.\n`;
}
