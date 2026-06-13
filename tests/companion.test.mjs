import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
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
  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  assert.deepEqual(argv.slice(0, 5), ["-p", "--permission-mode", "plan", "--tools", "Read,Grep,Glob"]);
  assert.match(readFileSync(stdinFile, "utf8"), /You are Claude Code acting as a read-only reviewer/);
  assert.doesNotMatch(JSON.stringify(argv), /You are Claude Code/);
  // claude --json-schema silently drops structured output when the schema
  // carries a $schema meta key; the companion must strip it.
  const schemaArg = argv[argv.indexOf("--json-schema") + 1];
  const schema = JSON.parse(schemaArg);
  assert.equal(schema.$schema, undefined);
  assert.deepEqual(schema.properties.decision.enum, ["approved", "needs_changes"]);
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }, result: "ok" }));
});
`, { mode: 0o755 });

  const result = run(["review"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude, CC_REVIEW_MAX_DIFF_CHARS: "500" },
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

  const result = run(["review"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude, CC_REVIEW_CLAUDE_TIMEOUT_MS: "200" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
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
  console.log(JSON.stringify({ structured_output: { decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }, result: "ok" }));
});
`, { mode: 0o755 });

  const result = run(["review"], {
    cwd: repo,
    env: { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude },
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

  writeFileSync(join(repo, "file.txt"), "fixed content\n");
  const cleanEnv = { ...env, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
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
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "high",
      needs_changes: [{ id: "cached", severity: "high", location: "file.txt:1", summary: "Cached issue.", required_action: "Fix." }],
      notes: [],
    }),
  };
  const first = run(["gate", "--json"], { cwd: repo, env: blockingEnv, input: '{"turn_id":"cache"}' });
  assert.equal(JSON.parse(first.stdout).decision, "block");

  // Same tree, reviewer would now approve — but the cached verdict is reused,
  // proving no second review ran for identical input.
  const approvingEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
  const cachedRun = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"cache"}' });
  assert.equal(JSON.parse(cachedRun.stdout).decision, "block");

  // A changed tree misses the cache and gets the fresh verdict.
  writeFileSync(join(repo, "file.txt"), "actually fixed\n");
  const fresh = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"cache"}' });
  assert.deepEqual(JSON.parse(fresh.stdout), {});
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
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const blockingEnv = {
    ...baseEnv,
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "high",
      needs_changes: [{ id: "tail", severity: "high", location: "long.txt:230", summary: "Issue past the preview.", required_action: "Fix." }],
      notes: [],
    }),
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
  const approvingEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
  const fixed = run(["gate", "--json"], { cwd: repo, env: approvingEnv, input: '{"turn_id":"tail"}' });
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
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1", CC_REVIEW_GATE_CHAIN_GAP_MS: "1" };
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
  // Six unkeyed stops separated by more than the chain gap stay independent
  // tasks: each gets a fresh budget and blocks instead of hitting a ceiling.
  for (let i = 0; i < 6; i += 1) {
    const result = run(["gate", "--json"], { cwd: repo, env: findingEnv(`finding-${i}`), input: "{}" });
    assert.equal(JSON.parse(result.stdout).decision, "block", `block ${i}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  writeFileSync(join(repo, "file.txt"), "changed once more\n");
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

  writeFileSync(join(repo, "file.txt"), "fixed for clean review\n");
  const cleanEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }) };
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "high", "category_block_on": { "security": "low", "style": "never" } }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const decisionWith = (findings) => JSON.stringify({
    decision: "needs_changes",
    approved: false,
    max_severity: "high",
    needs_changes: findings,
    notes: [],
  });

  // A low-severity security finding blocks because the category threshold is low.
  const securityEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "sec1", severity: "low", category: "security", location: "file.txt:1", summary: "Leaky.", required_action: "Fix." },
  ]) };
  const secBlock = run(["gate", "--json"], { cwd: repo, env: securityEnv, input: '{"turn_id":"sec"}' });
  assert.equal(JSON.parse(secBlock.stdout).decision, "block");
  assert.match(JSON.parse(secBlock.stdout).reason, /Leaky/);

  // A high-severity style finding never blocks.
  writeFileSync(join(repo, "file.txt"), "style change\n");
  const styleEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "style1", severity: "high", category: "style", location: "file.txt:1", summary: "Ugly.", required_action: "Prettify." },
  ]) };
  const styleAllow = run(["gate", "--json"], { cwd: repo, env: styleEnv, input: '{"turn_id":"style"}' });
  assert.deepEqual(JSON.parse(styleAllow.stdout), {});

  // Uncategorized findings use the base threshold from the policy.
  writeFileSync(join(repo, "file.txt"), "medium change\n");
  const mediumEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "m1", severity: "medium", location: "file.txt:1", summary: "Meh.", required_action: "Fix." },
  ]) };
  const mediumAllow = run(["gate", "--json"], { cwd: repo, env: mediumEnv, input: '{"turn_id":"med"}' });
  assert.deepEqual(JSON.parse(mediumAllow.stdout), {});
});

test("explicit setup block_on overrides the guidelines policy", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "high" }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  const setup = run(["setup", "--enable-review-gate", "--block-on", "low", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const lowEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
    decision: "needs_changes",
    approved: false,
    max_severity: "low",
    needs_changes: [{ id: "l1", severity: "low", location: "file.txt:1", summary: "Small.", required_action: "Fix." }],
    notes: [],
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "low", "category_block_on": { "security": "medium" } }
\`\`\`
`);
  const baseEnv = { ...testEnv(repo), CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1" };
  // Explicit high base overrides the policy's low base...
  const setup = run(["setup", "--enable-review-gate", "--block-on", "high", "--json"], { cwd: repo, env: baseEnv });
  assert.equal(setup.status, 0, setup.stderr);

  const mediumSecurityEnv = { ...baseEnv, CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
    decision: "needs_changes",
    approved: false,
    max_severity: "medium",
    needs_changes: [
      { id: "sec", severity: "medium", category: "security", location: "file.txt:1", summary: "Leaky.", required_action: "Fix." },
      { id: "plain", severity: "medium", location: "file.txt:2", summary: "Meh.", required_action: "Fix." },
    ],
    notes: [],
  }) };
  // ...but the category override still blocks the medium security finding,
  // while the uncategorized medium finding is held to the explicit high base.
  const blocked = run(["gate", "--json"], { cwd: repo, env: mediumSecurityEnv, input: '{"turn_id":"mix"}' });
  const parsed = JSON.parse(blocked.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Leaky/);
  assert.doesNotMatch(parsed.reason, /Meh/);
});

test("legacy gate config default does not shadow the guidelines policy", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "medium" }
\`\`\`
`);
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1",
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({
      decision: "needs_changes",
      approved: false,
      max_severity: "medium",
      needs_changes: [{ id: "m", severity: "medium", location: "file.txt:1", summary: "Medium issue.", required_action: "Fix." }],
      notes: [],
    }),
  };
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  // Simulate a pre-policy config: block_on stored unconditionally, no marker.
  const configPath = JSON.parse(setup.stdout).actions.find((item) => item.action === "enable-review-gate").path;
  const legacy = JSON.parse(readFileSync(configPath, "utf8"));
  legacy.block_on = "high";
  delete legacy.block_on_explicit;
  writeFileSync(configPath, JSON.stringify(legacy));

  const blocked = run(["gate", "--json"], { cwd: repo, env, input: '{"turn_id":"legacy"}' });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
});

test("malformed guidelines policy fails closed at the gate", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

\`\`\`json cc-review
{ "block_on": "catastrophic" }
\`\`\`
`);
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1",
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }),
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
    CC_REVIEW_FORCE_MAIN_AGENT_HOOK: "1",
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }),
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
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.state, "completed");
  assert.equal(typeof completed.pid, "number");
});

test("cancel of a completed job preserves the result", async () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo, "file.txt"), "changed\n");
  runGit(["add", "file.txt"], repo);
  runGit(["commit", "-m", "init"], repo);
  writeFileSync(join(repo, "file.txt"), "changed again\n");
  const env = {
    ...testEnv(repo),
    CC_REVIEW_FAKE_STRUCTURED_OUTPUT: JSON.stringify({ decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes: [] }),
  };
  const started = run(["review", "--background", "--json"], { cwd: repo, env });
  const job = JSON.parse(started.stdout);
  await waitFor(() => {
    const status = run(["status", job.id, "--json"], { cwd: repo, env });
    return JSON.parse(status.stdout).jobs[0]?.state === "completed";
  });
  const cancelled = run(["cancel", job.id, "--json"], { cwd: repo, env });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).state, "completed");
  const result = run(["result", job.id, "--json"], { cwd: repo, env });
  assert.equal(JSON.parse(result.stdout).result.decision.approved, true);
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
  const env = { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude, CC_REVIEW_CANCEL_GRACE_MS: "300" };
  const started = run(["review", "--background", "--json"], { cwd: repo, env });
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
  const env = { ...testEnv(repo), CC_REVIEW_CLAUDE_BIN: fakeClaude, CC_REVIEW_CANCEL_GRACE_MS: "50" };
  const started = run(["review", "--background", "--json"], { cwd: repo, env });
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
  // Isolate HOME so a developer's real ~/.claude/rules/review-guidelines.md
  // cannot leak into guideline resolution during tests.
  mkdirSync(join(repo, ".home"), { recursive: true });
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.167 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'ok'; exit 0; fi\necho '{\"structured_output\":{\"decision\":\"approved\",\"approved\":true,\"max_severity\":\"info\",\"needs_changes\":[],\"notes\":[]},\"result\":\"ok\"}'\n", { mode: 0o755 });
  // State must live outside the worktree (as it does in production): the
  // gate's own state files are otherwise untracked files in the next review
  // target, perturbing it between runs.
  return {
    ...process.env,
    HOME: join(repo, ".home"),
    CC_REVIEW_CLAUDE_BIN: fakeClaude,
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "cc-review-state-")),
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
