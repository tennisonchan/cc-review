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
- Conditional automatic review gate support when Codex exposes a proven main-agent finalization hook.

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

`cc-review-setup --enable-review-gate` only installs an automatic blocking gate when the current Codex version exposes a plugin/user hook that can block the main-agent finalization boundary.

If the only available completion event is `subagent_stop`, setup refuses to install a misleading main-agent gate and tells agents to use `cc-review --wait`.

## Development

```bash
npm test
```
