import { describe, expect, test } from "bun:test";
import { buildContextSummaryMessage, estimateTokens, formatSet, pruneMessages } from "../src/agent";

describe("context management helpers", () => {
  test("estimateTokens counts text and thinking content", () => {
    const textOnly = estimateTokens([
      {
        content: [
          { type: "text", text: "1234" },
        ],
      },
    ]);
    const withThinking = estimateTokens([
      {
        content: [
          { type: "text", text: "1234" },
          { type: "thinking", thinking: "1234" },
        ],
      },
    ]);
    expect(textOnly).toBe(1);
    expect(withThinking).toBe(2);
  });

  test("estimateTokens accounts for non-text content safely", () => {
    const tokens = estimateTokens([
      {
        content: [
          { type: "data", value: { alpha: 1, beta: "two" } },
        ],
      },
      {
        content: { nested: ["x", "y"] },
      },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  test("pruneMessages keeps newest messages within budget", () => {
    const messages = [
      { id: 1, content: "aaaa" },
      { id: 2, content: "bbbb" },
      { id: 3, content: "cccc" },
      { id: 4, content: "dddd" },
      { id: 5, content: "eeee" },
    ];
    const { kept, prunedCount } = pruneMessages(messages, 3);
    expect(prunedCount).toBe(2);
    expect(kept.map((msg) => msg.id)).toEqual([3, 4, 5]);
  });

  test("pruneMessages returns empty when budget is zero", () => {
    const messages = [
      { id: 1, content: "aaaa" },
      { id: 2, content: "bbbb" },
    ];
    const { kept, prunedCount } = pruneMessages(messages, 0);
    expect(kept).toEqual([]);
    expect(prunedCount).toBe(2);
  });

  test("formatSet limits output and reports remaining count", () => {
    expect(formatSet(new Set())).toBe("none");
    const ten = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(formatSet(ten)).toBe("a, b, c, d, e, f, g, h (+2 more)");
  });

  test("formatSet respects custom limit", () => {
    const values = new Set(["b", "a", "c"]);
    expect(formatSet(values, 2)).toBe("a, b (+1 more)");
  });

  test("buildContextSummaryMessage formats summary lines consistently", () => {
    const now = Date.now;
    Date.now = () => 123456;
    const summary = buildContextSummaryMessage(
      {
        filesRead: new Set(["b.ts", "a.ts"]),
        filesDiffed: new Set(["c.ts"]),
        truncatedReads: new Set(),
        partialReads: new Set(["partial.ts"]),
      },
      2,
      { inlineComments: 1, suggestions: 0, posted: true }
    );
    Date.now = now;
    expect(summary.role).toBe("user");
    expect(summary.timestamp).toBe(123456);
    expect(summary.content).toContain("[2 earlier messages pruned for context limits]");
    expect(summary.content).toContain("Files read: a.ts, b.ts");
    expect(summary.content).toContain("Files with diffs: c.ts");
    expect(summary.content).toContain("Partial reads: partial.ts");
    expect(summary.content).toContain("Truncated reads: none");
    expect(summary.content).toContain("Inline comments posted: 1");
    expect(summary.content).toContain("Suggestions posted: 0");
    expect(summary.content).toContain("Summary posted: yes");
  });

  test("buildContextSummaryMessage supports empty sets and no summary", () => {
    const summary = buildContextSummaryMessage(
      {
        filesRead: new Set(),
        filesDiffed: new Set(),
        truncatedReads: new Set(),
        partialReads: new Set(),
      },
      0,
      { inlineComments: 0, suggestions: 2, posted: false }
    );
    expect(summary.content).toContain("[0 earlier messages pruned for context limits]");
    expect(summary.content).toContain("Files read: none");
    expect(summary.content).toContain("Files with diffs: none");
    expect(summary.content).toContain("Partial reads: none");
    expect(summary.content).toContain("Truncated reads: none");
    expect(summary.content).toContain("Suggestions posted: 2");
    expect(summary.content).toContain("Summary posted: no");
  });
});
