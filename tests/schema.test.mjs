import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const reviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output.schema.json", import.meta.url), "utf8"));
const continuationReviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output-continuation.schema.json", import.meta.url), "utf8"));
const normalizedSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/normalized-result.schema.json", import.meta.url), "utf8"));
const authorizationSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/authorization.v1.schema.json", import.meta.url), "utf8"));
const transactionSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/transaction-result.v1.schema.json", import.meta.url), "utf8"));
const executionSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/execution-result.v1.schema.json", import.meta.url), "utf8"));

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

test("authoritative transaction schemas bind one invocation to derived isolation evidence", () => {
  assert.equal(authorizationSchema.properties.schema_version.const, "review-loop.authorization.v1");
  assert.ok(authorizationSchema.required.includes("authorization_digest"));
  assert.ok(authorizationSchema.required.includes("isolation_profile_digest"));
  assert.deepEqual(transactionSchema.properties.outcome.enum, ["decision", "unavailable", "unparseable"]);
  assert.equal(transactionSchema.properties.invocation_count.const, 1);
  assert.ok(transactionSchema.required.includes("reviewed_input_digest"));
  assert.equal(transactionSchema.properties.transport.oneOf[0].properties.status.const, "completed");
  assert.deepEqual(transactionSchema.properties.envelope.oneOf[0].properties.status.enum, ["valid", "invalid"]);
  assert.equal(transactionSchema.properties.isolation_profile.properties.fresh_context.const, true);
  assert.equal(transactionSchema.properties.isolation_profile.properties.resume_allowed.const, false);
  assert.equal(transactionSchema.properties.isolation_profile.properties.history_persistence.const, false);
  assert.equal(transactionSchema.properties.isolation_profile.properties.packet_only.const, true);
  assert.equal(transactionSchema.properties.reviewer_identity.oneOf[1].properties.signal.const,
    "provider_reported_session_id");
});

test("execution result schema is action-neutral and bounds host fallback provenance", () => {
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
