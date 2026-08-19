# Changelog

## Unreleased

## 0.11.2

- Publish normalized-result protocol v5 from one canonical declarative reviewer contract, with a deterministic contract digest in both host manifests, setup readiness, and every normalized result.
- Generate the canonical reviewer, normalized-result, execution-result, and Codex-compatible schemas from that contract, and reject generated-file drift during validation.
- Add mandatory canonical post-validation and closed semantic invariants so incomplete, contradictory, extra, or malformed reviewer evidence cannot become authority.
- Route optional advice, downstream workflow, invalid-envelope recovery, and Review Loop diagnostics through non-authority observations with explicit origin; reserve `required_next_actions` for current-subject remediation.
- Use the existing single fallback only for transport failures and contract-invalid envelopes without actionable blockers. Preserve actionable invalid evidence without answer-shopping, and preserve non-actionable invalid-envelope notes without attributing them to the fallback reviewer.

## 0.11.1

- Preserve `required_next_actions` as advisory follow-up when the reviewer explicitly approves and no blocking finding remains.
- Continue normalizing approved results with blocking findings to `changes_requested`.

## 0.11.0

- Publish normalized-result protocol v4 with explicit review completion, reviewability, substantive-merit, packet acknowledgement, material acknowledgement, and limitation fields.
- Bind performed reviews to the exact packet and complete reviewed-material digest set, and reject missing, stale, contradictory, or ungrounded reviewer evidence.
- Expose the protocol version in both host manifests and setup JSON so managed installers can reject unequal producer/consumer pairs before activation.
- Make the Stop gate reject every non-approved result, including grounded changes requests with no policy-promoted blocking finding.
- Preserve reviewer-decision polarity ahead of category exemptions: an explicit non-approved decision remains blocking even when its findings are policy-exempt.

## 0.10.0

- Remove the semantic-tier catalog, capability discovery, reconciliation, authorization transaction, release identity, isolation profile, and continuation-envelope bridge surfaces.
- Publish normalized result v3 with a string reviewer mechanism and no routing identity or workflow action.
- Keep optional exact reviewer/model selection and one automatic fresh host fallback inside Review Loop.
- Fix direct companion execution so help and setup initialize after all command metadata is declared.

## 0.9.0

- Add optional exact reviewer/model input and action-neutral execution provenance.
- Automatically attempt one fresh host reviewer for eligible mechanism failures without operator prompts.
- Prevent answer-shopping when malformed output contains recoverable findings, and require native session identity for completed fallback.
- Decouple operational readiness from the deprecated semantic-tier catalog while retaining a narrow old-Kernel rollout bridge.

## 0.8.0

- Make v1 reviewer-tier catalogs migration-only instead of projecting them as qualified runtime routes.
- Add machine-readable catalog and provider readiness, including both reviewer CLIs and authentication, while keeping complete healthy single-provider v2 catalogs Review Loop-ready.
- Add explicit operator-authored v2 reconciliation with preview, optimistic digest binding, backup, atomic write, production capability readback, and rollback.
- Refuse silent model selection, implicit migration, stale writes, and misleading setup success for legacy or invalid catalogs.
- Add an explicitly negotiated bounded failure category with a fixed safe message for authoritative unavailable outcomes; non-negotiating callers retain the old digest-only shape and raw provider/process detail always remains digest-only.
- Serialize catalog apply across digest comparison and atomic rename, recover dead-owner locks, retain recovery backups, and preserve setup `ok` compatibility while activation reads explicit readiness fields.
- Keep complete healthy single-provider catalogs Review Loop-ready while exposing missing alternates as stable informational reason codes for stricter callers such as Agent Kernel.

## 0.7.0

- Add ordered, provider-diverse reviewer profiles to each semantic tier.
- Select exactly one authoritative reviewer by its authorized isolation-profile digest.
- Preserve version 1 single-profile configuration and primary capability projections.
- Reject duplicate providers, mutable model aliases, and tiers with more than two profiles.

## 0.6.0

- Add Agent Kernel-authorized single-invocation review transactions with
  decision, unavailable, and unparseable outcomes.
- Derive versioned isolation evidence from qualified release identity and emit
  hashed provider-native reviewer session identity.
- Bind the authorization subject to the immutable packet bytes, classify
  returned invalid envelopes separately from transport failures, and enforce
  ephemeral qualified Codex sessions.
- Exclude unbound caller, project, and user reviewer instructions from
  authoritative packet-only transactions.
- Keep direct advisory review behavior compatible while authoritative mode
  bypasses cache, fallback, background, continuation, and fail-open paths.

## 0.5.3

- An explicit `category_block_on: "never"` policy is now a hard exemption even when the reviewer marks the finding blocking, preserving deterministic caller policy precedence.

## 0.5.2

- A concrete correctness, compatibility, safety, or data-loss regression that must be fixed before finalization now remains blocking at its evidence-supported severity. Reviewers no longer downgrade such findings merely because the machine policy threshold would not independently promote them.

## 0.5.1

- Strengthened the shared reviewer contract to trace externally reachable compatibility, stale retained identity across scope changes, and shared-component behavior. The same mechanism checks now apply to every reviewer provider and semantic tier.

## 0.5.0

- Added provider-independent `fast`, `standard`, and `strong` reviewer tiers backed by strict operator-owned configuration, a machine-readable capability response, exact model/reasoning argv, and digest-bound release identity evidence. Tiered runs fail closed without cross-provider fallback; Claude runs additionally reject provider-reported model drift. Legacy untiered behavior remains available but unqualified.
- Release identities distinguish Claude's provider-reported model evidence from Codex's explicit-argv evidence so callers can apply qualification policy without assuming equivalent runtime observability.
- Tiered Codex reviews run from an instruction-neutral state directory, disable project-document loading, and expose that workspace strategy in their attested read-only contract. Adapter versions are read from the packaged plugin manifest so capability discovery works from installed plugin caches as well as source checkouts.
- Release identities bind the installed reviewer CLI version. Tiered Claude capabilities fail closed for unqualified Bedrock, Vertex, or Foundry backends rather than attesting them as Anthropic.
- Added an opt-in structured continuation envelope for strong initial reviews. Only explicitly requested strong reviews receive the continuation-capable output schema; review-loop validates and carries the envelope as reviewer evidence without granting it policy authority.
- Reviewer output now requires an explicit decision and rejects the observed normalized `test` placeholder as a reviewer-mechanism failure. Review caches are integrity-versioned so legacy or placeholder-bearing entries are misses. Automatic gates now block by default when both the primary and distinct-host fallback reviewers fail; repositories that intentionally prefer availability can persist report-only behavior with `review-loop-setup --enable-review-gate --on-reviewer-failure allow`.

## 0.4.0

- An explicit `review-loop run` whose target resolves to empty (no diff in the selected scope and no `--artifact`/`--context`) now returns `decision: "invalid_input"` (`ok: false`) with actionable next steps instead of `approved` / "Nothing to review.". The automatic Stop-hook gate keeps the prior allow-on-clean-tree behavior so finalization is never blocked when there are genuinely no changes. This prevents an explicit review request from silently passing without reviewing anything.
- Renamed the product, package, plugin, CLI, skills, state directory, and environment namespace from `cc-review` to `review-loop`; old `cc-review*` command names and `CC_REVIEW_*` environment variables are intentionally not preserved.
- Removed the separate counter-review command surface; use `review-loop run --counter` for counter-review stance. Gate, fallback, background jobs, and bundled skills use the normalized v2 result shape.
- Renamed the machine policy fence to `json review-loop`; old `json cc-review` policy blocks are intentionally no longer honored.
- The Stop-hook review gate is enabled by default when the host hook is installed. `review-loop-setup --disable-review-gate` now writes an explicit disabled marker; use `--enable-review-gate` to persist options such as `--block-on`. Re-run `--disable-review-gate` after upgrading if a repository should keep the installed Stop hook disabled.
- Added separate reviewer-output and normalized-result schemas. Reviewer output is validated structurally first; review-loop then applies deterministic machine policy/fallback threshold normalization to return snake_case `blocking_findings`, `advisory_findings`, `required_next_actions`, and `reviewed_inputs`.
- Removed old gate-config compatibility markers; existing repositories should rerun `review-loop-setup --enable-review-gate` if they want the current null-by-default `block_on` config shape.
- Background job metadata for generic reviews redacts free-form focus text in persisted status/result records.
- Branch-scope reviews now auto-detect the default branch before falling back to `main`/`master`.
- Direct `review-loop run` and the Stop-hook gate now use a degraded host-agent fallback review when the selected opposite-agent reviewer hits auth, rate-limit, session-limit, timeout, missing CLI, malformed output, or other mechanism blockers.

## 0.3.0

- Gate infrastructure failures now degrade to a Codex fallback review instead of blocking solely on Claude Code tool/provider failure. Fallback findings still use the existing blocking policy; if both review paths fail, the gate allows finalization with an explicit missing-review-coverage warning.
- Fixed structured output against real Claude Code: the `$schema` meta key made `claude --json-schema` silently skip structured output, so every real review failed as an infrastructure error; the key is now stripped before invocation. Verified end-to-end through real Codex Stop hooks (allow and block paths).
- Gate reviews are cached per full-fidelity target fingerprint (content-hashed untracked files, full diff text), so a stop that changed nothing reuses the previous verdict instead of invoking Claude again.
- Review guidelines can declare the gate blocking policy in a `json review-loop` fenced block: `block_on` sets the base severity threshold and `category_block_on` overrides it per finding category (`"never"` exempts a category). Findings now require a `category`, and explicit `--block-on` choices override only the policy's base threshold. Legacy configs that stored the default threshold no longer shadow guidelines policies.
- `--init-guidelines` scaffolds a project-aware rubric: detected languages with review focus areas, test conventions, and manifest-derived test entry points.
- `review-loop-setup --enable-gate-debug` logs hook payloads to the state dir for diagnosing host integrations.

## 0.2.0

- Gate loop prevention is owned by bounded per-task counters (same-fingerprint cap, total block ceiling, infra-failure cap) instead of an early allow on `stop_hook_active`, so fixes are re-reviewed before finalization.
- Gate counters are consumed by cap allows and expire after a 10-minute chain gap, so one capped task cannot disable the gate for later tasks.
- The reviewer gets read-only context tools (Read, Grep, Glob); plan mode still prevents writes.
- Oversized diffs are truncated in the prompt with the full diff spilled to a readable overflow file; `claude` invocations time out; git spawn errors fail closed; unreadable untracked files no longer crash the review.
- Background job records have a single writer per phase, atomic writes, and honest cancel semantics (terminal states preserved, `kill_escalated` only on real escalation).
- Removed unused prompt files and the unregistered session-lifecycle hook; `--wait` is documented as the synchronous default; `claude` envelope errors are surfaced; token redaction covers GitHub and AWS key shapes.

## 0.1.0

- Initial implementation.
