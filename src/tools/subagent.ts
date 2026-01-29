import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAgentWithCompaction, type AgentSetupOverrides } from "../agent/agent-setup.js";
import type { ReviewConfig } from "../types.js";

const SubagentSchema = Type.Object({
  task: Type.String({ description: "Task to delegate to a subagent." }),
});

const SUBAGENT_SYSTEM_PROMPT = `# Role
You are a subagent invoked by another agent.

# Task
Complete the user's task using the available tools as needed.
Return your findings as plain text.

# Constraints
- You do not have the main agent's full context unless the task includes it.
- The subagent tool is not available in this environment.`;

interface SubagentDetails {
  output: string;
  toolCalls: number;
  aborted: boolean;
}

type SubagentToolParams = {
  config: ReviewConfig;
  buildTools: () => AgentTool<any>[];
  overrides?: AgentSetupOverrides;
};

function extractAssistantText(message: any): string {
  if (!message?.content) return "";
  return message.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("");
}

export function createSubagentTool(params: SubagentToolParams): AgentTool<typeof SubagentSchema, SubagentDetails> {
  return {
    name: "subagent",
    label: "Subagent",
    description: "Spawn an in-process subagent with a fresh context to complete a task.",
    parameters: SubagentSchema,
    execute: async (
      _id: string,
      toolParams: { task: string },
      signal?: AbortSignal,
      onUpdate?: (partial: { content: { type: "text"; text: string }[]; details: SubagentDetails }) => void
    ) => {

      const contextState = {
        filesRead: new Set<string>(),
        filesDiffed: new Set<string>(),
        truncatedReads: new Set<string>(),
        partialReads: new Set<string>(),
      };
      const summaryState = {
        posted: false,
        inlineComments: 0,
        suggestions: 0,
        billing: {
          input: 0,
          output: 0,
          total: 0,
          cost: 0,
        },
      };

      const tools = params
        .buildTools()
        .filter((tool) => tool.name !== "subagent");

      const { agent } = createAgentWithCompaction({
        config: params.config,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
        tools,
        contextState,
        summaryState,
        overrides: params.overrides,
      });

      const maxIterations = 10 + params.config.maxFiles * 5;
      let toolCalls = 0;
      let abortedByLimit = false;
      const assistantTexts: string[] = [];

      agent.subscribe((event: any) => {
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          if (toolCalls >= maxIterations) {
            abortedByLimit = true;
            agent.abort();
          }
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const text = extractAssistantText(event.message);
          if (text.trim()) {
            assistantTexts.push(text);
            if (onUpdate) {
              onUpdate({
                content: [{ type: "text", text }],
                details: { output: text, toolCalls, aborted: false },
              });
            }
          }
        }
      });

      const abortHandler = () => agent.abort();
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        await agent.prompt(toolParams.task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Subagent error: ${message}` }],
          details: { output: message, toolCalls, aborted: abortedByLimit },
          isError: true,
        };
      } finally {
        if (signal) signal.removeEventListener("abort", abortHandler);
      }

      if (abortedByLimit) {
        return {
          content: [{ type: "text", text: "Subagent aborted after exceeding tool call limit." }],
          details: { output: "", toolCalls, aborted: true },
          isError: true,
        };
      }

      const output = assistantTexts.join("\n\n").trim() || "(no output)";
      return {
        content: [{ type: "text", text: output }],
        details: { output, toolCalls, aborted: false },
      };
    },
  };
}
