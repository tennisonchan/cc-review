# Changelog

## Unreleased

- Renamed the product, package, plugin, CLI, skills, state directory, and environment namespace from `cc-review` to `review-loop`; old `cc-review*` command names and `CC_REVIEW_*` environment variables are intentionally not preserved.
- Removed the separate counter-review command surface; use `review-loop run --counter` for counter-review stance. Gate, fallback, background jobs, and bundled skills use the normalized v2 result shape.
- Renamed the machine policy fence to `json review-loop`; old `json cc-review` policy blocks are intentionally no longer honored.
- Existing repositories that previously enabled the gate should rerun `review-loop-setup --enable-review-gate` because gate state now lives under the `review-loop` state directory.
- Added separate reviewer-output and normalized-result schemas. Reviewer output is validated structurally first; review-loop then applies deterministic machine policy/fallback threshold normalization to return snake_case `blocking_findings`, `advisory_findings`, `required_next_actions`, and `reviewed_inputs`.
- Removed old gate-config compatibility markers; existing repositories should rerun `review-loop-setup --enable-review-gate` if they want the current null-by-default `block_on` config shape.
- Background job metadata for generic reviews redacts free-form focus text in persisted status/result records.
- Branch-scope reviews now auto-detect the default branch before falling back to `main`/`master`.

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
