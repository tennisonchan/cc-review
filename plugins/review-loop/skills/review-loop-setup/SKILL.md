---
name: review-loop-setup
description: Report catalog and provider readiness, explicitly reconcile trusted reviewer configuration, initialize review guidelines, and configure the default review-loop gate.
---

# review-loop setup

Use this skill when the user or agent needs to prepare `review-loop`.

Run:

```bash
REVIEW_LOOP_HOST=codex node "<skill-root>/../../scripts/review-loop-companion.mjs" setup $ARGUMENTS
```

Supported arguments:

- `--json`
- `--desired-tier-config <path>` (preview only unless apply is explicit)
- `--apply-tier-config`
- `--expected-tier-config-digest <sha256>`
- `--expect-tier-config-missing`
- `--init-guidelines`
- `--force`
- `--enable-review-gate`
- `--disable-review-gate`
- `--block-on info|low|medium|high`
- `--enable-gate-debug`
- `--disable-gate-debug`

Treat v1 tier configuration as migration input, never runtime-ready configuration. Never invent a v2 catalog or model choice. Preview before apply; apply only an operator-supplied v2 file with an explicit active-state expectation. Setup also checks both reviewer CLIs and authentication, initializes guidelines when requested, and configures the default gate when the current Codex hook surface supports it.
