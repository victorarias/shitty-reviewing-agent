import { computeRetryDelayMs, extractRetryAfterMs, isQuotaError } from "../retry.js";

export async function withRetries(
  fn: () => Promise<void>,
  attempts: number,
  shouldRetry: (error: unknown) => boolean
): Promise<void> {
  const standardRetry = {
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    minDelayMs: 0,
    jitterRatio: 0.2,
  };
  const rateLimitRetry = {
    baseDelayMs: 30000,
    maxDelayMs: 300000,
    minDelayMs: 30000,
    jitterRatio: 0.2,
  };
  const standardMaxElapsedMs = 60_000;
  const rateLimitMaxElapsedMs = 15 * 60_000;
  const rateLimitAttempts = Math.max(attempts, 6);

  let lastError: unknown;
  let attempt = 0;
  let maxAttempts = attempts;
  const startMs = Date.now();

  while (attempt < maxAttempts) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error)) {
        throw error;
      }

      const quotaError = isQuotaError(error);
      if (quotaError) {
        maxAttempts = Math.max(maxAttempts, rateLimitAttempts);
      }

      if (attempt >= maxAttempts - 1) {
        break;
      }

      const retryAfterMs = extractRetryAfterMs(error);
      const retryConfig = quotaError ? rateLimitRetry : standardRetry;
      const waitMs = computeRetryDelayMs({
        attempt,
        ...retryConfig,
        retryAfterMs,
      });
      const maxElapsedMs = quotaError ? rateLimitMaxElapsedMs : standardMaxElapsedMs;
      const elapsed = Date.now() - startMs;
      if (elapsed + waitMs > maxElapsedMs) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }

  throw lastError;
}
