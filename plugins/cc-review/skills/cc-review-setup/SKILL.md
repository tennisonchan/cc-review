---
name: cc-review-setup
description: Verify Claude Code readiness, initialize review guidelines, and configure the conditional cc-review gate.
---

# cc-review setup

Use this skill when the user or agent needs to prepare `cc-review`.

Run:

```bash
node "<skill-root>/../../scripts/cc-review-companion.mjs" setup $ARGUMENTS
```

Supported arguments:

- `--json`
- `--init-guidelines`
- `--force`
- `--enable-review-gate`
- `--disable-review-gate`
- `--block-on high|medium|low`

Do not ask Claude Code to edit files. Setup only checks local prerequisites, initializes guidelines when requested, and configures the conditional gate when the current Codex hook surface supports it.
