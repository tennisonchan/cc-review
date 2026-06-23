---
name: review-loop-cancel
description: Cancel a running review-loop background job.
---

# review-loop-cancel

Run:

```bash
REVIEW_LOOP_HOST=codex node "<skill-root>/../../scripts/review-loop-companion.mjs" cancel $ARGUMENTS
```

Supported arguments:

- `[job-id]`
- `--json`
