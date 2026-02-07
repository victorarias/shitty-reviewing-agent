import { describe, expect, it } from "bun:test";
import { withRetries } from "../src/agent/retries.js";

describe("withRetries", () => {
  it("extends retries for quota errors beyond the base attempts", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let nowMs = 0;

    await withRetries(
      async () => {
        calls += 1;
        if (calls <= 4) {
          const error = new Error("429 rate limit");
          (error as Error & { status?: number }).status = 429;
          throw error;
        }
      },
      1,
      () => true,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      }
    );

    expect(calls).toBe(5);
    expect(sleeps.length).toBe(4);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(30_000);
    }
  });

  it("stops retrying quota errors when max wait budget is exceeded", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    let nowMs = 0;

    await expect(
      withRetries(
        async () => {
          calls += 1;
          const error = new Error("429");
          (error as Error & { status?: number; retryAfterMs?: number }).status = 429;
          (error as Error & { status?: number; retryAfterMs?: number }).retryAfterMs = 61_000;
          throw error;
        },
        1,
        () => true,
        {
          env: {
            LLM_RATE_LIMIT_MAX_WAIT_MS: "60000",
          },
          now: () => nowMs,
          sleep: async (ms) => {
            sleeps.push(ms);
            nowMs += ms;
          },
        }
      )
    ).rejects.toThrow();

    expect(calls).toBe(1);
    expect(sleeps.length).toBe(0);
  });
});
