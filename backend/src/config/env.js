import 'dotenv/config';

export const config = Object.freeze({
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  provider: process.env.PROVIDER ?? 'simulator',
  recoveryRetryBaseDelayMs: Number.parseInt(process.env.RECOVERY_RETRY_BASE_DELAY_MS ?? '1000', 10),
  recoveryRetryMaxDelayMs: Number.parseInt(process.env.RECOVERY_RETRY_MAX_DELAY_MS ?? '60000', 10),
  recoveryRetryJitterRatio: Number.parseFloat(process.env.RECOVERY_RETRY_JITTER_RATIO ?? '0.2'),
  recoveryMaxAttempts: Number.parseInt(process.env.RECOVERY_MAX_ATTEMPTS ?? '3', 10),
  recoveryLeaseDurationMs: Number.parseInt(process.env.RECOVERY_LEASE_DURATION_MS ?? '60000', 10),
  recoveryPollingIntervalMs: Number.parseInt(process.env.RECOVERY_POLLING_INTERVAL_MS ?? '1000', 10),
  recoveryBatchSize: Number.parseInt(process.env.RECOVERY_BATCH_SIZE ?? '50', 10)
});
