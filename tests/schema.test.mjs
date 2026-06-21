import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const schema = JSON.parse(readFileSync(new URL("../plugins/cc-review/schemas/review-output.schema.json", import.meta.url), "utf8"));
const reviewerSchema = JSON.parse(readFileSync(new URL("../plugins/cc-review/schemas/reviewer-output.schema.json", import.meta.url), "utf8"));
const normalizedSchema = JSON.parse(readFileSync(new URL("../plugins/cc-review/schemas/normalized-result.schema.json", import.meta.url), "utf8"));

test("gate fields are enum constrained", () => {
  assert.deepEqual(schema.properties.decision.enum, ["approved", "needs_changes"]);
  assert.deepEqual(schema.$defs.severity.enum, ["info", "low", "medium", "high"]);
  assert.equal(schema.properties.max_severity.$ref, "#/$defs/severity");
  assert.equal(schema.properties.needs_changes.items.properties.severity.$ref, "#/$defs/severity");
});

test("reviewer output schema is model-facing and snake_case", () => {
  assert.deepEqual(reviewerSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(reviewerSchema.properties.findings.items.properties.required_action);
  assert.ok(reviewerSchema.properties.findings.items.properties.reviewer_disposition);
  assert.equal(reviewerSchema.properties.findings.items.properties.blocking_reason, undefined);
});

test("normalized result schema includes policy-aware caller fields", () => {
  assert.deepEqual(normalizedSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(normalizedSchema.properties.blocking_findings);
  assert.ok(normalizedSchema.properties.advisory_findings);
  assert.ok(normalizedSchema.properties.required_next_actions);
  assert.ok(normalizedSchema.properties.reviewed_inputs);
  assert.ok(normalizedSchema.$defs.finding.properties.blocking_reason);
});
