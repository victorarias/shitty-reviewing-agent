import { computeRetryDelayMs, extractRetryAfterMs, isQuotaError } from "../retry.js";

export class QuotaExhaustedError extends Error {
  readonly consecutiveQuotaErrors: number;
  readonly lastError: unknown;

  constructor(consecutiveQuotaErrors: number, lastError: unknown) {
    const inner = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Quota exhausted after ${consecutiveQuotaErrors} consecutive rate-limit errors: ${inner}`);
    this.name = "QuotaExhaustedError";
    this.consecutiveQuotaErrors = consecutiveQuotaErrors;
    this.lastError = lastError;
  }
}

export interface WithRetryOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  maxConsecutiveQuotaErrors?: number;
}

export async function withRetries(
  fn: () => Promise<void>,
  attempts: number,
  shouldRetry: (error: unknown) => boolean,
  options?: WithRetryOptions
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
  const env = options?.env ?? process.env;
  const now = options?.now ?? (() => Date.now());
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const configuredRateLimitMaxElapsedMs = parsePositiveInteger(env.LLM_RATE_LIMIT_MAX_WAIT_MS);
  const configuredRateLimitAttempts = parsePositiveInteger(env.LLM_RATE_LIMIT_MAX_ATTEMPTS);
  const configuredFallbackThreshold = parsePositiveInteger(env.LLM_FALLBACK_AFTER_QUOTA_ERRORS);
  const maxConsecutiveQuotaErrors = options?.maxConsecutiveQuotaErrors ?? configuredFallbackThreshold ?? null;
  const standardMaxElapsedMs = 60_000;
  const rateLimitMaxElapsedMs = configuredRateLimitMaxElapsedMs ?? 60 * 60_000;
  const rateLimitAttempts = Math.max(attempts, configuredRateLimitAttempts ?? 12);

  let lastError: unknown;
  let attempt = 0;
  let consecutiveQuotaErrors = 0;
  let maxAttempts = attempts;
  const startMs = now();

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
        consecutiveQuotaErrors += 1;
        if (maxConsecutiveQuotaErrors !== null && consecutiveQuotaErrors >= maxConsecutiveQuotaErrors) {
          throw new QuotaExhaustedError(consecutiveQuotaErrors, error);
        }
        maxAttempts = Math.max(maxAttempts, rateLimitAttempts);
      } else {
        consecutiveQuotaErrors = 0;
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
      const elapsed = now() - startMs;
      if (elapsed + waitMs > maxElapsedMs) {
        break;
      }
      await sleep(waitMs);
      attempt += 1;
    }
  }

  throw lastError;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
