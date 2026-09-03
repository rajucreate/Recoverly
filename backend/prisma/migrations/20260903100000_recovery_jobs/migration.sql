CREATE TYPE "RecoveryJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "RecoveryJob" (
    "id" UUID NOT NULL,
    "jobId" VARCHAR(255) NOT NULL,
    "transactionId" UUID NOT NULL,
    "recoveryActionId" UUID NOT NULL,
    "triggerAttemptId" UUID NOT NULL,
    "request" JSONB NOT NULL,
    "status" "RecoveryJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecoveryJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryJob_jobId_key" ON "RecoveryJob"("jobId");
CREATE UNIQUE INDEX "RecoveryJob_recoveryActionId_key" ON "RecoveryJob"("recoveryActionId");
CREATE UNIQUE INDEX "RecoveryJob_idempotencyKey_key" ON "RecoveryJob"("idempotencyKey");
CREATE INDEX "RecoveryJob_status_availableAt_idx" ON "RecoveryJob"("status", "availableAt");
CREATE INDEX "RecoveryJob_leaseUntil_idx" ON "RecoveryJob"("leaseUntil");
CREATE INDEX "RecoveryJob_transactionId_idx" ON "RecoveryJob"("transactionId");

ALTER TABLE "RecoveryJob" ADD CONSTRAINT "RecoveryJob_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryJob" ADD CONSTRAINT "RecoveryJob_recoveryActionId_fkey" FOREIGN KEY ("recoveryActionId") REFERENCES "RecoveryAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryJob" ADD CONSTRAINT "RecoveryJob_triggerAttemptId_fkey" FOREIGN KEY ("triggerAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;