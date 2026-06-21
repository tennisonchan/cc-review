# cc-review

Codex plugin for running read-only Claude Code reviews before an agent finalizes work.

The core workflow is agent-first:

```bash
cc-review-setup --init-guidelines
cc-review
```

`cc-review` asks Claude Code to review local changes without editing files. Review output uses a structured `approved` / `needs_changes` decision model so Codex can decide whether to continue, fix findings, or report a blocked review.

## Features

- Read-only Claude Code invocation: plan mode plus a Read/Grep/Glob-only tool list, so the reviewer can inspect surrounding code but never modify it.
- Project-customizable review rubric at `.claude/rules/review-guidelines.md`.
- Structured review decisions via `--output-format json --json-schema`.
- Working-tree and base-branch review target selection.
- Optional background review jobs with status/result/cancel.
- Optional automatic Stop-hook review gate for Codex finalization.

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

`block_on` sets the gate's base severity threshold and `category_block_on` overrides it per finding category, with `"never"` exempting a category from blocking. An explicit `cc-review-setup --enable-review-gate --block-on <severity>` choice overrides the policy's base `block_on`; `category_block_on` overrides still apply on top of it.

Guidelines tune review behavior but cannot override read-only safety: the reviewer's inability to modify files is enforced mechanically (plan mode plus a read-only tool list), not by prompt text. Note that guidelines and the reviewed diff are still prompt input, so they can influence review judgment - treat the guidelines file as trusted configuration.

## Automatic Gate

The plugin ships a Codex `Stop` hook. The hook is always registered with the plugin, but it approves immediately until a repository opts in.

Enable the blocking gate for the current repository:

```bash
cc-review-setup --enable-review-gate
```

The gate blocks finalization when Claude Code returns `needs_changes` at or above the configured threshold. Each blocked stop is re-reviewed, so fixes are verified before finalization. Loop prevention is bounded per task: three blocks for the same finding set and five blocks total; past those caps the gate allows finalization and reports the unresolved findings instead. A stop that changed nothing reuses the previous review decision instead of invoking Claude again.

When Claude Code cannot run because of a tool or provider failure, such as authentication, timeout, malformed output, or a missing CLI, the gate runs a degraded Codex fallback review over the same target instead of blocking solely on the tool failure. Findings from that fallback review still use the same `block_on` / `category_block_on` policy and can block finalization. If both Claude Code and the fallback review are unavailable, the gate allows finalization with an explicit missing-review-coverage warning. This MVP fallback is intentionally report-only for tool failure: inducing repeated Claude failures can downgrade review coverage until follow-up escalation/counter controls are added.

Disable the gate with:

```bash
cc-review-setup --disable-review-gate
```

## Development

```bash
npm test
```
