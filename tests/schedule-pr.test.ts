import { test, expect } from "bun:test";
import { ensureSchedulePrFooter } from "../src/tools/schedule-pr.ts";

const billing = { input: 10, output: 20, total: 30, cost: 0.123456 };

test("ensureSchedulePrFooter appends billing footer", () => {
  const body = "Scheduled update for docs.";
  const result = ensureSchedulePrFooter(body, "model-x", billing);
  expect(result).toContain(body);
  expect(result).toContain("Automated by shitty-reviewing-agent");
  expect(result).toContain("model: model-x");
  expect(result).toContain("Billing: input 10");
  expect(result).toContain("<!-- sri:schedule-billing -->");
});

test("ensureSchedulePrFooter replaces existing schedule footer", () => {
  const first = ensureSchedulePrFooter("Body", "model-x", billing);
  const updated = ensureSchedulePrFooter(first, "model-y", {
    input: 1,
    output: 2,
    total: 3,
    cost: 0.000001,
  });
  expect(updated).toContain("Body");
  expect(updated).toContain("model: model-y");
  expect(updated).toContain("Billing: input 1");
  expect(updated).not.toContain("Billing: input 10");
});

test("ensureSchedulePrFooter leaves body untouched without billing", () => {
  const body = "Plain body";
  expect(ensureSchedulePrFooter(body, "model-x", undefined)).toBe(body);
  expect(ensureSchedulePrFooter(body, undefined, billing)).toBe(body);
});
