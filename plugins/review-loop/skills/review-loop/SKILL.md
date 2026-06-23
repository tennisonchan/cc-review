---
name: review-loop
description: Run a read-only Claude Code review over local changes before Codex finalizes work.
---

# review-loop

Use this skill before a final response, implementation-ready claim, or PR submission.

Run:

```bash
REVIEW_LOOP_HOST=codex node "<skill-root>/../../scripts/review-loop-companion.mjs" run --scope auto $ARGUMENTS
```

Supported arguments:

- `--background`
- `--base <ref>`
- `--scope none|auto|working-tree|branch`
- `--context <path>`
- `--artifact <path>`
- `--focus <text>`
- `--guidelines <path>`
- `--counter`
- `--json`

The review is read-only. Do not ask Claude Code to patch, edit, commit, or continue into implementation.
