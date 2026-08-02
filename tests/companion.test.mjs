import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const companion = new URL("../plugins/review-loop/scripts/review-loop-companion.mjs", import.meta.url).pathname;

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

test("setup reports legacy tier configuration as migration required without mutating it", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const configPath = writeTierConfig(repo, {
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "low" },
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  env.REVIEW_LOOP_TIER_CONFIG = configPath;
  const before = readFileSync(configPath, "utf8");

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.catalog.status, "migration_required");
  assert.equal(parsed.catalog.schema_version, "review-loop.reviewer-tier-config.v1");
  assert.equal(parsed.catalog.path, configPath);
  assert.match(parsed.catalog.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.catalog.reason_codes, ["legacy_schema"]);
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("setup reports a missing catalog as usable degraded state but never ready", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.operational_status, "degraded");
  assert.equal(parsed.catalog.status, "degraded");
  assert.deepEqual(parsed.catalog.reason_codes, ["catalog_missing"]);
  assert.equal(parsed.providers.status, "healthy");
});

test("setup and capabilities expose an unambiguous strict-readiness contract", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    strong: {
      profiles: completeDualProviderTiers().strong.profiles,
    },
  }, "incomplete-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");

  const incompleteSetup = JSON.parse(run(["setup", "--json"], { cwd: repo, env }).stdout);
  const incompleteCapabilities = JSON.parse(run(["capabilities", "--json"], { cwd: repo, env }).stdout);
  assert.equal(incompleteSetup.ok, true);
  assert.equal(incompleteSetup.operational_status, "degraded");
  assert.equal(incompleteSetup.catalog.status, "degraded");
  assert.deepEqual(incompleteSetup.catalog.reason_codes, ["tier_missing:fast", "tier_missing:standard"]);
  assert.equal(incompleteCapabilities.tier_configuration.status, "configured");
  assert.equal(incompleteCapabilities.tiers.fast.configured, false);
  assert.equal(incompleteCapabilities.tiers.standard.configured, false);
  assert.equal(incompleteCapabilities.tiers.strong.alternate_profiles_configured, true);

  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, completeDualProviderTiers(), "complete-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  const readySetup = JSON.parse(run(["setup", "--json"], { cwd: repo, env }).stdout);
  const readyCapabilities = JSON.parse(run(["capabilities", "--json"], { cwd: repo, env }).stdout);
  assert.equal(readySetup.ok, true);
  assert.equal(readySetup.operational_status, "ready");
  assert.equal(readySetup.catalog.status, "ready");
  assert.deepEqual(readySetup.catalog.reason_codes, []);
  assert.equal(readySetup.providers.codex.status, "healthy");
  assert.equal(readySetup.providers.claude.status, "healthy");
  assert.equal(readyCapabilities.tier_configuration.schema_version, "review-loop.reviewer-tier-config.v2");
  for (const tier of ["fast", "standard", "strong"]) {
    assert.equal(readyCapabilities.tiers[tier].configured, true);
    assert.equal(readyCapabilities.tiers[tier].profiles.length, 2);
    assert.equal(readyCapabilities.tiers[tier].alternate_profiles_configured, true);
  }
});

test("setup previews an operator-supplied v2 catalog without mutating active configuration", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");

  const result = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const action = parsed.actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "preview");
  assert.equal(action.change, "update");
  assert.equal(action.target_path, activePath);
  assert.match(action.current_digest, /^[a-f0-9]{64}$/);
  assert.match(action.desired_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(action.current_digest, action.desired_digest);
  assert.equal(parsed.catalog.status, "migration_required");
  assert.equal(readFileSync(activePath, "utf8"), before);
  assert.equal(existsSync(`${activePath}.backup-${action.current_digest.slice(0, 12)}`), false);
});

test("setup apply rejects a stale catalog digest before writing or backing up", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");

  const result = run([
    "setup",
    "--desired-tier-config", desiredPath,
    "--apply-tier-config",
    "--expected-tier-config-digest", "0".repeat(64),
    "--json",
  ], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale reviewer tier configuration/i);
  assert.equal(readFileSync(activePath, "utf8"), before);
  assert.deepEqual(readdirSync(join(repo, ".home")).filter((name) => name.includes(".backup-")), []);
});

test("setup serializes explicit catalog apply before digest comparison", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  writeFileSync(`${activePath}.reconcile.lock`, JSON.stringify({ pid: process.pid, created_at: "2026-08-02T07:00:00.000Z" }));

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, new RegExp(`reconciliation is already locked \\(owner_pid=${process.pid} created_at=2026-08-02T07:00:00.000Z\\)`));
  assert.equal(readFileSync(activePath, "utf8"), before);
  assert.equal(existsSync(`${activePath}.backup-${expectedDigest.slice(0, 12)}`), false);
});

test("setup recovers an orphaned catalog apply lock and preserves its evidence", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  writeFileSync(`${activePath}.reconcile.lock`, JSON.stringify({ pid: 2147483647, created_at: "2026-08-01T00:00:00.000Z" }));

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).actions.find((item) => item.action === "reconcile-tier-config").status, "applied");
  assert.equal(existsSync(`${activePath}.reconcile.lock`), false);
  assert.equal(readdirSync(dirname(activePath)).filter((name) => name.includes(".reconcile.lock.orphaned-2147483647-")).length, 1);
});

test("setup recovers the crash window after atomic replacement and before readback", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const priorBytes = readFileSync(activePath, "utf8");
  const desiredBytes = readFileSync(desiredPath, "utf8");
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const action = preview.actions.find((item) => item.action === "reconcile-tier-config");
  const backupPath = `${activePath}.backup-${action.current_digest.slice(0, 12)}`;

  // Simulate a process death after the atomic candidate rename and backup, but
  // before catalog/provider readback and lock cleanup.
  writeFileSync(backupPath, priorBytes);
  writeFileSync(activePath, desiredBytes);
  writeFileSync(`${activePath}.reconcile.lock`, JSON.stringify({ pid: 2147483647, created_at: "2026-08-01T00:00:00.000Z" }));

  const inspected = run(["setup", "--json"], { cwd: repo, env });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).operational_status, "ready");
  assert.equal(readFileSync(activePath, "utf8"), desiredBytes);
  assert.equal(readFileSync(backupPath, "utf8"), priorBytes);

  const recovered = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", action.desired_digest, "--json",
  ], { cwd: repo, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).actions.find((item) => item.action === "reconcile-tier-config").status, "verified_noop");
  assert.equal(readFileSync(backupPath, "utf8"), priorBytes);
  assert.equal(readdirSync(dirname(activePath)).filter((name) => name.includes(".reconcile.lock.orphaned-2147483647-")).length, 1);
});

test("setup rejects a corrupt apply lock with recovery guidance and no mutation", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const beforeFiles = readdirSync(dirname(activePath)).sort();
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  writeFileSync(`${activePath}.reconcile.lock`, "not-json\n");

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.notEqual(applied.status, 0);
  assert.match(applied.stderr, /owner_pid=unknown created_at=unknown/);
  assert.match(applied.stderr, /inspect and remove or archive this lock/);
  assert.equal(readFileSync(activePath, "utf8"), before);
  assert.deepEqual(readdirSync(dirname(activePath)).sort(), [...beforeFiles, `${basename(activePath)}.reconcile.lock`].sort());
});

test("setup applies v2 catalog with backup atomic write and capability readback", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const preview = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  const expectedDigest = JSON.parse(preview.stdout).actions.find((item) => item.action === "reconcile-tier-config").current_digest;

  const applied = run([
    "setup",
    "--desired-tier-config", desiredPath,
    "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest,
    "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  const parsed = JSON.parse(applied.stdout);
  const action = parsed.actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "applied");
  assert.equal(action.change, "update");
  assert.equal(action.backup_path, `${activePath}.backup-${expectedDigest.slice(0, 12)}`);
  assert.equal(readFileSync(action.backup_path, "utf8"), before);
  assert.match(action.capability_readback_digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.catalog.status, "ready");
  assert.equal(parsed.catalog.digest, action.desired_digest);
  assert.deepEqual(JSON.parse(readFileSync(activePath, "utf8")), JSON.parse(readFileSync(desiredPath, "utf8")));

  const capabilities = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const capabilityPayload = JSON.parse(capabilities.stdout);
  assert.equal(capabilityPayload.tier_configuration.digest, action.desired_digest);
  assert.deepEqual(capabilityPayload.tiers.fast.profiles.map((profile) => profile.release_identity.provider), ["openai", "anthropic"]);
  assert.deepEqual(capabilityPayload.tiers.standard.profiles.map((profile) => profile.release_identity.provider), ["openai", "anthropic"]);
  assert.deepEqual(capabilityPayload.tiers.strong.profiles.map((profile) => profile.release_identity.provider), ["anthropic", "openai"]);
});

test("setup applies a valid catalog while provider capability readback is unavailable", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const healthyCodex = env.REVIEW_LOOP_CODEX_BIN;
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const preview = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  const expectedDigest = JSON.parse(preview.stdout).actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  env.REVIEW_LOOP_CODEX_BIN = join(repo, "missing-codex");

  const applied = run([
    "setup",
    "--desired-tier-config", desiredPath,
    "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest,
    "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  const failedPayload = JSON.parse(applied.stdout);
  const failedAction = failedPayload.actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(failedPayload.ok, true);
  assert.equal(failedAction.status, "applied_degraded");
  assert.equal(failedAction.reason_code, "provider_capability_unavailable");
  assert.match(failedAction.error, /codex reviewer CLI version probe failed/i);
  assert.equal(failedAction.capability_readback_status, "unavailable");
  assert.equal(failedAction.catalog_readback_digest, failedAction.desired_digest);
  assert.deepEqual(JSON.parse(readFileSync(activePath, "utf8")), JSON.parse(readFileSync(desiredPath, "utf8")));
  const backupPath = `${activePath}.backup-${expectedDigest.slice(0, 12)}`;
  assert.equal(readFileSync(backupPath, "utf8"), before);

  env.REVIEW_LOOP_CODEX_BIN = healthyCodex;
  const retried = run([
    "setup",
    "--desired-tier-config", desiredPath,
    "--apply-tier-config",
    "--expected-tier-config-digest", failedAction.desired_digest,
    "--json",
  ], { cwd: repo, env });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).actions.find((item) => item.action === "reconcile-tier-config").status, "verified_noop");
  assert.equal(readFileSync(backupPath, "utf8"), before);
});

test("setup separates successful capability identity readback from authentication outage", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  writeFileSync(env.REVIEW_LOOP_CLAUDE_BIN, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.167 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'not logged in' >&2; exit 1; fi\nexit 1\n", { mode: 0o755 });
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  const parsed = JSON.parse(applied.stdout);
  assert.equal(parsed.actions.find((item) => item.action === "reconcile-tier-config").status, "applied");
  assert.equal(parsed.providers.claude.cli_available, true);
  assert.equal(parsed.providers.claude.authenticated, false);
  assert.equal(parsed.providers.claude.status, "unavailable");
  assert.equal(parsed.operational_status, "degraded");
});

test("setup writer fault injection is inert outside explicit test mode", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  env.NODE_ENV = "production";
  env.REVIEW_LOOP_TEST_FORCE_CATALOG_READBACK_FAILURE = "1";
  env.REVIEW_LOOP_TEST_FORCE_ROLLBACK_FAILURE = "1";

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).actions.find((item) => item.action === "reconcile-tier-config").status, "applied");
});

test("setup restores the prior catalog when catalog readback fails", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const preview = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });
  const expectedDigest = JSON.parse(preview.stdout).actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  env.REVIEW_LOOP_TEST_FORCE_CATALOG_READBACK_FAILURE = "1";

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.notEqual(applied.status, 0);
  const rolledBack = JSON.parse(applied.stdout);
  assert.equal(rolledBack.ok, true);
  const action = rolledBack.actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "rolled_back");
  assert.equal(action.reason_code, "capability_readback_failed");
  assert.match(action.error, /catalog readback failure/);
  assert.equal(readFileSync(activePath, "utf8"), before);
});

test("setup reports a redacted double fault and retained backup when rollback fails", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "active-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const preview = JSON.parse(run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env }).stdout);
  const expectedDigest = preview.actions.find((item) => item.action === "reconcile-tier-config").current_digest;
  const backupPath = `${activePath}.backup-${expectedDigest.slice(0, 12)}`;
  env.REVIEW_LOOP_TEST_FORCE_CATALOG_READBACK_FAILURE = "1";
  env.REVIEW_LOOP_TEST_FORCE_ROLLBACK_FAILURE = "1";

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", expectedDigest, "--json",
  ], { cwd: repo, env });

  assert.notEqual(applied.status, 0);
  assert.equal(applied.stdout, "");
  assert.match(applied.stderr, /apply failed \(forced reviewer tier configuration catalog readback failure\)/);
  assert.match(applied.stderr, /rollback failed \(forced rollback failure api_key= REDACTED\)/);
  assert.match(applied.stderr, new RegExp(`retained backup: ${backupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(applied.stderr, /rollback-test-secret/);
  assert.equal(existsSync(backupPath), true);
});

test("setup keeps a complete healthy single-provider v2 catalog Review Loop-ready", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    fast: { profiles: [{ reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "low" }] },
    standard: { profiles: [{ reviewer: "codex", model: "gpt-5.6-20260731", reasoning_effort: "medium" }] },
    strong: { profiles: [{ reviewer: "codex", model: "gpt-5.6-sol-20260731", reasoning_effort: "xhigh" }] },
  }, "codex-only-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_CLAUDE_BIN = join(repo, "missing-claude");
  const before = readFileSync(env.REVIEW_LOOP_TIER_CONFIG, "utf8");
  const beforeFiles = readdirSync(dirname(env.REVIEW_LOOP_TIER_CONFIG)).sort();

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.operational_status, "ready");
  assert.equal(parsed.catalog.status, "ready");
  assert.deepEqual(parsed.catalog.reason_codes, [
    "alternate_profile_missing:fast",
    "alternate_profile_missing:standard",
    "alternate_profile_missing:strong",
  ]);
  assert.deepEqual(parsed.catalog.tiers.fast.providers, ["openai"]);
  assert.deepEqual(parsed.catalog.tiers.strong.models, ["gpt-5.6-sol-20260731"]);
  assert.equal(parsed.providers.status, "healthy");
  assert.equal(parsed.providers.codex.status, "healthy");
  assert.equal(parsed.providers.claude.status, "not_required");
  assert.equal(readFileSync(env.REVIEW_LOOP_TIER_CONFIG, "utf8"), before);
  assert.deepEqual(readdirSync(dirname(env.REVIEW_LOOP_TIER_CONFIG)).sort(), beforeFiles);
});

test("setup separates a ready dual-provider catalog from degraded provider health", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, completeDualProviderTiers(), "reviewer-tiers-v2.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_CLAUDE_BIN = join(repo, "missing-claude");

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.operational_status, "degraded");
  assert.equal(parsed.catalog.status, "ready");
  assert.equal(parsed.providers.status, "degraded");
  assert.equal(parsed.providers.codex.status, "healthy");
  assert.equal(parsed.providers.claude.status, "unavailable");
});

test("setup does not treat a zero-exit non-auth response as authenticated", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    fast: { profiles: [{ reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "low" }] },
    standard: { profiles: [{ reviewer: "codex", model: "gpt-5.6-20260731", reasoning_effort: "medium" }] },
    strong: { profiles: [{ reviewer: "codex", model: "gpt-5.6-sol-20260731", reasoning_effort: "xhigh" }] },
  }, "codex-only-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  writeFileSync(env.REVIEW_LOOP_CODEX_BIN, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo 'OpenAI Codex vtest'; exit 0; fi\necho 'usage: unrelated launcher'; exit 0\n", { mode: 0o755 });

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.operational_status, "unavailable");
  assert.equal(parsed.providers.codex.status, "unavailable");
  assert.equal(parsed.providers.codex.authenticated, false);
});

test("setup reports an invalid catalog without rewriting or hiding the parse error", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const configPath = join(repo, ".home", "invalid-reviewer-tiers.json");
  writeFileSync(configPath, "{not-json\n");
  env.REVIEW_LOOP_TIER_CONFIG = configPath;

  const result = run(["setup", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.operational_status, "invalid");
  assert.equal(parsed.catalog.status, "invalid");
  assert.match(parsed.catalog.digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.catalog.digest_basis, "raw_bytes");
  assert.deepEqual(parsed.catalog.reason_codes, ["invalid_configuration"]);
  assert.match(parsed.catalog.error, /invalid reviewer tier configuration/i);
  assert.equal(readFileSync(configPath, "utf8"), "{not-json\n");
});

test("setup can explicitly replace an invalid active catalog while preserving its exact backup", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = join(repo, ".home", "invalid-reviewer-tiers.json");
  const invalidBytes = "{not-json\n";
  writeFileSync(activePath, invalidBytes);
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;

  const preview = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  const previewAction = JSON.parse(preview.stdout).actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(previewAction.status, "preview");
  assert.equal(previewAction.current_status, "invalid");
  assert.equal(previewAction.current_digest_basis, "raw_bytes");
  assert.match(previewAction.current_digest, /^[a-f0-9]{64}$/);

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config",
    "--expected-tier-config-digest", previewAction.current_digest, "--json",
  ], { cwd: repo, env });
  assert.equal(applied.status, 0, applied.stderr);
  const action = JSON.parse(applied.stdout).actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "applied");
  assert.equal(readFileSync(action.backup_path, "utf8"), invalidBytes);
  assert.equal(JSON.parse(readFileSync(activePath, "utf8")).schema_version, "review-loop.reviewer-tier-config.v2");
});

test("setup creates a missing catalog only with an explicit missing-state expectation", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = join(repo, ".home", "missing-reviewer-tiers.json");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;

  const rejected = run(["setup", "--desired-tier-config", desiredPath, "--apply-tier-config", "--json"], { cwd: repo, env });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /--expect-tier-config-missing is required/);
  assert.equal(existsSync(activePath), false);

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config", "--expect-tier-config-missing", "--json",
  ], { cwd: repo, env });
  assert.equal(applied.status, 0, applied.stderr);
  const parsed = JSON.parse(applied.stdout);
  const action = parsed.actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "applied");
  assert.equal(action.change, "create");
  assert.equal(action.backup_path, null);
  assert.equal(parsed.catalog.status, "ready");
});

test("setup verifies an already-applied desired catalog without rewriting or backing it up", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const activePath = writeTierConfig(repo, completeDualProviderTiers(), "active-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  const desiredPath = writeTierConfig(repo, completeDualProviderTiers(), "desired-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  env.REVIEW_LOOP_TIER_CONFIG = activePath;
  const before = readFileSync(activePath, "utf8");
  const preview = run(["setup", "--desired-tier-config", desiredPath, "--json"], { cwd: repo, env });
  assert.equal(preview.status, 0, preview.stderr);
  const digest = JSON.parse(preview.stdout).actions.find((item) => item.action === "reconcile-tier-config").current_digest;

  const applied = run([
    "setup", "--desired-tier-config", desiredPath, "--apply-tier-config", "--expected-tier-config-digest", digest, "--json",
  ], { cwd: repo, env });

  assert.equal(applied.status, 0, applied.stderr);
  const action = JSON.parse(applied.stdout).actions.find((item) => item.action === "reconcile-tier-config");
  assert.equal(action.status, "verified_noop");
  assert.equal(action.change, "noop");
  assert.equal(readFileSync(activePath, "utf8"), before);
  assert.deepEqual(readdirSync(join(repo, ".home")).filter((name) => name.includes(".backup-")), []);
});

test("run uses normalized structured output and renders blocking findings", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const decision = blockingOutput([
    finding({ id: "file-txt-high", location: "file.txt:1", message: "The change is intentionally flagged.", required_action: "Fix the test fixture." }),
  ]);

  const result = run(["run", "--scope", "auto"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(decision) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Decision: changes_requested/);
  assert.match(result.stdout, /Required action: Fix the test fixture/);
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
`, { mode: 0o755 });

  const result = run(["run", "--scope", "auto"], {
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
  assert.doesNotMatch(JSON.stringify(argv), /You are Claude Code/);
  // claude --json-schema silently drops structured output when the schema
  // carries a $schema meta key; the companion must strip it.
  const schemaArg = argv[argv.indexOf("--json-schema") + 1];
  const schema = JSON.parse(schemaArg);
  assert.equal(schema.$schema, undefined);
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
  fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "codex ok", findings: [], required_next_actions: [] }));
});
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
  assert.ok(argv.includes("--output-schema"));
  assert.ok(argv.includes("--output-last-message"));
  const schemaPath = argv[argv.indexOf("--output-schema") + 1];
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  assert.deepEqual(schema.required, ["decision", "summary", "findings", "required_next_actions"]);
  assert.ok(schema.properties.findings.items.required.includes("reviewer_disposition"));
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

test("capabilities reports legacy compatibility when operator tiers are not configured", () => {
  const repo = makeGitRepo();
  const result = run(["capabilities", "--json"], { cwd: repo, env: testEnv(repo) });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.schema_version, "review-loop.capabilities.v1");
  assert.deepEqual(parsed.semantic_tiers, ["fast", "standard", "strong", "legacy_unqualified"]);
  assert.equal(parsed.tier_configuration.status, "missing");
  assert.equal(parsed.tiers.fast.configured, false);
  assert.equal(parsed.legacy_unqualified.approval_authority, false);
  assert.match(parsed.capability_digest, /^[a-f0-9]{64}$/);
});

test("capabilities reads its adapter version from a packaged plugin manifest", () => {
  const repo = makeGitRepo();
  const installedPlugin = join(repo, "installed", "review-loop");
  cpSync(new URL("../plugins/review-loop", import.meta.url).pathname, installedPlugin, { recursive: true });
  const installedCompanion = join(installedPlugin, "scripts", "review-loop-companion.mjs");
  const result = spawnSync(process.execPath, [installedCompanion, "capabilities", "--json"], {
    cwd: repo,
    env: testEnv(repo),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).adapter_version, "0.8.0");
});

test("capabilities treats legacy tier configuration as migration-only", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "medium" },
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  const first = run(["capabilities", "--json"], { cwd: repo, env });
  const second = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.deepEqual(parsed, JSON.parse(second.stdout));
  assert.equal(parsed.tier_configuration.status, "migration_required");
  assert.equal(parsed.tier_configuration.schema_version, "review-loop.reviewer-tier-config.v1");
  assert.equal(parsed.tiers.fast.configured, false);
  assert.equal(parsed.tiers.strong.configured, false);
  assert.equal(parsed.tiers.standard.configured, false);

  const tieredRun = run(["run", "--tier", "fast", "--scope", "none", "--json"], { cwd: repo, env });
  assert.notEqual(tieredRun.status, 0);
  assert.match(tieredRun.stderr, /migration required/i);
});

test("capabilities exposes ordered provider-diverse profiles while preserving the primary projection", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    strong: {
      profiles: [
        { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
        { reviewer: "codex", model: "gpt-5.6-sol-20260731", reasoning_effort: "xhigh" },
      ],
    },
  }, "reviewer-tiers-v2.json", "review-loop.reviewer-tier-config.v2");

  const result = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const tier = JSON.parse(result.stdout).tiers.strong;
  assert.equal(tier.configured, true);
  assert.equal(tier.alternate_profiles_configured, true);
  assert.equal(tier.profiles.length, 2);
  assert.deepEqual(tier.profiles.map((profile) => profile.release_identity.provider), ["anthropic", "openai"]);
  assert.deepEqual(tier.profiles.map((profile) => profile.release_identity.model), [
    "claude-opus-4-1-20250805",
    "gpt-5.6-sol-20260731",
  ]);
  assert.deepEqual(tier.release_identity, tier.profiles[0].release_identity);
  assert.deepEqual(tier.isolation_profile, tier.profiles[0].isolation_profile);
  assert.notEqual(tier.profiles[0].isolation_profile.profile_digest, tier.profiles[1].isolation_profile.profile_digest);

  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    strong: {
      profiles: [
        { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
        { reviewer: "codex", model: "gpt-5.6-sol-20260801", reasoning_effort: "xhigh" },
      ],
    },
  }, "reviewer-tiers-v2-changed.json", "review-loop.reviewer-tier-config.v2");
  const changed = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(changed.status, 0, changed.stderr);
  const changedTier = JSON.parse(changed.stdout).tiers.strong;
  assert.notEqual(changedTier.profiles[0].release_identity.release_digest, tier.profiles[0].release_identity.release_digest);
  assert.notEqual(changedTier.profiles[1].release_identity.release_digest, tier.profiles[1].release_identity.release_digest);
});

test("multi-profile tier validation rejects duplicate providers and more than two profiles", () => {
  const repo = makeGitRepo();
  const baseEnv = testEnv(repo);
  const duplicateEnv = {
    ...baseEnv,
    REVIEW_LOOP_TIER_CONFIG: writeTierConfig(repo, {
      strong: {
        profiles: [
          { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
          { reviewer: "claude", model: "claude-opus-4-8-20260701", reasoning_effort: "high" },
        ],
      },
    }, "duplicate-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2"),
  };
  const duplicate = run(["capabilities", "--json"], { cwd: repo, env: duplicateEnv });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate provider anthropic/);

  const excessiveEnv = {
    ...baseEnv,
    REVIEW_LOOP_TIER_CONFIG: writeTierConfig(repo, {
      standard: {
        profiles: [
          { reviewer: "claude", model: "claude-sonnet-4-5-20250929", reasoning_effort: "medium" },
          { reviewer: "codex", model: "gpt-5.6-20260731", reasoning_effort: "medium" },
          { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
        ],
      },
    }, "excessive-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2"),
  };
  const excessive = run(["capabilities", "--json"], { cwd: repo, env: excessiveEnv });
  assert.notEqual(excessive.status, 0);
  assert.match(excessive.stderr, /between 1 and 2 profiles/);
});

test("v2 single-profile tiers expose one profile without claiming alternate coverage", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  const result = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const tier = JSON.parse(result.stdout).tiers.strong;
  assert.equal(tier.alternate_profiles_configured, false);
  assert.equal(tier.profiles.length, 1);
  assert.deepEqual(tier.release_identity, tier.profiles[0].release_identity);
  assert.deepEqual(tier.isolation_profile, tier.profiles[0].isolation_profile);
});

test("tiered Claude review passes exact model settings and returns immutable mechanism evidence", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");
  const argvFile = join(repo, "tier-claude-argv.json");
  const fakeClaude = join(repo, "bin", "tier-claude");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("2.1.212 (Claude Code)"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok", modelUsage: { "claude-opus-4-1-20250805": { outputTokens: 12 } } }));
`, { mode: 0o755 });
  const env = {
    ...testEnv(repo),
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
  };
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  const result = run(["run", "--scope", "auto", "--tier", "strong", "--continuation-envelope", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.reviewer_mechanism.schema_version, "review-loop.reviewer-mechanism.v1");
  assert.equal(parsed.result.reviewer_mechanism.status, "completed");
  assert.equal(parsed.result.reviewer_mechanism.release_identity.model, "claude-opus-4-1-20250805");
  assert.match(parsed.result.reviewer_mechanism.release_identity.release_digest, /^[a-f0-9]{64}$/);
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const contract = parsed.result.reviewer_mechanism.release_identity.read_only_contract;
  assert.deepEqual(argv.slice(1, 1 + contract.static_argv.length), contract.static_argv);
  assert.deepEqual(argv.slice(0, 8), [
    "-p", "--safe-mode", "--model", "claude-opus-4-1-20250805",
    "--effort", "high", "--no-session-persistence", "--permission-mode",
  ]);
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2), ["--tools", "Read,Grep,Glob"]);
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]);
  assert.equal(schema.properties.continuation_envelope.$ref, "#/$defs/continuation_envelope");

  writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.1.212 (Claude Code)"); process.exit(0); }
console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok", modelUsage: { "claude-opus-4-8": { outputTokens: 12 } } }));
`, { mode: 0o755 });
  const drift = run(["run", "--scope", "auto", "--tier", "strong", "--json"], { cwd: repo, env });
  assert.equal(drift.status, 0, drift.stderr);
  const driftResult = JSON.parse(drift.stdout);
  assert.equal(driftResult.result.decision, "blocked");
  assert.match(driftResult.result.summary, /tier identity drift.*configured claude-opus-4-1-20250805, resolved claude-opus-4-8/);
});

test("tiered Codex review passes exact model settings without user configuration", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");
  const argvFile = join(repo, "tier-codex-argv.json");
  const cwdFile = join(repo, "tier-codex-cwd.txt");
  const fakeCodex = join(repo, "bin", "tier-codex");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log(process.env.FAKE_CODEX_VERSION || "OpenAI Codex vtest-1"); process.exit(0); }
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
const out = argv[argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "ok", findings: [], required_next_actions: [] }));
`, { mode: 0o755 });
  const env = { ...testEnv(repo), REVIEW_LOOP_CODEX_BIN: fakeCodex };
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "medium" },
  });
  const result = run(["run", "--scope", "auto", "--tier", "fast", "--json"], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.reviewer_mechanism.release_identity.semantic_tier, "fast");
  assert.equal(parsed.result.reviewer_mechanism.release_identity.reviewer_cli_version, "OpenAI Codex vtest-1");
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const contract = parsed.result.reviewer_mechanism.release_identity.read_only_contract;
  assert.deepEqual(argv.slice(1, 1 + contract.static_argv.length), contract.static_argv);
  assert.deepEqual(argv.slice(0, 15), [
    "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config", "--model", "gpt-5.6-luna-20260701",
    "--config", 'model_reasoning_effort="medium"',
    "--config", "project_doc_max_bytes=0",
    "--config", "project_doc_fallback_filenames=[]",
    "--sandbox", "read-only",
  ]);
  const neutralRoot = argv[argv.indexOf("--cd") + 1];
  assert.notEqual(neutralRoot, repo);
  assert.equal(realpathSync(readFileSync(cwdFile, "utf8")), realpathSync(neutralRoot));
  assert.deepEqual(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2), ["--add-dir", realpathSync(repo)]);
  assert.ok(argv.includes("--skip-git-repo-check"));
  assert.deepEqual(contract.workspace_argv_template, [
    "--cd", "<instruction-neutral-state-directory>",
    "--add-dir", "<repository-root>",
    "--skip-git-repo-check",
  ]);
  const changedCli = run(["capabilities", "--json"], {
    cwd: repo,
    env: { ...env, FAKE_CODEX_VERSION: "OpenAI Codex vtest-2" },
  });
  assert.equal(changedCli.status, 0, changedCli.stderr);
  const changedIdentity = JSON.parse(changedCli.stdout).tiers.fast.release_identity;
  assert.equal(changedIdentity.reviewer_cli_version, "OpenAI Codex vtest-2");
  assert.notEqual(changedIdentity.release_digest, parsed.result.reviewer_mechanism.release_identity.release_digest);
});

test("authoritative transaction invokes exactly once and emits derived isolation and identity evidence", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "review the exact implementation subject");
  mkdirSync(join(repo, ".review-loop"), { recursive: true });
  writeFileSync(join(repo, ".review-loop", "review-guidelines.md"), "PROJECT INSTRUCTION MUST NOT LOAD\n");
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  env.REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT = JSON.stringify(blockingOutput([
    finding({ id: "real-finding", message: "A schema-valid finding is terminal.", required_action: "Fix it." }),
  ]));
  env.REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID = "reviewer-session-1";
  env.REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT = JSON.stringify(approvedOutput("fallback must not run"));
  const authorization = writeAuthorization(repo, env, {
    task_id: "task-1",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "strong",
  });

  const result = run([
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
    "--authorization", authorization.path,
    "--subject-digest", authorization.record.subject_digest,
    "--json",
  ], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.guidelines.source, "authoritative-runtime");
  assert.equal(parsed.result.decision, "changes_requested");
  assert.equal(parsed.transaction.outcome, "decision");
  assert.equal(parsed.transaction.invocation_count, 1);
  assert.equal(parsed.transaction.transport.status, "completed");
  assert.equal(parsed.transaction.envelope.status, "valid");
  assert.match(parsed.transaction.envelope.content_digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.transaction.authorization.authorization_digest, authorization.record.authorization_digest);
  assert.equal(parsed.transaction.reviewed_input_digest, packet.digest);
  assert.equal(parsed.transaction.isolation_profile.release_digest,
    parsed.result.reviewer_mechanism.release_identity.release_digest);
  assert.equal(parsed.transaction.isolation_profile.read_only_contract_digest,
    parsed.result.reviewer_mechanism.release_identity.read_only_contract_digest);
  assert.match(parsed.transaction.isolation_profile.transaction_contract_digest, /^[a-f0-9]{64}$/);
  assert.equal(parsed.transaction.isolation_profile.fresh_context, true);
  assert.equal(parsed.transaction.isolation_profile.resume_allowed, false);
  assert.equal(parsed.transaction.isolation_profile.history_persistence, false);
  assert.equal(parsed.transaction.isolation_profile.packet_only, true);
  assert.match(parsed.transaction.review_context_id, /^[0-9a-f-]{36}$/i);
  assert.equal(parsed.transaction.reviewer_identity.provider, "anthropic");
  assert.equal(parsed.transaction.reviewer_identity.signal, "provider_reported_session_id");
  assert.match(parsed.transaction.reviewer_identity.session_id_digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(parsed), /reviewer-session-1|fallback must not run/);
});

test("authoritative transaction selects the exact authorized profile from a multi-profile tier", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "select the exact authorized profile");
  const fakeCodex = join(repo, "bin", "authorized-codex");
  const argvFile = join(repo, "authorized-codex-argv.json");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("OpenAI Codex vtest-strong"); process.exit(0); }
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
const out = argv[argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "codex selected", findings: [], required_next_actions: [] }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-authorized-session" }));
`, { mode: 0o755 });
  const env = { ...testEnv(repo), REVIEW_LOOP_CODEX_BIN: fakeCodex };
  env.REVIEW_LOOP_TIER_CONFIG = writeTierConfig(repo, {
    strong: {
      profiles: [
        { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
        { reviewer: "codex", model: "gpt-5.6-sol-20260731", reasoning_effort: "xhigh" },
      ],
    },
  }, "authorized-reviewer-tiers.json", "review-loop.reviewer-tier-config.v2");
  const authorization = writeAuthorization(repo, env, {
    task_id: "task-multi-profile",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "strong",
    profile_index: 1,
  }, "multi-profile-authorization.json");

  const result = run([
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
    "--authorization", authorization.path,
    "--subject-digest", packet.digest,
    "--json",
  ], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.transaction.invocation_count, 1);
  assert.equal(parsed.transaction.reviewer_identity.provider, "openai");
  assert.equal(parsed.transaction.isolation_profile.profile_digest, authorization.record.isolation_profile_digest);
  assert.equal(parsed.result.reviewer_mechanism.release_identity.model, "gpt-5.6-sol-20260731");
  assert.ok(JSON.parse(readFileSync(argvFile, "utf8")).includes("gpt-5.6-sol-20260731"));
});

test("authoritative transaction rejects invalid bindings before reviewer launch", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "immutable execution packet");
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  env.REVIEW_LOOP_FAKE_ERROR = "reviewer must not launch";
  const cases = [
    { name: "version", override: { schema_version: "review-loop.authorization.v0" }, subject: packet.digest, pattern: /authorization schema_version/ },
    { name: "subject", override: {}, subject: "2".repeat(64), pattern: /authorization subject digest mismatch/ },
    { name: "content", override: { subject_digest: "1".repeat(64) }, subject: "1".repeat(64), pattern: /reviewed input digest mismatch/ },
    { name: "expiry", override: { expires_at: "2026-07-27T08:30:00.000Z" }, subject: packet.digest, pattern: /authorization expired/ },
    { name: "attempt", override: { attempt_ordinal: 0 }, subject: packet.digest, pattern: /attempt_ordinal/ },
    { name: "profile", override: { isolation_profile_digest: "3".repeat(64) }, subject: packet.digest, pattern: /isolation profile digest mismatch/ },
    { name: "digest", override: { authorization_digest: "f".repeat(64) }, subject: packet.digest, pattern: /authorization digest mismatch/ },
  ];
  for (const item of cases) {
    const authorization = writeAuthorization(repo, env, {
      task_id: "task-1",
      gate: "execution",
      subject_digest: packet.digest,
      attempt_ordinal: 1,
      tier: "strong",
      ...item.override,
    }, `authorization-${item.name}.json`);
    const result = run([
      "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
      "--authorization", authorization.path,
      "--subject-digest", item.subject,
      "--json",
    ], { cwd: repo, env });
    assert.notEqual(result.status, 0, `${item.name}: ${result.stdout}`);
    assert.match(result.stderr, item.pattern);
    assert.doesNotMatch(result.stderr, /reviewer must not launch/);
  }
  for (const [name, extraArgs] of [
    ["focus", ["--focus", "unbound focus"]],
    ["counter", ["--counter"]],
    ["guidelines", ["--guidelines", packet.path]],
    ["positional", ["unbound positional instruction"]],
  ]) {
    const authorization = writeAuthorization(repo, env, {
      task_id: "task-1",
      gate: "execution",
      subject_digest: packet.digest,
      attempt_ordinal: 1,
      tier: "strong",
    }, `authorization-instruction-${name}.json`);
    const result = run([
      "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
      "--authorization", authorization.path,
      "--subject-digest", packet.digest,
      ...extraArgs,
      "--json",
    ], { cwd: repo, env });
    assert.notEqual(result.status, 0, `${name}: ${result.stdout}`);
    assert.match(result.stderr, /authoritative review does not accept caller or project instructions/);
    assert.doesNotMatch(result.stderr, /reviewer must not launch/);
  }
});

test("authoritative transaction captures Codex native session identity without exposing it", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "codex execution packet");
  const fakeCodex = join(repo, "bin", "authoritative-codex");
  const argvFile = join(repo, "codex-argv.json");
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("OpenAI Codex vtest-1"); process.exit(0); }
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
const out = argv[argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "codex decision", findings: [], required_next_actions: [] }));
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-native-session-1" }));
`, { mode: 0o755 });
  const env = { ...testEnv(repo), REVIEW_LOOP_CODEX_BIN: fakeCodex };
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "medium" },
  });
  const authorization = writeAuthorization(repo, env, {
    task_id: "task-1",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "fast",
  }, "codex-authorization.json");
  const result = run([
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "fast",
    "--authorization", authorization.path,
    "--subject-digest", authorization.record.subject_digest,
    "--json",
  ], { cwd: repo, env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.transaction.outcome, "decision");
  assert.equal(parsed.transaction.reviewer_identity.provider, "openai");
  assert.match(parsed.transaction.reviewer_identity.session_id_digest, /^[a-f0-9]{64}$/);
  assert.ok(JSON.parse(readFileSync(argvFile, "utf8")).includes("--ephemeral"));
  assert.doesNotMatch(JSON.stringify(parsed), /codex-native-session-1/);
});

test("authoritative transaction distinguishes unavailable and unparseable without fallback or prose salvage", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "outcome classification packet");
  const baseEnv = testEnv(repo);
  baseEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  const authorization = writeAuthorization(repo, baseEnv, {
    task_id: "task-1",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "strong",
  });
  const args = [
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
    "--authorization", authorization.path,
    "--subject-digest", authorization.record.subject_digest,
    "--json",
  ];
  const unavailable = run(args, {
    cwd: repo,
    env: {
      ...baseEnv,
      REVIEW_LOOP_FAKE_ERROR: "transport unavailable",
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
    },
  });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  const unavailableResult = JSON.parse(unavailable.stdout);
  assert.equal(unavailableResult.transaction.outcome, "unavailable");
  assert.equal(unavailableResult.transaction.invocation_count, 1);
  assert.equal(unavailableResult.transaction.transport.status, "failed");
  assert.match(unavailableResult.transaction.transport.diagnostic_digest, /^[a-f0-9]{64}$/);
  assert.equal("failure_diagnostic" in unavailableResult.transaction.transport, false);
  assert.equal(unavailableResult.transaction.envelope.status, "absent");
  assert.equal(unavailableResult.result, null);
  assert.doesNotMatch(JSON.stringify(unavailableResult), /fallback must not run/);

  const redacted = run([...args.slice(0, -1), "--emit-failure-diagnostic", "--json"], {
    cwd: repo,
    env: {
      ...baseEnv,
      REVIEW_LOOP_FAKE_ERROR: "authentication failed at https://alice:s3ss10n.blob@example.invalid/session?jwt=eyJhbGciOiJub25lIn0.payload.signature",
    },
  });
  assert.equal(redacted.status, 0, redacted.stderr);
  const redactedDiagnostic = JSON.parse(redacted.stdout).transaction.transport.failure_diagnostic;
  assert.equal(redactedDiagnostic.category, "authentication");
  assert.equal(redactedDiagnostic.message, "Reviewer authentication failed.");
  assert.doesNotMatch(JSON.stringify(JSON.parse(redacted.stdout)), /s3ss10n|eyJhbGciOiJub25lIn0|alice:/);

  const unparseable = run(args, {
    cwd: repo,
    env: {
      ...baseEnv,
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "changes_requested",
        summary: "test",
        findings: [finding({ message: "prose must not be salvaged" })],
        required_next_actions: ["do not salvage"],
      }),
      REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("fallback must not run")),
    },
  });
  assert.equal(unparseable.status, 0, unparseable.stderr);
  const unparseableResult = JSON.parse(unparseable.stdout);
  assert.equal(unparseableResult.transaction.outcome, "unparseable");
  assert.equal(unparseableResult.transaction.invocation_count, 1);
  assert.equal(unparseableResult.transaction.transport.status, "completed");
  assert.equal(unparseableResult.transaction.envelope.status, "invalid");
  assert.match(unparseableResult.transaction.envelope.content_digest, /^[a-f0-9]{64}$/);
  assert.equal(unparseableResult.result, null);
  assert.doesNotMatch(JSON.stringify(unparseableResult), /prose must not be salvaged|do not salvage|fallback must not run/);

  const repeated = run(args, {
    cwd: repo,
    env: {
      ...baseEnv,
      REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("second explicit invocation")),
      REVIEW_LOOP_FAKE_CLAUDE_SESSION_ID: "reviewer-session-2",
    },
  });
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatedResult = JSON.parse(repeated.stdout);
  assert.equal(repeatedResult.transaction.authorization.authorization_digest, authorization.record.authorization_digest);
  assert.notEqual(repeatedResult.transaction.review_context_id, unparseableResult.transaction.review_context_id);
});

test("authoritative transaction classifies returned invalid Claude and Codex envelopes as unparseable", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const packet = writeAuthoritativePacket(repo, "adapter envelope classification packet");
  const env = testEnv(repo);
  const bin = join(repo, "bin");

  const fakeClaude = join(bin, "invalid-envelope-claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("2.1.220 (Claude Code)"); process.exit(0); }
console.log(JSON.stringify({ result: "returned content without structured_output", session_id: "claude-session" }));
`, { mode: 0o755 });
  const claudeEnv = {
    ...env,
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
  };
  claudeEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "claude-envelope-tiers.json");
  const claudeAuthorization = writeAuthorization(repo, claudeEnv, {
    task_id: "task-claude",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "strong",
  }, "claude-envelope-authorization.json");
  const claude = run([
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "strong",
    "--authorization", claudeAuthorization.path,
    "--subject-digest", packet.digest,
    "--json",
  ], { cwd: repo, env: claudeEnv });
  assert.equal(claude.status, 0, claude.stderr);
  const claudeResult = JSON.parse(claude.stdout);
  assert.equal(claudeResult.transaction.outcome, "unparseable");
  assert.equal(claudeResult.transaction.transport.status, "completed");
  assert.equal(claudeResult.transaction.envelope.status, "invalid");

  const fakeCodex = join(bin, "invalid-envelope-codex");
  writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("OpenAI Codex vtest-1"); process.exit(0); }
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--output-last-message") + 1];
fs.writeFileSync(out, "not-json");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session" }));
`, { mode: 0o755 });
  const codexEnv = {
    ...env,
    REVIEW_LOOP_CODEX_BIN: fakeCodex,
  };
  codexEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "medium" },
  }, "codex-envelope-tiers.json");
  const codexAuthorization = writeAuthorization(repo, codexEnv, {
    task_id: "task-codex",
    gate: "execution",
    subject_digest: packet.digest,
    attempt_ordinal: 1,
    tier: "fast",
  }, "codex-envelope-authorization.json");
  const codex = run([
    "run", "--scope", "none", "--artifact", packet.path, "--tier", "fast",
    "--authorization", codexAuthorization.path,
    "--subject-digest", packet.digest,
    "--json",
  ], { cwd: repo, env: codexEnv });
  assert.equal(codex.status, 0, codex.stderr);
  const codexResult = JSON.parse(codex.stdout);
  assert.equal(codexResult.transaction.outcome, "unparseable");
  assert.equal(codexResult.transaction.transport.status, "completed");
  assert.equal(codexResult.transaction.envelope.status, "invalid");
});

test("tiered Claude capabilities reject alternate provider backends", () => {
  const repo = makeGitRepo();
  const baseEnv = testEnv(repo);
  baseEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  });
  for (const flag of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    const result = run(["capabilities", "--json"], { cwd: repo, env: { ...baseEnv, [flag]: "1" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`alternate backend configuration: ${flag}`));
  }
});

test("tiered review fails closed on missing, mutable, or unavailable configured identity", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");
  const baseEnv = testEnv(repo);

  const missing = run(["run", "--scope", "auto", "--tier", "fast", "--json"], { cwd: repo, env: baseEnv });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /reviewer tier configuration is missing/);

  const mutableEnv = { ...baseEnv };
  mutableEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "opus", reasoning_effort: "high" },
  }, "mutable-tiers.json");
  const mutable = run(["capabilities", "--json"], { cwd: repo, env: mutableEnv });
  assert.notEqual(mutable.status, 0);
  assert.match(mutable.stderr, /must be an exact model identifier/);

  const failedEnv = {
    ...baseEnv,
    REVIEW_LOOP_HOST: "claude",
    REVIEW_LOOP_CLAUDE_BIN: join(repo, "missing-claude"),
    REVIEW_LOOP_FAKE_CODEX_STRUCTURED_OUTPUT: JSON.stringify(approvedOutput("must not fallback")),
  };
  failedEnv.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
  }, "failed-tiers.json");
  const failed = run(["run", "--scope", "auto", "--tier", "strong", "--json"], { cwd: repo, env: failedEnv });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /claude reviewer CLI version probe failed/);
  assert.doesNotMatch(failed.stderr, /fallback review/);

  const allow = run(["run", "--scope", "auto", "--tier", "strong", "--on-reviewer-failure", "allow"], { cwd: repo, env: failedEnv });
  assert.notEqual(allow.status, 0);
  assert.match(allow.stderr, /tiered review cannot use --on-reviewer-failure allow/);
});

test("strong initial review can emit a strict continuation envelope and other invocations cannot", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "base\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed\n");
  const env = testEnv(repo);
  env.REVIEW_LOOP_TIER_CONFIG = writeRuntimeTierConfig(repo, {
    strong: { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
    fast: { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "medium" },
  });
  const output = {
    ...approvedOutput("bounded closure"),
    continuation_envelope: {
      allowed_paths: ["file.txt"],
      allowed_subject_elements: ["changed line"],
      expected_closure_claim: "Replace the incorrect fixture value.",
      required_checks: ["npm test"],
      forbidden_effects: ["runtime behavior outside file.txt"],
    },
  };
  env.REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT = JSON.stringify(output);
  const strong = run(["run", "--scope", "auto", "--tier", "strong", "--continuation-envelope", "--json"], { cwd: repo, env });
  assert.equal(strong.status, 0, strong.stderr);
  assert.deepEqual(JSON.parse(strong.stdout).result.continuation_envelope, output.continuation_envelope);

  const unrequested = run(["run", "--scope", "auto", "--tier", "strong", "--json"], { cwd: repo, env });
  assert.equal(unrequested.status, 0, unrequested.stderr);
  assert.equal(JSON.parse(unrequested.stdout).result.decision, "blocked");

  const fast = run(["run", "--scope", "auto", "--tier", "fast", "--continuation-envelope"], { cwd: repo, env });
  assert.notEqual(fast.status, 0);
  assert.match(fast.stderr, /--continuation-envelope requires --tier strong/);
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
  const reviewerOutput = {
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
  };

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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
  const reviewerOutput = {
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
  };
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
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
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
    }) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.blocking_findings[0].blocking_reason, "severity_policy");
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

test("run rejects the observed placeholder summary and uses one host fallback", () => {
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
    assert.equal(parsed.result.decision, "approved");
    assert.equal(parsed.result.summary, "fallback reviewed the target");
    assert.equal(parsed.result.reviewer_mechanism, "codex-fallback-fake");
    assert.doesNotMatch(JSON.stringify(parsed), /test message|do the thing|file\.md/i);
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
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "approved",
      summary: "Reviewed the target and found a blocker.",
      findings: [{ ...finding({ required_action: "Fix it." }), reviewer_disposition: "blocking" }],
      required_next_actions: [],
    }) },
  });
  assert.equal(JSON.parse(result.stdout).result.decision, "changes_requested");
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "claude fallback ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
});

test("run can fail open explicitly on reviewer mechanism failure", () => {
  const repo = makeGitRepo();
  const result = run(["run", "--scope", "none", "--on-reviewer-failure", "allow", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", findings: [] }) },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.result.decision, "approved");
  assert.match(parsed.result.summary, /on-reviewer-failure=allow/);
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
    const result = run(["run", "--scope", "none", "--json"], {
      cwd: repo,
      env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision,
        summary: `${decision} from reviewer`,
        findings: [],
        required_next_actions: ["Try again."],
      }) },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.result.decision, decision);
    assert.deepEqual(parsed.result.blocking_findings, []);
    assert.deepEqual(parsed.result.required_next_actions, ["Try again."]);
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
  assert.match(parsed.result.required_next_actions.join("\n"), /--artifact/);
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
  fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "fallback ok", findings: [], required_next_actions: [] }));
});
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "claude fallback ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
process.stdin.resume();
process.stdin.on("end", () => {
  const out = argv[argv.indexOf("--output-last-message") + 1];
  fs.writeFileSync(out, JSON.stringify({ decision: "approved", summary: "fallback ok", findings: [], required_next_actions: [] }));
});
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

  // An explicit category exemption overrides severity and reviewer disposition.
  writeFileSync(join(repo, "file.txt"), "style change\n");
  const styleEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
    finding({ id: "style1", severity: "high", category: "style", locations: ["file.txt:1"], message: "Ugly.", required_action: "Prettify." }),
  ])) };
  const styleAllow = run(["gate", "--json"], { cwd: repo, env: styleEnv, input: '{"turn_id":"style"}' });
  assert.deepEqual(JSON.parse(styleAllow.stdout), {});

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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "reviewer raw text" }));
});
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
  assert.equal(completed.result.result.schema_version, "2");
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
    env: { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "ok", findings: [], required_next_actions: [] }) },
    encoding: "utf8",
  });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(JSON.parse(review.stdout).result.decision, "approved");

  const context = join(repo, "context.md");
  writeFileSync(context, "Problem: wrapper run passthrough\n");
  const explicitRun = spawnSync(process.execPath, [reviewBin, "run", "--context", context, "--json"], {
    cwd: repo,
    env: { ...env, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", summary: "ok", findings: [], required_next_actions: [] }) },
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", summary: "ok", findings: [], required_next_actions: [] }, result: "ok" }));
});
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
  writeFileSync(fakeClaude, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.167 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ] && [ \"$3\" = \"--json\" ]; then echo '{\"loggedIn\":true}'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'Login method: test'; exit 0; fi\necho '{\"structured_output\":{\"decision\":\"approved\",\"summary\":\"ok\",\"findings\":[],\"required_next_actions\":[]},\"result\":\"ok\"}'\n", { mode: 0o755 });
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
    REVIEW_LOOP_TEST_MODE: "1",
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "review-loop-state-")),
  };
}

function writeTierConfig(repo, tiers, name = "reviewer-tiers.json", schemaVersion = "review-loop.reviewer-tier-config.v1") {
  const path = join(repo, ".home", name);
  mkdirSync(join(repo, ".home"), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema_version: schemaVersion,
    tiers,
  }));
  return path;
}

function writeRuntimeTierConfig(repo, tiers, name = "reviewer-tiers-v2.json") {
  return writeTierConfig(repo, Object.fromEntries(Object.entries(tiers).map(([tier, profile]) => [
    tier,
    { profiles: [profile] },
  ])), name, "review-loop.reviewer-tier-config.v2");
}

function completeDualProviderTiers() {
  return {
    fast: {
      profiles: [
        { reviewer: "codex", model: "gpt-5.6-luna-20260701", reasoning_effort: "low" },
        { reviewer: "claude", model: "claude-haiku-4-5-20251001", reasoning_effort: "low" },
      ],
    },
    standard: {
      profiles: [
        { reviewer: "codex", model: "gpt-5.6-20260731", reasoning_effort: "medium" },
        { reviewer: "claude", model: "claude-sonnet-4-5-20250929", reasoning_effort: "medium" },
      ],
    },
    strong: {
      profiles: [
        { reviewer: "claude", model: "claude-opus-4-1-20250805", reasoning_effort: "high" },
        { reviewer: "codex", model: "gpt-5.6-sol-20260731", reasoning_effort: "xhigh" },
      ],
    },
  };
}

function writeAuthorization(repo, env, fields, name = "authorization.json") {
  const capabilitiesResult = run(["capabilities", "--json"], { cwd: repo, env });
  assert.equal(capabilitiesResult.status, 0, capabilitiesResult.stderr);
  const capabilities = JSON.parse(capabilitiesResult.stdout);
  const tier = capabilities.tiers[fields.tier];
  const profile = fields.profile_index === undefined
    ? tier.isolation_profile
    : tier.profiles?.[fields.profile_index]?.isolation_profile;
  assert.ok(profile, `missing isolation profile for tier ${fields.tier}`);
  const payload = {
    schema_version: "review-loop.authorization.v1",
    authorization_id: `auth-${name.replace(/[^a-z0-9]/gi, "-")}`,
    task_id: fields.task_id,
    gate: fields.gate,
    subject_digest: fields.subject_digest,
    policy_version: "kernel-isolation-policy-v1",
    isolation_profile_digest: profile.profile_digest,
    attempt_ordinal: fields.attempt_ordinal,
    issued_at: "2026-07-27T08:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "tier" && key !== "profile_index") payload[key] = value;
  }
  const record = {
    ...payload,
    authorization_digest: fields.authorization_digest
      || createHash("sha256")
        .update(`review-loop.authorization.v1\0${JSON.stringify(stableValue(payload))}`)
        .digest("hex"),
  };
  const path = join(repo, name);
  writeFileSync(path, JSON.stringify(record));
  return { path, record };
}

function writeAuthoritativePacket(repo, content, name = "gate-packet.md") {
  const path = join(repo, name);
  writeFileSync(path, content);
  return {
    path,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function approvedOutput(summary = "ok") {
  return { decision: "approved", summary, findings: [], required_next_actions: [] };
}

function blockingOutput(findings, summary = "blocking findings") {
  return { decision: "changes_requested", summary, findings: findings.map((item) => ({ ...item, reviewer_disposition: "blocking" })), required_next_actions: [] };
}

function advisoryOutput(findings, summary = "advisory findings") {
  return { decision: "approved", summary, findings: findings.map((item) => ({ ...item, reviewer_disposition: "advisory" })), required_next_actions: [] };
}

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

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
