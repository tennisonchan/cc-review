---
description: Verify review-loop readiness, initialize guidelines, and configure the default Claude Code review gate
argument-hint: '[--json] [--init-guidelines] [--force] [--enable-review-gate] [--disable-review-gate] [--block-on info|low|medium|high]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" setup $ARGUMENTS
```

Present the command output to the user.
