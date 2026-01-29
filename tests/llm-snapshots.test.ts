import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertScenarioExpectations, loadScenarios, normalizeSnapshot, runScenario } from "./helpers/llm-snapshot.ts";

const shouldRun = process.env.RUN_LLM_SNAPSHOTS === "1";
const vertexKey = process.env.VERTEX_AI_API_KEY ?? "";
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";

if (!shouldRun) {
  test.skip("LLM snapshot tests disabled (set RUN_LLM_SNAPSHOTS=1)", () => {});
} else {
  const scenarios = loadScenarios();
  const needsVertex = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google-vertex");
  const needsGemini = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google");
  if (needsVertex && !vertexKey) {
    throw new Error("VERTEX_AI_API_KEY is required for google-vertex snapshot scenarios.");
  }
  if (needsVertex && !project) {
    throw new Error("GOOGLE_CLOUD_PROJECT (or GCLOUD_PROJECT) is required for google-vertex snapshot scenarios.");
  }
  if (needsVertex && !location) {
    throw new Error("GOOGLE_CLOUD_LOCATION is required for google-vertex snapshot scenarios.");
  }
  if (needsGemini && !geminiKey) {
    throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for google snapshot scenarios.");
  }
  const timeoutMs = Number(process.env.LLM_SNAPSHOT_TIMEOUT_MS ?? "120000");
  for (const scenario of scenarios) {
    test(
      `llm snapshot: ${scenario.id}`,
      async () => {
        const provider = scenario.config.provider ?? "google-vertex";
        const apiKey = provider === "google" ? geminiKey : vertexKey;
        const { snapshot } = await runScenario(scenario, apiKey, { timeoutMs });
        const normalized = normalizeSnapshot(snapshot);
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
      { timeout: timeoutMs }
    );
  }
}
