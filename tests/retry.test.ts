import { describe, expect, it } from "bun:test";
import { extractRetryAfterMs, isQuotaError, parseRetryAfterMs } from "../src/retry.js";

describe("retry helpers", () => {
  it("detects quota errors from message or status", () => {
    expect(isQuotaError("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isQuotaError({ status: 429 })).toBe(true);
    expect(isQuotaError({ code: 429 })).toBe(true);
    expect(isQuotaError("rate limit exceeded")).toBe(true);
  });

  it("parses Retry-After header seconds and dates", () => {
    const now = Date.UTC(2025, 0, 1, 0, 0, 0);
    expect(parseRetryAfterMs("120", now)).toBe(120000);
    const future = new Date(now + 60000).toUTCString();
    expect(parseRetryAfterMs(future, now)).toBe(60000);
  });

  it("extracts retry delay from error shapes", () => {
    const error = {
      response: { headers: { "retry-after": "45" } },
    };
    expect(extractRetryAfterMs(error, 0)).toBe(45000);
  });

  it("extracts retry delay from embedded JSON retryInfo", () => {
    const error = {
      message: JSON.stringify({
        error: {
          details: [{ retryDelay: { seconds: 5, nanos: 500000000 } }],
        },
      }),
    };
    expect(extractRetryAfterMs(error, 0)).toBe(5500);
  });
});
