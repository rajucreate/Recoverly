CREATE TYPE "RecoveryJobAttemptStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');

ALTER TYPE "RecoveryJobStatus" ADD VALUE 'RETRY_PENDING';
ALTER TYPE "RecoveryJobStatus" ADD VALUE 'DEAD_LETTER';

ALTER TABLE "RecoveryJob"
    ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN "claimVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastFailureCategory" VARCHAR(64),
    ADD COLUMN "lastFailureReason" TEXT,
    ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE TABLE "RecoveryJobAttempt" (
    "id" UUID NOT NULL,
    "recoveryJobId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "workerId" VARCHAR(255),
    "claimVersion" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "providerId" VARCHAR(64),
    "providerIdempotencyKey" VARCHAR(255) NOT NULL,
    "providerRequestId" VARCHAR(255),
    "providerPaymentId" VARCHAR(255),
    "status" "RecoveryJobAttemptStatus" NOT NULL DEFAULT 'PROCESSING',
    "failureCategory" VARCHAR(64),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryJobAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryJobAttempt_recoveryJobId_attemptNumber_key" ON "RecoveryJobAttempt"("recoveryJobId", "attemptNumber");
CREATE INDEX "RecoveryJobAttempt_recoveryJobId_idx" ON "RecoveryJobAttempt"("recoveryJobId");
CREATE INDEX "RecoveryJobAttempt_providerIdempotencyKey_idx" ON "RecoveryJobAttempt"("providerIdempotencyKey");
CREATE INDEX "RecoveryJobAttempt_claimVersion_idx" ON "RecoveryJobAttempt"("claimVersion");

ALTER TABLE "RecoveryJobAttempt" ADD CONSTRAINT "RecoveryJobAttempt_recoveryJobId_fkey" FOREIGN KEY ("recoveryJobId") REFERENCES "RecoveryJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
