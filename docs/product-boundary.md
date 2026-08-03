# Review Loop Product Boundary

Review Loop is read-only review machinery. Its public service is intentionally limited to review material plus two optional inputs:

1. review policy/guidelines;
2. a preferred reviewer and exact model.

The caller owns risk classification, model-policy translation, triggering, and every workflow action after review. Review Loop never translates `low`, `moderate`, `high`, or `critical`, and never decides whether a task should continue, retry, merge, block, or escalate.

## Resilience contract

- Omitted policy uses the bundled/default policy. An explicitly malformed policy is `invalid_input`; it is never silently weakened.
- Omitted model uses the host-aware default reviewer behavior.
- An exact requested model is passed with `--reviewer`, `--model`, and optional `--reasoning-effort`.
- If the requested mechanism fails before any substantive content exists, Review Loop automatically attempts one deduplicated fresh host-model reviewer. An exact model on the host provider is distinct from that provider's host default, so it remains fallback-eligible; only an already-default route is collapsed. Review Loop never asks the operator which model to use.
- A valid substantive decision is terminal. Malformed or truncated output containing a recoverable decision or finding returns `invalid_review_evidence`; Review Loop does not invoke another reviewer.
- A completed host fallback requires a provider-native session identity. Review Loop derives freshness structurally by launching a new non-persistent provider process and reports the resulting identity digest; the coordinating caller compares that digest with its bound author/fixer identities before admitting independence. Missing identity returns `unavailable`, and Review Loop never fabricates independence.
- Both mechanisms failing returns `unavailable` with bounded categories and digests, not raw provider/process diagnostics.
- A coordinating consumer must durably admit the complete normalized result before it publishes or interprets a gate/workflow outcome. Review Loop deliberately disables provider session persistence, so a consumer cannot treat decision/result digests alone as a recoverable substitute for findings and required actions. Publication replay must use that admitted normalized result and the original packet-bound authority inputs; it must not invoke another reviewer merely because downstream publication failed.

The action-neutral normalized result v3 and `review_execution` object are the caller contracts. `result` contains the complete review; `review_execution` contains only requested/effective mechanism, bounded attempt, diagnostic, fallback, and reviewer-session provenance. Neither contract encodes workflow action or risk classification.
