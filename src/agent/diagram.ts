import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Usage } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ChangedFile, PullRequestInfo, ReviewConfig } from "../types.js";
import type { ThinkingLevel } from "./model.js";

export async function maybeGenerateSequenceDiagram(params: {
  enabled: boolean;
  model: any;
  tools: AgentTool<any>[];
  config: ReviewConfig;
  prInfo: PullRequestInfo;
  changedFiles: ChangedFile[];
  effectiveThinkingLevel: ThinkingLevel;
  effectiveTemperature?: number;
  log: (...args: unknown[]) => void;
  onBilling?: (usage: Usage) => void;
}): Promise<string | null> {
  if (!params.enabled) return null;

  const diagramAgent = new Agent({
    initialState: {
      systemPrompt: buildDiagramSystemPrompt(),
      model: params.model,
      tools: params.tools,
      messages: [],
      thinkingLevel: params.effectiveThinkingLevel,
    },
    getApiKey: () => params.config.apiKey,
    streamFn: (modelArg, context, options) =>
      streamSimple(modelArg, context, {
        ...options,
        temperature: params.effectiveTemperature ?? options.temperature,
      }),
  });
  diagramAgent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
      params.onBilling?.(event.message.usage);
    }
  });

  const diagramPrompt = buildDiagramUserPrompt({
    prTitle: params.prInfo.title,
    prBody: params.prInfo.body,
    changedFiles: params.changedFiles.map((file) => file.filename),
  });

  try {
    await diagramAgent.prompt(diagramPrompt);
    const text = extractAssistantText(diagramAgent.state.messages);
    const diagram = normalizeMermaidDiagram(text);
    if (!diagram) {
      params.log("diagram agent produced no usable output");
      return null;
    }
    return diagram;
  } catch (error) {
    params.log("diagram agent failed", error);
    return null;
  }
}

function buildDiagramSystemPrompt(): string {
  return `# Role
You generate a Mermaid sequence diagram for a pull request.

# Constraints
- Output Mermaid sequence diagram code only. Do not wrap in markdown fences or add commentary.
- Start with "sequenceDiagram".
- Keep it concise and focused on key interactions introduced or modified by the PR.

# Workflow
1) Read the PR context and changed files.
2) Use get_diff and read to understand key interactions.
3) Produce the sequence diagram code.`;
}

function buildDiagramUserPrompt(params: { prTitle: string; prBody: string; changedFiles: string[] }): string {
  const body = params.prBody?.trim() ? params.prBody.trim() : "(no description)";
  const files = params.changedFiles.length > 0 ? params.changedFiles.map((f) => `- ${f}`).join("\n") : "(none)";
  return `# PR Context
PR title: ${params.prTitle}
PR description: ${body}

Changed files:
${files}

# Task
Generate a mermaid sequence diagram (only the code, no fences). Use tools if needed.`;
}

function extractAssistantText(messages: any[]): string {
  const lastAssistant = [...messages].reverse().find((msg) => msg?.role === "assistant");
  if (!lastAssistant) return "";
  const content = lastAssistant.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part?.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

export function normalizeMermaidDiagram(text: string): string | null {
  if (!text) return null;
  let normalized = text.trim();
  const fenced = normalized.match(/```mermaid\s*([\s\S]*?)```/i);
  if (fenced) {
    normalized = fenced[1].trim();
  }
  const sequenceIndex = normalized.indexOf("sequenceDiagram");
  if (sequenceIndex > 0) {
    normalized = normalized.slice(sequenceIndex);
  }
  if (!normalized.startsWith("sequenceDiagram")) {
    return null;
  }
  return normalized;
}
