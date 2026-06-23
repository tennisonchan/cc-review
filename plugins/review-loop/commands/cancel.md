---
description: Cancel a running review-loop background job
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" cancel $ARGUMENTS`
