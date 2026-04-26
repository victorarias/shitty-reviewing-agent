import type { Static, TSchema } from "typebox";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";

/**
 * Build an AgentTool with precise `Static<typeof Schema>` typing on the `params`
 * argument while erasing the schema generic at the outer boundary. pi-agent-core
 * consumes a heterogeneous AgentTool<any>[]; carrying the precise schema in the
 * outer type triggers TS2589 under typebox v1's deep `Static<>` recursion when
 * arrays of mixed-schema tools get widened.
 *
 * Curried so TS resolves the schema before evaluating `Static<S>` — combining the
 * passes in one call triggers the deep recursion at the call site.
 */
export function defineTool<S extends TSchema>(parameters: S) {
  return (spec: {
    name: string;
    label: string;
    description: string;
    execute: (
      toolCallId: string,
      params: Static<S>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<any>,
    ) => Promise<AgentToolResult<any>>;
  }): AgentTool<any> => ({ ...spec, parameters }) as unknown as AgentTool<any>;
}
