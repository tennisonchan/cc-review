# review-loop

Review Loop is read-only reviewer machinery. A caller supplies review material and may optionally supply:

1. review guidelines/policy;
2. a preferred reviewer, exact model, and reasoning effort.

Review Loop does not classify risk, translate risk to models, decide gates, or choose the next workflow action. Those decisions belong to the caller.

## Behavior

- With no reviewer/model override, Review Loop uses the host-aware default reviewer.
- With an exact reviewer/model override, it invokes that mechanism read-only.
- If the requested mechanism fails, or its envelope is contract-invalid without an actionable current-subject blocker, Review Loop automatically tries at most one fresh host-model reviewer. It never asks the operator to choose a fallback.
- A contract-invalid envelope with an actionable blocker is terminal `invalid_review_evidence`; Review Loop preserves that evidence and does not answer-shop. Advisory-only and finding-free invalid envelopes remain eligible for the single fallback, with recovered notes preserved as non-authority observations carrying their invalid-envelope origin.
- If both mechanisms fail, the result is `unavailable` with bounded diagnostic evidence.
- Results are action-neutral. The complete normalized v5 review is under `result`; requested/effective routes, at most two attempts, fallback provenance, diagnostics, and hashed provider-native reviewer identity are under `review_execution`.

See [the product boundary](docs/product-boundary.md).

## Use

Initialize optional project guidelines:

```bash
review-loop-setup --init-guidelines
```

Review local changes:

```bash
review-loop --json
```

Review one artifact without an implicit diff:

```bash
review-loop run --artifact design.md --scope none --focus "Check implementation readiness" --json
```

Request an exact model:

```bash
review-loop run \
  --reviewer claude \
  --model claude-opus-4-8 \
  --reasoning-effort high \
  --artifact gate-packet.md \
  --scope none \
  --json
```

Useful options:

- `--scope none|auto|working-tree|branch`
- `--context <path>`
- `--artifact <path>`
- `--focus <text>`
- `--guidelines <path>`
- `--reviewer claude|codex`
- `--model <exact-id>`
- `--reasoning-effort low|medium|high|xhigh|max`
- `--counter`
- `--background`
- `--on-reviewer-failure block|allow`
- `--json`

Mutable model aliases such as `latest`, `opus`, and `sonnet` are rejected. Reviewer subprocesses run in terminal, non-persistent, read-only mode and cannot start nested Review Loops.

`--on-reviewer-failure allow` is report-only: the command may return successfully so callers can inspect the failure envelope, but it never converts missing review coverage into an approved review. The automatic Stop gate honors its separately persisted reviewer-failure policy.

An explicit non-approved reviewer decision always blocks the automatic Stop gate, even when every reported finding belongs to a `category_block_on: "never"` category. Category policy can classify findings; it cannot rewrite the reviewer's terminal decision into approval.

## Setup readiness

`review-loop-setup --json` reports `review_protocol_version` and `review_contract_digest`, then checks Node, the Codex and Claude CLIs, and authentication. Consumers must require both values to match their pinned canonical contract. Review Loop is usable when at least one provider is healthy. It does not own caller model policy.

## Install

Codex marketplace:

```bash
codex plugin marketplace add tennisonchan/review-loop --ref main
codex plugin add review-loop@review-loop
```

Local development from this repository:

```bash
codex plugin marketplace add .agents/plugins
codex plugin add review-loop@review-loop
```

Shell binaries:

```bash
npm install -g github:tennisonchan/review-loop
review-loop-setup --init-guidelines
```

Claude Code exposes the same setup, run, status, result, and cancel operations through its plugin commands.

## Guidelines

Project guidelines live at `.review-loop/review-guidelines.md`. They may contain a deterministic policy block:

`````markdown
```json review-loop
{
  "block_on": "high",
  "category_block_on": {
    "security": "medium",
    "style": "never"
  }
}
```
`````

An explicitly malformed policy returns `invalid_input`; Review Loop never silently weakens it.

## Development

```bash
npm test
npm run validate
```

License: Apache-2.0.
