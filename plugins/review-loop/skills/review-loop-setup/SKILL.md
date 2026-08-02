---
name: review-loop-setup
description: Report Review Loop execution readiness, legacy bridge-catalog diagnostics, initialize review guidelines, and configure the default review-loop gate.
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

Execution readiness requires one usable provider and never requires a semantic-tier catalog. Tier reconciliation remains a deprecated old-Kernel bridge: treat v1 configuration as migration input, never invent a v2 catalog or model choice, preview before apply, and apply only an operator-supplied v2 file with an explicit active-state expectation. Setup also checks both reviewer CLIs and authentication, initializes guidelines when requested, and configures the default gate when the current Codex hook surface supports it.
