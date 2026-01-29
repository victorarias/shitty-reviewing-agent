import { test, expect } from "bun:test";
import { createSubagentTool } from "../src/tools/subagent.ts";
import type { ReviewConfig } from "../src/types.ts";

const baseConfig: ReviewConfig = {
  provider: "google",
  apiKey: "test",
  modelId: "model",
  maxFiles: 10,
  ignorePatterns: [],
  repoRoot: process.cwd(),
  debug: false,
  reasoning: "off",
};

test("subagent runs with isolated tools and returns assistant output", async () => {
  const observed: { toolNames: string[]; prompt: string | null } = {
    toolNames: [],
    prompt: null,
  };

  const agentFactory = ({ initialState }: any) => {
    observed.toolNames = initialState.tools.map((tool: any) => tool.name);
    let subscriber: (event: any) => void = () => {};
    return {
      state: { error: null, messages: [] },
      subscribe(fn: (event: any) => void) {
        subscriber = fn;
      },
      async prompt(input: string) {
        observed.prompt = input;
        subscriber({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Subagent response" }],
          },
        });
      },
      abort() {},
    };
  };

  const tool = createSubagentTool({
    config: baseConfig,
    buildTools: () =>
      [
        { name: "read", execute: async () => ({ content: [] }) },
        { name: "subagent", execute: async () => ({ content: [] }) },
      ] as any,
    overrides: {
      model: { contextWindow: 1000 } as any,
      compactionModel: null,
      agentFactory,
    },
  });

  const result = await tool.execute("tool-call-id", { task: "Do work" });

  expect(observed.prompt).toBe("Do work");
  expect(observed.toolNames).toContain("read");
  expect(observed.toolNames).not.toContain("subagent");
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text).toContain("Subagent response");
});
