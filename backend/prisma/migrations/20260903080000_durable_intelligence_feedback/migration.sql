CREATE TYPE "DecisionSource" AS ENUM ('ML', 'RULE');
CREATE TYPE "RecoveryFeedbackOutcome" AS ENUM ('SUCCESS', 'FAILED', 'EXECUTED');

CREATE TABLE "RecoveryDecisionAudit" (
    "id" UUID NOT NULL,
    "auditId" VARCHAR(255) NOT NULL,
    "transactionId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "recoveryActionId" UUID,
    "decisionTimestamp" TIMESTAMP(3) NOT NULL,
    "selectedAction" "RecoveryActionType" NOT NULL,
    "decisionSource" "DecisionSource" NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "selectedProbability" DECIMAL(8,6),
    "context" JSONB NOT NULL,
    "candidates" JSONB NOT NULL,
    "rejectedCandidates" JSONB NOT NULL,
    "fallback" JSONB NOT NULL,
    "versions" JSONB NOT NULL,
    "performance" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "explanationSchemaVersion" VARCHAR(50) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryDecisionAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryFeedback" (
    "id" UUID NOT NULL,
    "feedbackId" VARCHAR(255) NOT NULL,
    "transactionId" UUID NOT NULL,
    "triggerAttemptId" UUID NOT NULL,
    "recoveryActionId" UUID,
    "executionAttemptId" UUID,
    "auditId" VARCHAR(255),
    "feedbackTimestamp" TIMESTAMP(3) NOT NULL,
    "outcomeTimestamp" TIMESTAMP(3) NOT NULL,
    "selectedAction" "RecoveryActionType" NOT NULL,
    "decisionSource" "DecisionSource" NOT NULL,
    "probability" DECIMAL(8,6),
    "modelVersion" VARCHAR(255),
    "executionOutcome" "RecoveryFeedbackOutcome" NOT NULL,
    "actualRecoverySuccess" BOOLEAN,
    "context" JSONB NOT NULL,
    "decisionMetadata" JSONB NOT NULL,
    "executionMetadata" JSONB NOT NULL,
    "versions" JSONB NOT NULL,
    "deduplicationKey" VARCHAR(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryDecisionAudit_auditId_key" ON "RecoveryDecisionAudit"("auditId");
CREATE INDEX "RecoveryDecisionAudit_transactionId_decisionTimestamp_idx" ON "RecoveryDecisionAudit"("transactionId", "decisionTimestamp");
CREATE INDEX "RecoveryDecisionAudit_attemptId_idx" ON "RecoveryDecisionAudit"("attemptId");
CREATE INDEX "RecoveryDecisionAudit_recoveryActionId_idx" ON "RecoveryDecisionAudit"("recoveryActionId");
CREATE INDEX "RecoveryDecisionAudit_decisionSource_decisionTimestamp_idx" ON "RecoveryDecisionAudit"("decisionSource", "decisionTimestamp");
CREATE INDEX "RecoveryDecisionAudit_selectedAction_decisionTimestamp_idx" ON "RecoveryDecisionAudit"("selectedAction", "decisionTimestamp");

CREATE UNIQUE INDEX "RecoveryFeedback_feedbackId_key" ON "RecoveryFeedback"("feedbackId");
CREATE UNIQUE INDEX "RecoveryFeedback_deduplicationKey_key" ON "RecoveryFeedback"("deduplicationKey");
CREATE INDEX "RecoveryFeedback_transactionId_feedbackTimestamp_idx" ON "RecoveryFeedback"("transactionId", "feedbackTimestamp");
CREATE INDEX "RecoveryFeedback_recoveryActionId_idx" ON "RecoveryFeedback"("recoveryActionId");
CREATE INDEX "RecoveryFeedback_triggerAttemptId_idx" ON "RecoveryFeedback"("triggerAttemptId");
CREATE INDEX "RecoveryFeedback_executionAttemptId_idx" ON "RecoveryFeedback"("executionAttemptId");
CREATE INDEX "RecoveryFeedback_decisionSource_feedbackTimestamp_idx" ON "RecoveryFeedback"("decisionSource", "feedbackTimestamp");
CREATE INDEX "RecoveryFeedback_executionOutcome_outcomeTimestamp_idx" ON "RecoveryFeedback"("executionOutcome", "outcomeTimestamp");

ALTER TABLE "RecoveryDecisionAudit" ADD CONSTRAINT "RecoveryDecisionAudit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryDecisionAudit" ADD CONSTRAINT "RecoveryDecisionAudit_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryDecisionAudit" ADD CONSTRAINT "RecoveryDecisionAudit_recoveryActionId_fkey" FOREIGN KEY ("recoveryActionId") REFERENCES "RecoveryAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryFeedback" ADD CONSTRAINT "RecoveryFeedback_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryFeedback" ADD CONSTRAINT "RecoveryFeedback_triggerAttemptId_fkey" FOREIGN KEY ("triggerAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryFeedback" ADD CONSTRAINT "RecoveryFeedback_recoveryActionId_fkey" FOREIGN KEY ("recoveryActionId") REFERENCES "RecoveryAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryFeedback" ADD CONSTRAINT "RecoveryFeedback_executionAttemptId_fkey" FOREIGN KEY ("executionAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
