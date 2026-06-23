---
description: Show a completed review-loop background job result
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/review-loop-companion.mjs" result $ARGUMENTS`
