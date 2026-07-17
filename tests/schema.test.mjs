import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const reviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output.schema.json", import.meta.url), "utf8"));
const continuationReviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output-continuation.schema.json", import.meta.url), "utf8"));
const normalizedSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/normalized-result.schema.json", import.meta.url), "utf8"));

test("reviewer output schema is model-facing and snake_case", () => {
  assert.deepEqual(reviewerSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(reviewerSchema.properties.findings.items.properties.required_action);
  assert.ok(reviewerSchema.properties.findings.items.properties.reviewer_disposition);
  assert.equal(reviewerSchema.properties.findings.items.properties.blocking_reason, undefined);
  assert.equal(reviewerSchema.properties.continuation_envelope, undefined);
  assert.equal(continuationReviewerSchema.properties.continuation_envelope.$ref, "#/$defs/continuation_envelope");
  assert.equal(continuationReviewerSchema.$defs.continuation_envelope.additionalProperties, false);
  assert.deepEqual(continuationReviewerSchema.$defs.continuation_envelope.required, [
    "allowed_paths",
    "allowed_subject_elements",
    "expected_closure_claim",
    "required_checks",
    "forbidden_effects",
  ]);
});

test("normalized result schema includes policy-aware caller fields", () => {
  assert.deepEqual(normalizedSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(normalizedSchema.properties.blocking_findings);
  assert.ok(normalizedSchema.properties.advisory_findings);
  assert.ok(normalizedSchema.properties.required_next_actions);
  assert.ok(normalizedSchema.properties.reviewed_inputs);
  assert.ok(normalizedSchema.$defs.finding.properties.blocking_reason);
  assert.ok(normalizedSchema.properties.reviewer_mechanism.oneOf);
  assert.equal(normalizedSchema.$defs.reviewer_mechanism.additionalProperties, false);
  assert.equal(normalizedSchema.$defs.read_only_contract.additionalProperties, false);
  assert.equal(normalizedSchema.$defs.release_identity.properties.read_only_contract.$ref, "#/$defs/read_only_contract");
  assert.equal(normalizedSchema.$defs.release_identity.properties.release_digest.$ref, "#/$defs/sha256");
  assert.equal(normalizedSchema.properties.continuation_envelope.$ref, "#/$defs/continuation_envelope");
});
