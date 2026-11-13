# Changelog

What changed in each TRouteAI release. Update with `trouteai update`; on a hosting panel,
deploy again.

## 1.0.9 (2026-11-13): first stable release

TRouteAI is now **stable**, and its source code is public at
[github.com/allswebtech/trouteai](https://github.com/allswebtech/trouteai).

Versions 1.0.0 to 1.0.8 were **beta** releases. They were published on npm while the project was
still being finished and tested in private. 1.0.9 keeps the behaviour of the last beta (1.0.8),
which is what the beta period tested: updating from 1.0.8 changes nothing in how your providers,
keys and combos work.

### Highlights

- **Stable.** The beta period is over: this is the version to use every day. An update keeps
  your data: database changes only add to it, and a backup is made before each one.
- **Open source.** The full source is public under the MIT license. Bug reports, ideas and pull
  requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through a
  private form: see [SECURITY.md](SECURITY.md).
- **Tests anyone can run.** The repository includes the test suite. It runs on your own
  computer with fake providers, without any account or API key (`npm test`).

### Changes

- The npm page links to the source code and the issue tracker.
- Hosting on SixPanel is now one step: create a website **From an npm package** and type
  `trouteai`. The package carries its own settings for SixPanel (start command, health check,
  kept data folder, generated secret keys), and new versions arrive with one press of **Deploy**
  or by themselves.
- The README has a short guide for other hosting panels.

### Fixes

- Provider logos drawn in one colour only (OpenAI, Anthropic, xAI and others) are now visible in
  both the light and the dark theme.

### What the stable release includes

- One API for every provider: OpenAI format (`/v1/chat/completions`, `/v1/responses`,
  `/v1/models`, embeddings, images, audio) and Anthropic format (`/v1/messages`).
- 290+ built-in providers by API key or account sign-in, plus any OpenAI- or
  Anthropic-compatible server.
- Combos: one model name that tries several provider models, with 19 routing strategies and
  fallback on errors and usage limits.
- Usage-limit routing: an account whose limit is used up is skipped until it resets.
- Made for coding agents such as Claude Code and Codex CLI: model discovery, effort and
  thinking settings, web search, PDFs, and context-limit errors the agent recovers from.
- A dashboard with light and dark themes, API keys, usage analytics and request logs.
- Secure by default: a random first password, API keys required, provider credentials encrypted
  at rest, no telemetry.

## Beta releases

### 1.0.8 (2026-11-11)

- Claude clients can use web search and web fetch on providers that have no search of their own.
- PDFs reach Kiro models as text; scanned pages go along as page images.
- Thinking is kept between turns on Kiro, and structured output works there.
- Token counts for Claude models are close to the real numbers.
- An answer that fails or is cut off midway comes back as an error the client retries, never as
  a finished answer.
- A combo of several accounts keeps working when one account reaches its limit.

### 1.0.7 (2026-11-10)

- Anthropic-format answers follow the Messages API more closely: stop sequences, `max_tokens`,
  message ids, cache counters and the error format.
- A model refusal is passed on as a refusal, not as a server error, and a fallback model answers
  once. "Thinking off" is honoured.

### 1.0.6 (2026-11-10)

- Kiro accounts work again after Kiro's client update.
- A rejected Kiro token no longer blocks the account.
- Effort and thinking settings reach every Kiro model that supports them.

### 1.0.5 (2026-11-08)

- Usage-limit routing: an account whose 5-hour, weekly or daily limit is used up is skipped
  until it resets, in every combo strategy.
- A conversation is never shortened silently. A request that is too long gets the error Claude
  Code and Codex CLI recover from.
- SixPanel deploys the prebuilt package; nothing is built on the server.
- A quieter log, an "only combos as models" option, and the dashboard and API ask search engines
  not to index them.

### 1.0.4 (2026-11-06)

- New dashboard design, in English.
- Stricter content security policy; sessions end on logout and on a password change.
- Every step of a combo has its own ON/OFF switch.

### 1.0.0 to 1.0.3 (2026-11-03 and 2026-11-04)

- The first packages: a prebuilt app and the `trouteai` command with `config`, `reset-password`,
  `update` and `uninstall`.
- Security and stability hardening: the real client address behind a proxy, graceful shutdown,
  protection against requests to private addresses, token limits per minute and per day.
- Models can be switched ON and OFF; an OFF model is refused on `/v1` and in combos.

These early betas are no longer on npm.
