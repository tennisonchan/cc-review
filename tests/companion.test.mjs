import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const companion = new URL("../plugins/cc-review/scripts/cc-review-companion.mjs", import.meta.url).pathname;

test("setup initializes project review guidelines without overwriting", () => {
  const repo = makeGitRepo();
  const env = testEnv(repo);
  const first = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  const parsed = JSON.parse(first.stdout);
  const action = parsed.actions.find((item) => item.action === "init-guidelines");
  assert.ok(action.path.endsWith(".claude/rules/review-guidelines.md"));
  assert.ok(existsSync(action.path));

  writeFileSync(action.path, "custom\n");
  const second = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(action.path, "utf8"), "custom\n");
  const secondParsed = JSON.parse(second.stdout);
  assert.equal(secondParsed.actions.find((item) => item.action === "init-guidelines").status, "skipped");
});

test("review uses structured output and renders needs_changes", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const decision = {
    decision: "needs_changes",
    approved: false,
    max_severity: "high",
    needs_changes: [
      {
        id: "file-txt-high",
        severity: "high",
        location: "file.txt:1",
        summary: "The change is intentionally flagged.",
        required_action: "Fix the test fixture.",
      },
    ],
    notes: [],
  };

  const result = run(["review", "--wait"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify(decision) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Decision: needs_changes/);
  assert.match(result.stdout, /Required action: Fix the test fixture/);
});

test("review invokes Claude read-only via argv and sends prompt through stdin", () => {
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }, result: "ok" }));
});
`, { mode: 0o755 });

  const result = run(["review", "--wait"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")).slice(0, 5), ["-p", "--permission-mode", "plan", "--tools", ""]);
  assert.match(readFileSync(stdinFile, "utf8"), /You are Claude Code acting as a read-only reviewer/);
  assert.doesNotMatch(JSON.stringify(JSON.parse(readFileSync(argvFile, "utf8"))), /You are Claude Code/);
});

test("invalid structured severity fails closed", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");

  const result = run(["review", "--wait"], {
    cwd: repo,
    env: {
      ...testEnv(repo),
      CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "approved",
        approved: true,
        max_severity: "high because prose",
        needs_changes: [],
        notes: [],
      }),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /max_severity must be one of/);
});

test("invalid branch base fails closed instead of approving empty review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  const result = run(["review", "--wait", "--scope", "branch", "--base", "missing-ref"], {
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
    env: { ...testEnv(repo), CC_REVIEW_HOOK_EVENTS: "subagent_stop" },
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

test("gate re-reviews after a block instead of allowing on stop_hook_active", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1",
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "high",
      needs_changes: [
        {
          id: "blocker",
          severity: "high",
          location: "file.txt:1",
          summary: "Blocking issue.",
          required_action: "Fix it.",
        },
      ],
      notes: [],
    }),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);

  const blocked = run(["gate", "--json"], { cwd: repo, env, input: "{}" });
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const reentered = run(["gate", "--json"], { cwd: repo, env, input: '{"stop_hook_active":true}' });
  assert.equal(reentered.status, 0, reentered.stderr);
  assert.equal(JSON.parse(reentered.stdout).decision, "block");

  const cleanEnv = { ...env, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
  const fixed = run(["gate", "--json"], { cwd: repo, env: cleanEnv, input: '{"stop_hook_active":true}' });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(JSON.parse(fixed.stdout), {});
});

test("gate allows immediately on recursion sentinels", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1",
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "high",
      needs_changes: [{ id: "blocker", severity: "high", location: "file.txt:1", summary: "Blocking issue.", required_action: "Fix it." }],
      notes: [],
    }),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  for (const payload of ['{"hook_active":true}', '{"cc_review_active":true}']) {
    const result = run(["gate", "--json"], { cwd: repo, env, input: payload });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {}, payload);
  }
});

test("gate total block ceiling bounds churning finding sets", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const findingEnv = (id) => ({
    ...baseEnv,
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "high",
      needs_changes: [{ id, severity: "high", location: "file.txt:1", summary: `Issue ${id}.`, required_action: "Fix." }],
      notes: [],
    }),
  });
  for (let i = 0; i < 5; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: findingEnv(`finding-${i}`), input: '{"turn_id":"churn"}' });
    assert.equal(JSON.parse(result.stdout).decision, "block", `block ${i}`);
  }
  const capped = run(["gate", "--json"], { cwd: repo, env: findingEnv("finding-5"), input: '{"turn_id":"churn"}' });
  const cappedParsed = JSON.parse(capped.stdout);
  assert.equal(cappedParsed.decision, undefined);
  assert.match(cappedParsed.systemMessage, /total block ceiling/);

  // A cap allow ends the stop chain and consumes the counters, so a later
  // unrelated task reusing the same coarse key is still gated.
  const nextTask = run(["gate", "--json"], { cwd: repo, env: findingEnv("unrelated"), input: '{"turn_id":"churn"}' });
  assert.equal(JSON.parse(nextTask.stdout).decision, "block");
});

test("gate stops blocking after repeated infrastructure failures", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const brokenEnv = {
    ...baseEnv,
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "prose", needs_changes: [], notes: [] }),
  };
  for (let i = 0; i < 2; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: brokenEnv, input: '{"turn_id":"infra"}' });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.decision, "block", `block ${i}`);
    assert.match(parsed.reason, /infrastructure failure/);
  }
  const released = run(["gate", "--json"], { cwd: repo, env: brokenEnv, input: '{"turn_id":"infra"}' });
  const releasedParsed = JSON.parse(released.stdout);
  assert.equal(releasedParsed.decision, undefined);
  assert.match(releasedParsed.systemMessage, /could not run after 3 attempts/);

  const cleanEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
  const clean = run(["gate", "--json"], { cwd: repo, env: cleanEnv, input: '{"turn_id":"infra"}' });
  assert.deepEqual(JSON.parse(clean.stdout), {});

  const failsAgain = run(["gate", "--json"], { cwd: repo, env: brokenEnv, input: '{"turn_id":"infra"}' });
  assert.equal(JSON.parse(failsAgain.stdout).decision, "block");
});

test("gate uses persisted block_on and resets after clean review", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--block-on", "medium", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const mediumFinding = {
    decision: "needs_changes",
    approved: false,
    max_severity: "medium",
    needs_changes: [{ id: "m1", severity: "medium", location: "file.txt:1", summary: "Medium issue.", required_action: "Fix." }],
    notes: [],
  };
  const mediumEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify(mediumFinding) };
  for (let i = 0; i < 3; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
    assert.equal(JSON.parse(result.stdout).decision, "block");
  }
  const capped = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
  const cappedParsed = JSON.parse(capped.stdout);
  assert.match(cappedParsed.systemMessage, /three-block convergence cap/);
  assert.match(cappedParsed.systemMessage, /file\.txt:1: Medium issue/);
  assert.doesNotMatch(cappedParsed.systemMessage, /decision/);

  const cleanEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
  const clean = run(["gate", "--json"], { cwd: repo, env: cleanEnv, input: '{"turn_id":"t1"}' });
  assert.deepEqual(JSON.parse(clean.stdout), {});

  const blocksAgain = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"t1"}' });
  assert.equal(JSON.parse(blocksAgain.stdout).decision, "block");
});

test("gate allows when not enabled", () => {
  const repo = makeGitRepo();
  const result = run(["gate", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "needs_changes", approved: false, max_severity: "high", needs_changes: [{ id: "h1", severity: "high", location: "x", summary: "x", required_action: "x" }], notes: [] }) },
    input: "{}",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("gate allow paths never emit invalid approve decision", () => {
  const source = readFileSync(new URL("../plugins/cc-review/scripts/cc-review-companion.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision:\s*["']approve["']/);
});

test("gate infrastructure errors fail closed with block decision", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  const result = run(["gate", "--json"], {
    cwd: repo,
    env: {
      ...env,
      CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
        decision: "approved",
        approved: true,
        max_severity: "prose",
        needs_changes: [],
        notes: [],
      }),
    },
    input: "{}",
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /infrastructure failure/);
});

test("background review job can be started, listed, and read", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "approved",
      approved: true,
      max_severity: "info",
      needs_changes: [],
      notes: ["ok"],
    }),
  };

  const started = run(["review", "--background", "--json"], { cwd: repo, env });
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
  assert.equal(JSON.parse(result.stdout).state, "completed");
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
sleep 10
echo '{"structured_output":{"decision":"approved","approved":true,"max_severity":"info","needs_changes":[],"notes":[]},"result":"ok"}'
`, { mode: 0o755 });
  const env = { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude, CC_REVIEW_CANCEL_GRACE_MS: "50" };
  const started = run(["review", "--background", "--json"], { cwd: repo, env });
  assert.equal(started.status, 0, started.stderr);
  const job = JSON.parse(started.stdout);
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
  const result = run(["review", "--wait"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Using bundled review guidelines/);
});

test("skills use skill-root companion path and unquoted arguments", () => {
  const skillRoot = new URL("../plugins/cc-review/skills", import.meta.url).pathname;
  for (const skill of readdirSync(skillRoot)) {
    const content = readFileSync(join(skillRoot, skill, "SKILL.md"), "utf8");
    assert.match(content, /<skill-root>\/\.\.\/\.\.\/scripts\/cc-review-companion\.mjs/);
    assert.doesNotMatch(content, /"\$ARGUMENTS"|\$\(pwd\)|CC_REVIEW_PLUGIN_ROOT|<skill dir>/);
  }
});

test("skill shell invocation preserves flags in ARGUMENTS", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);

  const skillRoot = new URL("../plugins/cc-review/skills/cc-review", import.meta.url).pathname;
  const content = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const command = content.match(/node "<skill-root>\/\.\.\/\.\.\/scripts\/cc-review-companion\.mjs" review \$ARGUMENTS/)?.[0];
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
  assert.equal(parsed.target.scope, "branch");
  assert.equal(parsed.target.base, "HEAD");
});

test("manifest wires Codex Stop hook", () => {
  const manifest = JSON.parse(readFileSync(new URL("../plugins/cc-review/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.hooks, "./hooks/codex-hooks.json");
  const hooks = JSON.parse(readFileSync(new URL("../plugins/cc-review/hooks/codex-hooks.json", import.meta.url), "utf8"));
  const command = hooks.hooks.Stop[0].hooks[0].command;
  assert.match(command, /\$\{PLUGIN_ROOT\}\/scripts\/stop-review-gate-hook\.mjs/);
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
  const dir = mkdtempSync(join(tmpdir(), "cc-review-test-"));
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
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.167 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'ok'; exit 0; fi\necho '{\"structured_output\":{\"decision\":\"approved\",\"approved\":true,\"max_severity\":\"info\",\"needs_changes\":[],\"notes\":[]},\"result\":\"ok\"}'\n", { mode: 0o755 });
  return {
    ...process.env,
    CC_REVIEW_CLAUDE_BIN: fakeClaude,
    XDG_STATE_HOME: join(repo, ".state"),
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
