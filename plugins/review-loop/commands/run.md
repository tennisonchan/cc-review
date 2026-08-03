---
description: Run a read-only review-loop review with optional policy and exact model inputs
argument-hint: '[--background] [--base <ref>] [--scope none|auto|working-tree|branch] [--context <path>] [--artifact <path>] [--focus <text>] [--counter] [--guidelines <path>] [--reviewer claude|codex --model <exact-id> --reasoning-effort <level>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run. Omit `--guidelines` to use the default policy and omit `--model` to use host-aware reviewer selection. Exact-model failures automatically try one fresh host reviewer without prompting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" run --scope auto $ARGUMENTS
```

Return the command output as-is. This command is review-only; do not fix findings, edit files, or continue into implementation.
