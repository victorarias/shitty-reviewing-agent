import fs from "node:fs";
import path from "node:path";
import { assertScenarioExpectations, loadScenarios, normalizeSnapshot, runScenario } from "../tests/helpers/llm-snapshot.ts";

const vertexKey = process.env.VERTEX_AI_API_KEY ?? "";
const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
const scenarioFilter = (process.env.LLM_SNAPSHOT_SCENARIO ?? "").trim();
const timeoutMs = Number(process.env.LLM_SNAPSHOT_TIMEOUT_MS ?? "120000");
const debug = process.env.DEBUG_LLM_SNAPSHOT === "1";

if (!debug) {
  console.debug = () => {};
}

const scenarioDir = path.join(process.cwd(), "tests", "fixtures", "llm");
fs.mkdirSync(scenarioDir, { recursive: true });

const scenarios = loadScenarios().filter((scenario) => {
  if (!scenarioFilter) return true;
  return scenario.id === scenarioFilter || scenario.id.includes(scenarioFilter);
});

if (scenarios.length === 0) {
  console.error(`No LLM snapshot scenarios match filter: ${scenarioFilter}`);
  process.exit(1);
}

const needsVertex = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google-vertex");
const needsGemini = scenarios.some((scenario) => (scenario.config.provider ?? "google-vertex") === "google");
const hasVertexAuth = Boolean(vertexKey) || (Boolean(project) && Boolean(location));
if (needsVertex && !hasVertexAuth) {
  console.error(
    "Missing VERTEX_AI_API_KEY or GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION for google-vertex snapshot scenarios."
  );
  process.exit(1);
}
if (needsGemini && !geminiKey) {
  console.error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) for google snapshot scenarios.");
  process.exit(1);
}

for (const scenario of scenarios) {
  console.log(`Recording scenario: ${scenario.id}`);
  const provider = scenario.config.provider ?? "google-vertex";
  const apiKey = provider === "google" ? geminiKey : vertexKey;
  const { snapshot } = await runScenario(scenario, apiKey, { timeoutMs, debug });
  const normalized = normalizeSnapshot(snapshot);

  const recordPath = path.join(scenarioDir, `${scenario.id}.record.json`);
  const goldenPath = path.join(scenarioDir, `${scenario.id}.golden.json`);

  const recordPayload = {
    recordedAt: new Date().toISOString(),
    snapshot,
  };

  fs.writeFileSync(recordPath, JSON.stringify(recordPayload, null, 2), "utf8");
  assertScenarioExpectations(scenario, normalized);
  fs.writeFileSync(goldenPath, JSON.stringify(normalized, null, 2), "utf8");
}

console.log("LLM snapshot recording complete.");
