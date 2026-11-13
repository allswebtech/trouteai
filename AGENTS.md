# TRouteAI: guide for AI coding agents

TRouteAI is a self-hosted AI router. A user adds AI providers in a web dashboard, creates API
keys, and points any client at one OpenAI- and Anthropic-compatible endpoint (`<host>/v1`). A
**combo** is one model name that tries several provider models with a routing strategy and falls
back on errors and usage limits. It runs as one Node.js app on one port, with SQLite, and depends
on no external TRouteAI service.

Product priorities, in this order: secure, light (near-zero CPU and memory when idle), very easy
for non-technical users, fully white-label.

## Stack

- Next.js 16 (App Router, Turbopack), React 19, TypeScript 6 in `src/`; the routing engine is the
  workspace package `@trouteai/open-sse` in `open-sse/`
- Node.js 26 recommended; 22.22.2+ and 24+ supported (`engines` in `package.json`); ES modules
- SQLite through better-sqlite3, then the built-in `node:sqlite`, then sql.js
  (`src/lib/db/adapters/driverFactory.ts`)
- Tailwind CSS v4, next-intl (English only: `config/i18n.json`), Zod v4 for input validation

## Commands

| Command                      | What it does                                                      |
| ---------------------------- | ----------------------------------------------------------------- |
| `npm install`                | Install; creates or completes `.env` from `.env.example`          |
| `npm run dev`                | Dev server, port 20017 (data folder `~/.trouteai` unless set)     |
| `npm run build`              | Production build into `.build/next` (1 to 3 minutes)              |
| `npm start` / `node app.cjs` | Production server (`app.cjs` is the file hosting panels start)    |
| `npm run lint`               | ESLint; the baseline is `config/quality/eslint-suppressions.json` |
| `npm run typecheck:baseline` | `tsc`; fails only when the error count rises above the baseline   |
| `npm test`                   | Smoke test and offline checks against the build                   |
| `npm run test:all`           | Every offline suite                                               |
| `npm pack`                   | Release build (`prepack`) and the npm tarball                     |

## Verify every change

1. `npm run lint`.
2. `npm run build`, then `npm run typecheck:baseline` (it reads type files the build generates).
   The build itself ignores type errors, so this step is the only type gate. Never add a type
   error; the old ones are a counted baseline, not a licence.
3. `npm test`; for routing, context size or usage limits also `npm run test:all`.
4. Say what you ran and what it printed, and what you could not test.

Tests and manual runs always use a throwaway data folder and a spare port
(`DATA_DIR=$(mktemp -d) PORT=20018 …`). Never run against `~/.trouteai`: it can hold a person's
real provider credentials, and `server.env` in it is the key that decrypts them. Never call
routes that read credential files from the host (for example `/api/oauth/kiro/auto-import`) in a
test. Details: [tests/README.md](tests/README.md).

## Layout

- `src/app/(dashboard)/dashboard/*`: dashboard pages. Sidebar entries are in
  `src/shared/constants/sidebarVisibility/sections.ts` (ids in `types.ts`); the default simple
  menu is the `minimal` preset in `src/shared/constants/sidebarVisibility.ts`
- `src/app/api/v1/*`: client API (`chat/completions`, `messages`, `responses`, `models`,
  embeddings, images, audio). `/v1/*` is rewritten to `/api/v1/*` in `next.config.mjs`
- `src/app/api/*`: management API for the dashboard (providers, keys, combos, settings, logs)
- `src/proxy.ts` → `src/server/authz/pipeline.ts`: authentication for every request
- `src/instrumentation-node.ts`: boot sequence (database, secrets, schedulers)
- `src/server/ws/liveServer.ts`: live dashboard WebSocket at `/live-ws` on the main port
- `open-sse/handlers/chatCore.ts`: request pipeline. `open-sse/services/combo.ts`: combo
  routing. `open-sse/executors/`: per-provider upstream calls. `open-sse/translator/`: format
  conversion between OpenAI, Anthropic and provider formats
- `src/shared/constants/providers/`: provider catalog, validated with Zod at load.
  `open-sse/config/providers/registry/<id>/`: per-provider endpoints and models
- `src/lib/db/*`: SQLite modules; migrations in `src/lib/db/migrations/`. `src/lib/localDb.ts`
  is a re-export layer only
- `bin/trouteai.mjs`: the `trouteai` command. `scripts/build/`, `scripts/dev/`: build and start
- `tests/`: offline test suite (fake providers, no account, no network)

How to add a provider, a database change or a dashboard page: [CONTRIBUTING.md](CONTRIBUTING.md).

## Not part of TRouteAI

Do not add or refer to these unless asked: an MCP server, agent-to-agent protocols, cloud
agents, a plugin marketplace, gamification, evals, webhooks UI, tunnels, a traffic inspector, a
desktop app, a full terminal UI beyond `bin/trouteai.mjs`, a docs site, cloud sync, an
in-dashboard updater, sponsor or affiliate content, and telemetry of any kind.

Prompt compression and plugin hooks exist inside the request pipeline but are off by default and
have no dashboard page. Of the old skills code only the built-in web search and web fetch
interception in `src/lib/skills` remains.

## Code style

- Prettier: 2 spaces, semicolons, double quotes, 100 columns, es5 trailing commas
- Imports: external, then internal (`@/`, `@trouteai/open-sse`), then relative. Import database
  code from the specific `src/lib/db/<module>.ts`, not from `localDb.ts`
- Path aliases: `@/*` → `src/*`, `@trouteai/open-sse/*` → `open-sse/*`
- Environment variables of this app use the `TROUTEAI_` prefix
- Every user-visible text goes in `src/i18n/messages/en.json`
- Comments explain why, in plain words. No issue numbers, dates or names in comments

## Security rules

- Never commit secrets. They come from `.env` or `DATA_DIR/server.env` (see `.env.example`)
- Validate every API input with Zod; no SQL in routes (use `src/lib/db/` modules)
- Error responses use `buildErrorBody()` / `sanitizeErrorMessage()` from
  `open-sse/utils/error.ts`; never return a raw `err.message` or `err.stack`
- Public OAuth client identifiers of provider CLIs are read with `resolvePublicCred()` from
  `open-sse/utils/publicCreds.ts`, never written as string literals
- `exec()` / `spawn()` with runtime values: pass them through `env`, never build a command string
- `REQUIRE_API_KEY` defaults to true; never ship an open `/v1`
- "Is this request from the machine itself?" is answered only by `isTrustedLoopbackRequest()`
  (`src/shared/utils/apiAuth.ts`, a TCP-peer stamp), never by the Host header
- Outbound requests on a user's behalf go through `safeOutboundFetch` (public addresses only)
- Pages get a per-request nonce content security policy from `src/proxy.ts`; both policies are
  built in `src/server/security/csp.mjs`. An inline `<script>` needs
  `nonce={readCspNonce(await headers())}`. Never add a third-party script origin
- The app never runs without an admin password: `ensureInitialAdminPassword()` in
  `src/instrumentation-node.ts` creates a random one on the first start

## Things that break easily

- **Masked identifiers.** `open-sse/utils/publicCreds.ts` stores values XOR-masked with a fixed
  mask. Changing the mask, or a project-wide search-and-replace of the brand name, corrupts every
  one of them.
- **Runtime dependencies are pinned exactly.** The build output only works with the exact `next`
  version that built it. Only what the server needs at runtime is in `dependencies`; everything
  else is bundled at build time and lives in `devDependencies`.
- **Server-external packages.** A package added to `serverExternalPackages` in `next.config.mjs`
  must also be in `dependencies`; then rebuild and check `.build/next/trouteai-externals.json`
  (`scripts/build/buildExternals.mjs` recreates the links npm does not pack).
- **`NEXT_PUBLIC_*` is compiled in at build time** and is empty in the npm package. At runtime
  the server reads `TROUTEAI_PUBLIC_BASE_URL`, which `scripts/build/bootstrap-env.mjs` fills from
  `NEXT_PUBLIC_BASE_URL`.
- **Database migrations only add.** Never drop or rename a table or column: during an update the
  old and the new version share one database file, and a rollback runs old code on the new schema.
- **Startup chain.** `bin/trouteai.mjs` (or `app.cjs` / `npm start`) → `scripts/dev/run-next.mjs`
  → `scripts/build/bootstrap-env.mjs`. Change one, check all three ways of starting.
- **The combo test runs each step in-process** (`src/app/api/combos/test/route.ts`); calling
  `/v1` over HTTP from inside the app answers 401 because an API key is required.
- **Never delete `.build` while a dev server may be running**, and do not run clean-up commands
  next to a build or a type check.
- **An answer that fails inside a stream stays an error.** Never turn it into a normal finish:
  a coding agent would end its turn on half an answer.
