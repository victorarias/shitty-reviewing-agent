import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { defineTool } from "./define-tool.js";

const TerminateSchema = Type.Object({});

export function createTerminateTool(): AgentTool<any> {
  return defineTool(TerminateSchema)({
    name: "terminate",
    label: "Terminate",
    description: "No-op tool for ending a run. Always succeeds.",
    execute: async () => ({
      content: [{ type: "text", text: "Terminated." }],
      details: { ok: true },
    }),
  });
}
