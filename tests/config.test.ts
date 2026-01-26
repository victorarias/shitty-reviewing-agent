import { test, expect } from "bun:test";
import { normalizeProvider, parseReasoning } from "../src/app/config.ts";

test("normalizeProvider maps common aliases", () => {
  expect(normalizeProvider("gemini")).toBe("google");
  expect(normalizeProvider("vertex")).toBe("google-vertex");
  expect(normalizeProvider("gpt")).toBe("openai");
  expect(normalizeProvider("anthropic")).toBe("anthropic");
});

test("parseReasoning accepts known levels", () => {
  expect(parseReasoning("off")).toBe("off");
  expect(parseReasoning("LOW")).toBe("low");
  expect(parseReasoning("xhigh")).toBe("xhigh");
});
