---
description: Run a read-only review-loop review with the opposite-agent reviewer
argument-hint: '[--background] [--base <ref>] [--scope none|auto|working-tree|branch] [--context <path>] [--artifact <path>] [--focus <text>] [--counter] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" run --scope auto $ARGUMENTS
```

Return the command output as-is. This command is review-only; do not fix findings, edit files, or continue into implementation.
