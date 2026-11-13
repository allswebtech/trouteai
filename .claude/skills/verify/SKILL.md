---
name: verify
description: Run TRouteAI's checks in the right order (lint, type baseline, build, tests) with a throwaway data folder, and report the exact numbers. Use before calling any code change done, before a commit, and before opening a pull request.
allowed-tools: Bash(npm run lint) Bash(npm run typecheck:baseline) Bash(npm run build) Bash(npm test) Bash(npm run test:all) Bash(git status *) Bash(git diff *)
---

# Verify a change

Run the steps in this order and stop at the first one that fails. One heavy command at a time:
never start a second build, type check or test run next to a running one, and never delete
`.build` (a dev server may be using it).

1. **What changed:** `git status --short` and `git diff --stat`. If only documentation changed,
   say so and skip to the report.
2. **Lint:** `npm run lint`. Expect no errors. Warnings that were there before are fine; a new
   warning is not.
3. **Build:** `DATA_DIR=$(mktemp -d) npm run build`. One to three minutes.
4. **Types:** `npm run typecheck:baseline`, after the build because it reads type files the
   build generates. It fails only when the number of type errors is above the stored baseline.
   The build ignores type errors, so this step is the only type gate. If it reports fewer errors
   than the baseline, mention it (the baseline can be lowered).
5. **Tests:** `npm test`. It starts the built app on a spare port with a throwaway data folder
   and fake providers. For a change in context size, usage limits or routing, also run
   `npm run test:all`. Expected totals are in `tests/README.md`.

Rules that are not negotiable:

- Never point a test or a manual run at `~/.trouteai`, and never at a TRouteAI that is already
  running on port 20017. Use `DATA_DIR=$(mktemp -d)` and a spare port.
- Never call a route that reads credential files from the host (for example
  `/api/oauth/kiro/auto-import`).
- A failing check is fixed at its cause. Do not raise the type baseline, add a lint suppression,
  or loosen a test to get to green.

## Report

End with the facts, in this shape:

- lint: errors / warnings
- types: count against the baseline
- build: pass or fail
- tests: passed / total for each suite you ran
- what you could not check, and why
