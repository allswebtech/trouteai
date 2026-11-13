# Contributing to TRouteAI

Thank you for helping. Bug reports, ideas, new providers, fixes and documentation are all
welcome.

- **A bug or an idea:** open an [issue](https://github.com/allswebtech/trouteai/issues).
- **A security problem:** never in a public issue. Use the private form described in
  [SECURITY.md](SECURITY.md).
- **A code change:** for anything larger than a small fix, open an issue first so we can agree
  on the direction before you spend time on it.

## Set up

You need [Node.js](https://nodejs.org) 26 (recommended), 24, or 22.22.2 and newer.

```bash
git clone https://github.com/allswebtech/trouteai.git
cd trouteai
npm install        # also creates .env from .env.example with generated secrets
npm run dev        # http://localhost:20017
```

The development server reads its settings from the project `.env`. Its data folder is
`~/.trouteai` by default, the same one an installed TRouteAI uses. If you also use TRouteAI on
this computer, set a separate folder and port in the project `.env` so development never touches
your real providers and keys:

```bash
DATA_DIR=./data
PORT=20018
```

## Check your change

Run these before you open a pull request. CI runs the same ones.

Run them in this order:

| Command                      | What it checks                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| `npm run lint`               | ESLint: no errors                                                      |
| `npm run build`              | The production build                                                   |
| `npm run typecheck:baseline` | TypeScript: no new type errors (older ones are counted); after a build |
| `npm test`                   | The smoke test and the offline checks, against the build               |
| `npm run test:all`           | Every offline suite (context size, usage limits, …)                    |

The tests start TRouteAI on a spare port with a throwaway data folder and fake providers. They
need no account, no API key and no internet, and they never touch `~/.trouteai`. Details are in
[tests/README.md](tests/README.md).

Format code with Prettier (`npx prettier --write <files>`): 2 spaces, semicolons, double quotes,
100 columns.

## Where things are

| Path                              | What is there                                             |
| --------------------------------- | --------------------------------------------------------- |
| `src/app/(dashboard)/dashboard/`  | Dashboard pages                                           |
| `src/app/api/v1/`                 | The client API (`/v1/*` is rewritten to `/api/v1/*`)      |
| `src/app/api/`                    | The management API the dashboard uses                     |
| `src/lib/db/`                     | SQLite modules and migrations                             |
| `src/shared/constants/providers/` | The provider catalog shown in the dashboard               |
| `open-sse/`                       | The routing engine: combos, executors, format translators |
| `open-sse/config/providers/`      | Per-provider endpoints and models                         |
| `bin/`, `scripts/`                | The `trouteai` command, build and start scripts           |
| `tests/`                          | The offline test suite                                    |

[AGENTS.md](AGENTS.md) has the longer map, the code style and the security rules.

## Common changes

### Add a provider that speaks the OpenAI format

Copy an existing small provider such as `cerebras` at every step.

1. **Catalog entry** in the matching family file under `src/shared/constants/providers/apikey/`
   (`id`, `name`, `icon`, `color` as `#RRGGBB`, optional `website`, `alias`, `hasFree`). The
   catalog is validated when the app starts; a wrong entry stops it with a clear message.
2. **Routing entry** in a new folder `open-sse/config/providers/registry/<id>/index.ts`
   (`format: "openai"`, `executor: "default"`, `baseUrl`, `authType`, `authHeader`, `models`),
   then import it and add it to `REGISTRY` in `open-sse/config/providers/index.ts`.
3. **Icon** as `public/providers/<id>.svg`, and add the id to `KNOWN_SVGS` in
   `src/shared/components/ProviderIcon.tsx`.
4. "Test connection" and the request path work without more code for OpenAI-format providers.
   Add a custom executor in `open-sse/executors/` only when the provider needs its own request
   shape.

### Change the database

Add a new file `src/lib/db/migrations/NNN_short_name.sql` with the next free three-digit number.
Migrations run at start, in order, after an automatic backup.

**Only add** tables, columns and indexes. Never drop or rename: during an update the old and the
new version can run on the same database for a moment, and a rollback runs old code on the new
schema. Database code lives in `src/lib/db/<module>.ts`; routes never contain SQL.

### Add a dashboard page

Create `src/app/(dashboard)/dashboard/<slug>/page.tsx`, add the sidebar entry in
`src/shared/constants/sidebarVisibility/` (`types.ts` and `sections.ts`), and put every visible
text in `src/i18n/messages/en.json`. A new entry is hidden in the default simple menu unless you
add it to `MINIMAL_SHOWN` in `src/shared/constants/sidebarVisibility.ts`.

## Rules that keep TRouteAI safe and light

- No secrets, tokens, real account ids or personal data in code, tests, fixtures or logs.
- Check every API input with Zod. Error responses never contain a raw error message or a stack.
- `/v1` is never open: `REQUIRE_API_KEY` stays `true` by default.
- No telemetry, and no request to anything except the providers a user added.
- New runtime dependencies need a good reason: everything the server needs is installed on every
  user's machine. Runtime dependencies use exact versions.
- The dashboard is in English; a new language is one file in `src/i18n/messages/`.
- Keep idle CPU and memory near zero: no timers or polling that run when nobody uses the app.

## Pull requests

- One topic per pull request, as small as it can be.
- Say what a user now experiences, why, and how you checked it. The template asks for this.
- Write the commit subject as the change a user sees, for example
  `Combos: a step whose account hit its limit shows when it resets`.
- By sending a pull request you agree that your contribution is released under the
  [MIT license](LICENSE).

## Working with an AI coding agent

The repository is set up for coding agents. [AGENTS.md](AGENTS.md) is the shared guide (Claude
Code, Codex, Cursor and others read it), and `.claude/` adds Claude Code settings, rules for
each part of the code, and skills such as `/verify` and `/add-provider`. Please read what your
agent wrote and run the checks above before you send it: you are the author of your pull
request.
