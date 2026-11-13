# Tests

Offline tests for TRouteAI. They need no account, no real provider and no network beyond
`localhost`: every provider is a small mock server in this folder, or a replaced `fetch` inside
the process. Every run uses its own throwaway data folder (`mktemp -d`) and spare ports, so the
default data folder (`~/.trouteai`) and the default port 20017 are never touched.

Build first (the server tests start the built app with `node app.cjs`):

```bash
npm run build
npm test            # smoke test + Claude Code -> Kiro checks
npm run test:all    # every suite below
```

Both exit non-zero when any check fails. `sh tests/all.sh context quota checks` runs only the
named suites.

## What runs

| Command                     | Covers                                                                                                                                                                                                       | Expected    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `npm test` (`smoke/run.sh`) | login, every dashboard page, provider / connection / combo / API key setup, chat in OpenAI, Anthropic and Responses format, model and combo-step ON/OFF, auth errors (`e2e.mjs` against `mock-upstream.mjs`) | 27/27       |
|                             | Kiro refusals, thinking, stop sequences, max_tokens, error shapes, PDFs (`checks/check-kiro-refusal.mts`)                                                                                                    | 142         |
|                             | `count_tokens` estimates (`checks/check-count-tokens.mts`)                                                                                                                                                   | 8           |
|                             | Kiro usage numbers (`checks/check-kiro-usage.mts`)                                                                                                                                                           | 4           |
|                             | Claude `thinking.display` values (`checks/check-claude-display.mts`)                                                                                                                                         | 4           |
|                             | web search and web fetch server tools (`checks/check-web-search.mts`)                                                                                                                                        | 39          |
|                             | Anthropic Messages API conformance and answers that fail inside the stream, through the server against a fake Kiro (`smoke/kiro-mock.sh`)                                                                    | 39          |
| `smoke/context.sh`          | no silent trimming, context-overflow errors in the wording clients recover from (`context-e2e.mjs` against `mock-anthropic.mjs`)                                                                             | 29/29       |
| `smoke/quota.sh`            | usage-limit routing in all 16 combo strategies, reset, restart (`quota-e2e.mjs` against `mock-anthropic.mjs`)                                                                                                | 31/31 + 2/2 |
| `checks/run.sh <check>`     | `check-context-overflow.mts`                                                                                                                                                                                 | 50          |
|                             | `check-quota-windows.mts`                                                                                                                                                                                    | 23          |
|                             | `check-kiro-identity.mts` (`KIRO_IDENTITY_ONLINE=1`: 4 more checks that send a fake token to Kiro's servers)                                                                                                 | 24          |
|                             | `check-kiro-effort.mts`                                                                                                                                                                                      | 18          |

`npm test` runs `smoke/run.sh`; `npm run test:all` runs `all.sh` (smoke, context, quota and the
four checks above).

## Layout

- `smoke/`: suites that start the built server against mock providers: `run.sh` + `e2e.mjs` +
  `mock-upstream.mjs`; `kiro-mock.sh` + `mock-kiro.mjs` + `kiro-seed.mts` (fake Kiro accounts)
  - `anthropic-conformance.mjs` + `kiro-stream-failures.mjs`; `context.sh` + `context-e2e.mjs`;
    `quota.sh` + `quota-e2e.mjs`; `mock-anthropic.mjs` is shared by the last two.
- `checks/`: in-process checks run with `tsx`, one `PASS` / `FAIL` line per case.
  `sh tests/checks/run.sh` runs them all; name files to run a few.
- `quality/typecheck-baseline.mjs`: `npm run typecheck:baseline` fails when `tsc` reports more
  errors than `quality/typecheck-baseline.json`. After fixing old errors, lower the baseline with
  `npm run typecheck:baseline -- --update`.

## Options

- Ports: `SMOKE_PORT` / `SMOKE_MOCK_PORT` (8799 / 20997), `KIRO_MOCK_SMOKE_PORT` /
  `KIRO_MOCK_PORT` (8796 / 20995), `CONTEXT_PORT` / `CONTEXT_MOCK_PORT` (8817 / 20996),
  `QUOTA_PORT` / `QUOTA_MOCK_PORT` (8815 / 20998).
- `sh tests/smoke/run.sh trouteai` tests an installed npm package (the `trouteai` command)
  instead of the build; `SMOKE_SKIP_KIRO=1` skips the Kiro checks.
- `QUOTA_ONLY=priority,round-robin` runs only those strategies; `CONTEXT_KEEP_LOG`,
  `QUOTA_KEEP_LOG`, `KIRO_MOCK_KEEP_LOG` (a file path) keep the server log.
- `CHECKS_VERBOSE=1` prints the full output of each check.
- `KIRO_MOCK_CLAUDE_CODE=1` also runs an installed `claude` (Claude Code) through the server
  against the fake Kiro, with a temporary config folder.

Write new checks the same way: a throwaway `DATA_DIR`, a spare port, mocks instead of real
providers, and never a route that reads credential files from the host (for example
`/api/oauth/kiro/auto-import`).
