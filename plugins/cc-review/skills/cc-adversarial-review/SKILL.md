---
name: cc-adversarial-review
description: Run a focused read-only Claude Code challenge review over local changes.
---

# cc-adversarial-review

Use this skill when the agent needs Claude Code to challenge a specific design, risk area, or implementation assumption.

Run:

```bash
node "<skill-root>/../../scripts/cc-review-companion.mjs" run --scope auto --stance adversarial $ARGUMENTS
```

Supported arguments:

- `--background`
- `--base <ref>`
- `--scope none|auto|working-tree|branch`
- `--context <path>`
- `--artifact <path>`
- `--focus <text>`
- `--guidelines <path>`
- `--json`
- trailing focus text

Preserve the focus text. The review remains read-only.
