# Review Loop Product Boundary

Review Loop is read-only review machinery. Its public service is intentionally limited to review material plus two optional inputs:

1. review policy/guidelines;
2. a preferred reviewer and exact model.

The caller owns risk classification, model-policy translation, triggering, and every workflow action after review. Review Loop never translates `low`, `moderate`, `high`, or `critical`, and never decides whether a task should continue, retry, merge, block, or escalate.

## Resilience contract

- Omitted policy uses the bundled/default policy. An explicitly malformed policy is `invalid_input`; it is never silently weakened.
- Omitted model uses the host-aware default reviewer behavior.
- An exact requested model is passed with `--reviewer`, `--model`, and optional `--reasoning-effort`.
- If the requested mechanism fails, or returns a contract-invalid envelope without an actionable current-subject blocker, Review Loop automatically attempts one deduplicated fresh host-model reviewer. An exact model on the host provider is distinct from that provider's host default, so it remains fallback-eligible; only an already-default route is collapsed. Review Loop never asks the operator which model to use.
- A valid decision is terminal. A contract-invalid envelope with a recoverable blocking finding or current-subject required action returns `invalid_review_evidence` without invoking another reviewer. Advisory-only and finding-free invalid envelopes are eligible for the one fallback; their recoverable notes are carried only as non-authority observations with `origin: requested_invalid_envelope`, never attributed to the fallback reviewer. Truncated prose is terminal only when it contains an actionable finding or action.
- A completed host fallback requires a provider-native session identity. Review Loop derives freshness structurally by launching a new non-persistent provider process and reports the resulting identity digest; the coordinating caller compares that digest with its bound author/fixer identities before admitting independence. Missing identity returns `unavailable`, and Review Loop never fabricates independence.
- Both mechanisms failing returns `unavailable` with bounded categories and digests, not raw provider/process diagnostics.
- A coordinating consumer must durably admit the complete normalized result before it publishes or interprets a gate/workflow outcome. Review Loop deliberately disables provider session persistence, so a consumer cannot treat decision/result digests alone as a recoverable substitute for findings and required actions. Publication replay must use that admitted normalized result and the original packet-bound authority inputs; it must not invoke another reviewer merely because downstream publication failed.

The action-neutral normalized result v5 and `review_execution` object are the caller contracts. `result` contains the complete review and the exact `review_contract_digest`; `review_execution` contains only requested/effective mechanism, bounded attempt, diagnostic, fallback, and reviewer-session provenance. Neither contract encodes workflow action or risk classification. `required_next_actions` is reserved for current-subject remediation and must be empty for approval and diagnostic `invalid_input`; optional advice, downstream workflow, and Review Loop recovery guidance use closed observations with explicit origin.

The checked-in `reviewer-contract.v5.json` is the single declarative owner of the reviewer-output, normalized-result, and execution-result schemas, semantic invariant identifiers, and allowed provider projections. Shipped schemas are generated from it. Its identity is `sha256("review-loop.contract.v5\0" + canonicalJSON(contract))`, where canonical JSON recursively sorts object keys and preserves array order. Consumers must pin both protocol v5 and the exact digest, and every normalized v5 result carries that digest for live-wrapper admission.
