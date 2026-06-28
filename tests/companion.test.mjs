import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
  assert.ok(action.path.endsWith(".claude/rules/review-guidelines.md"));
  assert.ok(existsSync(action.path));

  writeFileSync(action.path, "custom\n");
  const second = run(["setup", "--init-guidelines", "--json"], { cwd: repo, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(action.path, "utf8"), "custom\n");
  const secondParsed = JSON.parse(second.stdout);
  assert.equal(secondParsed.actions.find((item) => item.action === "init-guidelines").status, "skipped");
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
  assert.match(readFileSync(stdinFile, "utf8"), /You are Claude Code acting as a read-only independent reviewer/);
  assert.doesNotMatch(JSON.stringify(argv), /You are Claude Code/);
  // claude --json-schema silently drops structured output when the schema
  // carries a $schema meta key; the companion must strip it.
  const schemaArg = argv[argv.indexOf("--json-schema") + 1];
  const schema = JSON.parse(schemaArg);
  assert.equal(schema.$schema, undefined);
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
  assert.match(readFileSync(stdinFile, "utf8"), /You are Codex acting as a read-only independent reviewer/);
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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
  assert.equal("infra_failures" in state.tasks["no-infra"], false);
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

  const result = run(["gate", "--json", "--scope", "branch", "--base", "missing-ref"], { cwd: repo, env, input: "{}" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /could not prepare review/);
  assert.match(parsed.reason, /base ref is not a valid commit/);
  assert.doesNotMatch(parsed.reason, /fallback should not run/);
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
  assert.match(readFileSync(stdinFile, "utf8"), /degraded fallback reviewer/);
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

test("gate allows report-only when Claude and fallback review are unavailable", () => {
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
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /Allowing finalization without review coverage/);
  assert.match(parsed.systemMessage, /api_key= REDACTED/);
  assert.doesNotMatch(parsed.systemMessage, /secret-value/);
});

test("gate allows report-only when Codex and Claude fallback are unavailable", () => {
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
  const setup = run(["setup", "--enable-review-gate", "--json"], { cwd: repo, env });
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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

  // A high-severity style finding never blocks.
  writeFileSync(join(repo, "file.txt"), "style change\n");
  const styleEnv = { ...baseEnv, REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: decisionWith([
    { id: "style1", severity: "high", category: "style", location: "file.txt:1", summary: "Ugly.", required_action: "Prettify." },
  ]) };
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"),
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
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(join(repo, ".claude", "rules", "review-guidelines.md"), `# Rules

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

test("gate allows when not enabled", () => {
  const repo = makeGitRepo();
  const result = run(["gate", "--json"], {
    cwd: repo,
    env: { ...testEnv(repo), REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT: JSON.stringify(blockingOutput([
      finding({ id: "h1", locations: ["x"], message: "x", required_action: "x" }),
    ])) },
    input: "{}",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("gate allow paths never emit invalid approve decision", () => {
  const source = readFileSync(new URL("../plugins/review-loop/scripts/review-loop-companion.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /decision:\s*["']approve["']/);
});

test("gate infrastructure errors allow report-only when fallback also fails", () => {
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
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage, /Allowing finalization without review coverage/);
  assert.match(parsed.systemMessage, /reviewer output summary is required/);
  assert.match(parsed.systemMessage, /fallback unavailable/);
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
  const marketplace = JSON.parse(readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(marketplace.plugins[0].source, "./plugins/review-loop");
  const manifest = JSON.parse(readFileSync(new URL("../plugins/review-loop/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "review-loop");
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
  // Isolate HOME so a developer's real ~/.claude/rules/review-guidelines.md
  // cannot leak into guideline resolution during tests.
  mkdirSync(join(repo, ".home"), { recursive: true });
  const fakeClaude = join(bin, "claude");
  writeFileSync(fakeClaude, "#!/usr/bin/env sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.167 (Claude Code)'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'ok'; exit 0; fi\necho '{\"structured_output\":{\"decision\":\"approved\",\"summary\":\"ok\",\"findings\":[],\"required_next_actions\":[]},\"result\":\"ok\"}'\n", { mode: 0o755 });
  // State must live outside the worktree (as it does in production): the
  // gate's own state files are otherwise untracked files in the next review
  // target, perturbing it between runs.
  return {
    ...process.env,
    HOME: join(repo, ".home"),
    REVIEW_LOOP_CLAUDE_BIN: fakeClaude,
    XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "review-loop-state-")),
  };
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

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("condition was not met before timeout");
}
