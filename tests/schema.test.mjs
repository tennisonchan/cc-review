import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const schema = JSON.parse(readFileSync(new URL("../plugins/cc-review/schemas/review-output.schema.json", import.meta.url), "utf8"));

test("gate fields are enum constrained", () => {
  assert.deepEqual(schema.properties.decision.enum, ["approved", "needs_changes"]);
  assert.deepEqual(schema.$defs.severity.enum, ["info", "low", "medium", "high"]);
  assert.equal(schema.properties.max_severity.$ref, "#/$defs/severity");
  assert.equal(schema.properties.needs_changes.items.properties.severity.$ref, "#/$defs/severity");
});
