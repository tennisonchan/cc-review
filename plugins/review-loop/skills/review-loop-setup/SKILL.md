---
name: review-loop-setup
description: Verify Claude Code readiness, initialize review guidelines, and configure the default review-loop gate.
---

# review-loop setup

Use this skill when the user or agent needs to prepare `review-loop`.

Run:

```bash
REVIEW_LOOP_HOST=codex node "<skill-root>/../../scripts/review-loop-companion.mjs" setup $ARGUMENTS
```

Supported arguments:

- `--json`
- `--init-guidelines`
- `--force`
- `--enable-review-gate`
- `--disable-review-gate`
- `--block-on info|low|medium|high`
- `--enable-gate-debug`
- `--disable-gate-debug`

Do not ask Claude Code to edit files. Setup only checks local prerequisites, initializes guidelines when requested, and configures the default gate when the current Codex hook surface supports it.
