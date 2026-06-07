---
name: cc-review
description: Run a read-only Claude Code review over local changes before Codex finalizes work.
---

# cc-review

Use this skill before a final response, implementation-ready claim, or PR submission.

Run:

```bash
node "<skill-root>/../../scripts/cc-review-companion.mjs" review $ARGUMENTS
```

Supported arguments:

- `--wait`
- `--background`
- `--base <ref>`
- `--scope auto|working-tree|branch`
- `--guidelines <path>`
- `--json`

The review is read-only. Do not ask Claude Code to patch, edit, commit, or continue into implementation.
