import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { GoogleGenAI } from "@google/genai";

interface WebSearchDeps {
  apiKey: string;
  modelId: string;
  enabled: boolean;
}

export function createWebSearchTool(deps: WebSearchDeps): AgentTool<any>[] {
  const tool: AgentTool<typeof WebSearchSchema, { queries: string[]; sources: SearchSource[] }> = {
    name: "web_search",
    label: "Web search",
    description: "Search the web for up-to-date information and return sources.",
    parameters: WebSearchSchema,
    execute: async (_id, params) => {
      if (!deps.enabled) {
        return {
          content: [{ type: "text", text: "Web search is only supported with Google/Gemini provider." }],
          details: { queries: [], sources: [] },
        };
      }
      if (!deps.apiKey) {
        return {
          content: [{ type: "text", text: "Missing API key for web search." }],
          details: { queries: [], sources: [] },
        };
      }

      const ai = new GoogleGenAI({ apiKey: deps.apiKey });
      const groundingTool = { googleSearch: {} } as const;
      const config = { tools: [groundingTool] };
      const response = await ai.models.generateContent({
        model: deps.modelId,
        contents: params.query,
        config,
      });

      const candidate = response.candidates?.[0];
      const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") || "";
      const grounding = candidate?.groundingMetadata;
      const queries = grounding?.webSearchQueries ?? [];
      const sources = (grounding?.groundingChunks ?? [])
        .map((chunk) => ({
          title: chunk.web?.title ?? "",
          url: chunk.web?.uri ?? "",
        }))
        .filter((item) => item.url);

      const maxResults = params.max_results ?? 5;
      const limitedSources = sources.slice(0, maxResults);
      const sourceLines = limitedSources.length
        ? limitedSources.map((s, i) => `${i + 1}. ${s.title || s.url} — ${s.url}`).join("\n")
        : "(no sources returned)";

      const resultText = [
        text.trim() ? `Answer:\n${text.trim()}` : "",
        queries.length ? `\nSearch queries:\n${queries.map((q) => `- ${q}`).join("\n")}` : "",
        `\nSources:\n${sourceLines}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        content: [{ type: "text", text: resultText }],
        details: { queries, sources: limitedSources },
      };
    },
  };

  return [tool];
}

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

interface SearchSource {
  title: string;
  url: string;
}
