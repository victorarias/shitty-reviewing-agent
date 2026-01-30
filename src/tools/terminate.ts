import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const TerminateSchema = Type.Object({});

export function createTerminateTool(): AgentTool<typeof TerminateSchema, { ok: boolean }> {
  return {
    name: "terminate",
    label: "Terminate",
    description: "No-op tool for ending a run. Always succeeds.",
    parameters: TerminateSchema,
    execute: async () => ({
      content: [{ type: "text", text: "Terminated." }],
      details: { ok: true },
    }),
  };
}
