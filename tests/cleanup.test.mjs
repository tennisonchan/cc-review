import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const companion = path.join(root, "plugins/review-loop/scripts/review-loop-companion.mjs");

test("Review Loop exposes only policy/model review inputs and no tier/catalog bridge", () => {
  const help = spawnSync(process.execPath, [companion, "run", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--tier|--authorization|--continuation-envelope/);
  const setup = spawnSync(process.execPath, [companion, "setup", "--help"], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  assert.doesNotMatch(setup.stdout, /tier-config|catalog|capabilities/);
  const top = spawnSync(process.execPath, [companion, "--help"], { encoding: "utf8" });
  assert.doesNotMatch(top.stdout, /capabilities/);
});

test("Review Loop ships only the normalized v4 action-neutral result contract", () => {
  const schemas = path.join(root, "plugins/review-loop/schemas");
  assert.equal(fs.existsSync(path.join(schemas, "authorization.v1.schema.json")), false);
  assert.equal(fs.existsSync(path.join(schemas, "transaction-result.v1.schema.json")), false);
  assert.equal(fs.existsSync(path.join(schemas, "reviewer-output-continuation.schema.json")), false);
  const schema = JSON.parse(fs.readFileSync(path.join(schemas, "normalized-result.schema.json"), "utf8"));
  assert.equal(schema.properties.schema_version.const, "4");
  assert.deepEqual(schema.properties.reviewer_mechanism, { type: "string", minLength: 1 });
  assert.equal("continuation_envelope" in schema.properties, false);
});
