import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertScenarioExpectations, loadScenarios, normalizeSnapshot, runScenario } from "./helpers/llm-snapshot.ts";

const liveMode = process.env.RUN_LLM_SNAPSHOTS === "1";
const replayMode = process.env.LLM_SNAPSHOT_REPLAY === "1";
const shouldRun = liveMode || replayMode;
const vertexKey = process.env.VERTEX_AI_API_KEY ?? "";
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";

if (!shouldRun) {
  test.skip("LLM snapshot tests disabled (set RUN_LLM_SNAPSHOTS=1)", () => {});
} else {
  if (liveMode && replayMode) {
    throw new Error("Set only one mode: RUN_LLM_SNAPSHOTS=1 (live) or LLM_SNAPSHOT_REPLAY=1 (recorded).");
  }
  const scenarios = loadScenarios();
  if (liveMode) {
    const needsVertex = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google-vertex");
    const needsGemini = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google");
    const hasVertexAuth = Boolean(vertexKey) || (Boolean(project) && Boolean(location));
    if (needsVertex && !hasVertexAuth) {
      throw new Error(
        "google-vertex snapshot scenarios require VERTEX_AI_API_KEY or GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION for ADC."
      );
    }
    if (needsGemini && !geminiKey) {
      throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for google snapshot scenarios.");
    }
  }
  const timeoutMs = Number(process.env.LLM_SNAPSHOT_TIMEOUT_MS ?? "120000");
  for (const scenario of scenarios) {
    test(
      `llm snapshot: ${scenario.id}`,
      async () => {
        let normalized: ReturnType<typeof normalizeSnapshot>;
        if (replayMode) {
          const recordPath = path.join(
            process.cwd(),
            "tests",
            "fixtures",
            "llm",
            `${scenario.id}.record.json`
          );
          if (!fs.existsSync(recordPath)) {
            throw new Error(`Missing recorded snapshot for ${scenario.id}. Run: bun run record:llm`);
          }
          const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
          const snapshot = record.snapshot ?? record;
          normalized = normalizeSnapshot(snapshot);
        } else {
          const provider = scenario.config.provider ?? "google-vertex";
          const apiKey = provider === "google" ? geminiKey : vertexKey;
          const { snapshot } = await runScenario(scenario, apiKey, { timeoutMs });
          normalized = normalizeSnapshot(snapshot);
        }
        assertScenarioExpectations(scenario, normalized);

        const goldenPath = path.join(
          process.cwd(),
          "tests",
          "fixtures",
          "llm",
          `${scenario.id}.golden.json`
        );
        if (!fs.existsSync(goldenPath)) {
          throw new Error(`Missing golden snapshot for ${scenario.id}. Run: bun run record:llm`);
        }
        const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
        expect(normalized).toEqual(golden);
      },
      { timeout: replayMode ? 10000 : timeoutMs }
    );
  }
}
