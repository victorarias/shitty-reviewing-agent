import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(repoRoot, "docs", "reviewerc.schema.json");
const examplePath = path.join(repoRoot, "docs", "reviewerc.example.yml");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

const schema = readJson(schemaPath);
const data = readYaml(examplePath);

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

if (!validate(data)) {
  console.error(".reviewerc example failed schema validation:");
  for (const err of validate.errors ?? []) {
    const path = err.instancePath || "(root)";
    console.error(`- ${path}: ${err.message}`);
  }
  process.exit(1);
}

console.log(".reviewerc example is valid.");
