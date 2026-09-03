export class RecoveryDecisionAuditRepository {
  constructor(prisma) { this.prisma = prisma; }

  toRecord(row) {
    if (!row) return null;
    return {
      audit_id: row.auditId,
      audit_schema_version: row.versions.audit_schema_version,
      decision_timestamp: row.decisionTimestamp.toISOString(),
      correlation: { transaction_id: row.transactionId, attempt_id: row.attemptId, recovery_action_id: row.recoveryActionId },
      context: row.context,
      candidates: row.candidates,
      rejected_candidates: row.rejectedCandidates,
      selected_action: row.selectedAction,
      decision_source: row.decisionSource,
      decision_reason: row.decisionReason,
      selected_probability: row.selectedProbability === null ? null : Number(row.selectedProbability),
      fallback: row.fallback,
      versions: row.versions,
      performance: row.performance,
      explanation: row.explanation
    };
  }

  create(record, explanation, client = this.prisma) {
    return client.recoveryDecisionAudit.create({
      data: {
        auditId: record.audit_id,
        transactionId: record.correlation.transaction_id,
        attemptId: record.correlation.attempt_id,
        recoveryActionId: record.correlation.recovery_action_id,
        decisionTimestamp: new Date(record.decision_timestamp),
        selectedAction: record.selected_action,
        decisionSource: record.decision_source,
        decisionReason: record.decision_reason,
        selectedProbability: record.selected_probability,
        context: record.context,
        candidates: record.candidates,
        rejectedCandidates: record.rejected_candidates,
        fallback: record.fallback,
        versions: record.versions,
        performance: record.performance,
        explanation,
        explanationSchemaVersion: explanation.explanation_schema_version,
        createdAt: new Date(record.decision_timestamp)
      }
    }).then((row) => this.toRecord(row));
  }

  findById(id) { return this.prisma.recoveryDecisionAudit.findUnique({ where: { id } }).then((row) => this.toRecord(row)); }

  findByAuditId(auditId) { return this.prisma.recoveryDecisionAudit.findUnique({ where: { auditId } }).then((row) => this.toRecord(row)); }

  findByRecoveryActionId(recoveryActionId, transactionId = null) {
    return this.prisma.recoveryDecisionAudit.findFirst({
      where: { recoveryActionId, ...(transactionId ? { transactionId } : {}) },
      orderBy: { decisionTimestamp: 'desc' }
    }).then((row) => this.toRecord(row));
  }

  findByAttemptId(attemptId, transactionId = null) {
    return this.prisma.recoveryDecisionAudit.findFirst({
      where: { attemptId, ...(transactionId ? { transactionId } : {}) },
      orderBy: { decisionTimestamp: 'desc' }
    }).then((row) => this.toRecord(row));
  }

  findByTransactionId(transactionId) {
    return this.prisma.recoveryDecisionAudit.findMany({
      where: { transactionId },
      orderBy: { decisionTimestamp: 'asc' }
    }).then((rows) => rows.map((row) => this.toRecord(row)));
  }

  findMany(args = {}) { return this.prisma.recoveryDecisionAudit.findMany(args).then((rows) => rows.map((row) => this.toRecord(row))); }
}