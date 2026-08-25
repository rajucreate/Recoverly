-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'RECOVERED');
CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CARD', 'NET_BANKING');
CREATE TYPE "AttemptStatus" AS ENUM ('SUCCESS', 'FAILED');
CREATE TYPE "FailureCategory" AS ENUM ('TEMPORARY_FAILURE', 'PAYMENT_METHOD_FAILURE', 'CUSTOMER_ACTION_REQUIRED', 'UNKNOWN_FAILURE');
CREATE TYPE "RecoveryActionType" AS ENUM ('RETRY', 'ALTERNATE_METHOD', 'CUSTOMER_ACTION', 'ESCALATE');
CREATE TYPE "RecoveryActionStatus" AS ENUM ('RECOMMENDED', 'EXECUTED', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" UUID NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "customerId" VARCHAR(255) NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentAttempt" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "status" "AttemptStatus" NOT NULL,
    "failureCategory" "FailureCategory",
    "failureReason" TEXT,
    "attemptNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryAction" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "actionType" "RecoveryActionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RecoveryActionStatus" NOT NULL DEFAULT 'RECOMMENDED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transaction_customerId_idx" ON "Transaction"("customerId");
CREATE INDEX "PaymentAttempt_transactionId_idx" ON "PaymentAttempt"("transactionId");
CREATE UNIQUE INDEX "PaymentAttempt_transactionId_attemptNumber_key" ON "PaymentAttempt"("transactionId", "attemptNumber");
CREATE INDEX "RecoveryAction_transactionId_idx" ON "RecoveryAction"("transactionId");
CREATE INDEX "RecoveryAction_attemptId_idx" ON "RecoveryAction"("attemptId");

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryAction" ADD CONSTRAINT "RecoveryAction_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryAction" ADD CONSTRAINT "RecoveryAction_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
