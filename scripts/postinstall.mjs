import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const isProduction =
  process.env.NODE_ENV === "production" ||
  process.env.npm_config_production === "true" ||
  process.env.BUN_INSTALL === "production";

const require = createRequire(import.meta.url);
let patchPackagePath;
try {
  patchPackagePath = require.resolve("patch-package");
} catch {
  patchPackagePath = null;
}

if (isProduction || !patchPackagePath) {
  console.log("Skipping patch-package (production install or not available).");
  process.exit(0);
}

const result = spawnSync(process.execPath, [patchPackagePath], { stdio: "inherit" });
process.exit(result.status ?? 1);
