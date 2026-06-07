# Review Guidelines

Review for correctness, security, maintainability, data loss risk, and missing tests.

Use these severities:

- `high`: likely user-facing breakage, data loss, security issue, or invalid core behavior.
- `medium`: meaningful bug, maintainability risk, or missing coverage for important behavior.
- `low`: minor issue, edge case, or localized cleanup.
- `info`: non-blocking observation.

Return `needs_changes` only for findings that require action before the work is finalized. Avoid style-only findings unless they affect correctness or maintainability.

