# cc-review

Codex plugin for running read-only Claude Code reviews. `cc-review` is a gate-agnostic review execution engine: callers provide context, artifacts, focus, and optional guidelines; higher-level agents decide when a review is needed and what gate or policy the result satisfies.

The core workflow is agent-first:

```bash
cc-review-setup --init-guidelines
cc-review
```

`cc-review` asks Claude Code to review supplied material without editing files. The public `cc-review` binary maps to the generic `run` engine over the current working tree. Legacy `review` and `adversarial-review` subcommands remain available for compatibility with existing hooks and skills.

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
cc-review --json
```

Run with an agent-prepared context packet and no implicit diff:

```bash
cc-review run --context review-context.md --focus "Check readiness and evidence gaps" --json
```

Review a design/spec artifact:

```bash
cc-review run --artifact design.md --focus "Challenge the approach before implementation" --json
```

Useful options:

- `--context <path>` passes a caller-prepared context packet.
- `--artifact <path>` passes a specific file to review.
- `--scope none|auto|working-tree|branch` selects repository diff input. For `run`, context/artifact-only reviews default to `none`; otherwise the default is `auto`.
- `--focus <text>` supplies the reviewer ask.
- `--stance standard|adversarial` changes the review stance without introducing gate-specific modes.
- `--on-reviewer-failure block|allow` controls mechanism failure behavior. The generic engine defaults to `block`; the legacy Stop hook keeps its historical report-only fallback path.
- `--background`, `status`, `result`, and `cancel` work with generic reviews. Persisted job metadata is sanitized; free-form focus text, logs, and errors are not returned raw through status/result JSON.

JSON output uses snake_case fields. The normalized result is under `result` and includes `decision`, `blocking_findings`, `advisory_findings`, `required_next_actions`, `reviewed_inputs`, `reviewer_mechanism`, and `read_only`.

Use `cc-review run --context ...` or `cc-review run --artifact ...` for context/artifact-only reviews. Bare `cc-review --context ...` keeps the compatibility wrapper's working-tree default and reviews the diff too. The normalized `decision` is derived from normalized blocking findings; reviewer `approved`/`changes_requested` proposals are advisory except for `invalid_input` and `blocked`.

`cc-review` does not know whether the caller is satisfying an execution, design, merge, or audit gate. For agent-kernel integration, agent-kernel prepares the context packet, calls `cc-review run`, records the generic result, and maps that result back to its own gate semantics.

## Install

Add the marketplace:

```bash
codex plugin marketplace add tennisonchan/cc-review --ref main
```

Install the plugin:

```bash
codex plugin add cc-review@cc-review
```

For local development from this repository root:

```bash
codex plugin marketplace add .agents/plugins
codex plugin add cc-review@cc-review
```

Inside Codex, `cc-review`, `cc-review-setup`, and the other commands are plugin skills — ask the agent to run them. To use the same commands from your own shell, install the binaries globally:

```bash
npm install -g github:tennisonchan/cc-review
cc-review-setup --init-guidelines
```

## Review Guidelines

Initialize project guidelines:

```bash
cc-review-setup --init-guidelines
```

Resolution order:

1. `--guidelines <path>`
2. nearest `.claude/rules/review-guidelines.md`
3. `~/.claude/rules/review-guidelines.md`
4. bundled `templates/review-guidelines.md`

Guidelines may include a machine-read blocking policy in a fenced block:

```json cc-review
{
  "block_on": "high",
  "category_block_on": {
    "security": "medium",
    "style": "never"
  }
}
```

`block_on` sets the base severity threshold and `category_block_on` overrides it per finding category, with `"never"` exempting a category from policy promotion. This machine-readable block is the only deterministic policy input; natural-language guidelines and `--focus` guide reviewer judgment but do not drive normalization. If no machine-readable policy is present, `cc-review run` uses the fallback threshold: high-severity findings block, lower severities are advisory unless the reviewer marks them blocking. An explicit `cc-review-setup --enable-review-gate --block-on <severity>` choice overrides the Stop-hook policy's base `block_on`; `category_block_on` overrides still apply on top of it.

Guidelines tune review behavior but cannot override read-only safety: the reviewer's inability to modify files is enforced mechanically (plan mode plus a read-only tool list), not by prompt text. The reviewer mechanism receives raw context, artifact, and diff content; redaction is best-effort and applies to persisted metadata/logs, not to what the model sees. Treat guidelines as trusted configuration and avoid sending secret-bearing files for review.

## Automatic Gate

The plugin ships a Codex `Stop` hook. The hook is always registered with the plugin, but it approves immediately until a repository opts in.

Enable the blocking gate for the current repository:

```bash
cc-review-setup --enable-review-gate
```

The gate blocks finalization when Claude Code returns `needs_changes` at or above the configured threshold. Each blocked stop is re-reviewed, so fixes are verified before finalization. Loop prevention is bounded per task: three blocks for the same finding set, five blocks total, and two blocks for review infrastructure failures; past those caps the gate allows finalization and reports the unresolved findings instead. A stop that changed nothing reuses the previous review decision instead of invoking Claude again. Disable it with:

```bash
cc-review-setup --disable-review-gate
```

## Development

```bash
npm test
```
