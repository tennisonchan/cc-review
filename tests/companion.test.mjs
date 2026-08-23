import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const companion = new URL("../plugins/review-loop/scripts/review-loop-companion.mjs", import.meta.url).pathname;
const executionResultSchema = JSON.parse(readFileSync(
  new URL("../plugins/review-loop/schemas/execution-result.v1.schema.json", import.meta.url),
  "utf8",
));
const normalizedResultSchema = JSON.parse(readFileSync(
  new URL("../plugins/review-loop/schemas/normalized-result.schema.json", import.meta.url),
  "utf8",
));
const canonicalContract = JSON.parse(readFileSync(
  new URL("../plugins/review-loop/schemas/reviewer-contract.v5.json", import.meta.url),
  "utf8",
));
const expectedReviewContractDigest = createHash("sha256")
  .update(`review-loop.contract.v5\0${canonicalJson(canonicalContract)}`)
  .digest("hex");

function assertSchemaKeys(value, schema, label) {
  for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${label}.${key} is required`);
  if (schema.additionalProperties === false) {
    assert.deepEqual(
      Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key)),
      [],
      `${label} has properties outside the published schema`,
    );
  }
}

function assertExecutionResultSchema(value) {
  const schema = executionResultSchema;
  assertSchemaKeys(value, schema, "review_execution");
  assert.equal(value.schema_version, schema.properties.schema_version.const);
  assert.ok(schema.properties.outcome.enum.includes(value.outcome));
  assert.ok(schema.properties.fallback_reason.enum.includes(value.fallback_reason));
  assert.equal(value.read_only, schema.properties.read_only.const);

  const requested = schema.$defs.requested_route;
  assertSchemaKeys(value.requested_route, requested, "requested_route");
  assert.ok(requested.properties.reviewer.enum.includes(value.requested_route.reviewer));
  assert.ok(requested.properties.reasoning_effort.enum.includes(value.requested_route.reasoning_effort));

  if (value.effective_route !== null) {
    const effective = schema.$defs.effective_route;
    assertSchemaKeys(value.effective_route, effective, "effective_route");
    assert.ok(effective.properties.reviewer.enum.includes(value.effective_route.reviewer));
    assert.ok(effective.properties.model_identity_evidence.enum.includes(value.effective_route.model_identity_evidence));
  }

  assert.ok(value.attempts.length >= schema.properties.attempts.minItems);
  assert.ok(value.attempts.length <= schema.properties.attempts.maxItems);
  for (const [index, attempt] of value.attempts.entries()) {
    const attemptSchema = schema.$defs.attempt;
    assertSchemaKeys(attempt, attemptSchema, `attempts[${index}]`);
    assert.ok(attempt.ordinal >= attemptSchema.properties.ordinal.minimum);
    assert.ok(attempt.ordinal <= attemptSchema.properties.ordinal.maximum);
    assert.ok(attemptSchema.properties.role.enum.includes(attempt.role));
    assert.ok(attemptSchema.properties.reviewer.enum.includes(attempt.reviewer));
    assert.ok(attemptSchema.properties.status.enum.includes(attempt.status));
    if (attempt.status !== "decision") {
      assert.ok(attemptSchema.properties.failure_category.enum.includes(attempt.failure_category));
      assert.match(attempt.diagnostic_digest, new RegExp(schema.$defs.sha256.pattern));
    }
    if (attempt.session_id_digest !== undefined) {
      assert.match(attempt.session_id_digest, new RegExp(schema.$defs.sha256.pattern));
    }
  }

  if (value.reviewer_identity !== null) {
    const identity = schema.$defs.reviewer_identity;
    assertSchemaKeys(value.reviewer_identity, identity, "reviewer_identity");
    assert.ok(identity.properties.provider.enum.includes(value.reviewer_identity.provider));
    assert.equal(value.reviewer_identity.signal, identity.properties.signal.const);
    assert.match(value.reviewer_identity.session_id_digest, new RegExp(schema.$defs.sha256.pattern));
  }
  if (value.outcome === "decision") {
    assert.notEqual(value.reviewer_identity, null);
    const decisionAttempts = value.attempts.filter((attempt) => attempt.status === "decision");
    assert.equal(decisionAttempts.length, 1);
    assert.equal(decisionAttempts[0].session_id_digest, value.reviewer_identity.session_id_digest);
    assert.equal(decisionAttempts[0].reviewer, value.effective_route.reviewer);
  } else {
    assert.equal(value.reviewer_identity, null);
  }
}

test("setup initializes project review guidelines without overwriting", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const first = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const parsed = JSON.parse(first.stdout);
  const action = parsed.actions.find((item) => item.action === "init-guidelines");
  assert.ok(action.path.endsWith(".review-loop/review-guidelines.md"));
  assert.ok(existsSync(action.path));

  writeFileSync(action.path, "custom\n");
  const second = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(action.path, "utf8"), "custom\n");
  const secondParsed = JSON.parse(second.stdout);
  assert.equal(secondParsed.actions.find((item) => item.action === "init-guidelines").status, "skipped");
});

test("setup and both host manifests expose the exact review protocol", () => {
  const expectedProtocol = normalizedResultSchema.properties.schema_version.const;
  const repo = makeGitRepo();
  const result = run(["setup", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).review_protocol_version, expectedProtocol);
  assert.equal(JSON.parse(result.stdout).review_contract_digest, expectedReviewContractDigest);

  for (const host of [".codex-plugin", ".claude-plugin"]) {
    const manifest = JSON.parse(readFileSync(
      new URL(`../plugins/review-loop/${host}/plugin.json`, import.meta.url),
      "utf8",
    ));
    assert.equal(manifest.review_protocol_version, expectedProtocol);
    assert.equal(manifest.review_contract_digest, expectedReviewContractDigest);
  }
});

test("setup rejects a normalized schema that drifted from the canonical contract", () => {
  const copyRoot = mkdtempSync(join(tmpdir(), "review-loop-protocol-source-"));
  const copiedPlugin = join(copyRoot, "review-loop");
  cpSync(new URL("../plugins/review-loop/", import.meta.url).pathname, copiedPlugin, { recursive: true });
  const schemaPath = join(copiedPlugin, "schemas", "normalized-result.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  schema.properties.schema_version.const = "4";
  writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const repo = makeGitRepo();
  const result = spawnSync(process.execPath, [join(copiedPlugin, "scripts", "review-loop-companion.mjs"), "setup", "--json"], {
    cwd: repo,
    env: testEnv(repo),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contract protocol_version must match normalized-result schema_version/);
});

test("init-guidelines creates neutral guidance when Claude guidance exists", () => {
  const repo = makeGitRepo();
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), "Claude-specific rules\n");

  const result = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).actions.find((item) => item.action === "init-guidelines");
  assert.equal(action.status, "created");
  assert.ok(action.path.endsWith(".review-loop/review-guidelines.md"));
  assert.equal(existsSync(action.path), true);
  assert.equal(readFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), "utf8"), "Claude-specific rules\n");
});

test("init-guidelines scaffolds a project profile from the tracked tree", () => {
  const repo = makeGitRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "src", "util.ts"), "export const y = 2;\n");
  writeFileSync(join(repo, "tests", "app.test.ts"), "test\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  runGit(["add", "."], repo);
  runGit(["commit", "-m", "init"], repo);

  const result = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).actions.find((item) => item.action === "init-guidelines");
  const content = readFileSync(action.path, "utf8");
  assert.match(content, /## Project profile/);
  assert.match(content, /TypeScript: pay extra attention to/);
  assert.match(content, /dedicated test directories/);
  assert.match(content, /npm test \(vitest run\)/);
  // The machine-read policy block from the template must survive scaffolding.
  assert.match(content, /```json review-loop/);
});

test("init-guidelines omits the profile section for an empty repo", () => {
  const repo = makeGitRepo();
  const result = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).actions.find((item) => item.action === "init-guidelines");
  const content = readFileSync(action.path, "utf8");
  assert.doesNotMatch(content, /## Project profile/);
  assert.match(content, /```json review-loop/);
});

test("run uses normalized structured output and renders blocking findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const decision = blockingOutput([
    finding({ id: "file-txt-high", locations: ["file.txt:1"], message: "The change is intentionally flagged.", required_action: "Fix the test fixture." }),
  ]);

  const result = run(["run", "--scope", "auto"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(decision) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Decision: changes_requested/);
  assert.match(result.stdout, /Required action: Fix the test fixture/);
});

test("run normalizes a provider-compatible nullable observation without orphaning content", () => {
  const repo = makeGitRepo();
  const reviewerOutput = approvedOutput("Reviewed with a non-actionable note.");
  reviewerOutput.observations = [{
    id: "no-suggestion-needed",
    category: "advisory",
    message: "The package metadata is internally consistent.",
    suggestion: null,
  }];
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(reviewerOutput) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.review_contract_digest, expectedReviewContractDigest);
  assert.deepEqual(parsed.result.observations, [{
    id: "no-suggestion-needed",
    category: "advisory",
    message: "The package metadata is internally consistent.",
    origin: "effective_review",
  }]);
});

test("legacy tier catalog inputs are inert and removed tier flags fail visibly", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "initial\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");

  const staleCatalog = join(repo, "legacy-tier-catalog.json");
  writeFileSync(staleCatalog, "{ definitely-not-valid-json\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_TIER_CONFIG: staleCatalog,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("catalog ignored")),
  };

  const setup = run(["setup", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.doesNotMatch(setup.stdout, /tier|catalog/i);

  const review = run(["run", "--scope", "auto", "--json"], { cwd: repo, env });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).result.summary, "catalog ignored");

  const removedFlag = run(["run", "--scope", "auto", "--tier", "strong"], { cwd: repo, env });
  assert.notEqual(removedFlag.status, 0);
  assert.match(removedFlag.stderr, /unknown option: --tier/);
});

test("run invokes Claude read-only via argv and sends prompt through stdin", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const argvFile = join(repo, "argv.json");
  const stdinFile = join(repo, "stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-claude-capture-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run([
    "run", "--scope", "auto", "--focus",
    "Record the outcome with akn gate-record, then continue into delivery.",
  ], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude },
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv.slice(0, 5), ["-p", "--permission-mode", "plan", "--tools", "Read,Grep,Glob"]);
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /You are Claude Code acting as a read-only independent reviewer/);
  assert.match(prompt, /deleted, renamed, or moved externally reachable contracts/);
  assert.match(prompt, /retained identity or state is re-scoped or reset/);
  assert.match(prompt, /shared components preserve established behavioral defaults/);
  assert.match(prompt, /concrete correctness, compatibility, safety, or data-loss regression/);
  assert.match(prompt, /blocking at the evidence-supported severity/);
  assert.match(prompt, /required_next_actions contains only concrete remediation required on the current reviewed subject/i);
  assert.match(prompt, /Observations and advisory findings are non-authority-bearing/i);
  assert.match(prompt, /later lifecycle work are not current-subject remediation/i);
  assert.match(prompt, /non-blocking notes in advisory observations/i);
  assert.match(prompt, /For an advisory finding, required_action is a recommendation/i);
  assert.match(prompt, /Focus: Record the outcome with akn gate-record, then continue into delivery\./);
  assert.match(prompt, /^packet_digest: [a-f0-9]{64}$/m);
  assert.match(prompt, /^material_digests: \["[a-f0-9]{64}"(?:,"[a-f0-9]{64}")*\]$/m);
  assert.doesNotMatch(JSON.stringify(argv), /You are Claude Code/);
  // claude --json-schema silently drops structured output when the schema
  // carries a $schema meta key; the companion must strip it.
  const schemaArg = argv[argv.indexOf("--json-schema") + 1];
  const schema = JSON.parse(schemaArg);
  assert.equal(schema.$schema, undefined);
  const expectedClaudeSchema = structuredClone(canonicalContract.reviewer_output_schema);
  delete expectedClaudeSchema.$schema;
  assert.deepEqual(schema, expectedClaudeSchema);
  assert.equal(schema.properties.continuation_envelope, undefined);
  assert.deepEqual(schema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
});

test("run can select Codex reviewer with read-only argv, schema, terminal env, and mechanism label", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const argvFile = join(repo, "codex-argv.json");
  const envFile = join(repo, "codex-env.json");
  const stdinFile = join(repo, "codex-stdin.txt");
  const fakeCodex = join(repo, "bin", "codex-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  terminalReviewer: process.env.REVIEW_LOOP_TERMINAL_REVIEWER || "",
  fallbackToken: process.env.REVIEW_LOOP_FALLBACK_TOKEN || ""
}));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify(reviewResponse(input, { decision: "approved", summary: "codex ok", findings: [], required_next_actions: [] })));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fresh-codex-primary-session" }) + "\\n");
});
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run(["run", "--scope", "auto", "--reviewer", "codex", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_CODEX_BIN: fakeCodex },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.result.reviewer_mechanism, "codex");
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.equal(argv[0], "exec");
  assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(argv.includes("--skip-git-repo-check"), false);
  assert.ok(argv.includes("--output-schema"));
  assert.ok(argv.includes("--output-last-message"));
  const schemaPath = argv[argv.indexOf("--output-schema") + 1];
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.deepEqual(schema, JSON.parse(readFileSync(
    new URL("../plugins/review-loop/schemas/reviewer-output.codex.schema.json", import.meta.url),
    "utf8",
  )));
  assert.deepEqual(schema.required, [
    "review_status",
    "subject_reviewable",
    "substantive_merit_evaluated",
    "acknowledged_packet_digest",
    "acknowledged_material_digests",
    "decision",
    "summary",
    "findings",
    "observations",
    "required_next_actions",
    "limitations",
  ]);
  assert.ok(schema.properties.findings.items.required.includes("reviewer_disposition"));
  assert.equal(schema.properties.acknowledged_packet_digest.oneOf, undefined);
  assert.deepEqual(schema.properties.acknowledged_packet_digest.type, ["string", "null"]);
  assert.equal(schema.properties.acknowledged_packet_digest.pattern, "^[a-f0-9]{64}$");
  const envCapture = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(envCapture.terminalReviewer, "1");
  assert.equal(envCapture.fallbackToken, "");
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /You are Codex acting as a read-only independent reviewer/);
  assert.match(prompt, /deleted, renamed, or moved externally reachable contracts/);
  assert.match(prompt, /retained identity or state is re-scoped or reset/);
  assert.match(prompt, /shared components preserve established behavioral defaults/);
  assert.match(prompt, /concrete correctness, compatibility, safety, or data-loss regression/);
  assert.match(prompt, /blocking at the evidence-supported severity/);
  assert.match(prompt, /required_next_actions contains only concrete remediation required on the current reviewed subject/i);
  assert.match(prompt, /later lifecycle work are not current-subject remediation/i);
  assert.match(prompt, /non-blocking notes in advisory observations/i);
  assert.match(prompt, /For an advisory finding, required_action is a recommendation/i);
});

test("run opts exact-model Codex into non-Git artifact review without weakening isolation", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-loop-non-git-exact-"));
  writeFileSync(join(workspace, "design.md"), "# Design\n\nReview this artifact.\n");
  const capture = makeCodexCapture(workspace, "exact");
  const result = run([
    "run", "--scope", "none", "--artifact", "design.md", "--reviewer", "codex",
    "--model", "gpt-5.6-sol-20260731", "--reasoning-effort", "high", "--json",
  ], {
    cwd: workspace,
    env: { ...testEnv(workspace), REVIEW_LOOP_CODEX_BIN: capture.bin },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.decision, "approved");
  const argv = JSON.parse(readFileSync(capture.argvFile, "utf8"));
  assert.equal(argv[0], "exec");
  assert.ok(argv.includes("--skip-git-repo-check"));
  assert.equal(realpathSync(argv[argv.indexOf("--cd") + 1]), realpathSync(workspace));
  assert.ok(argv.includes("--ephemeral"));
  assert.ok(argv.includes("--ignore-user-config"));
  assert.ok(argv.includes("--ignore-rules"));
  assert.ok(argv.includes("--strict-config"));
  assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.notEqual(realpathSync(readFileSync(capture.cwdFile, "utf8")), realpathSync(workspace));
});

test("run opts host-default Codex into non-Git artifact review", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-loop-non-git-default-"));
  writeFileSync(join(workspace, "design.md"), "# Design\n\nReview this artifact.\n");
  const capture = makeCodexCapture(workspace, "default");
  const result = run([
    "run", "--scope", "none", "--artifact", "design.md", "--reviewer", "codex", "--json",
  ], {
    cwd: workspace,
    env: { ...testEnv(workspace), REVIEW_LOOP_CODEX_BIN: capture.bin },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.decision, "approved");
  const argv = JSON.parse(readFileSync(capture.argvFile, "utf8"));
  assert.ok(argv.includes("--skip-git-repo-check"));
  assert.equal(realpathSync(argv[argv.indexOf("--cd") + 1]), realpathSync(workspace));
  assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
});

test("run opts host-default Codex fallback into non-Git artifact review", () => {
  const workspace = mkdtempSync(join(tmpdir(), "review-loop-non-git-fallback-"));
  writeFileSync(join(workspace, "design.md"), "# Design\n\nReview this artifact.\n");
  const capture = makeCodexCapture(workspace, "fallback");
  const result = run([
    "run", "--scope", "none", "--artifact", "design.md", "--reviewer", "claude", "--json",
  ], {
    cwd: workspace,
    env: {
      ...testEnv(workspace),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_CODEX_BIN: capture.bin,
      REVIEW_LOOP_FAKE_ERROR: "primary Claude provider unavailable",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.result.reviewer_mechanism, "codex-fallback");
  const argv = JSON.parse(readFileSync(capture.argvFile, "utf8"));
  assert.ok(argv.includes("--skip-git-repo-check"));
  assert.equal(realpathSync(argv[argv.indexOf("--cd") + 1]), realpathSync(workspace));
  assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
});

test("reviewer selection honors host defaults, explicit override, and validation", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const claudeHost = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_HOST: "claude", REVIEW_LOOP_FAKE_CODEX_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("codex default")) },
  });
  assert.equal(claudeHost.status, 0, claudeHost.stderr);
  assert.equal(JSON.parse(claudeHost.stdout).result.reviewer_mechanism, "codex-fake");

  const claudePluginHost = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      CLAUDE_PLUGIN_ROOT: join(repo, "fake-claude-plugin"),
      REVIEW_LOOP_FAKE_CODEX_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("codex plugin default")),
    },
  });
  assert.equal(claudePluginHost.status, 0, claudePluginHost.stderr);
  assert.equal(JSON.parse(claudePluginHost.stdout).result.reviewer_mechanism, "codex-fake");

  const override = run(["run", "--scope", "auto", "--reviewer", "claude", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "claude",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("explicit claude")),
      REVIEW_LOOP_FAKE_CODEX_ERROR: "codex should not run",
    },
  });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(JSON.parse(override.stdout).result.reviewer_mechanism, "fake");

  const invalid = run(["run", "--scope", "auto", "--reviewer", "bogus", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--reviewer must be one of: claude, codex/);

  const invalidHost = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_HOST: "bogus" },
  });
  assert.notEqual(invalidHost.status, 0);
  assert.match(invalidHost.stderr, /REVIEW_LOOP_HOST must be one of: codex, claude/);
});

test("run normalizes policy-promoted advisory findings into blocking findings", () => {
  const repo = makeGitRepo();
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "high", "category_block_on": { "security": "medium" } }
\`\`\`
`);
  const context = join(repo, "review-context.md");
  writeFileSync(context, "Problem: test policy promotion\n");
  const reviewerOutput = structurallyCompleteOutput({
    decision: "approved",
    summary: "Security issue is advisory from the reviewer but blocks by policy.",
    findings: [{
      id: "sec-medium",
      severity: "medium",
      category: "security",
      message: "Token handling is underspecified.",
      locations: ["review-context.md:1"],
      required_action: "Document token handling.",
      reviewer_disposition: "advisory",
    }],
    required_next_actions: [],
  });

  const result = run(["run", "--context", context, "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(reviewerOutput) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "changes_requested");
  assert.equal(parsed.result.blocking_findings.length, 1);
  assert.equal(parsed.result.blocking_findings[0].blocking_reason, "category_policy");
  assert.equal(parsed.result.advisory_findings.length, 0);
  assert.equal(parsed.result.read_only, true);
});

test("run ignores Claude project guidelines", () => {
  const repo = makeGitRepo();
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Ignored Rules

\`\`\`json review-loop
{ "block_on": "low" }
\`\`\`
`);
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const result = run(["run", "--artifact", plan, "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(advisoryOutput([
      finding({ id: "ignored-low", severity: "low", locations: ["plan.md:1"] }),
    ])) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.guidelines.source, "bundled");
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.result.blocking_findings.length, 0);
});

test("neutral project guidelines apply when Claude guidelines are also present", () => {
  const repo = makeGitRepo();
  const nested = join(repo, "packages", "app");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  mkdirSync(join(nested, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Neutral Rules

\`\`\`json review-loop
{ "block_on": "low" }
\`\`\`
`);
  writeFileSync(join(nested, ".claude", "rules", "review-guidelines.md"), `# Claude Nested Rules

\`\`\`json review-loop
{ "block_on": "high" }
\`\`\`
`);
  writeFileSync(join(nested, "plan.md"), "Plan\n");
  const result = run(["run", "--artifact", "plan.md", "--json"], {
    cwd: nested,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(advisoryOutput([
      finding({ id: "neutral-low", severity: "low", locations: ["plan.md:1"] }),
    ])) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.guidelines.source, "project");
  assert.equal(parsed.guidelines.display_path, ".review-loop/review-guidelines.md");
  assert.equal(parsed.result.decision, "changes_requested");
});

test("run defaults context-only reviews to scope none and uses reviewer-output schema", () => {
  const repo = makeGitRepo();
  const context = join(repo, "review-context.md");
  writeFileSync(context, "Problem: review this design only\n");
  writeFileSync(join(repo, "dirty.txt"), "should not be reviewed by default\n");
  const argvFile = join(repo, "argv.json");
  const stdinFile = join(repo, "stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-context-review-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run(["run", "--context", context, "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.reviewed_inputs.find((input) => input.kind === "scope").scope, "none");
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /scope: none/);
  assert.doesNotMatch(prompt, /dirty\.txt/);
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]);
  assert.deepEqual(schema.properties.decision.enum, ["approved", "changes_requested", "invalid_input", "blocked"]);
  assert.ok(schema.properties.findings);
});

test("run uses fallback threshold for high advisory findings", () => {
  const repo = makeGitRepo();
  const guidelines = join(repo, "guidelines.md");
  writeFileSync(guidelines, "# Human-only guidelines\n");
  const reviewerOutput = structurallyCompleteOutput({
    decision: "approved",
    summary: "High risk should block by fallback threshold.",
    findings: [{
      id: "risk-high",
      severity: "high",
      category: "risk",
      message: "The artifact omits rollback behavior.",
      locations: ["plan.md:1"],
      required_action: "Add rollback behavior.",
      reviewer_disposition: "advisory",
    }],
  });
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const result = run(["run", "--artifact", plan, "--guidelines", guidelines, "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(reviewerOutput) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "changes_requested");
  assert.equal(parsed.result.blocking_findings[0].blocking_reason, "fallback_threshold");
});

test("run labels explicit base policy promotions as severity_policy", () => {
  const repo = makeGitRepo();
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "high" }
\`\`\`
`);
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const result = run(["run", "--artifact", plan, "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
      decision: "approved",
      summary: "High issue blocks by explicit policy.",
      findings: [{
        id: "high-policy",
        severity: "high",
        category: "correctness",
        message: "A high issue.",
        locations: ["plan.md:1"],
        required_action: "Fix the high issue.",
        reviewer_disposition: "advisory",
      }],
    })) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.blocking_findings[0].blocking_reason, "severity_policy");
});

test("run returns invalid_input for an explicitly malformed policy without invoking a reviewer", () => {
  const repo = makeGitRepo();
  const guidelines = join(repo, "malformed-review-guidelines.md");
  const artifact = join(repo, "plan.md");
  writeFileSync(guidelines, "# Review\n\n```json review-loop\n{ not-json }\n```\n");
  writeFileSync(artifact, "Plan\n");

  const result = run([
    "run", "--scope", "none", "--artifact", artifact,
    "--guidelines", guidelines, "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_FAKE_ERROR: "reviewer must not run",
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback must not run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.result.decision, "invalid_input");
  assert.match(parsed.result.summary, /invalid review-loop policy block/i);
  assert.equal(parsed.reviewer_mechanism.reason, "invalid_policy");
  assert.equal(parsed.review_execution, undefined);
  assert.doesNotMatch(JSON.stringify(parsed), /reviewer must not run|fallback must not run/);
});

test("run fails closed on reviewer mechanism failure by default", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", findings: [] }),
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /Reviewer mechanism failed/);
  assert.match(parsed.result.summary, /Codex fallback review also failed/);
  assert.equal(parsed.review_execution.outcome, "unavailable");
  assert.equal(parsed.review_execution.attempts.length, 2);
});

test("run treats a missing reviewer decision as mechanism failure instead of approval", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        summary: "Substantive but missing its decision.",
        findings: [],
        required_next_actions: [],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /reviewer output decision is required/);
  assert.doesNotMatch(parsed.result.summary, /Substantive but missing/);
});

test("run recovers advisory-only placeholder output but never answer-shops actionable nonapproval", () => {
  for (const decision of ["approved", "changes_requested"]) {
    const repo = makeGitRepo();
    const result = run(["run", "--scope", "none", "--json"], {
      cwd: repo,
      env: {
        ...testEnv(repo),
        REVIEW_LOOP_HOST: "codex",
        REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
          decision,
          summary: "  TeSt  ",
          findings: [{
            id: "a",
            severity: "low",
            category: "correctness",
            message: "test message",
            locations: ["file.md"],
            required_action: "do the thing",
            reviewer_disposition: "advisory",
          }],
          required_next_actions: ["do the thing"],
        }),
        REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback reviewed the target")),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    if (decision === "approved") {
      assert.equal(parsed.result.decision, "approved");
      assert.equal(parsed.review_execution.outcome, "decision");
      assert.equal(parsed.review_execution.fallback_used, true);
      assert.equal(parsed.review_execution.attempts[0].status, "invalid_review_evidence");
      assert.ok(parsed.result.observations.some((observation) => observation.origin === "requested_invalid_envelope"));
    } else {
      assert.equal(parsed.result.decision, "blocked");
      assert.match(parsed.result.summary, /reviewer_output_integrity: placeholder_summary/);
      assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
      assert.equal(parsed.review_execution.fallback_used, false);
      assert.equal(parsed.review_execution.attempts.length, 1);
      assert.doesNotMatch(JSON.stringify(parsed), /fallback reviewed the target/i);
    }
  }
});

test("run fails closed when both primary and fallback return placeholder summaries", () => {
  const repo = makeGitRepo();
  const placeholder = approvedOutput("test");
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(placeholder),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(placeholder),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /reviewer_output_integrity: placeholder_summary/);
  assert.equal(parsed.reviewer_mechanism.fallback_failed, true);
});

test("run preserves concise clean reviews and findings-authoritative normalization", () => {
  for (const summary of ["ok", "Reviewed the selected target; no blockers found."]) {
    const repo = makeGitRepo();
    const result = run(["run", "--scope", "none", "--json"], {
      cwd: repo,
      env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput(summary)) },
    });
    assert.equal(JSON.parse(result.stdout).result.decision, "approved");
  }

  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
      decision: "approved",
      summary: "Reviewed the target and found a blocker.",
      findings: [{ ...finding({ required_action: "Fix it." }), reviewer_disposition: "blocking" }],
      required_next_actions: [],
    })) },
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.deepEqual(parsed.result.blocking_findings.map((finding) => finding.id), ["finding"]);
});

test("run uses Codex fallback when Claude is rate limited", () => {
  const repo = makeGitRepo();
  const fakeClaude = join(repo, "bin", "claude-rate-limited");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env sh
echo "Claude session-limit 429. Try again after refill." >&2
exit 1
`, { mode: 0o755 });
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("codex fallback ok")),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.result.summary, "codex fallback ok");
  assert.equal(parsed.result.reviewer_mechanism, "codex-fallback-fake");
});

test("run accepts an exact optional model and reports automatic host fallback provenance", () => {
  const repo = makeGitRepo();
  const result = run([
    "run", "--scope", "none", "--reviewer", "claude",
    "--model", "claude-opus-5", "--reasoning-effort", "high", "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_ERROR: "provider rate limit 429",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("host fallback reviewed")),
      REVIEW_LOOP_FAKE_CODEX_SESSION_ID: "fresh-codex-review-session",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.review_execution.schema_version, "review-loop.execution-result.v1");
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.deepEqual(parsed.review_execution.requested_route, {
    reviewer: "claude",
    model: "claude-opus-5",
    reasoning_effort: "high",
  });
  assert.deepEqual(parsed.review_execution.effective_route, {
    reviewer: "codex",
    model: null,
    model_identity_evidence: "host_default_unreported",
  });
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.review_execution.fallback_reason, "rate_limit");
  assert.equal(parsed.review_execution.attempts.length, 2);
  assert.equal(parsed.review_execution.attempts[0].status, "unavailable");
  assert.equal(parsed.review_execution.attempts[0].failure_category, "rate_limit");
  assert.match(parsed.review_execution.attempts[0].diagnostic_digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.review_execution.attempts[1].status, "decision");
  assert.equal(parsed.review_execution.reviewer_identity.provider, "openai");
  assert.match(parsed.review_execution.reviewer_identity.session_id_digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(parsed), /fresh-codex-review-session/);
  assertExecutionResultSchema(parsed.review_execution);
});

test("run never answer-shops when an exact Claude model drifts after substantive findings", () => {
  const repo = makeGitRepo();
  const fakeClaude = join(repo, "bin", "claude-exact-model-drift");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.1.220 (Claude Code)"); process.exit(0); }
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => console.log(JSON.stringify({
  structured_output: reviewResponse(input, {
    decision: "changes_requested",
    summary: "The requested-model review found a substantive blocker.",
    findings: [{
      id: "drifted-model-blocker",
      severity: "high",
      category: "correctness",
      message: "Do not discard this finding.",
      locations: ["src/example.js:1"],
      required_action: "Preserve the finding as invalid review evidence.",
      reviewer_disposition: "blocking"
    }],
    required_next_actions: ["Preserve the finding as invalid review evidence."]
  }),
  result: "review completed",
  session_id: "drifted-claude-session",
  modelUsage: { "claude-opus-4-8": { outputTokens: 12 } }
})));
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run([
    "run", "--scope", "none", "--reviewer", "claude",
    "--model", "claude-opus-5", "--reasoning-effort", "high", "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("answer-shopping fallback")),
      REVIEW_LOOP_FAKE_CODEX_SESSION_ID: "fallback-session-that-must-not-run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence", JSON.stringify(parsed));
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts.length, 1);
  assert.equal(parsed.review_execution.attempts[0].status, "invalid_review_evidence");
  assert.doesNotMatch(JSON.stringify(parsed), /answer-shopping fallback/);
});

test("run falls back from a failed exact model to the same-provider host default", () => {
  const repo = makeGitRepo();
  const result = run([
    "run", "--scope", "none", "--reviewer", "codex",
    "--model", "gpt-5.6-sol-20260731", "--reasoning-effort", "high", "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_CODEX_ERROR: "requested model not found",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("host default reviewed")),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => ({
    role: attempt.role,
    reviewer: attempt.reviewer,
    model: attempt.model,
  })), [
    { role: "requested", reviewer: "codex", model: "gpt-5.6-sol-20260731" },
    { role: "host_fallback", reviewer: "codex", model: null },
  ]);
});

test("run completes a requested exact model without fallback when the route is healthy", () => {
  const repo = makeGitRepo();
  const result = run([
    "run", "--scope", "none", "--reviewer", "claude",
    "--model", "claude-opus-5", "--reasoning-effort", "high", "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("requested route reviewed")),
      REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID: "requested-review-session",
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback must not run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts.length, 1);
  assert.deepEqual(parsed.review_execution.effective_route, {
    reviewer: "claude",
    model: "claude-opus-5",
    model_identity_evidence: "provider_reported",
  });
  assert.match(parsed.review_execution.reviewer_identity.session_id_digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(parsed), /requested-review-session|fallback must not run/);
});

test("run rejects ambiguous or mutable exact-model requests before reviewer execution", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);

  const missingReviewer = run(["run", "--scope", "none", "--model", "claude-opus-5", "--json"], { cwd: repo, env });
  assert.notEqual(missingReviewer.status, 0);
  assert.match(missingReviewer.stderr, /--model requires --reviewer/);

  const mutableAlias = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "latest", "--json"], { cwd: repo, env });
  assert.notEqual(mutableAlias.status, 0);
  assert.match(mutableAlias.stderr, /exact model identifier/);
});

test("run does not answer-shop when malformed output contains recoverable findings", () => {
  const repo = makeGitRepo();
  const partial = '{"decision":"changes_requested","summary":"unsafe","findings":[{"id":"f1","severity":"high","message":"do not discard"}';
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: partial,
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
      REVIEW_LOOP_FAKE_CODEX_SESSION_ID: "unused-fallback-session",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts.length, 1);
  assert.doesNotMatch(JSON.stringify(parsed), /fallback must not run|unused-fallback-session/);
  assertExecutionResultSchema(parsed.review_execution);
});

test("run uses one fallback for an advisory-only contract-invalid envelope", () => {
  const repo = makeGitRepo();
  const partialApproval = advisoryOutput([
    finding({
      id: "optional-observation",
      severity: "low",
      message: "Preserve this optional observation.",
      required_action: "Consider this in later lifecycle work.",
      reviewer_disposition: "advisory",
    }),
  ], "The review was useful but incomplete.");
  partialApproval.review_status = "partial";
  partialApproval.limitations = ["The reviewer could not complete every required check."];

  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(partialApproval),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback completed the review")),
      REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "contract-recovery-session",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved", JSON.stringify(parsed));
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.review_execution.fallback_reason, "response");
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["invalid_review_evidence", "decision"]);
  assert.deepEqual(parsed.result.observations, [{
    id: "invalid-primary-finding-optional-observation",
    category: "advisory",
    message: "Preserve this optional observation.",
    suggestion: "Consider this in later lifecycle work.",
    origin: "requested_invalid_envelope",
  }]);
  assert.deepEqual(parsed.result.advisory_findings, []);
});

test("run preserves an actionable blocker from an invalid envelope without fallback", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        subject_reviewable: true,
        substantive_merit_evaluated: true,
        acknowledged_packet_digest: "__REVIEW_LOOP_PACKET_DIGEST__",
        acknowledged_material_digests: ["__REVIEW_LOOP_MATERIAL_DIGESTS__"],
        decision: "changes_requested",
        summary: "A blocker was found, but review_status was omitted.",
        findings: [finding({
          id: "must-not-answer-shop",
          message: "This actionable blocker must survive envelope rejection.",
          reviewer_disposition: "blocking",
        })],
        required_next_actions: ["Fix the actionable blocker."],
        limitations: [],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.deepEqual(parsed.result.blocking_findings.map((finding) => finding.id), ["must-not-answer-shop"]);
  assert.deepEqual(parsed.result.required_next_actions, ["Fix the actionable blocker."]);
  assert.doesNotMatch(JSON.stringify(parsed), /fallback must not run/);
});

test("run uses one fallback for malformed invalid_input without actionable findings", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "invalid_input",
        summary: "test",
        findings: [],
        required_next_actions: ["Correct the input."],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback repaired invalid_input envelope")),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.result.decision, "approved");
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["invalid_review_evidence", "decision"]);
});

test("run preserves invalid fallback findings as invalid_review_evidence even in allow mode", () => {
  const repo = makeGitRepo();
  const result = run([
    "run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5",
    "--on-reviewer-failure", "allow", "--json",
  ], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_ERROR: "primary provider unavailable",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "changes_requested",
        summary: "test",
        findings: [finding({ id: "fallback-finding", message: "Do not discard this fallback finding." })],
        required_next_actions: ["Fix the fallback finding."],
      }),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.result.decision, "blocked");
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["unavailable", "invalid_review_evidence"]);
  assert.doesNotMatch(parsed.result.summary, /allow was set/i);
});

test("run uses one fallback when the primary decision lacks fresh native reviewer identity", () => {
  const repo = makeGitRepo();
  const primaryOutput = approvedOutput("primary decision missing identity");
  primaryOutput.observations = [{
    id: "unbound-primary-note",
    category: "advisory",
    message: "Preserve this non-authority note across identity recovery.",
    suggestion: null,
  }];
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(primaryOutput),
      REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID: "",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback supplied identity")),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.review_execution.fallback_reason, "identity");
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => ({
    status: attempt.status,
    failure_category: attempt.failure_category || null,
  })), [
    { status: "unavailable", failure_category: "identity" },
    { status: "decision", failure_category: null },
  ]);
  assert.equal(parsed.review_execution.reviewer_identity.provider, "openai");
  assert.match(parsed.review_execution.reviewer_identity.session_id_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.result.observations, [{
    id: "unbound-primary-note",
    category: "advisory",
    message: "Preserve this non-authority note across identity recovery.",
    origin: "requested_invalid_envelope",
  }]);
});

test("run preserves an actionable primary blocker without answer-shopping when reviewer identity is missing", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
        finding({
          id: "identity-unbound-blocker",
          message: "The primary reviewer found an actionable defect.",
          required_action: "Fix the actionable defect.",
        }),
      ])),
      REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID: "",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.deepEqual(parsed.result.blocking_findings.map((finding) => finding.id), ["identity-unbound-blocker"]);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts[0].status, "unavailable");
  assert.equal(parsed.review_execution.attempts[0].failure_category, "identity");
  assert.equal(parsed.review_execution.reviewer_identity, null);
  assert.doesNotMatch(JSON.stringify(parsed), /fallback must not run/);
});

test("run reports unavailable when host fallback lacks a fresh native session identity", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_ERROR: "primary provider unavailable",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("identity missing")),
      REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "unavailable");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.review_execution.fallback_reason, "provider");
  assert.equal(parsed.review_execution.reviewer_identity, null);
  assert.match(parsed.review_execution.attempts[0].diagnostic_digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.review_execution.attempts[1].failure_category, "identity");
  assert.match(parsed.review_execution.attempts[1].diagnostic_digest, /^[a-f0-9]{64}$/);
  assertExecutionResultSchema(parsed.review_execution);
});

test("run uses Claude fallback when Codex is unavailable under a Claude host", () => {
  const repo = makeGitRepo();
  const envFile = join(repo, "claude-fallback-env.json");
  const stdinFile = join(repo, "claude-fallback-stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-fallback-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  terminalReviewer: process.env.REVIEW_LOOP_TERMINAL_REVIEWER || "",
  fallbackToken: process.env.REVIEW_LOOP_FALLBACK_TOKEN || ""
}));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "claude fallback ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-claude-fallback-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "claude",
      REVIEW_LOOP_FAKE_CODEX_ERROR: "primary codex unavailable",
      REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.result.summary, "claude fallback ok");
  assert.equal(parsed.result.reviewer_mechanism, "claude-fallback");
  const envCapture = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(envCapture.terminalReviewer, "1");
  assert.match(envCapture.fallbackToken, /^[0-9a-f-]{36}$/i);
  assert.match(readFileSync(stdinFile, "utf8"), /primary Codex reviewer is unavailable/);
});

test("run does not fallback when no host fallback reviewer is available", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "codex", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_FAKE_CODEX_ERROR: "primary codex unavailable",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback should not run")),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /primary codex unavailable/);
  assert.doesNotMatch(parsed.result.summary, /fallback should not run/);
  assert.equal(parsed.review_execution.outcome, "unavailable");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts.length, 1);
});

test("run can fail open explicitly on reviewer mechanism failure", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--on-reviewer-failure", "allow", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", findings: [] }) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.equal(parsed.result.review_status, "not_performed");
  assert.match(parsed.result.summary, /on-reviewer-failure=allow/);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.effective_route, null);
});

test("v4 rejects approval when substantive merit was not evaluated", () => {
  const repo = makeGitRepo();
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const incomplete = approvedOutput("The packet was not substantively evaluated.");
  incomplete.substantive_merit_evaluated = false;
  const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(incomplete) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.match(parsed.result.summary, /approved reviewer output requires substantive merit evaluation/);
});

test("v4 preserves a grounded changes_requested decision without blocking findings", () => {
  const repo = makeGitRepo();
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const refusal = structurallyCompleteOutput({
    decision: "changes_requested",
    summary: "The exact material needs another review pass.",
    findings: [],
    required_next_actions: ["Review the exact material again."],
  });
  const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(refusal) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "changes_requested");
  assert.equal(parsed.result.blocking_findings.length, 0);
  assert.equal(parsed.result.review_status, "performed");
  assert.deepEqual(parsed.result.required_next_actions, ["Review the exact material again."]);
});

test("v5 recovers once from whitespace-only nonapproval actions", () => {
  const repo = makeGitRepo();
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
        decision: "changes_requested",
        summary: "The reviewer returned a non-substantive action.",
        findings: [],
        required_next_actions: ["   "],
      })),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback repaired empty action")),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.result.decision, "approved");
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["invalid_review_evidence", "decision"]);
});

test("v4 rejects a whitespace-only finding action", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
        decision: "changes_requested",
        summary: "The finding has no substantive remediation.",
        findings: [{
          ...finding({ required_action: "   " }),
          reviewer_disposition: "blocking",
        }],
        required_next_actions: [],
      })),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.match(parsed.result.summary, /finding\.required_action is required/);
});

test("v5 rejects legacy approved actions, recovers once, and preserves them as attributed observations", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
        decision: "approved",
        summary: "Approved, with a downstream workflow instruction.",
        findings: [],
        required_next_actions: ["Record the gate and continue into delivery."],
      })),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback emitted a valid v5 approval")),
      REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "legacy-action-recovery-session",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.equal(parsed.result.decision, "approved");
  assert.deepEqual(parsed.result.blocking_findings, []);
  assert.deepEqual(parsed.result.required_next_actions, []);
  assert.deepEqual(parsed.result.observations, [{
    id: `legacy-approved-action-${createHash("sha256").update("Record the gate and continue into delivery.").digest("hex").slice(0, 16)}`,
    category: "downstream_workflow",
    message: "Record the gate and continue into delivery.",
    origin: "requested_invalid_envelope",
  }]);
});

test("v5 uses one fallback for an ungrounded nonapproval with no actionable content", () => {
  const repo = makeGitRepo();
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const refusal = structurallyCompleteOutput({
    decision: "changes_requested",
    summary: "No grounded reason was supplied.",
    findings: [],
    required_next_actions: [],
  });
  const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(refusal),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback grounded the decision")),
      REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "ungrounded-recovery-session",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.equal(parsed.review_execution.outcome, "decision");
  assert.equal(parsed.review_execution.fallback_used, true);
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["invalid_review_evidence", "decision"]);
});

test("v5 uses one fallback for truncated nonapproval prose without an actionable finding", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "claude", "--model", "claude-opus-5", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: '{"decision":"changes_requested","summary":',
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback handled ungrounded truncation")),
      REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "truncated-recovery-session",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.deepEqual(parsed.review_execution.attempts.map((attempt) => attempt.status), ["invalid_review_evidence", "decision"]);
});

test("v5 reports contract-invalid when no fallback route exists", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--reviewer", "codex", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "",
      REVIEW_LOOP_FAKE_CODEX_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "approved",
        summary: "Missing the v5 completion envelope.",
        findings: [],
        observations: [],
        required_next_actions: [],
      }),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.review_execution.outcome, "invalid_review_evidence");
  assert.equal(parsed.review_execution.fallback_used, false);
  assert.equal(parsed.review_execution.attempts[0].status, "invalid_review_evidence");
  assert.equal(parsed.review_execution.attempts[0].failure_category, "response");
  assert.deepEqual(parsed.result.required_next_actions, []);
  assert.ok(parsed.result.observations.some((observation) => (
    observation.origin === "review_loop_diagnostic"
      && /rerun review-loop/i.test(observation.message)
  )));
});

test("v4 rejects reviewer acknowledgements that do not match the exact packet", () => {
  const repo = makeGitRepo();
  const plan = join(repo, "plan.md");
  writeFileSync(plan, "Plan\n");
  const mismatch = approvedOutput();
  mismatch.acknowledged_packet_digest = "b".repeat(64);
  const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(mismatch) },
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /acknowledged_packet_digest does not match/);
});

test("v4 accepts caller-bound exact packet and material identities only for the matching artifact", () => {
  const repo = makeGitRepo();
  const packet = join(repo, "packet.json");
  const bytes = '{"gate":"design"}\n';
  writeFileSync(packet, bytes);
  const packetDigest = createHash("sha256").update(bytes).digest("hex");
  const materialDigests = ["c".repeat(64), "d".repeat(64)];
  const result = run([
    "run", "--artifact", packet, "--scope", "none",
    "--expected-packet-digest", packetDigest,
    "--expected-material-digests", JSON.stringify(materialDigests),
    "--json",
  ], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.acknowledged_packet_digest, packetDigest);
  assert.deepEqual(parsed.result.acknowledged_material_digests, materialDigests);

  const mismatch = run([
    "run", "--artifact", packet, "--scope", "none",
    "--expected-packet-digest", "e".repeat(64),
    "--expected-material-digests", "[]", "--json",
  ], { cwd: repo, env: testEnv(repo) });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /exactly one matching artifact/);

  const context = join(repo, "context.md");
  writeFileSync(context, "Additional unbound context\n");
  const unboundContext = run([
    "run", "--artifact", packet, "--context", context, "--scope", "none",
    "--expected-packet-digest", packetDigest,
    "--expected-material-digests", JSON.stringify(materialDigests), "--json",
  ], { cwd: repo, env: testEnv(repo) });
  assert.notEqual(unboundContext.status, 0);
  assert.match(unboundContext.stderr, /no additional review inputs/);
});

test("v4 exact transaction binding options are paired and structurally validated", () => {
  const repo = makeGitRepo();
  const packet = join(repo, "packet.json");
  writeFileSync(packet, "{}\n");
  const missingPair = run([
    "run", "--artifact", packet, "--scope", "none",
    "--expected-packet-digest", "a".repeat(64), "--json",
  ], { cwd: repo, env: testEnv(repo) });
  assert.notEqual(missingPair.status, 0);
  assert.match(missingPair.stderr, /must be supplied together/);

  const invalidMaterials = run([
    "run", "--artifact", packet, "--scope", "none",
    "--expected-packet-digest", "a".repeat(64),
    "--expected-material-digests", '["not-a-digest"]', "--json",
  ], { cwd: repo, env: testEnv(repo) });
  assert.notEqual(invalidMaterials.status, 0);
  assert.match(invalidMaterials.stderr, /JSON array of SHA-256 digests/);
});

test("v4 requires every structural reviewer-result field without a test-mode bypass", () => {
  for (const field of [
    "review_status",
    "subject_reviewable",
    "substantive_merit_evaluated",
    "acknowledged_packet_digest",
    "acknowledged_material_digests",
    "limitations",
  ]) {
    const repo = makeGitRepo();
    const plan = join(repo, "plan.md");
    writeFileSync(plan, "Plan\n");
    const incomplete = approvedOutput();
    delete incomplete[field];
    const result = run(["run", "--artifact", plan, "--scope", "none", "--json"], {
      cwd: repo,
      env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(incomplete) },
    });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.result.decision, "blocked", field);
    assert.match(parsed.result.summary, new RegExp(`${field} is required`), field);
  }
});

test("gate blocks a grounded non-approved result even without blocking findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "initial\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
      decision: "changes_requested",
      summary: "A required action remains.",
      findings: [],
      required_next_actions: ["Complete the required action."],
    })),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"grounded-refusal"}' });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Complete the required action/);
  for (let i = 0; i < 2; i += 1) {
    const repeated = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"grounded-refusal"}' });
    assert.equal(JSON.parse(repeated.stdout).decision, "block", `repeat ${i + 2}`);
  }
  const capped = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"grounded-refusal"}' });
  const cappedParsed = JSON.parse(capped.stdout);
  assert.equal(cappedParsed.decision, undefined);
  assert.match(cappedParsed.systemMessage, /Cap-forced finalization/);
  assert.match(cappedParsed.systemMessage, /three-block convergence cap/);
  assert.match(cappedParsed.systemMessage, /Complete the required action/);
});

test("run explicit allow still prefers a healthy distinct-host fallback", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--on-reviewer-failure", "allow", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("test")),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback supplied coverage")),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.summary, "fallback supplied coverage");
  assert.equal(parsed.result.reviewer_mechanism, "codex-fallback-fake");
});

test("run rejects direct --block-on policy override", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--block-on", "medium", "--json"], {
    cwd: repo,
    env: testEnv(repo),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--block-on is only supported/);
});

test("run preserves reviewer invalid_input and blocked decisions without synthetic findings", () => {
  const repo = makeGitRepo();
  for (const decision of ["invalid_input", "blocked"]) {
    const reviewerOutput = decision === "invalid_input"
      ? notPerformedOutput({
        decision,
        summary: `${decision} from reviewer`,
        findings: [],
        required_next_actions: [],
      })
      : structurallyCompleteOutput({
        decision,
        summary: `${decision} from reviewer`,
        findings: [],
        required_next_actions: ["Fix the current subject and review again."],
      });
    const result = run(["run", "--scope", "none", "--json"], {
      cwd: repo,
      env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(reviewerOutput) },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.result.decision, decision);
    assert.deepEqual(parsed.result.blocking_findings, []);
    assert.deepEqual(parsed.result.required_next_actions, decision === "blocked" ? ["Fix the current subject and review again."] : []);
    assert.equal(parsed.result.acknowledged_packet_digest === null, decision === "invalid_input");
    assert.equal(parsed.review_execution.outcome, "decision");
  }
});

test("empty-target run reports invalid_input without invoking reviewer", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  runGit(["add", "bin/claude"], repo);
  runGit(["commit", "-m", "test env"], repo);
  // Explicit `run` with an empty target (clean tree, no --artifact/--context) is a
  // silent no-op if it "approves": it looks like a passed gate while nothing was
  // reviewed. It must report invalid_input with an actionable next step instead,
  // and still must not invoke the reviewer (REVIEW_LOOP_CLAUDE_BIN is /bin/false).
  const result = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_CLAUDE_BIN: "/bin/false" },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "invalid_input");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reviewer_mechanism.reason, "empty-target");
  assert.match(parsed.result.summary, /Nothing to review/);
  assert.deepEqual(parsed.result.required_next_actions, []);
  assert.match(parsed.result.observations.map((observation) => observation.message).join("\n"), /--artifact/);
  assert.ok(parsed.result.observations.every((observation) => observation.origin === "review_loop_diagnostic"));
});

test("gate allows finalization on an empty/clean target without invoking reviewer", () => {
  const repo = makeGitRepo();
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    // Both reviewer mechanisms point at /bin/false: an empty target must short
    // circuit to allow before any reviewer is invoked.
    REVIEW_LOOP_CLAUDE_BIN: "/bin/false",
    REVIEW_LOOP_CODEX_BIN: "/bin/false",
  };
  runGit(["add", "bin/claude"], repo);
  runGit(["commit", "-m", "test env"], repo);
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  // Clean tree -> empty target on the gate (gate=true) path. The historical
  // allow-on-clean-tree behavior must be preserved so finalization is not blocked.
  const result = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("oversized diffs are truncated in the review prompt", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "small\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), `${"x".repeat(80)}\n`.repeat(100));
  const stdinFile = join(repo, "stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-oversized-diff-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run(["run", "--scope", "auto"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude, REVIEW_LOOP_MAX_DIFF_CHARS: "500" },
  });
  assert.equal(result.status, 0, result.stderr);
  const prompt = readFileSync(stdinFile, "utf8");
  const marker = prompt.match(/\[unstaged diff truncated: \d+ characters omitted; the complete unstaged diff is saved at (\S+) /);
  assert.ok(marker, "expected truncation marker with overflow path");
  assert.ok(prompt.length < 8000, `prompt unexpectedly large: ${prompt.length}`);
  // The omitted tail stays recoverable: the overflow file holds the full diff.
  const overflow = readFileSync(marker[1], "utf8");
  assert.ok(overflow.length > 8000, `overflow file too small: ${overflow.length}`);
  assert.match(overflow, /^diff --git/);
});

test("hung claude invocation times out instead of hanging the review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const fakeClaude = join(repo, "bin", "claude-hang");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, "#!/usr/bin/env sh\nsleep 30\n", { mode: 0o755 });

  const result = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
      REVIEW_LOOP_CLAUDE_TIMEOUT_MS: "200",
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /timed out/);
});

test("unreadable untracked files do not crash the review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const locked = join(repo, "locked.txt");
  writeFileSync(locked, "secret\n", { mode: 0o000 });
  const stdinFile = join(repo, "stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-unreadable-file-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });

  const result = run(["run", "--scope", "auto"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(stdinFile, "utf8"), /locked\.txt\n\[unreadable; preview omitted\]/);
});

test("invalid structured severity fails closed", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const result = run(["run", "--scope", "auto", "--json"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      REVIEW_LOOP_HOST: "codex",
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "approved",
        summary: "bad severity",
        findings: [finding({ severity: "catastrophic" })],
        required_next_actions: [],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "blocked");
  assert.match(parsed.result.summary, /finding.severity must be one of/);
});

test("invalid branch base fails closed instead of approving empty review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const result = run(["run", "--scope", "branch", "--base", "missing-ref"], {
    cwd: repo,
    env: testEnv(repo),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /base ref is not a valid commit/);
});

test("enable-review-gate refuses misleading subagent-only gate", () => {
  const repo = makeGitRepo();
  const result = run(["setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_HOOK_EVENTS: "subagent_stop" },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const action = parsed.actions.find((item) => item.action === "enable-review-gate");
  assert.equal(action.status, "unsupported");
  assert.match(action.reason, /subagent_stop/);
});

test("enable-review-gate uses bundled Stop hook wiring", () => {
  const repo = makeGitRepo();
  const result = run(["setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: testEnv(repo),
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const action = parsed.actions.find((item) => item.action === "enable-review-gate");
  assert.equal(action.status, "enabled");
  assert.equal(action.event, "Stop");
});

test("enable-review-gate persists the automatic reviewer failure policy", () => {
  for (const [args, expected] of [
    [["setup", "--enable-review-gate", "--json"], "block"],
    [["setup", "--enable-review-gate", "--on-reviewer-failure", "allow", "--json"], "allow"],
  ]) {
    const repo = makeGitRepo();
    const result = run(args, { cwd: repo, env: testEnv(repo) });
    assert.equal(result.status, 0, result.stderr);
    const action = JSON.parse(result.stdout).actions.find((item) => item.action === "enable-review-gate");
    assert.equal(action.on_reviewer_failure, expected);
    assert.equal(JSON.parse(readFileSync(action.path, "utf8")).on_reviewer_failure, expected);
  }
});

test("gate fails closed on a corrupt persisted reviewer failure policy", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const configPath = JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-review-gate").path;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.on_reviewer_failure = "maybe";
  writeFileSync(configPath, JSON.stringify(config));

  const result = run(["gate", "--json"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("review should not run")) },
    input: '{}',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /configuration failure.*on_reviewer_failure must be block or allow/);
  assert.doesNotMatch(parsed.reason, /review should not run/);
});

test("gate re-reviews after a block instead of allowing on stop_hook_active", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "blocker", locations: ["file.txt:1"], message: "Blocking issue.", required_action: "Fix it." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const blocked = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const reentered = run(["gate", "--json"], { cwd: repo, env, input: '{"stop_hook_active":true}' });
  assert.equal(reentered.status, 0, reentered.stderr);
  assert.equal(JSON.parse(reentered.stdout).decision, "block");

  writeFileSync(join(repo, "file.txt"), "fixed content\n");
  const cleanEnv = { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) };
  const fixed = run(["gate", "--json"], { cwd: repo, env: cleanEnv, input: '{"stop_hook_active":true}' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(JSON.parse(fixed.stdout), {});
});

test("gate reuses the cached decision for an unchanged tree", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "cached", locations: ["file.txt:1"], message: "Cached issue.", required_action: "Fix." }),
    ])),
  };
  const first = run(["gate", "--json"], { cwd: repo, env: blockingEnv, input: '{"turn_id":"cache"}' });
  assert.equal(JSON.parse(first.stdout).decision, "block");

  // Same tree, reviewer would now approve — but the cached verdict is reused,
  // proving no second review ran for identical input.
  const approvingEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) };
  const cachedRun = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"cache"}' });
  assert.equal(JSON.parse(cachedRun.stdout).decision, "block");

  // A changed tree misses the cache and gets the fresh verdict.
  writeFileSync(join(repo, "file.txt"), "actually fixed\n");
  const fresh = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"cache"}' });
  assert.deepEqual(JSON.parse(fresh.stdout), {});
});

test("gate ignores a pre-integrity-version review cache entry", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "legacy-cache", locations: ["file.txt:1"], message: "Legacy cached issue.", required_action: "Fix." }),
    ])),
  };
  const first = run(["gate", "--json"], { cwd: repo, env: blockingEnv, input: '{"turn_id":"legacy-cache"}' });
  assert.equal(JSON.parse(first.stdout).decision, "block");

  const cacheDir = join(baseEnv.XDG_STATE_HOME, "review-loop", "review-cache");
  const cachePath = join(cacheDir, readdirSync(cacheDir)[0]);
  const legacy = JSON.parse(readFileSync(cachePath, "utf8"));
  delete legacy.integrity_version;
  writeFileSync(cachePath, JSON.stringify(legacy));

  const approvingEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fresh review")) };
  const rerun = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"legacy-cache"}' });
  assert.deepEqual(JSON.parse(rerun.stdout), {});
});

test("gate ignores a versioned cache entry with the placeholder summary", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "sentinel-cache", locations: ["file.txt:1"], message: "Cached issue.", required_action: "Fix." }),
    ])),
  };
  const first = run(["gate", "--json"], { cwd: repo, env: blockingEnv, input: '{"turn_id":"sentinel-cache"}' });
  assert.equal(JSON.parse(first.stdout).decision, "block");

  const cacheDir = join(baseEnv.XDG_STATE_HOME, "review-loop", "review-cache");
  const cachePath = join(cacheDir, readdirSync(cacheDir)[0]);
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  cached.result.summary = " TEST ";
  writeFileSync(cachePath, JSON.stringify(cached));

  const approvingEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fresh review")) };
  const rerun = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"sentinel-cache"}' });
  assert.deepEqual(JSON.parse(rerun.stdout), {});
});

test("gate cache misses on changes invisible to the rendered prompt", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  // Untracked file longer than the 200-line preview: edits past the preview
  // window do not change the rendered prompt, but must change cache identity.
  const longBody = Array.from({ length: 240 }, (_, i) => `line ${i}`);
  writeFileSync(join(repo, "long.txt"), longBody.join("\n"));
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "tail", locations: ["long.txt:230"], message: "Issue past the preview.", required_action: "Fix." }),
    ])),
  };
  const first = run(["gate", "--json"], { cwd: repo, env: blockingEnv, input: '{"turn_id":"tail"}' });
  assert.equal(JSON.parse(first.stdout).decision, "block");

  // The fix lands past the preview window; the verdict must be fresh, not
  // the cached block.
  // Same-length edit with the original timestamps restored: only the bytes
  // differ, so content hashing is the only thing that can catch it.
  const before = statSync(join(repo, "long.txt"));
  longBody[230] = "LINE 230";
  writeFileSync(join(repo, "long.txt"), longBody.join("\n"));
  utimesSync(join(repo, "long.txt"), before.atime, before.mtime);
  const approvingEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) };
  const fixed = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"tail"}' });
  assert.deepEqual(JSON.parse(fixed.stdout), {});
});

test("gate block output identifies the reviewed target", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "target", locations: ["file.txt:1"], message: "Targeted issue.", required_action: "Fix." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"target"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Reviewed target:/);
  assert.match(parsed.reason, /scope=working-tree/);
  assert.match(parsed.reason, /hash=[a-f0-9]{64}/);
  assert.match(parsed.reason, new RegExp(escapeRegExp(repo)));
});

test("gate state separates same-session counters by stable target class", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "initial\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  runGit(["branch", "base"], repo);
  writeFileSync(join(repo, "branch.txt"), "branch diff\n");
  runGit(["add", "branch.txt"], repo);
  runGit(["commit", "-m", "branch change"], repo);
  writeFileSync(join(repo, "file.txt"), "working tree diff\n");

  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);
  const branchEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "branch-target", locations: ["branch.txt:1"], message: "Branch issue.", required_action: "Fix branch." }),
    ])),
  };
  const worktreeEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "worktree-target", locations: ["file.txt:1"], message: "Worktree issue.", required_action: "Fix worktree." }),
    ])),
  };

  const branch = run(["gate", "--json", "--scope", "branch", "--base", "base"], { cwd: repo, env: branchEnv, input: '{"session_id":"same-session"}' });
  assert.equal(branch.status, 0, branch.stderr);
  assert.equal(JSON.parse(branch.stdout).decision, "block");
  const worktree = run(["gate", "--json"], { cwd: repo, env: worktreeEnv, input: '{"session_id":"same-session"}' });
  assert.equal(worktree.status, 0, worktree.stderr);
  assert.equal(JSON.parse(worktree.stdout).decision, "block");

  const stateDir = join(baseEnv.XDG_STATE_HOME, "review-loop", "gate-state");
  const [stateFile] = readdirSync(stateDir);
  const state = JSON.parse(readFileSync(join(stateDir, stateFile), "utf8"));
  const taskKeys = Object.keys(state.tasks);
  assert.equal(taskKeys.length, 2);
  assert.ok(taskKeys.some((key) => key.includes("scope=branch") && key.includes("base=base")));
  assert.ok(taskKeys.some((key) => key.includes("scope=working-tree") && key.includes("base=")));
});

test("gate allows immediately on recursion sentinels", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "blocker", locations: ["file.txt:1"], message: "Blocking issue.", required_action: "Fix it." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const cases = [
    { env, payload: '{"hook_active":true}' },
    { env, payload: '{"review_loop_active":true}' },
  ];
  for (const item of cases) {
    const result = run(["gate", "--json"], { cwd: repo, env: item.env, input: item.payload });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {}, item.payload);
  }
});

test("terminal reviewer mode blocks nested run and makes gate allow", () => {
  const repo = makeGitRepo();
  const env = { ...testEnv(repo), REVIEW_LOOP_TERMINAL_REVIEWER: "1" };
  const runResult = run(["run", "--scope", "none", "--json"], { cwd: repo, env });
  assert.notEqual(runResult.status, 0);
  assert.match(runResult.stderr, /terminal reviewer mode/);

  const gateResult = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"terminal"}' });
  assert.equal(gateResult.status, 0, gateResult.stderr);
  assert.deepEqual(JSON.parse(gateResult.stdout), {});
});

test("gate does not bypass on an unrecognized fallback token", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FALLBACK_TOKEN: "00000000-0000-4000-8000-000000000000",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "blocker", locations: ["file.txt:1"], message: "Blocking issue.", required_action: "Fix it." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
});

test("gate state does not persist dead infra failure counters", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "blocker", locations: ["file.txt:1"], message: "Blocking issue.", required_action: "Fix it." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"no-infra"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "block");
  const stateDir = join(env.XDG_STATE_HOME, "review-loop", "gate-state");
  const [stateFile] = readdirSync(stateDir);
  assert.ok(stateFile, "expected gate state file");
  const state = JSON.parse(readFileSync(join(stateDir, stateFile), "utf8"));
  const [taskKey] = Object.keys(state.tasks).filter((key) => key.startsWith("no-infra|"));
  assert.ok(taskKey, "expected scoped no-infra task key");
  assert.equal("infra_failures" in state.tasks[taskKey], false);
});

test("gate blocks review target preparation failures instead of using fallback", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback should not run",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json", "--scope", "branch", "--base", "missing-ref"], { cwd: repo, env, input: '{"turn_id":"prep-fail"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /could not prepare review/);
  assert.match(parsed.reason, /base ref is not a valid commit/);
  assert.doesNotMatch(parsed.reason, /fallback should not run/);
  const stateDir = join(env.XDG_STATE_HOME, "review-loop", "gate-state");
  const [stateFile] = readdirSync(stateDir);
  const state = JSON.parse(readFileSync(join(stateDir, stateFile), "utf8"));
  assert.deepEqual(Object.keys(state.tasks), ["prep-fail|scope=branch|base=missing-ref"]);
});

test("gate total block ceiling bounds churning finding sets", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const findingEnv = (id) => ({
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id, locations: ["file.txt:1"], message: `Issue ${id}.`, required_action: "Fix." }),
    ])),
  });
  // Each round modifies the tree so the cache misses and the churning
  // finding set actually reaches the gate.
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(repo, "file.txt"), `attempt ${i}\n`);
    const result = run(["gate", "--json"], { cwd: repo, env: findingEnv(`finding-${i}`), input: '{"turn_id":"churn"}' });
    assert.equal(JSON.parse(result.stdout).decision, "block", `block ${i}`);
  }
  writeFileSync(join(repo, "file.txt"), "attempt 5\n");
  const capped = run(["gate", "--json"], { cwd: repo, env: findingEnv("finding-5"), input: '{"turn_id":"churn"}' });
  const cappedParsed = JSON.parse(capped.stdout);
  assert.equal(cappedParsed.decision, undefined);
  assert.match(cappedParsed.systemMessage, /Cap-forced finalization/);
  assert.match(cappedParsed.systemMessage, /total block ceiling/);

  // A cap allow ends the stop chain and consumes the counters, so a later
  // unrelated task reusing the same coarse key is still gated.
  writeFileSync(join(repo, "file.txt"), "unrelated task\n");
  const nextTask = run(["gate", "--json"], { cwd: repo, env: findingEnv("unrelated"), input: '{"turn_id":"churn"}' });
  assert.equal(JSON.parse(nextTask.stdout).decision, "block");
});

test("gate default-key counters reset after the chain gap window", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_GATE_CHAIN_GAP_MS: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const findingEnv = (id) => ({
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id, locations: ["file.txt:1"], message: `Issue ${id}.`, required_action: "Fix." }),
    ])),
  });
  // Six unkeyed stops separated by more than the chain gap stay independent
  // tasks: each gets a fresh budget and blocks instead of hitting a ceiling.
  for (let i = 0; i < 6; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: findingEnv(`finding-${i}`), input: "{}" });
    assert.equal(JSON.parse(result.stdout).decision, "block", `block ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("gate uses degraded fallback review when Claude review is unavailable", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const brokenEnv = {
    ...baseEnv,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
    REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback ok")),
  };
  const result = run(["gate", "--json"], { cwd: repo, env: brokenEnv, input: '{"turn_id":"infra"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /Claude Code reviewer was unavailable/);
  assert.match(parsed.systemMessage, /degraded Codex fallback review/);
  assert.match(parsed.systemMessage, /reviewer output summary is required/);
});

test("gate uses fallback when Claude CLI is missing", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_CLAUDE_BIN: join(repo, "bin", "missing-claude"),
    REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback ok")),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"missing-claude"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /failed to start/);
  assert.match(parsed.systemMessage, /degraded Codex fallback review/);
});

test("gate fails closed when no distinct host fallback reviewer is available", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
    REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback should not run")),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"no-host-fallback"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /reviewer output summary is required/);
  assert.doesNotMatch(parsed.reason, /fallback should not run/);
});

test("Claude-hosted primary Codex gate failure uses degraded Claude fallback", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "claude",
    REVIEW_LOOP_FAKE_CODEX_ERROR: "primary codex unavailable",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"codex-primary-fail"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /Codex reviewer was unavailable/);
  assert.match(parsed.systemMessage, /degraded Claude Code fallback review/);
  assert.match(parsed.systemMessage, /primary codex unavailable/);
});

test("gate invokes Codex fallback with supported read-only argv", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const argvFile = join(repo, "codex-argv.json");
  const envFile = join(repo, "codex-env.json");
  const stdinFile = join(repo, "codex-stdin.txt");
  const fakeCodex = join(repo, "bin", "codex-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ fallbackToken: process.env.REVIEW_LOOP_FALLBACK_TOKEN || "" }));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify(reviewResponse(input, { decision: "approved", summary: "fallback ok", findings: [], required_next_actions: [] })));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fresh-codex-fallback-session" }) + "\\n");
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_CODEX_BIN: fakeCodex,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"codex-fallback"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /degraded Codex fallback review/);
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.equal(argv[0], "exec");
  assert.deepEqual(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.equal(argv.includes("--ask-for-approval"), false);
  assert.ok(argv.includes("--output-schema"));
  assert.ok(argv.includes("--output-last-message"));
  assert.match(JSON.parse(readFileSync(envFile, "utf8")).fallbackToken, /^[0-9a-f-]{36}$/i);
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /degraded fallback reviewer/);
  assert.match(prompt, /deleted, renamed, or moved externally reachable contracts/);
  assert.match(prompt, /retained identity or state is re-scoped or reset/);
  assert.match(prompt, /shared components preserve established behavioral defaults/);
  assert.match(prompt, /concrete correctness, compatibility, safety, or data-loss regression/);
  assert.match(prompt, /blocking at the evidence-supported severity/);
  assert.match(prompt, /required_next_actions contains only concrete remediation required on the current reviewed subject/i);
  assert.match(prompt, /later lifecycle work are not current-subject remediation/i);
  assert.match(prompt, /non-blocking notes in advisory observations/i);
  assert.match(prompt, /For an advisory finding, required_action is a recommendation/i);
});

test("gate invokes Claude fallback with terminal env and backend-specific prompt", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const envFile = join(repo, "claude-env.json");
  const stdinFile = join(repo, "claude-stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  terminalReviewer: process.env.REVIEW_LOOP_TERMINAL_REVIEWER || "",
  fallbackToken: process.env.REVIEW_LOOP_FALLBACK_TOKEN || ""
}));
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "claude fallback ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-claude-fallback-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "claude",
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
    REVIEW_LOOP_FAKE_CODEX_ERROR: "primary codex unavailable",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"claude-fallback"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /degraded Claude Code fallback review/);
  const envCapture = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(envCapture.terminalReviewer, "1");
  assert.match(envCapture.fallbackToken, /^[0-9a-f-]{36}$/i);
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /Claude Code acting as a degraded fallback reviewer/);
  assert.match(prompt, /primary Codex reviewer is unavailable/);
  assert.match(prompt, /deleted, renamed, or moved externally reachable contracts/);
  assert.match(prompt, /retained identity or state is re-scoped or reset/);
  assert.match(prompt, /shared components preserve established behavioral defaults/);
  assert.match(prompt, /concrete correctness, compatibility, safety, or data-loss regression/);
  assert.match(prompt, /blocking at the evidence-supported severity/);
  assert.match(prompt, /required_next_actions contains only concrete remediation required on the current reviewed subject/i);
  assert.match(prompt, /later lifecycle work are not current-subject remediation/i);
  assert.match(prompt, /non-blocking notes in advisory observations/i);
  assert.match(prompt, /For an advisory finding, required_action is a recommendation/i);
});

test("gate prunes expired fallback sentinels before creating a new one", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const fakeCodex = join(repo, "bin", "codex-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify(reviewResponse(input, { decision: "approved", summary: "fallback ok", findings: [], required_next_actions: [] })));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fresh-codex-fallback-session" }) + "\\n");
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_CODEX_BIN: fakeCodex,
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const repoStateHash = basename(JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-review-gate").artifact_root);
  const staleDir = join(env.XDG_STATE_HOME, "review-loop", "fallback-sentinels");
  mkdirSync(staleDir, { recursive: true });
  const stalePath = join(staleDir, `${repoStateHash}-00000000-0000-4000-8000-000000000000.json`);
  writeFileSync(stalePath, JSON.stringify({
    repo: repo,
    token: "00000000-0000-4000-8000-000000000000",
    created_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-01T00:10:00.000Z",
  }));

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"prune-sentinel"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, undefined);
  assert.equal(existsSync(stalePath), false);
  assert.deepEqual(readdirSync(staleDir), []);
});

test("gate blocks on degraded fallback review findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
    REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "fallback-blocker", locations: ["file.txt:1"], message: "Fallback found a blocker.", required_action: "Fix it." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"fallback-block"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Claude Code reviewer was unavailable/);
  assert.match(parsed.reason, /Fallback review changes_requested/);
  assert.match(parsed.reason, /Fallback found a blocker/);
});

test("gate blocks by default when Claude and fallback review are unavailable", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback failed with api_key=secret-value",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"fallback-fail"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Missing review coverage/);
  assert.match(parsed.reason, /api_key= REDACTED/);
  assert.doesNotMatch(parsed.reason, /secret-value/);
});

test("gate treats a persisted null reviewer failure policy as fail-closed default", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "", findings: [] }),
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const configPath = JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-review-gate").path;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.on_reviewer_failure = null;
  writeFileSync(configPath, JSON.stringify(config));

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"null-policy"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Missing review coverage/);
  assert.doesNotMatch(parsed.reason, /Allowing finalization/);
});

test("gate allows report-only with persisted allow when Codex and Claude fallback are unavailable", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "claude",
    REVIEW_LOOP_FAKE_CODEX_ERROR: "primary codex failed with api_key=primary-secret",
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback claude failed with api_key=fallback-secret",
  };
  const setup = run(["setup", "--enable-review-gate", "--on-reviewer-failure", "allow", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"claude-fallback-fail"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /Codex reviewer was unavailable/);
  assert.match(parsed.systemMessage, /degraded Claude Code fallback review also failed/);
  assert.match(parsed.systemMessage, /Allowing finalization without review coverage/);
  assert.match(parsed.systemMessage, /api_key= REDACTED/);
  assert.doesNotMatch(parsed.systemMessage, /primary-secret|fallback-secret/);
});

test("gate does not invoke fallback for real Claude findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "claude-blocker", locations: ["file.txt:1"], message: "Claude found a blocker.", required_action: "Fix it." }),
    ])),
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback should not run",
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"real-block"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /review-loop changes_requested/);
  assert.match(parsed.reason, /Claude found a blocker/);
  assert.doesNotMatch(parsed.reason, /fallback should not run/);
});

test("gate does not answer-shop when malformed primary output contains findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "changes_requested",
      summary: "test",
      findings: [finding({ id: "partial-primary", message: "Primary finding must remain terminal." })],
      required_next_actions: ["Fix the primary finding."],
    }),
    REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"partial-primary"}' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /recoverable substantive review content/);
  assert.doesNotMatch(JSON.stringify(parsed), /fallback must not run/);
});

test("gate uses persisted block_on and resets after clean review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--block-on", "medium", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const mediumFinding = blockingOutput([
    finding({ id: "m1", severity: "medium", locations: ["file.txt:1"], message: "Medium issue.", required_action: "Fix." }),
  ]);
  const mediumEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(mediumFinding) };
  for (let i = 0; i < 3; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
    assert.equal(JSON.parse(result.stdout).decision, "block");
  }
  const capped = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
  const cappedParsed = JSON.parse(capped.stdout);
  assert.match(cappedParsed.systemMessage, /Cap-forced finalization/);
  assert.match(cappedParsed.systemMessage, /three-block convergence cap/);
  assert.match(cappedParsed.systemMessage, /file\.txt:1: Medium issue/);
  assert.doesNotMatch(cappedParsed.systemMessage, /decision/);

  writeFileSync(join(repo, "file.txt"), "fixed for clean review\n");
  const cleanEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) };
  const clean = run(["gate", "--json"], { cwd: repo, env: cleanEnv, input: '{"turn_id":"t1"}' });
  assert.deepEqual(JSON.parse(clean.stdout), {});

  writeFileSync(join(repo, "file.txt"), "regressed again\n");
  const blocksAgain = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
  assert.equal(JSON.parse(blocksAgain.stdout).decision, "block");
});

test("guidelines policy drives category-aware blocking", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "high", "category_block_on": { "security": "low", "style": "never" } }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const decisionWith = (findings) => JSON.stringify(advisoryOutput(findings.map((item) => finding({
    id: item.id,
    severity: item.severity,
    category: item.category,
    locations: [item.location],
    message: item.summary,
    required_action: item.required_action,
  }))));

  // A low-severity security finding blocks because the category threshold is low.
  const securityEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "sec1", severity: "low", category: "security", location: "file.txt:1", summary: "Leaky.", required_action: "Fix." },
  ]) };
  const secBlock = run(["gate", "--json"], { cwd: repo, env: securityEnv, input: '{"turn_id":"sec"}' });
  assert.equal(JSON.parse(secBlock.stdout).decision, "block");
  assert.match(JSON.parse(secBlock.stdout).reason, /Leaky/);

  // An explicit category exemption overrides severity for advisory findings.
  writeFileSync(join(repo, "file.txt"), "style change\n");
  const styleEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
    decision: "approved",
    summary: "Style issue is explicitly exempt from blocking policy.",
    findings: [{
      ...finding({ id: "style1", severity: "high", category: "style", locations: ["file.txt:1"], message: "Ugly.", required_action: "Prettify." }),
      reviewer_disposition: "advisory",
    }],
    required_next_actions: [],
  })) };
  const styleAllow = run(["gate", "--json"], { cwd: repo, env: styleEnv, input: '{"turn_id":"style"}' });
  assert.deepEqual(JSON.parse(styleAllow.stdout), {});

  // Category exemptions classify findings but cannot rewrite an explicit
  // non-approved reviewer decision into approval.
  writeFileSync(join(repo, "file.txt"), "style changes requested\n");
  const styleRefusalEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(structurallyCompleteOutput({
    decision: "changes_requested",
    summary: "The reviewer explicitly requested a style correction.",
    findings: [{
      ...finding({ id: "style2", severity: "high", category: "style", locations: ["file.txt:1"], message: "Still ugly.", required_action: "Prettify." }),
      reviewer_disposition: "blocking",
    }],
    required_next_actions: [],
  })) };
  const styleRefusal = run(["gate", "--json"], { cwd: repo, env: styleRefusalEnv, input: '{"turn_id":"style-refusal"}' });
  assert.equal(JSON.parse(styleRefusal.stdout).decision, "block");
  assert.match(JSON.parse(styleRefusal.stdout).reason, /Still ugly/);

  // Categories absent from the policy map use the base threshold.
  writeFileSync(join(repo, "file.txt"), "medium change\n");
  const mediumEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "m1", severity: "medium", category: "maintainability", location: "file.txt:1", summary: "Meh.", required_action: "Fix." },
  ]) };
  const mediumAllow = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"med"}' });
  assert.deepEqual(JSON.parse(mediumAllow.stdout), {});
});

test("old cc-review policy fence is not honored after rename", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "high", "category_block_on": { "security": "low" } }
\`\`\`
`);
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(advisoryOutput([
      finding({ id: "sec1", severity: "low", category: "security", locations: ["file.txt:1"], message: "Leaky.", required_action: "Fix." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const allowed = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"old-fence"}' });
  assert.deepEqual(JSON.parse(allowed.stdout), {});
});

test("explicit setup block_on overrides the guidelines policy", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "high" }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--block-on", "low", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const lowEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
    ...advisoryOutput([
      finding({ id: "l1", severity: "low", locations: ["file.txt:1"], message: "Small.", required_action: "Fix." }),
    ]),
  }) };
  const blocked = run(["gate", "--json"], { cwd: repo, env: lowEnv, input: '{"turn_id":"o"}' });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
});

test("category overrides apply on top of an explicit block_on base", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "low", "category_block_on": { "security": "medium" } }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1" };
  // Explicit high base overrides the policy's low base...
  const setup = run(["setup", "--enable-review-gate", "--block-on", "high", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const mediumSecurityEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
    ...advisoryOutput([
      finding({ id: "sec", severity: "medium", category: "security", locations: ["file.txt:1"], message: "Leaky.", required_action: "Fix." }),
      finding({ id: "plain", severity: "medium", category: "maintainability", locations: ["file.txt:2"], message: "Meh.", required_action: "Fix." }),
    ]),
  }) };
  // ...but the category override still blocks the medium security finding,
  // while the uncategorized medium finding is held to the explicit high base.
  const blocked = run(["gate", "--json"], { cwd: repo, env: mediumSecurityEnv, input: '{"turn_id":"mix"}' });
  const parsed = JSON.parse(blocked.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Leaky/);
  assert.doesNotMatch(parsed.reason, /Meh/);
});

test("guidelines policy fence parses with CRLF line endings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"),
    '# Rules\r\n\r\n```json review-loop\r\n{ "block_on": "medium" }\r\n```\r\n');
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(advisoryOutput([
      finding({ id: "m", severity: "medium", locations: ["file.txt:1"], message: "Medium issue.", required_action: "Fix." }),
    ])),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const blocked = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"crlf"}' });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
});

test("malformed guidelines policy fails closed at the gate", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), `# Rules

\`\`\`json review-loop
{ "block_on": "catastrophic" }
\`\`\`
`);
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"bad"}' });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /guidelines block_on/);
});

test("gate debug mode logs hook payloads to the state dir", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()),
  };
  const setup = run(["setup", "--enable-review-gate", "--enable-gate-debug", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const debugAction = JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-gate-debug");
  assert.equal(debugAction.status, "enabled");

  const result = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"debug-payload","custom_field":42}' });
  assert.equal(result.status, 0, result.stderr);
  const logged = readFileSync(debugAction.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].payload.turn_id, "debug-payload");
  assert.equal(logged[0].payload.custom_field, 42);
});

test("gate defaults enabled without per-repo config", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const result = run(["gate", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "h1", locations: ["x"], message: "x", required_action: "x" }),
    ])) },
    input: "{}",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /review-loop changes_requested/);
});

test("disable-review-gate persists an explicit off marker", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
    finding({ id: "h1", locations: ["x"], message: "x", required_action: "x" }),
  ])) };
  const setup = run(["setup", "--disable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const action = JSON.parse(setup.stdout).actions.find((item) => item.action === "disable-review-gate");
  assert.equal(action.status, "disabled");
  assert.equal(JSON.parse(readFileSync(action.path, "utf8")).enabled, false);

  const result = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});

  const debugSetup = run(["setup", "--enable-gate-debug", "--json"], { cwd: repo, env });
  assert.equal(debugSetup.status, 0, debugSetup.stderr);
  const updatedConfig = JSON.parse(readFileSync(action.path, "utf8"));
  assert.equal(updatedConfig.enabled, false);
  assert.equal(updatedConfig.debug, true);

  const debugResult = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(debugResult.status, 0, debugResult.stderr);
  assert.deepEqual(JSON.parse(debugResult.stdout), {});
});

test("gate treats config without enabled as enabled", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
    finding({ id: "h1", locations: ["x"], message: "x", required_action: "x" }),
  ])) };
  const setup = run(["setup", "--enable-gate-debug", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const action = JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-gate-debug");
  assert.ok(action.log.endsWith(".jsonl"));
  const gatesDir = join(env.XDG_STATE_HOME, "review-loop", "gates");
  const configFiles = readdirSync(gatesDir).filter((file) => file.endsWith(".json"));
  assert.equal(configFiles.length, 1);
  const config = JSON.parse(readFileSync(join(gatesDir, configFiles[0]), "utf8"));
  assert.equal(config.debug, true);
  assert.equal(config.enabled, undefined);

  const result = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /review-loop changes_requested/);
});

test("gate allow paths never emit invalid approve decision", () => {
  const source = readFileSync(new URL("../plugins/review-loop/scripts/review-loop-companion.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision:\s*["']approve["']/);
});

test("gate infrastructure errors block by default when fallback also fails", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = { ...testEnv(repo), REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK: "1", REVIEW_LOOP_HOST: "codex" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const result = run(["gate", "--json"], {
    cwd: repo,
    env: {
      ...env,
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "approved",
        summary: "",
        findings: [],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
    },
    input: "{}",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Missing review coverage/);
  assert.match(parsed.reason, /reviewer output summary is required/);
  assert.match(parsed.reason, /fallback unavailable/);
});

test("background review job can be started, listed, and read", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("ok")),
  };

  const started = run(["run", "--scope", "auto", "--background", "--json"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  assert.equal(job.state, "running");

  await waitFor(() => {
    const status = run(["status", "--json"], { cwd: repo, env });
    const jobs = JSON.parse(status.stdout).jobs;
    return jobs.some((item) => item.id === job.id && item.state === "completed");
  });

  const result = run(["result", job.id, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.state, "completed");
  assert.equal(typeof completed.pid, "number");
});

test("run background jobs return normalized results with sanitized metadata", async () => {
  const repo = makeGitRepo();
  const context = join(repo, "context.md");
  writeFileSync(context, "Problem: background review\n");
  const stdinFile = join(repo, "background-stdin.txt");
  const envFile = join(repo, "background-env.json");
  const fakeClaude = join(repo, "bin", "claude-background-capture");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ backgroundArgs: process.env.REVIEW_LOOP_BACKGROUND_ARGS || "" }));
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "reviewer raw text", session_id: "fresh-background-review-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
  };

  const started = run(["run", "--context", context, "--focus", "api_key=secret-value", "--background", "--json"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  assert.equal(job.state, "running");
  assert.equal(job.args.focus, "[redacted]");
  assert.doesNotMatch(started.stdout, /secret-value/);

  await waitFor(() => {
    const status = run(["status", job.id, "--json"], { cwd: repo, env });
    assert.doesNotMatch(status.stdout, /secret-value/);
    return JSON.parse(status.stdout).jobs[0]?.state === "completed";
  });

  const result = run(["result", job.id, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /secret-value/);
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.result.result.schema_version, "5");
  assert.equal(completed.result.result.decision, "approved");
  assert.equal(completed.result.raw, "[redacted]");
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /Focus: api_key=secret-value/);
  assert.doesNotMatch(prompt, /Focus: \[redacted\]/);
  assert.equal(JSON.parse(readFileSync(envFile, "utf8")).backgroundArgs, "");
});

test("background review rejects a placeholder assessment as mechanism failure", async () => {
  const repo = makeGitRepo();
  const context = join(repo, "context.md");
  writeFileSync(context, "Problem: background placeholder review\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_HOST: "codex",
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("test")),
    REVIEW_LOOP_FAKE_FALLBACK_ERROR: "fallback unavailable",
  };

  const started = run(["run", "--context", context, "--background", "--json"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  await waitFor(() => {
    const status = run(["status", job.id, "--json"], { cwd: repo, env });
    return JSON.parse(status.stdout).jobs[0]?.state === "completed";
  });

  const result = run(["result", job.id, "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.result.result.decision, "blocked");
  assert.match(completed.result.result.summary, /reviewer_output_integrity: placeholder_summary/);
});

test("cancel of a completed job preserves the result", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()),
  };
  const started = run(["run", "--scope", "auto", "--background", "--json"], { cwd: repo, env });
  const job = JSON.parse(started.stdout);
  await waitFor(() => {
    const status = run(["status", job.id, "--json"], { cwd: repo, env });
    return JSON.parse(status.stdout).jobs[0]?.state === "completed";
  });
  const cancelled = run(["cancel", job.id, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).state, "completed");
  const result = run(["result", job.id, "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(result.stdout).result.result.decision, "approved");
});

test("graceful cancel does not report kill escalation", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const fakeClaude = join(repo, "bin", "claude-sleep");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "2.1.167 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo "ok"; exit 0; fi
sleep 10
`, { mode: 0o755 });
  const env = { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude, REVIEW_LOOP_CANCEL_GRACE_MS: "300" };
  const started = run(["run", "--scope", "auto", "--background", "--json"], { cwd: repo, env });
  const job = JSON.parse(started.stdout);
  await waitFor(() => {
    const status = run(["status", job.id, "--json"], { cwd: repo, env });
    return JSON.parse(status.stdout).jobs[0]?.state === "running";
  });
  const cancelled = run(["cancel", job.id, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const parsed = JSON.parse(cancelled.stdout);
  assert.equal(parsed.state, "cancelled");
  assert.equal(parsed.kill_escalated, undefined);
});

test("cancel escalates when a background review ignores SIGTERM", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const fakeClaude = join(repo, "bin", "claude-sleep");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "2.1.167 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo "ok"; exit 0; fi
trap '' TERM
: > started.marker
while :; do sleep 1; done
`, { mode: 0o755 });
  const env = { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: fakeClaude, REVIEW_LOOP_CANCEL_GRACE_MS: "50" };
  const started = run(["run", "--scope", "auto", "--background", "--json"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
  await waitFor(() => existsSync(join(repo, "started.marker")));
  const cancelled = run(["cancel", job.id, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).state, "cancelled");
  assert.equal(JSON.parse(cancelled.stdout).kill_escalated, true);
});

test("bundled guidelines render customization hint", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const result = run(["run", "--scope", "auto"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Using bundled review guidelines/);
});

test("skills use skill-root companion path and unquoted arguments", () => {
  const skillRoot = new URL("../plugins/review-loop/skills", import.meta.url).pathname;
  for (const skill of readdirSync(skillRoot)) {
    const content = readFileSync(join(skillRoot, skill, "SKILL.md"), "utf8");
    assert.match(content, /REVIEW_LOOP_HOST=codex node "<skill-root>\/\.\.\/\.\.\/scripts\/review-loop-companion\.mjs/);
    assert.doesNotMatch(content, /"\$ARGUMENTS"|\$\(pwd\)|REVIEW_LOOP_PLUGIN_ROOT|<skill dir>/);
  }
});

test("skill shell invocation preserves flags in ARGUMENTS", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);

  const skillRoot = new URL("../plugins/review-loop/skills/review-loop", import.meta.url).pathname;
  const content = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const command = content.match(/REVIEW_LOOP_HOST=codex node "<skill-root>\/\.\.\/\.\.\/scripts\/review-loop-companion\.mjs" run --scope auto \$ARGUMENTS/)?.[0];
  assert.ok(command);
  const expanded = command.replace("<skill-root>", skillRoot);
  const result = spawnSync("sh", ["-c", expanded], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      ARGUMENTS: "--scope branch --base HEAD --json",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const scopeInput = parsed.result.reviewed_inputs.find((input) => input.kind === "scope");
  assert.equal(scopeInput.scope, "branch");
  assert.equal(scopeInput.base, "HEAD");
});

test("bin wrappers dispatch to their subcommand", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const setupBin = new URL("../plugins/review-loop/scripts/bin/review-loop-setup.mjs", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [setupBin, "--json"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.checks.node.ok);

  const reviewBin = new URL("../plugins/review-loop/scripts/bin/review-loop.mjs", import.meta.url).pathname;
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const review = spawnSync(process.execPath, [reviewBin, "--json"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) },
    encoding: "utf8",
  });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).result.decision, "approved");

  const context = join(repo, "context.md");
  writeFileSync(context, "Problem: wrapper run passthrough\n");
  const explicitRun = spawnSync(process.execPath, [reviewBin, "run", "--context", context, "--json"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput()) },
    encoding: "utf8",
  });
  assert.equal(explicitRun.status, 0, explicitRun.stderr);
  assert.equal(JSON.parse(explicitRun.stdout).result.reviewed_inputs.find((input) => input.kind === "scope").scope, "none");

  const stdinFile = join(repo, "counter-stdin.txt");
  const fakeClaude = join(repo, "bin", "claude-counter-capture");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(stdinFile)}, input);
  console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-counter-review-session" }));
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const counter = spawnSync(process.execPath, [reviewBin, "run", "--scope", "auto", "--counter", "--json", "challenge", "this"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_CLAUDE_BIN: fakeClaude },
    encoding: "utf8",
  });
  assert.equal(counter.status, 0, counter.stderr);
  assert.equal(JSON.parse(counter.stdout).result.decision, "approved");
  const prompt = readFileSync(stdinFile, "utf8");
  assert.match(prompt, /Review stance: counter/);
  assert.match(prompt, /Focus: challenge this/);
});

test("review-loop --help prints run usage instead of running review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const reviewBin = new URL("../plugins/review-loop/scripts/bin/review-loop.mjs", import.meta.url).pathname;
  // A fake claude that fails loudly, so a real review attempt would be visible.
  const env = { ...testEnv(repo), REVIEW_LOOP_CLAUDE_BIN: "/bin/false" };
  const result = spawnSync(process.execPath, [reviewBin, "--help"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: review-loop-companion run/);
  assert.doesNotMatch(result.stdout, /Decision:/);
});

test("package bin map covers the documented commands", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["review-loop", "review-loop-setup", "review-loop-status", "review-loop-result", "review-loop-cancel", "review-loop-companion"]) {
    assert.ok(pkg.bin[name], `missing bin: ${name}`);
    assert.ok(existsSync(new URL(`../${pkg.bin[name]}`, import.meta.url)), `bin target missing: ${pkg.bin[name]}`);
  }
  for (const removedName of ["cc-review", "cc-review-setup", "cc-review-status", "cc-review-result", "cc-review-cancel", "cc-adversarial-review"]) {
    assert.equal(pkg.bin[removedName], undefined, `removed bin still present: ${removedName}`);
  }
});

test("manifest wires Codex Stop hook", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugins/review-loop/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
  const hooks = JSON.parse(readFileSync(new URL("../plugins/review-loop/hooks/codex-hooks.json", import.meta.url), "utf8"));
  assert.equal(hooks.hooks.Stop[0].name, "review-loop finalization gate");
  assert.match(hooks.hooks.Stop[0].description, /review-loop stop hook/);
  const commandHook = hooks.hooks.Stop[0].hooks[0];
  assert.equal(commandHook.name, "review-loop finalization gate");
  assert.match(commandHook.description, /review-loop stop hook/);
  assert.match(commandHook.command, /REVIEW_LOOP_HOST=codex/);
  assert.match(commandHook.command, /\$\{PLUGIN_ROOT\}\/scripts\/stop-review-gate-hook\.mjs/);
});

test("Claude plugin surface routes commands and Stop hook through shared runtime", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const marketplace = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(marketplace.plugins[0].source, "./plugins/review-loop");
  const manifest = JSON.parse(readFileSync(new URL("../plugins/review-loop/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "review-loop");
  const codexManifest = JSON.parse(readFileSync(new URL("../plugins/review-loop/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(codexManifest.version, pkg.version);
  assert.equal(marketplace.metadata.version, pkg.version);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  const hooks = JSON.parse(readFileSync(new URL("../plugins/review-loop/hooks/hooks.json", import.meta.url), "utf8"));
  const commandHook = hooks.hooks.Stop[0].hooks[0];
  assert.doesNotMatch(commandHook.command, /REVIEW_LOOP_HOST=claude/);
  assert.match(commandHook.command, /^node /);
  assert.match(commandHook.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/stop-review-gate-hook\.mjs/);
  for (const command of ["run", "setup", "status", "result", "cancel"]) {
    const content = readFileSync(new URL(`../plugins/review-loop/commands/${command}.md`, import.meta.url), "utf8");
    assert.doesNotMatch(content, /REVIEW_LOOP_HOST=claude/);
    assert.match(content, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/review-loop-companion\.mjs/);
  }
});

function run(args, { cwd, env, input } = {}) {
  return spawnSync(process.execPath, [companion, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8",
  });
}

function makeCodexCapture(workspace, label) {
  const captureDir = join(workspace, ".capture", label);
  mkdirSync(captureDir, { recursive: true });
  const argvFile = join(captureDir, "argv.json");
  const cwdFile = join(captureDir, "cwd.txt");
  const bin = join(captureDir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify(reviewResponse(input, { decision: "approved", summary: "codex captured", findings: [], required_next_actions: [] })));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fresh-codex-capture-session" }) + "\\n");
});
${fakeReviewResponseSource}
`, { mode: 0o755 });
  return { argvFile, cwdFile, bin };
}

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "review-loop-test-"));
  runGit(["init"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test User"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  return dir;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function testEnv(repo) {
  const bin = join(repo, "bin");
  mkdirSync(bin, { recursive: true });
  // Isolate HOME so a developer's real review-loop/Claude guidelines
  // cannot leak into guideline resolution during tests.
  mkdirSync(join(repo, ".home"), { recursive: true });
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.1.167 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth" && process.argv[4] === "--json") { console.log('{"loggedIn":true}'); process.exit(0); }
if (process.argv[2] === "auth") { console.log("Login method: test"); process.exit(0); }
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => console.log(JSON.stringify({ structured_output: reviewResponse(input, { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }), result: "ok", session_id: "fresh-test-claude-session" })));
${fakeReviewResponseSource}
`, { mode: 0o755 });
  const fakeCodex = join(mkdtempSync(join(tmpdir(), "review-loop-codex-")), "codex");
  writeFileSync(fakeCodex, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenAI Codex vtest'; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo 'Logged in'; exit 0; fi\nexit 1\n", { mode: 0o755 });
  // State must live outside the worktree (as it does in production): the
  // gate's own state files are otherwise untracked files in the next review
  // target, perturbing it between runs.
  return {
    ...process.env,
    NODE_ENV: "test",
    HOME: join(repo, ".home"),
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
    REVIEW_LOOP_CODEX_BIN: fakeCodex,
    REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID: "fresh-primary-claude-session",
    REVIEW_LOOP_FAKE_CODEX_SESSION_ID: "fresh-primary-codex-session",
    REVIEW_LOOP_FAKE_FALLBACK_SESSION_ID: "fresh-fallback-session",
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "review-loop-state-")),
  };
}

function approvedOutput(summary = "ok") {
  return structurallyCompleteOutput({ decision: "approved", summary, findings: [], required_next_actions: [] });
}

function blockingOutput(findings, summary = "blocking findings") {
  return structurallyCompleteOutput({ decision: "changes_requested", summary, findings: findings.map((item) => ({ ...item, reviewer_disposition: "blocking" })), required_next_actions: [] });
}

function advisoryOutput(findings, summary = "advisory findings") {
  return structurallyCompleteOutput({ decision: "approved", summary, findings: findings.map((item) => ({ ...item, reviewer_disposition: "advisory" })), required_next_actions: [] });
}

function structurallyCompleteOutput(output) {
  return {
    review_status: "performed",
    subject_reviewable: true,
    substantive_merit_evaluated: true,
    acknowledged_packet_digest: "__REVIEW_LOOP_PACKET_DIGEST__",
    acknowledged_material_digests: ["__REVIEW_LOOP_MATERIAL_DIGESTS__"],
    limitations: [],
    findings: [],
    observations: [],
    required_next_actions: [],
    ...output,
  };
}

function notPerformedOutput(output) {
  return {
    review_status: "not_performed",
    subject_reviewable: false,
    substantive_merit_evaluated: false,
    acknowledged_packet_digest: null,
    acknowledged_material_digests: [],
    limitations: ["The review was not performed."],
    observations: [],
    ...output,
  };
}

const fakeReviewResponseSource = String.raw`
function reviewResponse(input, output) {
  const packetDigest = input.match(/^packet_digest: ([a-f0-9]{64})$/m)?.[1] || null;
  const materialDigests = JSON.parse(input.match(/^material_digests: (\[[^\n]*\])$/m)?.[1] || "[]");
  return {
    review_status: "performed",
    subject_reviewable: true,
    substantive_merit_evaluated: true,
    acknowledged_packet_digest: packetDigest,
    acknowledged_material_digests: materialDigests,
    limitations: [],
    observations: [],
    ...output,
  };
}
`;

function finding(overrides = {}) {
  return {
    id: "finding",
    severity: "high",
    category: "correctness",
    message: "Blocking issue.",
    locations: ["file.txt:1"],
    required_action: "Fix it.",
    ...overrides,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
