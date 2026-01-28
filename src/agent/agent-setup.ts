import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ReviewConfig } from "../types.js";
import {
  buildContextSummaryMessage,
  buildDeterministicSummary,
  estimateTokens,
  pruneMessages,
  summarizeForCompaction,
} from "./context-compaction.js";
import { isGemini3, mapThinkingLevelForGemini3, resolveCompactionModel } from "./model.js";

export interface AgentSetupOverrides {
  agentFactory?: (params: {
    initialState: {
      systemPrompt: string;
      model: any;
      tools: any[];
      messages: any[];
      thinkingLevel: any;
    };
    transformContext: (messages: any[]) => Promise<any[]>;
    getApiKey: () => string;
    streamFn: typeof streamSimple;
  }) => AgentLike;
  streamFn?: typeof streamSimple;
  model?: ReturnType<typeof getModel>;
  compactionModel?: ReturnType<typeof getModel> | null;
}

export interface AgentContextState {
  filesRead: Set<string>;
  filesDiffed: Set<string>;
  truncatedReads: Set<string>;
  partialReads: Set<string>;
}

export interface AgentSummaryState {
  inlineComments: number;
  suggestions: number;
  posted: boolean;
}

export function createAgentWithCompaction(params: {
  config: ReviewConfig;
  systemPrompt: string;
  tools: AgentTool<any>[];
  contextState: AgentContextState;
  summaryState: AgentSummaryState;
  temperatureOverride?: number;
  thinkingLevelOverride?: ReviewConfig["reasoning"];
  overrides?: AgentSetupOverrides;
}): {
  agent: AgentLike;
  model: ReturnType<typeof getModel>;
  compactionModel: ReturnType<typeof getModel> | null;
  effectiveThinkingLevel: ReviewConfig["reasoning"];
  effectiveTemperature: number | undefined;
} {
  const streamFn = params.overrides?.streamFn ?? streamSimple;
  const model = params.overrides?.model ?? getModel(params.config.provider as any, params.config.modelId as any);
  const compactionModelId = resolveCompactionModel(params.config);
  const compactionModel = params.overrides?.compactionModel ??
    (compactionModelId ? getModel(params.config.provider as any, compactionModelId as any) : null);

  const effectiveThinkingLevel = params.thinkingLevelOverride ??
    (isGemini3(params.config.modelId)
      ? mapThinkingLevelForGemini3(params.config.reasoning)
      : params.config.reasoning);

  const effectiveTemperature = params.temperatureOverride ??
    (isGemini3(params.config.modelId)
      ? params.config.temperature ?? 1.0
      : params.config.temperature);

  const transformContext = async (messages: any[]) => {
    const maxTokens = model.contextWindow || 120000;
    const threshold = Math.floor(maxTokens * 0.8);
    const estimated = estimateTokens(messages);
    if (estimated < threshold) {
      return messages;
    }
    const { kept, pruned, prunedCount } = pruneMessages(messages, Math.floor(maxTokens * 0.3));
    if (pruned.length === 0) return kept;
    const summary = compactionModel
      ? await summarizeForCompaction(pruned, compactionModel, params.config.apiKey)
      : buildDeterministicSummary(pruned);
    const contextSummary = buildContextSummaryMessage(params.contextState, prunedCount, params.summaryState);
    const summaryText = summary || "Earlier context was compacted to fit within model limits.";
    return [
      contextSummary,
      {
        role: "user",
        content: `Compacted context summary:\n${summaryText}`,
        timestamp: Date.now(),
      },
      ...kept,
    ];
  };

  const initialState = {
    systemPrompt: params.systemPrompt,
    model,
    tools: params.tools,
    messages: [],
    thinkingLevel: effectiveThinkingLevel,
  };

  const agent = params.overrides?.agentFactory
    ? params.overrides.agentFactory({
      initialState,
      transformContext,
      getApiKey: () => params.config.apiKey,
      streamFn: (modelArg, context, options) =>
        streamFn(modelArg, context, {
          ...options,
          temperature: effectiveTemperature ?? options.temperature,
        }),
    })
    : new Agent({
      initialState,
      transformContext,
      getApiKey: () => params.config.apiKey,
      streamFn: (modelArg, context, options) =>
        streamFn(modelArg, context, {
          ...options,
          temperature: effectiveTemperature ?? options.temperature,
        }),
    });

  return {
    agent,
    model,
    compactionModel,
    effectiveThinkingLevel,
    effectiveTemperature,
  };
}

type AgentLike = {
  state: any;
  subscribe: (fn: (event: any) => void) => void;
  prompt: (input: any) => Promise<void>;
  abort: () => void;
};
