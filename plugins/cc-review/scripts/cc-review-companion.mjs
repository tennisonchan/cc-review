#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "schemas", "review-output.schema.json");
const TEMPLATE_GUIDELINES = join(ROOT, "templates", "review-guidelines.md");
const SEVERITIES = ["info", "low", "medium", "high"];
const DEFAULT_BLOCK_ON = "high";
const GATE_FINGERPRINT_BLOCK_LIMIT = 3;
const GATE_TOTAL_BLOCK_LIMIT = 5;
const GATE_INFRA_FAILURE_BLOCK_LIMIT = 2;
const GATE_CHAIN_GAP_MS = 10 * 60 * 1000;
const DEFAULT_MAX_DIFF_CHARS = 200 * 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".jsx", ".json", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql",
  ".ts", ".tsx", ".txt", ".yaml", ".yml", ".toml", ".xml",
]);

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cc-review: ${message}`);
  process.exitCode = 1;
});

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "__run-job") {
    await runBackgroundJob(rest[0]);
    return;
  }

  const args = parseArgs(rest);
  switch (command) {
    case "setup":
      await setup(args);
      break;
    case "review":
      await reviewCommand("review", args);
      break;
    case "adversarial-review":
      await reviewCommand("adversarial-review", args);
      break;
    case "status":
      await statusCommand(args);
      break;
    case "result":
      await resultCommand(args);
      break;
    case "cancel":
      await cancelCommand(args);
      break;
    case "gate":
      await gateCommand(args);
      break;
    default:
      throw new Error(`unknown subcommand: ${command}`);
  }
}

function printHelp() {
  console.log(`Usage: cc-review-companion <subcommand> [options]

Subcommands:
  setup
  review
  adversarial-review
  status
  result
  cancel
  gate`);
}

function parseArgs(argv) {
  const args = {
    all: false,
    background: false,
    base: null,
    blockOn: null,
    force: false,
    guidelines: null,
    initGuidelines: false,
    json: false,
    scope: "auto",
    wait: false,
    enableReviewGate: false,
    disableReviewGate: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--all":
        args.all = true;
        break;
      case "--background":
        args.background = true;
        break;
      case "--wait":
        args.wait = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--init-guidelines":
        args.initGuidelines = true;
        break;
      case "--enable-review-gate":
        args.enableReviewGate = true;
        break;
      case "--disable-review-gate":
        args.disableReviewGate = true;
        break;
      case "--base":
      case "--guidelines":
      case "--scope":
      case "--block-on": {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        if (arg === "--base") args.base = value;
        if (arg === "--guidelines") args.guidelines = value;
        if (arg === "--scope") args.scope = value;
        if (arg === "--block-on") args.blockOn = value;
        break;
      }
      default:
        args.positional.push(arg);
        break;
    }
  }

  if (!["auto", "working-tree", "branch"].includes(args.scope)) {
    throw new Error(`invalid --scope: ${args.scope}`);
  }
  if (args.blockOn) assertSeverity(args.blockOn, "--block-on");
  return args;
}

async function setup(args) {
  const repo = resolveWorkspace();
  const checks = {
    node: checkCommand(process.execPath, ["--version"]),
    claude: checkCommand(claudeBin(), ["--version"]),
    claudeAuthText: checkCommand(claudeBin(), ["auth", "status", "--text"]),
    claudeAuthJson: checkCommand(claudeBin(), ["auth", "status", "--json"]),
  };
  const actions = [];

  if (args.initGuidelines) {
    actions.push(initGuidelines(repo.root, args.force));
  }

  if (args.disableReviewGate) {
    const config = gateConfigPath(repo.root);
    if (existsSync(config)) rmSync(config);
    actions.push({ action: "disable-review-gate", status: "disabled", path: config });
  }

  if (args.enableReviewGate) {
    const support = detectMainAgentGateSupport();
    if (!support.supported) {
      actions.push({
        action: "enable-review-gate",
        status: "unsupported",
        reason: support.reason,
        recommendation: "Use cc-review --wait before finalization.",
      });
    } else {
      const config = gateConfigPath(repo.root);
      mkdirSync(dirname(config), { recursive: true });
      const payload = {
        enabled: true,
        event: support.event,
        block_on: args.blockOn || DEFAULT_BLOCK_ON,
        installed_at: new Date().toISOString(),
        companion: fileURLToPath(import.meta.url),
      };
      writeJson(config, payload);
      actions.push({
        action: "enable-review-gate",
        status: "enabled",
        event: support.event,
        block_on: args.blockOn || DEFAULT_BLOCK_ON,
        path: config,
        artifact_root: jobsDir(repo.root),
      });
    }
  }

  const result = {
    ok: checks.node.ok && checks.claude.ok,
    repo: repo.root,
    checks,
    actions,
  };
  output(result, args.json, renderSetup);
}

function initGuidelines(repoRoot, force) {
  const dest = join(repoRoot, ".claude", "rules", "review-guidelines.md");
  if (existsSync(dest) && !force) {
    return { action: "init-guidelines", status: "skipped", path: dest, reason: "already exists" };
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(TEMPLATE_GUIDELINES, dest);
  return { action: "init-guidelines", status: existsSync(dest) ? "created_or_overwritten" : "created", path: dest };
}

async function reviewCommand(kind, args) {
  if (args.background) {
    const job = await startBackgroundReview(kind, args);
    output(job, args.json, (value) => `Started cc-review job ${value.id}\nState: ${value.state}\n`);
    return;
  }
  const result = await runReview({ kind, args, cwd: process.cwd(), gate: false });
  output(result, args.json, renderReviewResult);
}

async function runReview({ kind, args, cwd, gate }) {
  const repo = resolveWorkspace(cwd);
  const guidelines = resolveGuidelines(args.guidelines, cwd, repo.root);
  const target = collectReviewTarget(repo.root, args);

  if (target.empty) {
    return {
      ok: true,
      repo: repo.root,
      guidelines,
      target,
      decision: approvedDecision(["Nothing to review."]),
      raw: "",
    };
  }

  const focus = kind === "adversarial-review" ? args.positional.join(" ").trim() : "";
  const prompt = buildPrompt({ kind, guidelines, target, focus });
  const claude = await runClaude(prompt);
  const decision = validateDecision(claude.structuredOutput);
  return {
    ok: decision.approved,
    repo: repo.root,
    guidelines,
    target,
    decision,
    raw: claude.resultText,
    claude: claude.meta,
  };
}

function buildPrompt({ kind, guidelines, target, focus }) {
  const mode = kind === "adversarial-review" ? "adversarial challenge review" : "code review";
  return [
    "You are Claude Code acting as a read-only reviewer for Codex.",
    "Non-overridable safety: do not edit files, write files, apply patches, commit, run destructive commands, or continue into implementation.",
    "You may use Read, Grep, and Glob to inspect surrounding code for context.",
    "Return findings only. Use the requested structured output schema exactly.",
    "",
    `Review mode: ${mode}`,
    focus ? `Focus: ${focus}` : "",
    "",
    "Review guidelines:",
    guidelines.content,
    "",
    "Review target:",
    target.content,
  ].filter(Boolean).join("\n");
}

async function runClaude(prompt) {
  if (process.env.CC_REVIEW_FAKE_STRUCTURED_OUTPUT) {
    const structuredOutput = JSON.parse(process.env.CC_REVIEW_FAKE_STRUCTURED_OUTPUT);
    return { structuredOutput, resultText: "", meta: { fake: true } };
  }

  // Read-only context tools so the reviewer can see beyond the diff (the
  // enclosing function, callers, tests); plan mode prevents writes.
  const args = ["-p", "--permission-mode", "plan", "--tools", "Read,Grep,Glob", "--output-format", "json", "--json-schema", readFileSync(SCHEMA_PATH, "utf8")];

  const child = spawn(claudeBin(), args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(prompt);

  const timeoutMs = Number(process.env.CC_REVIEW_CLAUDE_TIMEOUT_MS || DEFAULT_CLAUDE_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }, timeoutMs);
  timer.unref();

  const status = await new Promise((resolveStatus) => {
    // "close" waits for stdio to drain, which is right for the happy path,
    // but a killed claude can leave grandchildren holding the pipes open —
    // after a timeout, the process exit is all we need.
    child.on("close", (code) => resolveStatus(code));
    child.on("exit", (code) => {
      if (timedOut) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        resolveStatus(code);
      }
    });
  });
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(`claude review timed out after ${Math.round(timeoutMs / 1000)}s`);
  }
  if (status !== 0) {
    throw new Error(`claude review failed with exit ${status}: ${redact(stderr || stdout)}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude structured output was not JSON: ${redact(stdout.slice(0, 500))}`);
  }

  if (!envelope.structured_output) {
    throw new Error("claude JSON envelope did not include structured_output");
  }

  return {
    structuredOutput: envelope.structured_output,
    resultText: envelope.result || "",
    meta: {
      status,
      session_id: envelope.session_id,
      stop_reason: envelope.stop_reason,
      terminal_reason: envelope.terminal_reason,
    },
  };
}

function resolveWorkspace(cwd = process.cwd()) {
  const rootResult = git(["rev-parse", "--show-toplevel"], { cwd, optional: true });
  return { root: rootResult.ok ? rootResult.stdout.trim() : cwd };
}

function collectReviewTarget(repoRoot, args) {
  const scope = args.scope === "auto" ? (args.base ? "branch" : "working-tree") : args.scope;
  if (scope === "branch") {
    const base = args.base || "main";
    const baseCheck = git(["rev-parse", "--verify", `${base}^{commit}`], { cwd: repoRoot, optional: true });
    if (!baseCheck.ok) {
      throw new Error(`base ref is not a valid commit: ${base}`);
    }
    const stat = git(["diff", "--stat", `${base}...HEAD`], { cwd: repoRoot });
    const diff = git(["diff", `${base}...HEAD`], { cwd: repoRoot });
    const content = [
      `scope: branch`,
      `base: ${base}`,
      "",
      "diff stat:",
      stat.stdout,
      "",
      "diff:",
      truncateForPrompt(diff.stdout, "diff"),
    ].join("\n");
    return {
      scope,
      base,
      empty: !stat.stdout.trim() && !diff.stdout.trim(),
      content,
    };
  }

  const status = git(["status", "--short", "--untracked-files=all"], { cwd: repoRoot, optional: true });
  const staged = git(["diff", "--cached"], { cwd: repoRoot, optional: true });
  const unstaged = git(["diff"], { cwd: repoRoot, optional: true });
  const untracked = collectUntrackedPreviews(repoRoot);
  const content = [
    "scope: working-tree",
    "",
    "status:",
    status.stdout,
    "",
    "staged diff:",
    truncateForPrompt(staged.stdout, "staged diff"),
    "",
    "unstaged diff:",
    truncateForPrompt(unstaged.stdout, "unstaged diff"),
    "",
    "untracked file previews:",
    untracked,
  ].join("\n");
  return {
    scope,
    empty: !status.stdout.trim() && !staged.stdout.trim() && !unstaged.stdout.trim() && !untracked.trim(),
    content,
  };
}

function collectUntrackedPreviews(repoRoot) {
  const listed = git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, optional: true });
  if (!listed.stdout) return "";
  const allFiles = listed.stdout.split("\0").filter(Boolean);
  const files = allFiles.slice(0, 20);
  const previews = files.map((file) => {
    const full = join(repoRoot, file);
    if (!isProbablyText(full)) return `--- ${file}\n[binary or unsupported preview omitted]`;
    let lines;
    try {
      lines = readFileSync(full, "utf8").split("\n");
    } catch {
      return `--- ${file}\n[unreadable; preview omitted]`;
    }
    const content = lines.slice(0, 200).join("\n");
    const suffix = lines.length > 200 ? "\n[preview truncated after 200 lines]" : "";
    return `--- ${file}\n${content}${suffix}`;
  });
  if (allFiles.length > files.length) {
    previews.push(`[untracked preview truncated: ${allFiles.length - files.length} additional files omitted]`);
  }
  return previews.join("\n\n");
}

function truncateForPrompt(text, label) {
  const limit = Number(process.env.CC_REVIEW_MAX_DIFF_CHARS || DEFAULT_MAX_DIFF_CHARS);
  if (text.length <= limit) return text;
  // Read/Grep cannot reconstruct the base side of omitted hunks, so the full
  // diff is spilled to a file the reviewer can Read in chunks.
  const overflowPath = writeOverflowFile(label, text);
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n[${label} truncated: ${omitted} characters omitted; the complete ${label} is saved at ${overflowPath} — use the Read tool on that file to review the remainder]`;
}

function writeOverflowFile(label, text) {
  const dir = join(stateRoot(), "overflow");
  mkdirSync(dir, { recursive: true });
  pruneOldFiles(dir);
  const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${label.replace(/[^a-z0-9]+/gi, "-")}.diff`);
  writeFileSync(file, text);
  return file;
}

function pruneOldFiles(dir) {
  for (const entry of readdirSync(dir)) {
    try {
      const path = join(dir, entry);
      if (Date.now() - statSync(path).mtimeMs > 24 * 60 * 60 * 1000) rmSync(path);
    } catch {}
  }
}

function isProbablyText(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return false;
    const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
    if (TEXT_EXTENSIONS.has(ext)) return true;
    const sample = readFileSync(path).subarray(0, 1024);
    return !sample.includes(0);
  } catch {
    return false;
  }
}

function resolveGuidelines(explicit, cwd, repoRoot) {
  const candidates = [];
  if (explicit) {
    candidates.push({ path: isAbsolute(explicit) ? explicit : resolve(cwd, explicit), source: "explicit" });
  }

  let cursor = cwd;
  while (isWithinPath(cursor, repoRoot)) {
    candidates.push({ path: join(cursor, ".claude", "rules", "review-guidelines.md"), source: "project" });
    if (cursor === repoRoot) break;
    cursor = dirname(cursor);
  }

  candidates.push({ path: join(homedir(), ".claude", "rules", "review-guidelines.md"), source: "user" });
  candidates.push({ path: TEMPLATE_GUIDELINES, source: "bundled" });

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return {
        source: candidate.source,
        path: candidate.path,
        displayPath: relative(repoRoot, candidate.path).startsWith("..") ? candidate.path : relative(repoRoot, candidate.path),
        content: readFileSync(candidate.path, "utf8"),
      };
    }
  }
  throw new Error("no review guidelines found");
}

async function startBackgroundReview(kind, args) {
  const repo = resolveWorkspace();
  const id = `ccr-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dir = jobsDir(repo.root);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `${id}.json`);
  const job = {
    id,
    kind,
    cwd: process.cwd(),
    args,
    state: "queued",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    pid: null,
  };
  writeJson(jobPath, job);

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__run-job", jobPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  job.pid = child.pid;
  job.state = "running";
  job.updated_at = new Date().toISOString();
  writeJson(jobPath, job);
  child.unref();
  return job;
}

async function runBackgroundJob(jobPath) {
  if (!jobPath) throw new Error("__run-job requires a job path");
  const job = readJson(jobPath);
  job.state = "running";
  job.updated_at = new Date().toISOString();
  writeJson(jobPath, job);
  try {
    const result = await runReview({ kind: job.kind, args: job.args, cwd: job.cwd, gate: false });
    job.state = "completed";
    job.result = result;
    job.exit_code = 0;
  } catch (error) {
    job.state = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.exit_code = 1;
  }
  job.completed_at = new Date().toISOString();
  job.updated_at = job.completed_at;
  writeJson(jobPath, job);
}

async function statusCommand(args) {
  const repo = resolveWorkspace();
  const jobs = listJobs(repo.root);
  const selected = args.positional[0]
    ? jobs.filter((job) => job.id === args.positional[0])
    : args.all ? jobs : jobs.slice(0, 10);
  output({ jobs: selected }, args.json, (value) => {
    if (!value.jobs.length) return "No cc-review jobs found.\n";
    return value.jobs.map((job) => `${job.id}\t${job.state}\t${job.updated_at}`).join("\n") + "\n";
  });
}

async function resultCommand(args) {
  const repo = resolveWorkspace();
  const jobs = listJobs(repo.root);
  const id = args.positional[0] || jobs[0]?.id;
  if (!id) throw new Error("no job id provided and no jobs found");
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`job not found: ${id}`);
  output(job, args.json, (value) => {
    if (value.result) return renderReviewResult(value.result);
    if (value.error) return `Job ${value.id} failed:\n${value.error}\n`;
    return `Job ${value.id} is ${value.state}.\n`;
  });
}

async function cancelCommand(args) {
  const repo = resolveWorkspace();
  const jobs = listJobs(repo.root);
  const id = args.positional[0] || jobs.find((job) => job.state === "running")?.id;
  if (!id) throw new Error("no job id provided and no running job found");
  const jobPath = join(jobsDir(repo.root), `${id}.json`);
  const job = readJson(jobPath);
  if (job.pid) {
    signalProcessTree(job.pid, "SIGTERM");
    await new Promise((resolveWait) => setTimeout(resolveWait, Number(process.env.CC_REVIEW_CANCEL_GRACE_MS || 500)));
    signalProcessTree(job.pid, "SIGKILL");
    job.kill_escalated = true;
  }
  job.state = "cancelled";
  job.updated_at = new Date().toISOString();
  writeJson(jobPath, job);
  output(job, args.json, (value) => `Cancelled ${value.id}.\n`);
}

async function gateCommand(args) {
  const hookPayload = await readStdinJson();
  // Recursion sentinels: a review already in flight must not start another.
  // stop_hook_active is deliberately NOT checked — stops that follow a block
  // are re-reviewed so fixes get verified; the per-task counters bound them.
  if (hookPayload?.hook_active || hookPayload?.cc_review_active) {
    outputHookAllow();
    return;
  }

  const repo = resolveWorkspace();
  const config = readGateConfig(repo.root);
  if (!config?.enabled) {
    outputHookAllow();
    return;
  }

  const blockOn = config.block_on || args.blockOn || DEFAULT_BLOCK_ON;
  assertSeverity(blockOn, "gate block_on");
  const taskKey = gateTaskKey(hookPayload);
  const state = readGateState(repo.root);
  const taskState = freshTaskState(state.tasks[taskKey]);

  let result;
  try {
    result = await runReview({ kind: "review", args: { ...args, json: true, positional: [] }, cwd: process.cwd(), gate: true });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    taskState.infra_failures = Number(taskState.infra_failures || 0) + 1;
    taskState.updated_at = new Date().toISOString();
    if (taskState.infra_failures > GATE_INFRA_FAILURE_BLOCK_LIMIT) {
      // A cap allow ends the stop chain, so consume the counters; the next
      // stop under the same coarse key is a new task and stays gated.
      delete state.tasks[taskKey];
      writeGateState(repo.root, state);
      outputHookAllow(`cc-review could not run after ${taskState.infra_failures} attempts; allowing finalization without review. Last failure:\n${message}`);
      return;
    }
    state.tasks[taskKey] = taskState;
    writeGateState(repo.root, state);
    outputHookBlock(`cc-review infrastructure failure: ${message}`);
    return;
  }

  taskState.infra_failures = 0;
  const blocking = blockingFindings(result.decision, blockOn);
  if (!blocking.length) {
    delete state.tasks[taskKey];
    writeGateState(repo.root, state);
    outputHookAllow();
    return;
  }

  // Reset the same-fingerprint count when Claude reports a different finding
  // set; the total ceiling bounds churn when findings change on every run.
  const fingerprint = blocking.map((finding) => finding.id).sort().join("|");
  taskState.block_count = taskState.fingerprint === fingerprint ? Number(taskState.block_count || 0) + 1 : 1;
  taskState.fingerprint = fingerprint;
  taskState.total_blocks = Number(taskState.total_blocks || 0) + 1;
  taskState.last_blocked_at = new Date().toISOString();
  taskState.updated_at = taskState.last_blocked_at;
  taskState.last_findings = blocking.map((finding) => finding.id);

  const reason = blocking.map((finding) => `[${finding.severity}] ${finding.location}: ${finding.summary}`).join("\n");
  const cap = taskState.block_count > GATE_FINGERPRINT_BLOCK_LIMIT
    ? "cc-review reached the three-block convergence cap."
    : taskState.total_blocks > GATE_TOTAL_BLOCK_LIMIT
      ? "cc-review reached the total block ceiling for this task."
      : null;
  if (cap) {
    // A cap allow ends the stop chain, so consume the counters; the next
    // stop under the same coarse key is a new task and stays gated.
    delete state.tasks[taskKey];
    writeGateState(repo.root, state);
    outputHookAllow(`${cap} Report-only unresolved findings:\n${reason}`);
    return;
  }
  state.tasks[taskKey] = taskState;
  writeGateState(repo.root, state);
  outputHookBlock(`cc-review needs_changes:\n${reason}`);
}

function freshTaskState(taskState) {
  const empty = { block_count: 0, fingerprint: "", total_blocks: 0, infra_failures: 0 };
  if (!taskState) return empty;
  // Every key is a coarse task proxy (session_id and thread_id span many
  // tasks; the default key spans everything), so counters are scoped to the
  // live stop chain by recency: blocks in one chain arrive minutes apart,
  // while a later unrelated task deserves its own cap budget.
  const gap = Number(process.env.CC_REVIEW_GATE_CHAIN_GAP_MS || GATE_CHAIN_GAP_MS);
  const updatedAt = Date.parse(taskState.updated_at || taskState.last_blocked_at || "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > gap) return empty;
  return taskState;
}

function blockingFindings(decision, blockOn) {
  const threshold = SEVERITIES.indexOf(blockOn);
  return decision.needs_changes.filter((finding) => SEVERITIES.indexOf(finding.severity) >= threshold);
}

function validateDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("structured_output must be an object");
  }
  if (!["approved", "needs_changes"].includes(value.decision)) {
    throw new Error("structured_output.decision must be approved or needs_changes");
  }
  if (typeof value.approved !== "boolean") {
    throw new Error("structured_output.approved must be boolean");
  }
  assertSeverity(value.max_severity, "structured_output.max_severity");
  if (!Array.isArray(value.needs_changes)) {
    throw new Error("structured_output.needs_changes must be an array");
  }
  for (const finding of value.needs_changes) {
    if (!finding || typeof finding !== "object") throw new Error("finding must be an object");
    if (!finding.id) throw new Error("finding.id is required");
    assertSeverity(finding.severity, "finding.severity");
    if (typeof finding.location !== "string") throw new Error("finding.location must be a string");
    if (!finding.summary) throw new Error("finding.summary is required");
    if (!finding.required_action) throw new Error("finding.required_action is required");
  }
  if (!Array.isArray(value.notes)) {
    throw new Error("structured_output.notes must be an array");
  }
  return value;
}

function approvedDecision(notes = []) {
  return { decision: "approved", approved: true, max_severity: "info", needs_changes: [], notes };
}

function assertSeverity(value, label) {
  if (!SEVERITIES.includes(value)) {
    throw new Error(`${label} must be one of: ${SEVERITIES.join(", ")}`);
  }
}

function detectMainAgentGateSupport() {
  if (process.env.CC_REVIEW_HOOK_EVENTS) {
    const events = process.env.CC_REVIEW_HOOK_EVENTS.split(/[,\s]+/).filter(Boolean);
    const event = events.find((candidate) => ["main_agent_finalization", "stop", "session_stop"].includes(candidate));
    if (event) return { supported: true, event, source: "CC_REVIEW_HOOK_EVENTS" };
    if (events.includes("subagent_stop")) {
      return { supported: false, reason: "Only subagent_stop is available; main-agent finalization gating is unsupported." };
    }
  }
  if (process.env.CC_REVIEW_FORCE_MAIN_AGENT_HOOK === "1") {
    return { supported: true, event: "main_agent_finalization", source: "CC_REVIEW_FORCE_MAIN_AGENT_HOOK" };
  }
  const bundledHookConfig = join(ROOT, "hooks", "codex-hooks.json");
  if (existsSync(bundledHookConfig)) {
    const hooks = readJson(bundledHookConfig).hooks || {};
    if (Array.isArray(hooks.Stop) && hooks.Stop.length > 0) {
      return { supported: true, event: "Stop", source: bundledHookConfig };
    }
  }
  return {
    supported: false,
    reason: "No proven main-agent finalization hook is available in this Codex version.",
  };
}

function isWithinPath(candidate, root) {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function readGateConfig(repoRoot) {
  const config = gateConfigPath(repoRoot);
  return existsSync(config) ? readJson(config) : null;
}

function readGateState(repoRoot) {
  const statePath = gateStatePath(repoRoot);
  if (!existsSync(statePath)) return { tasks: {} };
  const state = readJson(statePath);
  if (!state.tasks) return { tasks: { default: state } };
  return state;
}

function writeGateState(repoRoot, state) {
  writeJson(gateStatePath(repoRoot), state);
}

function gateTaskKey(hookPayload) {
  return hookPayload?.turn_id || hookPayload?.session_id || hookPayload?.thread_id || "default";
}

function signalProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch {}
  }
}

function renderSetup(value) {
  const lines = [];
  lines.push(`Node: ${value.checks.node.ok ? value.checks.node.stdout.trim() : "missing"}`);
  lines.push(`Claude: ${value.checks.claude.ok ? value.checks.claude.stdout.trim() : "missing"}`);
  if (!value.checks.claude.ok) lines.push("Run: install Claude Code and authenticate with claude auth login");
  if (value.checks.claude.ok && !value.checks.claudeAuthText.ok && !value.checks.claudeAuthJson.ok) {
    lines.push("Claude authentication: not authenticated. Run: claude auth login");
  } else if (value.checks.claudeAuthText.ok || value.checks.claudeAuthJson.ok) {
    lines.push("Claude authentication: available");
  }
  for (const action of value.actions) {
    if (action.action === "init-guidelines") lines.push(`Guidelines ${action.status}: ${action.path}`);
    if (action.action === "enable-review-gate") {
      if (action.status === "enabled") {
        lines.push(`Review gate enabled on ${action.event}; block_on=${action.block_on}; config=${action.path}`);
      } else {
        lines.push(`Review gate not enabled: ${action.reason}`);
        lines.push(action.recommendation);
      }
    }
    if (action.action === "disable-review-gate") lines.push(`Review gate disabled: ${action.path}`);
  }
  return lines.join("\n") + "\n";
}

function renderReviewResult(value) {
  const lines = [];
  if (value.guidelines.source === "bundled") {
    lines.push("Using bundled review guidelines. Run `cc-review-setup --init-guidelines` to customize.");
  } else {
    lines.push(`Using review guidelines: ${value.guidelines.displayPath}`);
  }
  lines.push(`Decision: ${value.decision.decision}`);
  lines.push(`Max severity: ${value.decision.max_severity}`);
  if (value.decision.needs_changes.length) {
    lines.push("");
    lines.push("Needs changes:");
    for (const finding of value.decision.needs_changes) {
      lines.push(`- [${finding.severity}] ${finding.location}: ${finding.summary}`);
      lines.push(`  Required action: ${finding.required_action}`);
    }
  }
  if (value.decision.notes?.length) {
    lines.push("");
    lines.push("Notes:");
    for (const note of value.decision.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n") + "\n";
}

function output(value, json, renderer) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(renderer(value));
  }
}

function outputHook(value) {
  console.log(JSON.stringify(value));
}

function outputHookAllow(systemMessage) {
  outputHook(systemMessage ? { systemMessage } : {});
}

function outputHookBlock(reason) {
  outputHook({ decision: "block", reason });
}

function listJobs(repoRoot) {
  const dir = jobsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(join(dir, file)))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function jobsDir(repoRoot) {
  return join(stateRoot(), "jobs", repoHash(repoRoot));
}

function gateConfigPath(repoRoot) {
  return join(stateRoot(), "gates", `${repoHash(repoRoot)}.json`);
}

function gateStatePath(repoRoot) {
  return join(stateRoot(), "gate-state", `${repoHash(repoRoot)}.json`);
}

function stateRoot() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cc-review");
}

function repoHash(repoRoot) {
  return createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: redact(result.stderr || ""),
  };
}

function git(args, { cwd, optional = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Spawn errors (ENOBUFS on a giant diff, ENOENT) must throw even for
  // optional calls: treating truncated output as "no changes" would let the
  // gate approve a review target it never saw.
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0 && !optional) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function claudeBin() {
  return process.env.CC_REVIEW_CLAUDE_BIN || "claude";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readStdinJson() {
  const raw = await new Promise((resolveRead) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveRead(data));
  });
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-REDACTED")
    .replace(/(token|api[_-]?key|authorization)(=|:)\s*["']?[^"'\s]+/gi, "$1$2 REDACTED");
}
