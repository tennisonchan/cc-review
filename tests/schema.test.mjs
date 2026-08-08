import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const reviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output.schema.json", import.meta.url), "utf8"));
const normalizedSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/normalized-result.schema.json", import.meta.url), "utf8"));
const executionSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/execution-result.v1.schema.json", import.meta.url), "utf8"));

test("reviewer output schema is model-facing and action-neutral", () => {
  assert.deepEqual(reviewerSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(reviewerSchema.properties.findings.items.properties.required_action);
  assert.ok(reviewerSchema.properties.findings.items.properties.reviewer_disposition);
  assert.equal(reviewerSchema.properties.findings.items.properties.blocking_reason, undefined);
  assert.equal(reviewerSchema.properties.continuation_envelope, undefined);
  for (const field of [
    "review_status",
    "subject_reviewable",
    "substantive_merit_evaluated",
    "acknowledged_packet_digest",
    "acknowledged_material_digests",
    "limitations",
  ]) assert.ok(reviewerSchema.required.includes(field));
});

test("normalized result v4 structurally binds review completion and exact inputs", () => {
  assert.equal(normalizedSchema.properties.schema_version.const, "4");
  assert.deepEqual(normalizedSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(normalizedSchema.properties.blocking_findings);
  assert.ok(normalizedSchema.properties.advisory_findings);
  assert.ok(normalizedSchema.properties.required_next_actions);
  assert.ok(normalizedSchema.properties.reviewed_inputs);
  assert.ok(normalizedSchema.$defs.finding.properties.blocking_reason);
  assert.equal(normalizedSchema.properties.reviewer_mechanism.type, "string");
  assert.equal(normalizedSchema.properties.continuation_envelope, undefined);
  assert.equal(normalizedSchema.$defs.release_identity, undefined);
  assert.equal(normalizedSchema.properties.read_only.const, true);
  assert.deepEqual(normalizedSchema.properties.review_status.enum, ["performed", "partial", "not_performed"]);
  assert.equal(normalizedSchema.properties.subject_reviewable.type, "boolean");
  assert.equal(normalizedSchema.properties.substantive_merit_evaluated.type, "boolean");
  assert.ok(normalizedSchema.properties.acknowledged_packet_digest);
  assert.ok(normalizedSchema.properties.acknowledged_material_digests);
  assert.ok(normalizedSchema.properties.limitations);
});

test("execution result schema bounds automatic host fallback provenance", () => {
  assert.equal(executionSchema.properties.schema_version.const, "review-loop.execution-result.v1");
  assert.deepEqual(executionSchema.properties.outcome.enum, ["decision", "invalid_review_evidence", "unavailable"]);
  assert.equal(executionSchema.properties.attempts.maxItems, 2);
  assert.deepEqual(executionSchema.$defs.attempt.properties.role.enum, ["requested", "host_fallback"]);
  assert.ok(executionSchema.$defs.attempt.properties.failure_category.enum.includes("identity"));
  assert.equal(executionSchema.$defs.attempt.properties.diagnostic_digest.$ref, "#/$defs/sha256");
  assert.equal(executionSchema.$defs.reviewer_identity.properties.signal.const, "provider_reported_session_id");
  assert.equal(executionSchema.properties.read_only.const, true);
  assert.equal(executionSchema.properties.next_action, undefined);
});
