# Review Loop Rename Plan

## Problem

The project has moved from a Claude Code-focused `cc-review` identity to a gate-agnostic multi-agent review loop engine. The old names imply a Claude Code-only reviewer and expose a separate counter-review surface. That creates product confusion and conflicts with the intended agent-kernel rename from `kernel:review-loop` to `kernel:review-gate`.

## Value

Renaming the product to `review-loop` makes the execution engine boundary explicit: it runs read-only independent review loops over caller-supplied context, artifacts, scopes, focus, and policy. Making counter-review a flag keeps the UX simple: normal review and counter-review are stances of one engine, not separate products or skills.

## Scope

Included:

- Rename repo-facing package/plugin/product identity from `cc-review` to `review-loop`.
- Rename plugin directory from `plugins/cc-review` to `plugins/review-loop`.
- Rename CLI binaries from `cc-review*` to `review-loop*`.
- Remove the old `cc-review` and `cc-adversarial-review` binary surfaces instead of keeping compatibility aliases.
- Rename the primary skill to `review-loop`.
- Remove the separate counter skill; expose counter behavior through `review-loop run --counter`.
- Replace public `--stance ...` UX with `--counter`.
- Rename the environment-variable namespace from `CC_REVIEW_*` to `REVIEW_LOOP_*`.
- Keep internal review result schema generic and gate-agnostic.
- Rename user-facing strings, docs, metadata, tests, state/cache labels, hook messages, and setup guidance.
- Preserve read-only reviewer safety, background jobs, status/result/cancel, Stop hook behavior, fallback review behavior, and normalized v2 output.
- Keep the machine policy fence language as `json review-loop`.
- Update tests to assert no legacy `cc-review` command compatibility remains.

Excluded:

- Renaming the GitHub repository through GitHub settings.
- Renaming agent-kernel in this repo; that is a separate agent-kernel change.
- Preserving `cc-review` CLI or skill aliases.
- Changing the normalized result schema semantics except where naming appears in metadata/messages.

## Target Names

- Product/repo/package/CLI: `review-loop`
- Main command: `review-loop run`
- Setup/status/result/cancel binaries: `review-loop-setup`, `review-loop-status`, `review-loop-result`, `review-loop-cancel`
- Companion binary/script: `review-loop-companion`
- Skill: `review-loop`
- Counter stance: `review-loop run --counter`
- Policy fence: `json review-loop`
- State directory: `review-loop`
- Environment variables: `REVIEW_LOOP_*`
- Hook script: keep descriptive purpose, `stop-review-gate-hook.mjs`.

## CLI Shape

Canonical examples:

```bash
review-loop run --scope working-tree --json
review-loop run --context review-context.md --focus "Check readiness and evidence gaps" --json
review-loop run --artifact design.md --focus "Check implementation readiness" --json
review-loop run --context packet.md --counter --focus "Challenge the caching assumption" --json
review-loop status --json
review-loop result <job-id> --json
review-loop cancel <job-id> --json
review-loop setup --init-guidelines
```

Behavior:

- `--counter` sets reviewer stance to counter-review.
- Without `--counter`, stance is standard.
- `--counter` may be combined with `--focus`.
- Trailing positional text continues to populate focus for convenience.
- The old `counter-review` subcommand and `cc-adversarial-review` binary are removed.
- The old `review` alias is removed. The Stop hook uses `gate`, not `review`, so alias removal is hook-safe. Existing tests that call `review` must be migrated to `run`.

## Implementation Approach

1. Rename files and directories:
   - `plugins/cc-review` -> `plugins/review-loop`
   - `cc-review-companion.mjs` -> `review-loop-companion.mjs`
   - bin wrappers to `review-loop*.mjs`
   - skill directories to `review-loop`, `review-loop-setup`, `review-loop-status`, `review-loop-result`, `review-loop-cancel`
   - remove the counter skill and binary wrapper.

2. Update manifests and package metadata:
   - `package.json` / `package-lock.json` name and `bin` map.
   - plugin manifest name, display text, repository/homepage strings, default prompts, and skill path.
   - marketplace metadata under `.agents/plugins`.

3. Update script behavior:
   - Top-level usage/help says `review-loop-companion`.
   - Parse `--counter`.
   - Remove public `review` and `counter-review` subcommands.
   - Replace public `--stance counter` with `--counter` while allowing an internal stance value for prompt construction.
   - Rename prompt language from adversarial to counter-review.
   - Rename state/cache dirs and messages from `cc-review` to `review-loop`.
   - Rename machine policy parser from fenced `json cc-review` to `json review-loop`.
   - Use reviewer mechanism strings like `review-loop` / `claude-code`, not `cc-review`.
   - Rename `CC_REVIEW_INPUT_` prompt delimiter text to `REVIEW_LOOP_INPUT_`.
   - Rename background job prefix from `ccr-` to a review-loop prefix such as `rlp-`.
   - Rename hook-payload recursion sentinel `cc_review_active` to `review_loop_active` and update the recursion-sentinel tests.
   - Rename fallback/operator strings such as "Claude-backed cc-review", "cc-review changes_requested", "No cc-review jobs found", "Started cc-review job", and "rerun cc-review".

4. Rename environment variables in one pass:
   - `CC_REVIEW_CLAUDE_BIN` -> `REVIEW_LOOP_CLAUDE_BIN`
   - `CC_REVIEW_CODEX_BIN` -> `REVIEW_LOOP_CODEX_BIN`
   - `CC_REVIEW_MAX_DIFF_CHARS` -> `REVIEW_LOOP_MAX_DIFF_CHARS`
   - `CC_REVIEW_CLAUDE_TIMEOUT_MS` -> `REVIEW_LOOP_CLAUDE_TIMEOUT_MS`
   - `CC_REVIEW_FALLBACK_TIMEOUT_MS` -> `REVIEW_LOOP_FALLBACK_TIMEOUT_MS`
   - `CC_REVIEW_GATE_CHAIN_GAP_MS` -> `REVIEW_LOOP_GATE_CHAIN_GAP_MS`
   - `CC_REVIEW_CANCEL_GRACE_MS` -> `REVIEW_LOOP_CANCEL_GRACE_MS`
   - `CC_REVIEW_HOOK_EVENTS` -> `REVIEW_LOOP_HOOK_EVENTS`
   - `CC_REVIEW_FORCE_MAIN_AGENT_HOOK` -> `REVIEW_LOOP_FORCE_MAIN_AGENT_HOOK`
   - `CC_REVIEW_BACKGROUND_ARGS` -> `REVIEW_LOOP_BACKGROUND_ARGS`
   - `CC_REVIEW_FALLBACK_TOKEN` -> `REVIEW_LOOP_FALLBACK_TOKEN`
   - `CC_REVIEW_FAKE_STRUCTURED_OUTPUT` -> `REVIEW_LOOP_FAKE_STRUCTURED_OUTPUT`
   - `CC_REVIEW_FAKE_FALLBACK_ERROR` -> `REVIEW_LOOP_FAKE_FALLBACK_ERROR`
   - `CC_REVIEW_FAKE_FALLBACK_STRUCTURED_OUTPUT` -> `REVIEW_LOOP_FAKE_FALLBACK_STRUCTURED_OUTPUT`

5. Update policy fences, docs, and guidelines atomically:
   - README and plugin README should describe `review-loop` as a multi-agent review loop engine.
   - Document `--counter` as the counter-review stance.
   - State that old `cc-review` command names are intentionally not preserved.
   - Update install examples to use the renamed GitHub repository URL `tennisonchan/review-loop`.
   - Update templates and live `.claude/rules/review-guidelines.md` fence names.
   - Update the parser to recognize only `json review-loop`.
   - Add a changelog/migration note that old `json cc-review` policy blocks are intentionally no longer honored.
   - Add a test that an old `json cc-review` fence is not parsed as policy, so the no-compatibility behavior is explicit rather than accidental.

6. Update tests:
   - Test new binary names and package bin map.
   - Test `review-loop run --counter` prompt rendering.
   - Test skill shell invocation uses `review-loop-companion`.
   - Test old `cc-review` binaries are absent from package bin map.
   - Test `json review-loop` policy parsing.
   - Test old `json cc-review` policy fences are ignored as no policy, with changelog warning.
   - Test state directory path uses `review-loop`.
   - Test `REVIEW_LOOP_*` env vars drive behavior and stale `CC_REVIEW_*` test seams no longer do.
   - Preserve current v2 output/gate/background/fallback tests.

## Verification

- `node --check plugins/review-loop/scripts/review-loop-companion.mjs`
- `node --check tests/companion.test.mjs`
- `npm test`
- Residual token scan must pass with only documented exceptions:
  - Allowed: migration/history references that explain the old repository name.
  - Allowed: migration notes and tests explicitly describing removed `cc-review` names and ignored old policy fences.
  - Allowed: this design plan when describing old-to-new rename intent.
  - Not allowed: active bin names, skill names, env vars, state dirs, prompt strings, policy parser names, or docs commands using `cc-review`, `cc-adversarial-review`, `adversarial`, `cc_review`, `ccr-`, or `CC_REVIEW_`.
  - Candidate command:

    ```bash
    rg -n 'cc-review|cc-adversarial|adversarial|CC_REVIEW_|cc_review|ccr-|needs_changes|max_severity' . --glob '!node_modules/**' --glob '!.git/**'
    ```

- Run the existing reviewer engine on the final diff. Before implementation, use the current `cc-review` command; after implementation, use `review-loop run`.
- Open PR, wait for CI, merge, pull `main`, and run post-merge `npm test`.

## Known Risks

- Broad rename can miss path references in tests, manifests, hook config, marketplace metadata, or README install examples.
- Removing compatibility aliases means any local scripts using `cc-review*` fail immediately. This is intentional per user direction.
- Renaming the state directory disables any previously-enabled gate until `review-loop setup --enable-review-gate` is rerun, because the enabled gate config lives under the state root. This is acceptable for a no-compatibility rename but must be documented in the changelog and README upgrade note.
- Renaming the policy fence means old `json cc-review` blocks no longer apply; category-specific security/data-loss blocking can silently stop until guidelines are updated. This must be documented and tested as intentional no-compatibility behavior.
- Renaming env vars means existing shell config using `CC_REVIEW_*` stops applying. This must be documented as intentional.
- The GitHub repository URL cannot be renamed by code changes alone; docs should avoid claiming the remote has changed until it is renamed externally.
- The current source checkout may still live under a local directory named `cc-review` during the PR; local path names should not leak into product docs except repository URL examples.

## Reviewer Ask

Review this plan before implementation. Focus on whether the rename scope is complete, whether `--counter` cleanly replaces counter naming, whether removing old `cc-review` surfaces creates any accidental internal breakage, and whether verification is strong enough for a repo-wide rename.
