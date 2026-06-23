# review-loop

Multi-agent review loops for structured, policy-aware code gates.

`review-loop` is a gate-agnostic, read-only review execution engine: callers provide context, artifacts, focus, and optional guidelines; higher-level agents decide when a review is needed and what gate or policy the result satisfies.

The core workflow is agent-first:

```bash
review-loop-setup --init-guidelines
review-loop
```

`review-loop` asks an independent reviewer to evaluate supplied material without editing files. `run` is the canonical engine; counter-review is selected with `--counter`, not a separate command. Old `cc-review` command names are intentionally not preserved.

## Features

- Read-only Claude Code invocation: plan mode plus a Read/Grep/Glob-only tool list, so the reviewer can inspect surrounding code but never modify it.
- Project-customizable review rubric at `.claude/rules/review-guidelines.md`.
- Structured generic review results via `--output-format json --json-schema`.
- Context packet, artifact, working-tree, and base-branch review target selection.
- Optional background review jobs with status/result/cancel.
- Optional automatic Stop-hook review gate for Codex finalization.

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
- `--on-reviewer-failure block|allow` controls direct-run mechanism failure behavior. The generic engine defaults to `block`; the Stop hook uses the same v2 result shape and can invoke a degraded read-only Codex fallback when Claude Code is unavailable.
- `--background`, `status`, `result`, and `cancel` work with generic reviews. Persisted job metadata is sanitized; free-form focus text, logs, and errors are not returned raw through status/result JSON.

JSON output uses snake_case fields. The normalized result is under `result` and includes `decision`, `blocking_findings`, `advisory_findings`, `required_next_actions`, `reviewed_inputs`, `reviewer_mechanism`, and `read_only`.

Use `review-loop run --context ...` or `review-loop run --artifact ...` for context/artifact-only reviews. Bare `review-loop --context ...` uses the `review-loop` binary default of `--scope auto` and reviews the diff too. The normalized `decision` is derived from normalized blocking findings; reviewer `approved`/`changes_requested` proposals are advisory except for `invalid_input` and `blocked`.

`review-loop` does not know whether the caller is satisfying an execution, design, merge, or audit gate. For agent-kernel integration, agent-kernel prepares the context packet, calls `review-loop run`, records the generic result, and maps that result back to its own gate semantics.

## Install

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

## Migration Notes

This rename intentionally does not preserve old command or configuration names:

- `cc-review*` binaries were removed; use `review-loop*`.
- `CC_REVIEW_*` environment variables were removed; use `REVIEW_LOOP_*`.
- `json cc-review` policy fences are no longer honored; use `json review-loop`.
- State now lives under `review-loop`, so repositories that previously enabled the gate should rerun `review-loop-setup --enable-review-gate`.

## Review Guidelines

Initialize project guidelines:

```bash
review-loop-setup --init-guidelines
```

Resolution order:

1. `--guidelines <path>`
2. nearest `.claude/rules/review-guidelines.md`
3. `~/.claude/rules/review-guidelines.md`
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

The plugin ships a Codex `Stop` hook. The hook is always registered with the plugin, but it approves immediately until a repository opts in.

Enable the blocking gate for the current repository:

```bash
review-loop-setup --enable-review-gate
```

The gate blocks finalization when the normalized result contains `blocking_findings`. Each blocked stop is re-reviewed, so fixes are verified before finalization. Loop prevention is bounded per task: three blocks for the same finding set and five blocks total; past those caps the gate allows finalization and reports the unresolved findings instead. A stop that changed nothing reuses the previous review decision instead of invoking Claude again. Disable it with:

```bash
review-loop-setup --disable-review-gate
```

## Development

```bash
npm test
```
