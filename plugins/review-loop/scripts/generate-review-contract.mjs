#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const CONTRACT_PATH = join(SCHEMAS, "reviewer-contract.v5.json");
const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
const checkOnly = process.argv.includes("--check");

if (contract.schema_version !== "review-loop.contract.v5" || contract.protocol_version !== "5") {
  throw new Error("reviewer-contract.v5.json must declare Review Loop contract and protocol v5");
}

writeSchema("reviewer-output.schema.json", contract.reviewer_output_schema);
writeSchema("normalized-result.schema.json", contract.normalized_result_schema);
writeSchema("execution-result.v1.schema.json", contract.execution_result_schema);

const codexProjection = structuredClone(contract.reviewer_output_schema);
const codexTransforms = contract.provider_projections?.codex?.transforms || [];
if (codexTransforms.length !== 1 || codexTransforms[0].id !== "codex_nullable_packet_digest_without_one_of") {
  throw new Error("canonical contract must declare exactly the approved Codex nullable projection");
}
codexProjection.properties.acknowledged_packet_digest = structuredClone(codexTransforms[0].to);
writeSchema("reviewer-output.codex.schema.json", codexProjection);

function writeSchema(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`canonical contract ${name} source must be an object`);
  }
  const path = join(SCHEMAS, name);
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  if (checkOnly) {
    if (readFileSync(path, "utf8") !== expected) throw new Error(`${name} is stale; run npm run generate-contract`);
    return;
  }
  writeFileSync(path, expected);
}
