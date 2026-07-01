---
name: review-loop
description: Review local changes with a read-only opposite-agent gate before Codex finalizes work, submits a PR, or claims implementation-ready output.
---

# review-loop

Use this skill when local repo changes, a design artifact, or an agent-prepared context packet needs independent review before a final response, implementation-ready handoff, or PR submission.

1. Choose the review target:
   - use the default `--scope auto` for local changes
   - pass `--scope none` with `--context <path>` or `--artifact <path>` for context-only or artifact-only review
   - add `--focus <text>` for known risks, and use `--counter` only to challenge a specific assumption

   Completion criterion: the target, optional focus, and any base/context/artifact arguments are explicit.

Run:

```bash
REVIEW_LOOP_HOST=codex node "<skill-root>/../../scripts/review-loop-companion.mjs" run --scope auto $ARGUMENTS
```

2. If the review may outlast the current turn, add `--background`, use `review-loop-status` until the job completes, then use `review-loop-result` to retrieve the result. Otherwise, wait for the command output.

   Completion criterion: you have the final review output, not just a job id.

Common arguments; append `--help` to the `run` command before using advanced reviewer or failure-policy controls:

- `--background`
- `--base <ref>`
- `--scope none|auto|working-tree|branch`
- `--context <path>`
- `--artifact <path>`
- `--focus <text>`
- `--guidelines <path>`
- `--counter`
- `--json`

3. Treat the reviewer as read-only. Do not ask the opposite-agent reviewer to patch, edit, commit, delegate, invoke `review-loop`, or continue into implementation.

   Completion criterion: every blocking finding is fixed by Codex and re-reviewed, or handed off as unresolved; every advisory finding is considered. A prose rejection does not clear a deterministic gate block.

4. If you change files after the review, run `review-loop` again over the updated target.

   Completion criterion: the latest review has no unresolved blocking findings, or the final response reports the reviewer failure or unresolved blocker with evidence.
