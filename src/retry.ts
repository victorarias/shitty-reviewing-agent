export type RetryDelayOptions = {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  minDelayMs?: number;
  jitterRatio?: number;
  retryAfterMs?: number | null;
};

export function isQuotaError(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  if (/quota|resource_exhausted|rate limit|429/i.test(message)) {
    return true;
  }
  const status = extractStatusCode(error);
  return status === 429;
}

export function extractRetryAfterMs(error: unknown, nowMs: number = Date.now()): number | null {
  const directMs = toNumber((error as any)?.retryAfterMs ?? (error as any)?.retry_after_ms);
  if (directMs !== null) return clampDelayMs(directMs);

  const directSeconds = toNumber((error as any)?.retryAfter ?? (error as any)?.retry_after);
  if (directSeconds !== null) return clampDelayMs(directSeconds * 1000);

  const headerValue = getHeaderValue(error);
  if (headerValue) {
    const parsed = parseRetryAfterMs(headerValue, nowMs);
    if (parsed !== null) return clampDelayMs(parsed);
  }

  const message = normalizeErrorMessage(error);
  const parsedMessage = extractEmbeddedJson(message);
  const details = parsedMessage?.error?.details ?? parsedMessage?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const retryDelay = detail?.retryDelay ?? detail?.retryInfo?.retryDelay;
      const retryMs = parseRetryDelayMs(retryDelay);
      if (retryMs !== null) return clampDelayMs(retryMs);
    }
  }

  return null;
}

export function computeRetryDelayMs(options: RetryDelayOptions): number {
  const minDelayMs = options.minDelayMs ?? 0;
  const retryAfterMs = options.retryAfterMs ?? null;
  const exponential = options.baseDelayMs * Math.pow(2, options.attempt);
  let delayMs = Math.min(options.maxDelayMs, Math.max(minDelayMs, exponential));
  if (retryAfterMs !== null) {
    delayMs = Math.max(delayMs, retryAfterMs, minDelayMs);
  }
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (jitterRatio > 0) {
    const jitter = Math.floor(delayMs * jitterRatio * Math.random());
    delayMs += jitter;
  }
  return Math.max(0, Math.floor(delayMs));
}

export function parseRetryAfterMs(value: string, nowMs: number = Date.now()): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return Math.max(0, numeric * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - nowMs);
  }
  return null;
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && typeof error.message === "string") return error.message;
  if (error && typeof error === "object" && typeof (error as any).message === "string") {
    return (error as any).message;
  }
  return "";
}

function extractStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const direct = toNumber((error as any).status ?? (error as any).code ?? (error as any).statusCode);
  if (direct !== null) return direct;
  const nested = toNumber((error as any).error?.code ?? (error as any).error?.statusCode);
  return nested;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getHeaderValue(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as any).headers ?? (error as any).response?.headers ?? (error as any).response?.header;
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get("retry-after") ?? headers.get("Retry-After");
  }
  const raw = headers["retry-after"] ?? headers["Retry-After"] ?? headers["retry_after"];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function extractEmbeddedJson(message: string): any | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const direct = parseJsonSafe(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  const slice = trimmed.slice(start, end + 1);
  return parseJsonSafe(slice);
}

function parseJsonSafe(value: string): any | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRetryDelayMs(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (match) {
      return Math.max(0, Number(match[1]) * 1000);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value * 1000);
  }
  if (typeof value === "object") {
    const secondsRaw = (value as any).seconds;
    const nanosRaw = (value as any).nanos;
    const seconds = toNumber(secondsRaw) ?? 0;
    const nanos = toNumber(nanosRaw) ?? 0;
    if (seconds !== 0 || nanos !== 0) {
      return Math.max(0, seconds * 1000 + Math.floor(nanos / 1e6));
    }
  }
  return null;
}

function clampDelayMs(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value);
}
