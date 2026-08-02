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

The action-neutral `review_execution` object is the new caller contract. The legacy normalized `result` projection and semantic-tier capability fields remain only as the temporary old-Kernel rollout bridge and are removed by RL-CLEANUP after AK-CUTOVER is installed and verified.

## Consumer inventory for the bridge-present release

| Consumer | Foundation treatment | Cleanup owner |
| --- | --- | --- |
| `review-loop run` and command wrapper | Add optional model flags and `review_execution`; retain legacy `result` projection | RL-CLEANUP removes only obsolete projection after Kernel cutover |
| Standalone Stop/gate adapter | Preserve existing normalized-result behavior; mechanism fallback remains internal | RL-CLEANUP switches to action-neutral outcome where needed |
| Background job persistence/status/result | Additive wrapper field; raw session IDs are removed before persistence | No behavioral break expected |
| Setup and capabilities | Operational readiness no longer depends on the catalog; tier/catalog fields remain marked deprecated | RL-CLEANUP removes tier/catalog bridge |
| Existing Agent Kernel v2 transaction | Continues to use authorized `--tier` path without internal fallback; its digest-only terminal record is not a durable store for normalized findings | AK-CUTOVER replaces it with Kernel-owned request/transaction v3 that admits the full action-neutral result before publication |
| External CLI/JSON callers | Additive top-level `review_execution`; legacy fields remain during bridge window | Breaking removal must be called out in RL-CLEANUP release notes |

## Delivery boundary

RL-FOUNDATION ships the bridge-present contract. AK-CUTOVER then consumes the new contract and owns risk/model policy and result interpretation. RL-CLEANUP is a separate exact-head change with its own Execution Gate, install smoke, rollback pair, and Delivery Validation.
