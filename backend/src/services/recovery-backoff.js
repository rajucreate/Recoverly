export function calculateRetryDelay(attemptNumber, {
  baseDelayMs = 1000,
  maxDelayMs = 60000,
  jitterRatio = 0.2,
  random = Math.random
} = {}) {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) throw new RangeError('attemptNumber must be a positive integer');
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new RangeError('baseDelayMs must be non-negative');
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) throw new RangeError('maxDelayMs must be at least baseDelayMs');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new RangeError('jitterRatio must be between 0 and 1');

  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attemptNumber - 1)));
  const jitter = (random() * 2 - 1) * jitterRatio;
  return Math.max(0, Math.min(maxDelayMs, Math.round(exponentialDelay * (1 + jitter))));
}