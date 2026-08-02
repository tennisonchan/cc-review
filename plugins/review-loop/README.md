# review-loop

Multi-agent review loops for structured, policy-aware code gates.

Review Loop owns read-only reviewer execution and one automatic fresh host-model fallback. It does not own risk tiers or workflow actions. Policy and exact model inputs are optional; malformed explicit policy is rejected, and substantive review content is never discarded to seek another answer. See [`docs/product-boundary.md`](../../docs/product-boundary.md).

`review-loop` is a gate-agnostic, read-only review execution engine: callers provide context, artifacts, focus, and optional guidelines; higher-level agents decide when a review is needed and what gate or policy the result satisfies. Codex and Claude Code surfaces are host adapters over the same engine.

The core workflow is agent-first:

```bash
review-loop-setup --init-guidelines
review-loop
```

`review-loop` asks an independent reviewer to evaluate supplied material without editing files. Direct Codex-hosted runs use Claude Code by default; direct Claude Code-hosted runs use Codex by default. An Agent Kernel-authorized run may use the same provider when the selected tier proves a fresh non-resumed packet-only reviewer context. `run` is the canonical engine; counter-review is selected with `--counter`, not a separate command. Old `cc-review` command names are intentionally not preserved.

## Features

- Read-only opposite-agent reviewer invocation: Claude Code runs in plan mode with Read/Grep/Glob-only tools; Codex runs with a read-only sandbox and schema-bound output.
- Project-customizable review rubric at `.review-loop/review-guidelines.md`.
- Structured generic review results via `--output-format json --json-schema`.
- Fail-closed reviewer-output integrity checks reject missing decisions and the exact observed placeholder summary before findings normalization or cache admission.
- Context packet, artifact, working-tree, and base-branch review target selection.
- Optional background review jobs with status/result/cancel.
- Automatic Stop-hook review gate for Codex or Claude Code finalization, enabled by default when the hook is installed.
- Terminal reviewer mode prevents reviewer subprocesses from starting nested review loops.
- Optional Agent Kernel authorization mode performs exactly one qualified invocation and emits transaction, isolation-profile, and provider-native session identity evidence without owning retries or gate admission.

## Generic Review Engine

Run a generic review over local changes:

```bash
review-loop --json
```

Run with an agent-prepared context packet and no implicit diff:

```bash
review-loop run --context review-context.md --focus "Check readiness and evidence gaps" --json
```

Review a design/spec artifact:

```bash
review-loop run --artifact design.md --focus "Check implementation readiness" --json
```

Run a counter-review focused on a risky assumption:

```bash
review-loop run --context packet.md --counter --focus "Challenge the caching assumption" --json
```

Useful options:

- `--context <path>` passes a caller-prepared context packet.
- `--artifact <path>` passes a specific file to review.
- `--scope none|auto|working-tree|branch` selects repository diff input. For `run`, context/artifact-only reviews default to `none`; otherwise the default is `auto`.
- `--focus <text>` supplies the reviewer ask.
- `--counter` runs the loop in counter-review stance, focused on challenging an assumption, risk, or approach.
- `--tier fast|standard|strong` selects an exact operator-configured reviewer release. Tiered runs fail closed and do not use cross-provider fallback or `--on-reviewer-failure allow`.
- `--authorization <path> --subject-digest <sha256>` selects transaction mode for an Agent Kernel-issued envelope. It requires a qualified tier, executes once, and bypasses cache, fallback, background execution, continuation, and fail-open behavior.
- `--continuation-envelope` asks a `strong` tier initial review for a structured closure envelope. It is invalid without `--tier strong`.
- `--on-reviewer-failure block|allow` controls direct-run mechanism failure behavior. The generic engine defaults to `block`; when the selected opposite-agent reviewer fails and the host agent is known, review-loop first tries one degraded read-only host-agent fallback. An explicit `allow` is consulted only when distinct-host fallback is unavailable or also fails.
- `--background`, `status`, `result`, and `cancel` work with generic reviews. Persisted job metadata is sanitized; free-form focus text, logs, and errors are not returned raw through status/result JSON.

JSON output uses snake_case fields. The normalized result is under `result` and includes `decision`, `blocking_findings`, `advisory_findings`, `required_next_actions`, `reviewed_inputs`, `reviewer_mechanism`, and `read_only`.

Use `review-loop run --context ...` or `review-loop run --artifact ...` for context/artifact-only reviews. Bare `review-loop --context ...` uses the `review-loop` binary default of `--scope auto` and reviews the diff too. The normalized `decision` is derived from normalized blocking findings; reviewer `approved`/`changes_requested` proposals are advisory except for `invalid_input` and `blocked`.

Reviewer assessments must carry an explicit recognized decision. The exact observed schema-repair placeholder (`summary` equal to `test` after trimming and case normalization) is classified as invalid review evidence before normalization. Review Loop uses its normal distinct-host fallback only when that invalid envelope contains no recoverable substantive decision or finding; otherwise it returns `invalid_review_evidence` without invoking another reviewer. This is corpus-specific integrity protection, not a general proof that arbitrary fluent prose reflects meaningful reasoning. Valid concise summaries such as `ok` remain supported. Private gate-cache entries are integrity-versioned; legacy or placeholder-bearing entries miss and are re-reviewed while the existing target-hash and TTL rules remain authoritative.

Direct `review-loop` does not know whether the caller is satisfying an execution, design, merge, or audit gate. In authorization mode it validates and echoes the Kernel-supplied gate and subject bindings but still does not decide admission. Agent Kernel owns the attempt ledger, consumed-token rejection, retries, recovery, reviewer-independence classification, and gate semantics.

## Reviewer Hosts

Host plugins select the opposite reviewer by default:

- Codex host: Claude Code reviewer.
- Claude Code host: Codex reviewer.

Reviewer agents are terminal. A reviewer may inspect code and return structured findings, but must not invoke `review-loop`, run another reviewer, delegate work, or modify files. Internally, reviewer subprocesses receive `REVIEW_LOOP_TERMINAL_REVIEWER=1`; `review-loop run` refuses nested review execution and the Stop hook allows/no-ops in that mode.

`REVIEW_LOOP_REVIEWER=claude|codex` and `--reviewer claude|codex` exist for internal/plugin routing and tests. Normal users should rely on the host defaults.

## Semantic Reviewer Tiers

Review-loop exposes `fast`, `standard`, `strong`, and `legacy_unqualified` as provider-independent capability names. It executes the selected reviewer read-only; it does not decide whether a release is qualified or has gate authority. Callers such as Agent Kernel own qualification, routing, and approval policy.

Trusted tier configuration lives outside repositories at `$XDG_STATE_HOME/review-loop/reviewer-tiers.json` (or `~/.local/state/review-loop/reviewer-tiers.json` when `XDG_STATE_HOME` is unset). An operator may point `REVIEW_LOOP_TIER_CONFIG` at another trusted file. Repository files cannot configure reviewer tiers.

Setup's `ok` field preserves its pre-0.8 meaning exactly: Node and the Claude CLI version
probe succeeded. It does not cover authentication, Codex, catalog state, rollback, or
activation.
Activation consumers must ignore `ok`. `operational_status: ready` is the only Review
Loop-ready state. Its catalog evidence is
`catalog.status`, `catalog.schema_version`, `catalog.reason_codes`, and `catalog.digest`;
its provider evidence is `providers.codex.status` and `providers.claude.status`. Agent
Kernel then reads `capabilities --json` and requires
`tier_configuration.schema_version`, `tier_configuration.digest`, each semantic tier's
`configured`, `profiles`, and `alternate_profiles_configured` fields, plus the profile
release/isolation digests. The stable catalog reason codes are `catalog_missing`,
`tier_missing:<tier>`, `alternate_profile_missing:<tier>`, `legacy_schema`, and
`invalid_configuration`. Missing catalogs and missing semantic tiers block Review Loop
activation; legacy and invalid catalogs are also blocking. An absent alternate profile
is informational: a complete healthy single-provider v2 catalog is Review Loop-ready.
Referenced provider status `unavailable` blocks readiness; `not_required` is
informational. Agent Kernel additionally treats every alternate-profile code and
`not_required` provider as blocking because its deployment requires exactly six
profiles across both providers.
`ok` is retained only for backwards compatibility and is deprecated for any readiness
decision.
`operational_status` is closed to `ready`, `degraded`, `migration_required`,
`invalid`, and `unavailable`. Catalog `migration_required` and `invalid` take
precedence; otherwise runtime/provider unavailability yields `unavailable`, complete
catalog plus healthy referenced providers yields `ready`, and other usable states are
`degraded`.

```json
{
  "schema_version": "review-loop.reviewer-tier-config.v2",
  "tiers": {
    "fast": {
      "profiles": [
        {
          "reviewer": "codex",
          "model": "gpt-release-specific-model-id",
          "reasoning_effort": "medium"
        },
        {
          "reviewer": "claude",
          "model": "claude-release-specific-model-id",
          "reasoning_effort": "medium"
        }
      ]
    },
    "strong": {
      "profiles": [
        {
          "reviewer": "claude",
          "model": "claude-release-specific-model-id",
          "reasoning_effort": "high"
        },
        {
          "reviewer": "codex",
          "model": "gpt-release-specific-model-id",
          "reasoning_effort": "xhigh"
        }
      ]
    }
  }
}
```

Known mutable aliases such as `latest`, `opus`, and `sonnet` are rejected. Operators remain responsible for using a provider-pinned model identifier rather than another mutable family name. Inspect the resolved identities before routing:

```bash
review-loop-companion capabilities --json
review-loop run --tier strong --context review-context.md --scope none --json
```

Each tier may contain one or two ordered profiles. Two-profile tiers must use distinct providers. Capabilities expose the complete `profiles` array and keep `release_identity` and `isolation_profile` as projections of the first profile for existing consumers. Version 1 is migration input only: setup reports `migration_required`, capabilities advertise no qualified tier routes, and tiered execution refuses to run until an operator explicitly applies a v2 catalog.

`review-loop-setup --json` reports catalog state (`ready`, `degraded`, `migration_required`, or `invalid`) separately from referenced-provider CLI and authentication health. A complete healthy single-provider v2 catalog is Review Loop-ready; dual-provider coverage is a caller deployment policy, not a universal Review Loop restriction.

Preview an operator-authored v2 catalog without changing active state:

```bash
review-loop-setup --desired-tier-config /trusted/reviewer-tiers-v2.json --json
```

Apply only after binding the write to the previewed active digest (or explicitly asserting that the active file is missing):

```bash
review-loop-setup \
  --desired-tier-config /trusted/reviewer-tiers-v2.json \
  --apply-tier-config \
  --expected-tier-config-digest <previewed-sha256> \
  --json
```

Apply serializes the digest check through atomic replacement, retains a digest-named
backup, and performs catalog plus production capability readback. A stale expectation is
rejected before mutation; catalog-readback failure restores the prior catalog, while
provider unavailability retains the valid catalog as `applied_degraded`. Backups remain
available after success or rollback. If restoration itself fails, setup reports both
redacted failures and the retained backup path and never reports the candidate ready.
The lock records its PID and creation time; a dead-owner lock is archived and recovered
automatically, while a live or unreadable lock reports its owner evidence and explicit
operator recovery instruction.
PID liveness assumes the trusted state directory is local to one host. Digest-named
backups use ordinary OS copy permissions, belong to the invoking operator, and are never
deleted automatically; that operator owns retention/removal after validation.
Archived orphan-lock records follow the same operator-owned retention policy. A crash
after atomic replacement but before readback leaves either complete old or complete new
bytes; the next setup re-inspects the active catalog, and the next explicit apply
archives the dead lock and must bind to the active digest before verification or change.
Review Loop never invents model choices or silently converts v1 data.

Each configured profile includes a release digest over the provider, model, reasoning effort, installed reviewer CLI version, companion/run-wrapper source and version, exact static read-only argv contract, prompt contract, reviewer schemas, deterministic finding policy, and complete operator tier configuration. A tiered normalized result returns that exact identity under `result.reviewer_mechanism.release_identity`. In authoritative transaction mode, the authorization's isolation-profile digest selects exactly one configured profile; review-loop never retries or falls back internally. Existing untiered runs remain `legacy_unqualified` and preserve their current host selection and fallback behavior.

Each configured tier also exposes `isolation_profile`, a versioned derivation of
that release identity and its exact read-only launch contract. The profile
asserts a fresh context, disabled resume/history persistence, packet-only input,
and terminal-reviewer behavior. Its digest is the value bound into an Agent
Kernel authorization; it is not a parallel profile registry.

### Agent Kernel-authorized transactions

Agent Kernel may supply `--authorization <path> --subject-digest <sha256>` with
a qualified `--tier`, exactly one immutable `--artifact` packet, and explicit
`--scope none`. The subject digest must equal the packet's actual SHA-256;
content substitution therefore fails before reviewer launch. Review Loop also
validates the envelope schema, digest, expiry, attempt ordinal, and selected
isolation-profile digest. Authoritative mode rejects `--focus`, `--counter`,
`--guidelines`, and positional reviewer instructions, and ignores discovered
project/user guidance in favor of fixed adapter-owned instructions covered by
the adapter release digest. It then performs exactly one invocation and returns a
`review-loop.transaction-result.v1` object:

- `outcome: decision` means the complete reviewer result was schema-valid and
  substantive. Valid findings are terminal even when the outer `ok` is false.
- `outcome: unavailable` means the reviewer transport or process did not return
  content.
- `outcome: unparseable` means content was returned but the complete result or
  required identity evidence was invalid. Review Loop never salvages prose.

The transaction includes the authorization identity, a fresh
`review_context_id`, the derived isolation profile, exactly
`invocation_count: 1`, the producer-computed `reviewed_input_digest`, separate
transport and envelope validity evidence, and a digest of the provider-reported
native reviewer session ID. Qualified Codex runs include `--ephemeral`, so the
no-history-persistence claim is enforced by the exact digest-bound launch argv.
An authoritative caller that admits the optional v1 diagnostic explicitly passes
`--emit-failure-diagnostic`; without that negotiation, unavailable results preserve the
pre-change digest-only failed-transport shape. Negotiated outcomes include a bounded
best-effort category and fixed safe message so operators can distinguish authentication,
rate limit, timeout, process, provider, response, and unknown failures. Categories are
diagnostic hints, never control inputs. Raw provider/process diagnostics are represented
only by their existing digest; raw diagnostics, invalid reviewer prose, and provider
session IDs are not emitted. Review Loop deliberately
requires the negotiation flag and consumer schema to be installed and rolled back as
one caller unit. Agent Kernel enforces this by shipping both in the same plugin version;
other callers assume the same obligation. Negotiated diagnostics ship here because the
same outage exposed the missing evidence, but the default-off flag/schema addition is
independently reversible without reverting catalog reconciliation. Review Loop
deliberately
does not persist a replay ledger: Agent Kernel rejects consumed authorizations,
owns the retry budget and recovery generation, and decides whether the emitted
evidence is admissible.

Claude tiered runs also compare the configured model with the primary model reported by Claude's result envelope. Silent provider remapping is treated as identity drift and blocks the review. Bedrock, Vertex, and Foundry Claude backends are not currently qualified and fail closed instead of being mislabeled as Anthropic.

Codex currently does not report a resolved model in its structured execution output. Its release identity therefore records `model_identity_evidence: "explicit_argv"`: review-loop removes user configuration, disables project-document loading, runs from an instruction-neutral state directory with the reviewed repository mounted read-only, and passes the configured model explicitly. These controls are included in the attested argv contract, but Codex still cannot perform Claude's post-execution model comparison. Claude identities record `provider_reported`. Callers can enforce different qualification requirements using this field.

A caller requesting a strong initial review may add `--continuation-envelope`. Only that invocation receives the continuation-capable reviewer schema; ordinary and legacy reviewers cannot emit the field. When the reviewer can bound the remediation, the normalized result may include `continuation_envelope` with allowed paths and subject elements, the expected closure claim, required checks, and forbidden effects. This remains untrusted reviewer evidence until the caller validates it against its own policy and immutable subject.

## Install

### Codex

Add the marketplace:

```bash
codex plugin marketplace add tennisonchan/review-loop --ref main
```

Install the plugin:

```bash
codex plugin add review-loop@review-loop
```

For local development from this repository root:

```bash
codex plugin marketplace add .agents/plugins
codex plugin add review-loop@review-loop
```

Inside Codex, `review-loop`, `review-loop-setup`, and the other commands are plugin skills — ask the agent to run them. To use the same commands from your own shell, install the binaries globally:

```bash
npm install -g github:tennisonchan/review-loop
review-loop-setup --init-guidelines
```

### Claude Code

The same plugin also includes Claude Code slash-command metadata. Install it through Claude Code's plugin flow, ensure `codex` is available for opposite-agent review, then use:

```bash
/review-loop:setup
/review-loop:run
/review-loop:status
/review-loop:result
/review-loop:cancel
```

The Claude Code commands run from `CLAUDE_PLUGIN_ROOT`, so the shared runtime uses Codex as the default reviewer.

## Migration Notes

This rename intentionally does not preserve old command or configuration names:

- `cc-review*` binaries were removed; use `review-loop*`.
- `CC_REVIEW_*` environment variables were removed; use `REVIEW_LOOP_*`.
- `json cc-review` policy fences are no longer honored; use `json review-loop`.
- State now lives under `review-loop`; repositories that need an explicit `block_on` override or disabled marker should rerun `review-loop-setup` with the appropriate gate flag.
- Missing gate config now means enabled, so rerun `review-loop-setup --disable-review-gate` after upgrading if a repository should keep the installed Stop hook disabled.

## Review Guidelines

Initialize project guidelines:

```bash
review-loop-setup --init-guidelines
```

This creates `.review-loop/review-guidelines.md`. Review-loop does not read Claude-specific rule files; move any existing review guidance into the neutral path.

Resolution order:

1. `--guidelines <path>`
2. nearest `.review-loop/review-guidelines.md`
3. `~/.review-loop/review-guidelines.md`
4. bundled `templates/review-guidelines.md`

Guidelines may include a machine-read blocking policy in a fenced block:

```json review-loop
{
  "block_on": "high",
  "category_block_on": {
    "security": "medium",
    "style": "never"
  }
}
```

`block_on` sets the base severity threshold and `category_block_on` overrides it per finding category, with `"never"` exempting a category from policy promotion. This machine-readable block is the only deterministic policy input; natural-language guidelines and `--focus` guide reviewer judgment but do not drive normalization. If no machine-readable policy is present, `review-loop run` uses the fallback threshold: high-severity findings block, lower severities are advisory unless the reviewer marks them blocking. An explicit `review-loop-setup --enable-review-gate --block-on <severity>` choice overrides the Stop-hook policy's base `block_on`; `category_block_on` overrides still apply on top of it.

Guidelines tune review behavior but cannot override read-only safety: the reviewer's inability to modify files is enforced mechanically (plan mode plus a read-only tool list), not by prompt text. The reviewer mechanism receives raw context, artifact, and diff content; redaction is best-effort and applies to persisted metadata/logs, not to what the model sees. Treat guidelines as trusted configuration and avoid sending secret-bearing files for review.

## Automatic Gate

The plugin ships host-specific `Stop` hook metadata. When that hook is installed, the review gate is enabled by default and uses the normal guidelines/default blocking policy unless a repository writes an explicit override.

Write or refresh an explicit gate configuration for the current repository:

```bash
review-loop-setup --enable-review-gate
```

This is only needed to persist options such as `--block-on` and automatic-gate reviewer failure policy; the missing-config default is enabled. Automatic gates block after both primary and fallback reviewer mechanisms fail unless the repository explicitly opts into report-only availability:

```bash
review-loop-setup --enable-review-gate --on-reviewer-failure allow
```

Restore fail-closed behavior after an outage with the same command and `block`. Background reviews retain their captured direct-run `--on-reviewer-failure` policy and do not consume this automatic-gate setting.

The gate blocks finalization when the normalized result contains `blocking_findings`. Each blocked stop is re-reviewed, so fixes are verified before finalization. Loop prevention is bounded per task: three blocks for the same finding set and five blocks total; past those caps the gate allows finalization and reports the unresolved findings instead. A stop that changed nothing reuses the previous review decision instead of invoking the reviewer again.

When the opposite-agent reviewer has a tool or provider failure, review-loop can trigger one degraded read-only fallback review by the host agent: Codex-hosted runs fall back from Claude Code to Codex, and Claude Code-hosted runs fall back from Codex to Claude Code. Eligible failures include authentication, rate limits, session limits, missing CLIs, timeouts, provider/process failures, and wholly non-substantive malformed or absent envelopes. Malformed output carrying a recoverable substantive decision or finding returns `invalid_review_evidence` without fallback. Findings from a completed fallback review still use the same `block_on` / `category_block_on` policy and can block finalization. If both mechanisms fail, direct review and the automatic Stop gate block missing review coverage by default; only the explicit automatic-gate `allow` configuration above permits report-only finalization. If no distinct host fallback reviewer is known, reviewer mechanism failures follow the configured reviewer-failure policy. The separate cap-forced-finalization path for repeated substantive findings remains unchanged.

Disable the gate with:

```bash
review-loop-setup --disable-review-gate
```

That command writes an explicit disabled marker. Users who manually disable or relocate the host hook can continue to do so outside review-loop setup.

## Development

```bash
npm test
```
