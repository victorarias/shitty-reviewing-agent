export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function isGemini3(modelId: string): boolean {
  return /gemini[- ]?3/i.test(modelId);
}

/**
 * Map granular thinking levels to Gemini 3's supported levels (low/high).
 * Gemini 3 only supports "low" and "high" thinking levels.
 */
export function mapThinkingLevelForGemini3(level: ThinkingLevel): ThinkingLevel {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
    case "xhigh":
      return "high";
  }
}

export function resolveCompactionModel(config: { compactionModel?: string; provider: string; modelId: string }): string | null {
  if (config.compactionModel) return config.compactionModel;
  if (config.provider === "google") {
    return "gemini-3-flash-preview";
  }
  return config.modelId || null;
}
