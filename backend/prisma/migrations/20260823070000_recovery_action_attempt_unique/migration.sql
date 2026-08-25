-- Each payment attempt can have only one initial recovery recommendation.
DROP INDEX IF EXISTS "RecoveryAction_attemptId_idx";
CREATE UNIQUE INDEX "RecoveryAction_attemptId_key" ON "RecoveryAction"("attemptId");
