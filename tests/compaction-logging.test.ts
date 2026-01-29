import { test, expect } from "bun:test";
import { createAgentWithCompaction } from "../src/agent/agent-setup.ts";
import type { ReviewConfig } from "../src/types.ts";

test("createAgentWithCompaction logs when context is compacted", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    let transform: ((messages: any[]) => Promise<any[]>) | null = null;
    const config: ReviewConfig = {
      provider: "google",
      apiKey: "test",
      modelId: "model",
      maxFiles: 10,
      ignorePatterns: [],
      repoRoot: process.cwd(),
      debug: true,
      reasoning: "off",
    };

    createAgentWithCompaction({
      config,
      systemPrompt: "",
      tools: [],
      contextState: {
        filesRead: new Set<string>(),
        filesDiffed: new Set<string>(),
        truncatedReads: new Set<string>(),
        partialReads: new Set<string>(),
      },
      summaryState: { inlineComments: 0, suggestions: 0, posted: false },
      overrides: {
        model: { contextWindow: 20 } as any,
        compactionModel: null,
        agentFactory: ({ transformContext }) => {
          transform = transformContext;
          return {
            state: { error: null, messages: [] },
            subscribe() {},
            async prompt() {},
            abort() {},
          };
        },
      },
    });

    if (!transform) {
      throw new Error("Missing transformContext from agent factory.");
    }

    const messages = [
      { role: "user", content: "x".repeat(100) },
      { role: "assistant", content: "y".repeat(100) },
      { role: "user", content: "z".repeat(100) },
    ];

    await transform(messages);
  } finally {
    console.log = originalLog;
  }

  expect(logs.some((line) => line.includes("context compaction:"))).toBe(true);
});
