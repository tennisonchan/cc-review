# Review Guidelines

Review for correctness, security, maintainability, data loss risk, and missing tests.

Use these severities:

- `high`: likely user-facing breakage, data loss, security issue, or invalid core behavior.
- `medium`: meaningful bug, maintainability risk, or missing coverage for important behavior.
- `low`: minor issue, edge case, or localized cleanup.
- `info`: non-blocking observation.

Mark findings as `blocking` only when they require action before the work is finalized. Avoid style-only findings unless they affect correctness or maintainability.

## Categories

Tag each finding with the best-matching category: `security`, `correctness`, `data-loss`, `maintainability`, `tests`, or `style`.

## Blocking policy

This block is machine-read by the review gate. `block_on` is the base severity threshold; `category_block_on` overrides it per category (`"never"` exempts a category from blocking).

```json cc-review
{
  "block_on": "high",
  "category_block_on": {
    "security": "medium",
    "data-loss": "medium",
    "style": "never"
  }
}
```


## Project profile

Detected by `cc-review-setup --init-guidelines`; edit freely.

- JavaScript (ESM): pay extra attention to unhandled promise rejections, missing await, loose equality on user input.
- Tests live in dedicated test directories; flag changed behavior that lacks matching test updates.
- Expected test entry points: npm test (node --test tests/*.test.mjs).
