import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reviewContractDigest, validateNormalizedResult, validateReviewerOutput } from "../plugins/review-loop/scripts/review-loop-companion.mjs";

const reviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output.schema.json", import.meta.url), "utf8"));
const normalizedSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/normalized-result.schema.json", import.meta.url), "utf8"));
const executionSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/execution-result.v1.schema.json", import.meta.url), "utf8"));
const codexReviewerSchema = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-output.codex.schema.json", import.meta.url), "utf8"));
const canonicalContract = JSON.parse(readFileSync(new URL("../plugins/review-loop/schemas/reviewer-contract.v5.json", import.meta.url), "utf8"));

test("reviewer output schema is the canonical model-facing contract", () => {
  assert.deepEqual(reviewerSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(reviewerSchema.properties.findings.items.properties.required_action);
  assert.ok(reviewerSchema.properties.findings.items.properties.reviewer_disposition);
  assert.equal(reviewerSchema.properties.findings.items.properties.blocking_reason, undefined);
  assert.equal(reviewerSchema.properties.continuation_envelope, undefined);
  assert.deepEqual(reviewerSchema.properties.acknowledged_packet_digest.oneOf, [
    { $ref: "#/$defs/sha256" },
    { type: "null" },
  ]);
  assert.equal(reviewerSchema.properties.acknowledged_material_digests.uniqueItems, undefined);
  assert.equal(reviewerSchema.properties.required_next_actions.items.minLength, 1);
  assert.match(reviewerSchema.properties.required_next_actions.description, /current reviewed subject/i);
  assert.match(reviewerSchema.properties.required_next_actions.description, /empty when decision is approved/i);
  assert.ok(reviewerSchema.properties.observations);
  assert.ok(reviewerSchema.$defs.observation.required.includes("suggestion"));
  assert.deepEqual(reviewerSchema.$defs.observation.properties.suggestion.type, ["string", "null"]);
  assert.match(reviewerSchema.properties.findings.items.properties.required_action.description, /recommendation when.*advisory/i);
  for (const field of [
    "review_status",
    "subject_reviewable",
    "substantive_merit_evaluated",
    "acknowledged_packet_digest",
    "acknowledged_material_digests",
    "limitations",
  ]) assert.ok(reviewerSchema.required.includes(field));
});

test("normalized result v5 structurally binds contract identity, completion, and exact inputs", () => {
  assert.equal(normalizedSchema.properties.schema_version.const, "5");
  assert.equal(normalizedSchema.properties.review_contract_digest.$ref, "#/$defs/sha256");
  assert.deepEqual(normalizedSchema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(normalizedSchema.properties.blocking_findings);
  assert.ok(normalizedSchema.properties.advisory_findings);
  assert.ok(normalizedSchema.properties.observations);
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

test("canonical contract owns every shipped schema and the narrow Codex projection", () => {
  assert.deepEqual(canonicalContract.reviewer_output_schema, reviewerSchema);
  assert.deepEqual(canonicalContract.normalized_result_schema, normalizedSchema);
  assert.deepEqual(canonicalContract.execution_result_schema, executionSchema);
  assert.equal(canonicalContract.protocol_version, "5");
  assert.match(reviewContractDigest, /^[a-f0-9]{64}$/);

  const expectedCodex = structuredClone(reviewerSchema);
  expectedCodex.properties.acknowledged_packet_digest = {
    type: ["string", "null"],
    pattern: "^[a-f0-9]{64}$",
  };
  assert.deepEqual(codexReviewerSchema, expectedCodex);
  assert.deepEqual(canonicalContract.provider_projections.codex.transforms.map((item) => item.id), [
    "codex_nullable_packet_digest_without_one_of",
  ]);
  assert.deepEqual(canonicalContract.provider_projections.claude.transforms.map((item) => item.id), [
    "claude_remove_schema_meta_key",
  ]);
});

test("canonical post-validation closes the reviewer authority state cross-product", () => {
  const digest = "a".repeat(64);
  const bindings = { packetDigest: digest, materialDigests: [digest] };
  for (const reviewStatus of ["performed", "partial", "not_performed"]) {
    for (const subjectReviewable of [false, true]) {
      for (const substantiveMeritEvaluated of [false, true]) {
        for (const decision of ["approved", "changes_requested", "invalid_input", "blocked"]) {
          for (const hasBlockingFinding of [false, true]) {
            for (const hasRequiredAction of [false, true]) {
              const notPerformed = reviewStatus === "not_performed";
              const value = {
                review_status: reviewStatus,
                subject_reviewable: subjectReviewable,
                substantive_merit_evaluated: substantiveMeritEvaluated,
                acknowledged_packet_digest: notPerformed ? null : digest,
                acknowledged_material_digests: notPerformed ? [] : [digest],
                decision,
                summary: "Cross-product contract vector.",
                findings: hasBlockingFinding ? [{
                  id: "blocker",
                  severity: "high",
                  category: "correctness",
                  message: "Current-subject blocker.",
                  locations: ["src/example.js:1"],
                  required_action: "Fix the blocker.",
                  reviewer_disposition: "blocking",
                }] : [],
                observations: [],
                required_next_actions: hasRequiredAction ? ["Fix the current subject."] : [],
                limitations: reviewStatus === "performed" ? [] : ["Review was incomplete."],
              };
              const completed = reviewStatus === "performed" && subjectReviewable && substantiveMeritEvaluated;
              const expected = decision === "approved"
                ? completed && !hasBlockingFinding && !hasRequiredAction
                : ["changes_requested", "blocked"].includes(decision)
                  ? completed && (hasBlockingFinding || hasRequiredAction)
                  : notPerformed && !subjectReviewable && !substantiveMeritEvaluated && !hasBlockingFinding && !hasRequiredAction;
              let accepted = true;
              try {
                validateReviewerOutput(value, bindings);
              } catch {
                accepted = false;
              }
              assert.equal(accepted, expected, JSON.stringify({ reviewStatus, subjectReviewable, substantiveMeritEvaluated, decision, hasBlockingFinding, hasRequiredAction }));
            }
          }
        }
      }
    }
  }
});

test("normalized post-validation closes the authority state cross-product", () => {
  const digest = "a".repeat(64);
  const bindings = { packetDigest: digest, materialDigests: [digest] };
  for (const reviewStatus of ["performed", "partial", "not_performed"]) {
    for (const subjectReviewable of [false, true]) {
      for (const substantiveMeritEvaluated of [false, true]) {
        for (const decision of ["approved", "changes_requested", "invalid_input", "blocked"]) {
          for (const hasBlockingFinding of [false, true]) {
            for (const hasRequiredAction of [false, true]) {
              const notPerformed = reviewStatus === "not_performed";
              const value = {
                schema_version: "5",
                review_contract_digest: reviewContractDigest,
                review_status: reviewStatus,
                subject_reviewable: subjectReviewable,
                substantive_merit_evaluated: substantiveMeritEvaluated,
                acknowledged_packet_digest: notPerformed ? null : digest,
                acknowledged_material_digests: notPerformed ? [] : [digest],
                decision,
                summary: "Normalized cross-product contract vector.",
                blocking_findings: hasBlockingFinding ? [{
                  id: "blocker",
                  severity: "high",
                  category: "correctness",
                  message: "Current-subject blocker.",
                  locations: ["src/example.js:1"],
                  required_action: "Fix the blocker.",
                  reviewer_disposition: "blocking",
                  blocking_reason: "reviewer",
                }] : [],
                advisory_findings: [],
                observations: [],
                required_next_actions: hasRequiredAction ? ["Fix the current subject."] : [],
                reviewed_inputs: [{ kind: "artifact", display_path: "packet.json", size: 1, hash: digest, format: "json" }],
                reviewer_mechanism: "test",
                limitations: reviewStatus === "performed" ? [] : ["Review was incomplete."],
                read_only: true,
              };
              const completed = reviewStatus === "performed" && subjectReviewable && substantiveMeritEvaluated;
              const diagnostic = notPerformed && !subjectReviewable && !substantiveMeritEvaluated;
              const expected = decision === "approved"
                ? completed && !hasBlockingFinding && !hasRequiredAction
                : decision === "changes_requested"
                  ? completed && (hasBlockingFinding || hasRequiredAction)
                  : decision === "blocked"
                    ? (completed && (hasBlockingFinding || hasRequiredAction)) || diagnostic
                    : diagnostic && !hasBlockingFinding && !hasRequiredAction;
              let accepted = true;
              try {
                validateNormalizedResult(value, bindings);
              } catch {
                accepted = false;
              }
              assert.equal(accepted, expected, JSON.stringify({ reviewStatus, subjectReviewable, substantiveMeritEvaluated, decision, hasBlockingFinding, hasRequiredAction }));
            }
          }
        }
      }
    }
  }
});

test("canonical post-validation rejects structural shapes outside the published schemas", () => {
  const digest = "a".repeat(64);
  const reviewer = {
    review_status: "performed",
    subject_reviewable: true,
    substantive_merit_evaluated: true,
    acknowledged_packet_digest: digest,
    acknowledged_material_digests: [digest],
    decision: "approved",
    summary: "Valid review.",
    findings: [],
    observations: [],
    required_next_actions: [],
    limitations: [],
  };
  assert.throws(
    () => validateReviewerOutput({ ...reviewer, unexpected: true }, { packetDigest: digest, materialDigests: [digest] }),
    /not allowed|unexpected fields/,
  );
  assert.throws(
    () => validateReviewerOutput({
      ...reviewer,
      decision: "changes_requested",
      findings: [{
        id: "bad-location",
        severity: "high",
        category: "correctness",
        message: "Bad location type.",
        locations: [42],
        required_action: "Fix it.",
        reviewer_disposition: "blocking",
      }],
    }, { packetDigest: digest, materialDigests: [digest] }),
    /locations|type string/,
  );
  const nullableSuggestion = {
    ...reviewer,
    observations: [{
      id: "provider-compatible-note",
      category: "advisory",
      message: "No suggestion is needed.",
      suggestion: null,
    }],
  };
  assert.doesNotThrow(
    () => validateReviewerOutput(nullableSuggestion, { packetDigest: digest, materialDigests: [digest] }),
  );
  const missingSuggestion = structuredClone(nullableSuggestion);
  delete missingSuggestion.observations[0].suggestion;
  assert.throws(
    () => validateReviewerOutput(missingSuggestion, { packetDigest: digest, materialDigests: [digest] }),
    /suggestion is required/i,
  );

  const normalizedDiagnostic = {
    schema_version: "5",
    review_contract_digest: reviewContractDigest,
    review_status: "not_performed",
    subject_reviewable: false,
    substantive_merit_evaluated: false,
    acknowledged_packet_digest: null,
    acknowledged_material_digests: [],
    decision: "invalid_input",
    summary: "The input could not be reviewed.",
    blocking_findings: [],
    advisory_findings: [{
      id: "orphan-advisory",
      severity: "info",
      category: "tests",
      message: "This note has no reviewed subject.",
      locations: [],
      required_action: "Consider a later check.",
      reviewer_disposition: "advisory",
      blocking_reason: "none",
    }],
    observations: [],
    required_next_actions: [],
    reviewed_inputs: [],
    reviewer_mechanism: "test",
    limitations: ["No review was performed."],
    read_only: true,
  };
  assert.throws(
    () => validateNormalizedResult(normalizedDiagnostic, { packetDigest: digest, materialDigests: [digest] }),
    /invalid_input normalized result routes diagnostics/i,
  );
});

test("execution result schema bounds automatic host fallback provenance", () => {
  assert.equal(executionSchema.properties.schema_version.const, "review-loop.execution-result.v1");
  assert.deepEqual(executionSchema.properties.outcome.enum, ["decision", "invalid_review_evidence", "unavailable"]);
  assert.equal(executionSchema.properties.attempts.maxItems, 2);
  assert.deepEqual(executionSchema.$defs.attempt.properties.role.enum, ["requested", "host_fallback"]);
  assert.ok(executionSchema.$defs.attempt.properties.failure_category.enum.includes("identity"));
  assert.ok(executionSchema.properties.fallback_reason.enum.includes("identity"));
  assert.equal(executionSchema.$defs.attempt.properties.diagnostic_digest.$ref, "#/$defs/sha256");
  assert.ok(executionSchema.$defs.attempt.allOf.some((rule) => (
    rule.if?.properties?.status?.const === "decision"
      && rule.then?.required?.includes("session_id_digest")
  )));
  assert.equal(executionSchema.$defs.reviewer_identity.properties.signal.const, "provider_reported_session_id");
  assert.ok(executionSchema.allOf.some((rule) => (
    rule.if?.properties?.outcome?.const === "decision"
      && rule.then?.properties?.reviewer_identity?.$ref === "#/$defs/reviewer_identity"
  )));
  assert.ok(canonicalContract.semantic_invariants.some((invariant) => (
    invariant.id === "decision_requires_fresh_consistent_reviewer_identity"
  )));
  assert.equal(executionSchema.properties.read_only.const, true);
  assert.equal(executionSchema.properties.next_action, undefined);
});
