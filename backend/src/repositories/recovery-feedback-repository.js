export class RecoveryFeedbackRepository {
  constructor(prisma) { this.prisma = prisma; }

  toRecord(row) {
    if (!row) return null;
    return {
      feedback_id: row.feedbackId,
      feedback_schema_version: row.versions.feedback_schema_version,
      feedback_timestamp: row.feedbackTimestamp.toISOString(),
      correlation: {
        transaction_id: row.transactionId,
        trigger_attempt_id: row.triggerAttemptId,
        recovery_action_id: row.recoveryActionId,
        execution_attempt_id: row.executionAttemptId,
        audit_id: row.auditId
      },
      decision: row.decisionMetadata,
      context: row.context,
      execution: row.executionMetadata,
      versions: row.versions
    };
  }

  toData(record) {
    return {
      feedbackId: record.feedback_id,
      transactionId: record.correlation.transaction_id,
      triggerAttemptId: record.correlation.trigger_attempt_id,
      recoveryActionId: record.correlation.recovery_action_id,
      executionAttemptId: record.correlation.execution_attempt_id,
      auditId: record.correlation.audit_id,
      feedbackTimestamp: new Date(record.feedback_timestamp),
      outcomeTimestamp: new Date(record.execution.outcome_timestamp),
      selectedAction: record.decision.selected_action,
      decisionSource: record.decision.decision_source,
      probability: record.decision.predicted_recovery_probability,
      modelVersion: record.decision.model_version,
      executionOutcome: record.execution.execution_outcome,
      actualRecoverySuccess: record.execution.actual_recovery_success,
      context: record.context,
      decisionMetadata: record.decision,
      executionMetadata: record.execution,
      versions: record.versions,
      deduplicationKey: `${record.correlation.transaction_id}:${record.correlation.trigger_attempt_id}:${record.decision.selected_action}:${record.execution.execution_outcome}`,
      createdAt: new Date(record.feedback_timestamp)
    };
  }

  createIdempotent(record, overwrite = false, client = this.prisma) {
    const data = this.toData(record);
    return client.recoveryFeedback.upsert({
      where: { deduplicationKey: data.deduplicationKey },
      create: data,
      update: overwrite ? data : {}
    }).then((row) => this.toRecord(row));
  }

  findById(id) { return this.prisma.recoveryFeedback.findUnique({ where: { id } }).then((row) => this.toRecord(row)); }

  findByFeedbackId(feedbackId) { return this.prisma.recoveryFeedback.findUnique({ where: { feedbackId } }).then((row) => this.toRecord(row)); }

  findByTransactionId(transactionId) {
    return this.prisma.recoveryFeedback.findMany({
      where: { transactionId },
      orderBy: { feedbackTimestamp: 'asc' }
    }).then((rows) => rows.map((row) => this.toRecord(row)));
  }

  findMany(args = {}) { return this.prisma.recoveryFeedback.findMany(args).then((rows) => rows.map((row) => this.toRecord(row))); }
}