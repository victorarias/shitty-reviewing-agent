import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));

const provider = args.provider ?? process.env.PROVIDER;
const apiKey = args.apiKey ?? process.env.API_KEY;
const model = args.model ?? process.env.MODEL;
const token = args.token ?? process.env.GITHUB_TOKEN;
const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
const prNumber = Number.parseInt(args.pr ?? process.env.PR_NUMBER ?? "", 10);
const appPrivateKeyFile = args.appPrivateKeyFile ?? process.env.APP_PRIVATE_KEY_FILE;

if (!provider || !apiKey || !model) {
  console.error("Missing provider/api-key/model. Use --provider/--api-key/--model or env PROVIDER/API_KEY/MODEL.");
  process.exit(1);
}
const hasAppAuth = Boolean(args.appId && args.appInstallationId && (args.appPrivateKey || appPrivateKeyFile));
if (!token && !hasAppAuth) {
  console.error("Missing GitHub token. Use --token or env GITHUB_TOKEN, or provide GitHub App credentials.");
  process.exit(1);
}
if (!repo || !repo.includes("/")) {
  console.error("Missing repo. Use --repo owner/name or env GITHUB_REPOSITORY.");
  process.exit(1);
}
if (!Number.isFinite(prNumber)) {
  console.error("Missing PR number. Use --pr or env PR_NUMBER.");
  process.exit(1);
}

const workspace = args.workspace ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
const eventPath = args.event ?? process.env.GITHUB_EVENT_PATH ?? writeEvent(repo, prNumber);

const distPath = path.resolve(process.cwd(), "dist", "index.js");
if (!fs.existsSync(distPath)) {
  console.error("dist/index.js not found. Run npm run build first.");
  process.exit(1);
}

process.env.GITHUB_TOKEN = token;
process.env.GITHUB_REPOSITORY = repo;
process.env.GITHUB_EVENT_PATH = eventPath;
process.env.GITHUB_WORKSPACE = workspace;
process.env["INPUT_PROVIDER"] = provider;
process.env["INPUT_API-KEY"] = apiKey;
process.env["INPUT_MODEL"] = model;
if (args.maxFiles) process.env["INPUT_MAX-FILES"] = String(args.maxFiles);
if (args.ignorePatterns) process.env["INPUT_IGNORE-PATTERNS"] = args.ignorePatterns;
if (args.debug) process.env["INPUT_DEBUG"] = "true";
if (args.reasoning) process.env["INPUT_REASONING"] = args.reasoning;
if (args.temperature) process.env["INPUT_TEMPERATURE"] = String(args.temperature);
if (appPrivateKeyFile) {
  const pem = fs.readFileSync(appPrivateKeyFile, "utf8");
  process.env["INPUT_APP-PRIVATE-KEY"] = pem;
}
if (args.appId) process.env["INPUT_APP-ID"] = String(args.appId);
if (args.appInstallationId) process.env["INPUT_APP-INSTALLATION-ID"] = String(args.appInstallationId);
if (args.appPrivateKey) process.env["INPUT_APP-PRIVATE-KEY"] = args.appPrivateKey;

await import(pathToFileURL(distPath).href);

function writeEvent(repository, number) {
  const [owner, repoName] = repository.split("/");
  const payload = {
    pull_request: { number },
    repository: { name: repoName, owner: { login: owner } },
  };
  const filePath = path.join(os.tmpdir(), `pr-event-${owner}-${repoName}-${number}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}
