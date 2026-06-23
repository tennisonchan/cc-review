---
description: List running and recent review-loop jobs for the current repository
argument-hint: '[job-id] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" status $ARGUMENTS`
