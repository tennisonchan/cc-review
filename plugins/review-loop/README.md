# review-loop

Multi-agent review loops for structured, policy-aware code gates.

`review-loop` is a gate-agnostic, read-only review execution engine: callers provide context, artifacts, focus, and optional guidelines; higher-level agents decide when a review is needed and what gate or policy the result satisfies. Codex and Claude Code surfaces are host adapters over the same engine.

The core workflow is agent-first:

```bash
review-loop-setup --init-guidelines
review-loop
```

`review-loop` asks an independent opposite-agent reviewer to evaluate supplied material without editing files. Codex-hosted runs use Claude Code by default; Claude Code-hosted runs use Codex by default. `run` is the canonical engine; counter-review is selected with `--counter`, not a separate command. Old `cc-review` command names are intentionally not preserved.

## Features

- Read-only opposite-agent reviewer invocation: Claude Code runs in plan mode with Read/Grep/Glob-only tools; Codex runs with a read-only sandbox and schema-bound output.
- Project-customizable review rubric at `.review-loop/review-guidelines.md`.
- Structured generic review results via `--output-format json --json-schema`.
- Fail-closed reviewer-output integrity checks reject missing decisions and the exact observed placeholder summary before findings normalization or cache admission.
- Context packet, artifact, working-tree, and base-branch review target selection.
- Optional background review jobs with status/result/cancel.
- Automatic Stop-hook review gate for Codex or Claude Code finalization, enabled by default when the hook is installed.
- Terminal reviewer mode prevents reviewer subprocesses from starting nested review loops.

## Generic Review Engine

Run a generic review over local changes:

```bash
review-loop --json
```

Run with an agent-prepared context packet and no implicit diff:

```bash
review-loop run --context review-context.md --focus "Check readiness and evidence gaps" --json
```

Review a design/spec artifact:

```bash
review-loop run --artifact design.md --focus "Check implementation readiness" --json
```

Run a counter-review focused on a risky assumption:

```bash
review-loop run --context packet.md --counter --focus "Challenge the caching assumption" --json
```

Useful options:

- `--context <path>` passes a caller-prepared context packet.
- `--artifact <path>` passes a specific file to review.
- `--scope none|auto|working-tree|branch` selects repository diff input. For `run`, context/artifact-only reviews default to `none`; otherwise the default is `auto`.
- `--focus <text>` supplies the reviewer ask.
- `--counter` runs the loop in counter-review stance, focused on challenging an assumption, risk, or approach.
- `--on-reviewer-failure block|allow` controls direct-run mechanism failure behavior. The generic engine defaults to `block`; when the selected opposite-agent reviewer fails and the host agent is known, review-loop first tries one degraded read-only host-agent fallback. An explicit `allow` is consulted only when distinct-host fallback is unavailable or also fails.
- `--background`, `status`, `result`, and `cancel` work with generic reviews. Persisted job metadata is sanitized; free-form focus text, logs, and errors are not returned raw through status/result JSON.

JSON output uses snake_case fields. The normalized result is under `result` and includes `decision`, `blocking_findings`, `advisory_findings`, `required_next_actions`, `reviewed_inputs`, `reviewer_mechanism`, and `read_only`.

Use `review-loop run --context ...` or `review-loop run --artifact ...` for context/artifact-only reviews. Bare `review-loop --context ...` uses the `review-loop` binary default of `--scope auto` and reviews the diff too. The normalized `decision` is derived from normalized blocking findings; reviewer `approved`/`changes_requested` proposals are advisory except for `invalid_input` and `blocked`.

Reviewer assessments must carry an explicit recognized decision. The exact observed schema-repair placeholder (`summary` equal to `test` after trimming and case normalization) is classified as reviewer-mechanism failure before normalization; review-loop then uses its normal distinct-host fallback or blocks when coverage is unavailable. This is corpus-specific integrity protection, not a general proof that arbitrary fluent prose reflects meaningful reasoning. Valid concise summaries such as `ok` remain supported. Private gate-cache entries are integrity-versioned; legacy or placeholder-bearing entries miss and are re-reviewed while the existing target-hash and TTL rules remain authoritative.

`review-loop` does not know whether the caller is satisfying an execution, design, merge, or audit gate. For agent-kernel integration, agent-kernel prepares the context packet, calls `review-loop run`, records the generic result, and maps that result back to its own gate semantics.

## Reviewer Hosts

Host plugins select the opposite reviewer by default:

- Codex host: Claude Code reviewer.
- Claude Code host: Codex reviewer.

Reviewer agents are terminal. A reviewer may inspect code and return structured findings, but must not invoke `review-loop`, run another reviewer, delegate work, or modify files. Internally, reviewer subprocesses receive `REVIEW_LOOP_TERMINAL_REVIEWER=1`; `review-loop run` refuses nested review execution and the Stop hook allows/no-ops in that mode.

`REVIEW_LOOP_REVIEWER=claude|codex` and `--reviewer claude|codex` exist for internal/plugin routing and tests. Normal users should rely on the host defaults.

## Install

### Codex

Add the marketplace:

```bash
codex plugin marketplace add tennisonchan/review-loop --ref main
```

Install the plugin:

```bash
codex plugin add review-loop@review-loop
```

For local development from this repository root:

```bash
codex plugin marketplace add .agents/plugins
codex plugin add review-loop@review-loop
```

Inside Codex, `review-loop`, `review-loop-setup`, and the other commands are plugin skills — ask the agent to run them. To use the same commands from your own shell, install the binaries globally:

```bash
npm install -g github:tennisonchan/review-loop
review-loop-setup --init-guidelines
```

### Claude Code

The same plugin also includes Claude Code slash-command metadata. Install it through Claude Code's plugin flow, ensure `codex` is available for opposite-agent review, then use:

```bash
/review-loop:setup
/review-loop:run
/review-loop:status
/review-loop:result
/review-loop:cancel
```

The Claude Code commands run from `CLAUDE_PLUGIN_ROOT`, so the shared runtime uses Codex as the default reviewer.

## Migration Notes

This rename intentionally does not preserve old command or configuration names:

- `cc-review*` binaries were removed; use `review-loop*`.
- `CC_REVIEW_*` environment variables were removed; use `REVIEW_LOOP_*`.
- `json cc-review` policy fences are no longer honored; use `json review-loop`.
- State now lives under `review-loop`; repositories that need an explicit `block_on` override or disabled marker should rerun `review-loop-setup` with the appropriate gate flag.
- Missing gate config now means enabled, so rerun `review-loop-setup --disable-review-gate` after upgrading if a repository should keep the installed Stop hook disabled.

## Review Guidelines

Initialize project guidelines:

```bash
review-loop-setup --init-guidelines
```

This creates `.review-loop/review-guidelines.md`. Review-loop does not read Claude-specific rule files; move any existing review guidance into the neutral path.

Resolution order:

1. `--guidelines <path>`
2. nearest `.review-loop/review-guidelines.md`
3. `~/.review-loop/review-guidelines.md`
4. bundled `templates/review-guidelines.md`

Guidelines may include a machine-read blocking policy in a fenced block:

```json review-loop
{
  "block_on": "high",
  "category_block_on": {
    "security": "medium",
    "style": "never"
  }
}
```

`block_on` sets the base severity threshold and `category_block_on` overrides it per finding category, with `"never"` exempting a category from policy promotion. This machine-readable block is the only deterministic policy input; natural-language guidelines and `--focus` guide reviewer judgment but do not drive normalization. If no machine-readable policy is present, `review-loop run` uses the fallback threshold: high-severity findings block, lower severities are advisory unless the reviewer marks them blocking. An explicit `review-loop-setup --enable-review-gate --block-on <severity>` choice overrides the Stop-hook policy's base `block_on`; `category_block_on` overrides still apply on top of it.

Guidelines tune review behavior but cannot override read-only safety: the reviewer's inability to modify files is enforced mechanically (plan mode plus a read-only tool list), not by prompt text. The reviewer mechanism receives raw context, artifact, and diff content; redaction is best-effort and applies to persisted metadata/logs, not to what the model sees. Treat guidelines as trusted configuration and avoid sending secret-bearing files for review.

## Automatic Gate

The plugin ships host-specific `Stop` hook metadata. When that hook is installed, the review gate is enabled by default and uses the normal guidelines/default blocking policy unless a repository writes an explicit override.

Write or refresh an explicit gate configuration for the current repository:

```bash
review-loop-setup --enable-review-gate
```

This is only needed to persist options such as `--block-on` and automatic-gate reviewer failure policy; the missing-config default is enabled. Automatic gates block after both primary and fallback reviewer mechanisms fail unless the repository explicitly opts into report-only availability:

```bash
review-loop-setup --enable-review-gate --on-reviewer-failure allow
```

Restore fail-closed behavior after an outage with the same command and `block`. Background reviews retain their captured direct-run `--on-reviewer-failure` policy and do not consume this automatic-gate setting.

The gate blocks finalization when the normalized result contains `blocking_findings`. Each blocked stop is re-reviewed, so fixes are verified before finalization. Loop prevention is bounded per task: three blocks for the same finding set and five blocks total; past those caps the gate allows finalization and reports the unresolved findings instead. A stop that changed nothing reuses the previous review decision instead of invoking the reviewer again.

When the opposite-agent reviewer has a tool or provider failure, review-loop can trigger one degraded read-only fallback review by the host agent: Codex-hosted runs fall back from Claude Code to Codex, and Claude Code-hosted runs fall back from Codex to Claude Code. This includes auth failures, rate limits, session limits, missing CLI failures, timeouts, malformed envelopes, semantic integrity rejection, and other reviewer mechanism blockers. Findings from the fallback review still use the same `block_on` / `category_block_on` policy and can block finalization. If both mechanisms fail, direct review and the automatic Stop gate block missing review coverage by default; only the explicit automatic-gate `allow` configuration above permits report-only finalization. If no distinct host fallback reviewer is known, reviewer mechanism failures follow the configured reviewer-failure policy. The separate cap-forced-finalization path for repeated substantive findings remains unchanged.

Disable the gate with:

```bash
review-loop-setup --disable-review-gate
```

That command writes an explicit disabled marker. Users who manually disable or relocate the host hook can continue to do so outside review-loop setup.

## Development

```bash
npm test
```
