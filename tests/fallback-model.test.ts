import { describe, expect, it } from "bun:test";
import { QuotaExhaustedError, withRetries } from "../src/agent/retries.js";

describe("QuotaExhaustedError", () => {
  it("is thrown after N consecutive quota errors when maxConsecutiveQuotaErrors is set", async () => {
    let calls = 0;
    let nowMs = 0;

    const error = await getError(
      withRetries(
        async () => {
          calls += 1;
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        },
        1,
        () => true,
        {
          now: () => nowMs,
          sleep: async (ms) => { nowMs += ms; },
          maxConsecutiveQuotaErrors: 3,
        }
      )
    );

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).consecutiveQuotaErrors).toBe(3);
    expect(calls).toBe(3);
  });

  it("resets consecutive count on non-quota errors", async () => {
    let calls = 0;

    // Pattern: 2 quota errors, 1 non-quota error, 3 quota errors → triggers at call 6
    // Time stays at 0 so we don't exhaust the elapsed-time budget between phases.
    const error = await getError(
      withRetries(
        async () => {
          calls += 1;
          if (calls <= 2) {
            const err = new Error("429 rate limit");
            (err as any).status = 429;
            throw err;
          }
          if (calls === 3) {
            throw new Error("transient network error");
          }
          // calls 4+ are quota errors again
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        },
        1,
        () => true,
        {
          now: () => 0,
          sleep: async () => {},
          maxConsecutiveQuotaErrors: 3,
        }
      )
    );

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).consecutiveQuotaErrors).toBe(3);
    expect(calls).toBe(6);
  });

  it("succeeds if fn recovers before hitting the threshold", async () => {
    let calls = 0;
    let nowMs = 0;

    await withRetries(
      async () => {
        calls += 1;
        if (calls <= 2) {
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        }
      },
      1,
      () => true,
      {
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; },
        maxConsecutiveQuotaErrors: 3,
      }
    );

    expect(calls).toBe(3);
  });

  it("does not trigger when maxConsecutiveQuotaErrors is not set", async () => {
    let calls = 0;
    let nowMs = 0;

    // Without the option, it should exhaust the time budget instead
    await withRetries(
      async () => {
        calls += 1;
        if (calls <= 5) {
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        }
      },
      1,
      () => true,
      {
        now: () => nowMs,
        sleep: async (ms) => { nowMs += ms; },
      }
    );

    expect(calls).toBe(6);
  });

  it("reads threshold from LLM_FALLBACK_AFTER_QUOTA_ERRORS env var", async () => {
    let calls = 0;
    let nowMs = 0;

    const error = await getError(
      withRetries(
        async () => {
          calls += 1;
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        },
        1,
        () => true,
        {
          env: { LLM_FALLBACK_AFTER_QUOTA_ERRORS: "2" },
          now: () => nowMs,
          sleep: async (ms) => { nowMs += ms; },
        }
      )
    );

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).consecutiveQuotaErrors).toBe(2);
    expect(calls).toBe(2);
  });

  it("explicit maxConsecutiveQuotaErrors takes precedence over env var", async () => {
    let calls = 0;
    let nowMs = 0;

    const error = await getError(
      withRetries(
        async () => {
          calls += 1;
          const err = new Error("429 rate limit");
          (err as any).status = 429;
          throw err;
        },
        1,
        () => true,
        {
          env: { LLM_FALLBACK_AFTER_QUOTA_ERRORS: "10" },
          now: () => nowMs,
          sleep: async (ms) => { nowMs += ms; },
          maxConsecutiveQuotaErrors: 2,
        }
      )
    );

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(calls).toBe(2);
  });
});

async function getError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error;
  }
}
