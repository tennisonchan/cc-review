---
description: Report review-loop catalog and provider readiness, reconcile trusted configuration, initialize guidelines, and configure the default Claude Code review gate
argument-hint: '[--json] [--desired-tier-config <path>] [--apply-tier-config (--expected-tier-config-digest <sha256>|--expect-tier-config-missing)] [--init-guidelines] [--force] [--enable-review-gate] [--disable-review-gate] [--block-on info|low|medium|high]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" setup $ARGUMENTS
```

Present the command output to the user.
