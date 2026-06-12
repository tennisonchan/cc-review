# Changelog

## 0.2.0

- Gate loop prevention is owned by bounded per-task counters (same-fingerprint cap, total block ceiling, infra-failure cap) instead of an early allow on `stop_hook_active`, so fixes are re-reviewed before finalization.
- Gate counters are consumed by cap allows and expire after a 10-minute chain gap, so one capped task cannot disable the gate for later tasks.
- The reviewer gets read-only context tools (Read, Grep, Glob); plan mode still prevents writes.
- Oversized diffs are truncated in the prompt with the full diff spilled to a readable overflow file; `claude` invocations time out; git spawn errors fail closed; unreadable untracked files no longer crash the review.
- Background job records have a single writer per phase, atomic writes, and honest cancel semantics (terminal states preserved, `kill_escalated` only on real escalation).
- Removed unused prompt files and the unregistered session-lifecycle hook; `--wait` is documented as the synchronous default; `claude` envelope errors are surfaced; token redaction covers GitHub and AWS key shapes.

## 0.1.0

- Initial implementation.
