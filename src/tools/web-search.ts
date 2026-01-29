import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { GoogleGenAI } from "@google/genai";

interface WebSearchDeps {
  apiKey: string;
  modelId: string;
  enabled: boolean;
  provider: string;
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
          content: [{ type: "text", text: "Web search is only supported with Google/Gemini or Vertex AI providers." }],
          details: { queries: [], sources: [] },
        };
      }
      const isVertex = deps.provider === "google-vertex";
      if (!isVertex && !deps.apiKey) {
        return {
          content: [{ type: "text", text: "Missing API key for web search." }],
          details: { queries: [], sources: [] },
        };
      }

      let ai: GoogleGenAI;
      if (isVertex) {
        const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
        const location = process.env.GOOGLE_CLOUD_LOCATION ?? "global";
        if (!project) {
          return {
            content: [
              {
                type: "text",
                text: "Missing Vertex AI config for web search. Set GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) and GOOGLE_CLOUD_LOCATION.",
              },
            ],
            details: { queries: [], sources: [] },
          };
        }
        ai = new GoogleGenAI({ vertexai: true, project, location });
      } else {
        ai = new GoogleGenAI({ apiKey: deps.apiKey });
      }
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
