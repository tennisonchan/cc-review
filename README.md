# cc-review

Codex plugin for running read-only Claude Code reviews before an agent finalizes work.

The core workflow is agent-first:

```bash
cc-review-setup --init-guidelines
cc-review --wait
```

`cc-review` asks Claude Code to review local changes without editing files. Review output uses a structured `approved` / `needs_changes` decision model so Codex can decide whether to continue, fix findings, or report a blocked review.

## Features

- Read-only Claude Code invocation using `--permission-mode plan`.
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

Guidelines tune review behavior but cannot override read-only safety.

## Automatic Gate

The plugin ships a Codex `Stop` hook. The hook is always registered with the plugin, but it approves immediately until a repository opts in.

Enable the blocking gate for the current repository:

```bash
cc-review-setup --enable-review-gate
```

The gate blocks finalization when Claude Code returns `needs_changes` at or above the configured threshold. Disable it with:

```bash
cc-review-setup --disable-review-gate
```

## Development

```bash
npm test
```
