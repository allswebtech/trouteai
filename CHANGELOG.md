# Changelog

What changed in each TRouteAI release. Update with `trouteai update`; on a hosting panel,
deploy again.

## 1.0.13 (2026-11-27): easier pages, a sign-in link, a stricter local rule

Version 1.0.12 was tagged but never published: its release stopped at a failing test, so
everything below is new in 1.0.13.

### Fixed in this release

- **The sign-in link names the port the gateway listens on.** When the configured public address
  pointed at this computer (`localhost` or `127.0.0.1`) with another port than the one the gateway
  listens on, for example a leftover `http://localhost:20017` while it runs on another port, the
  link led to a dead address. It now uses the listening port. A real public address is unchanged.

### Easier to use

- **A menu of six.** The side menu now shows six pages: Home, Accounts, Combos, API Keys, Usage and
  Settings, with no group headings and no search box. **Show all menus** adds the Status pages
  (Activity, Health, Runtime and Playground).
- **A first run that says the one next thing.** The sign-in page shows only the sign-in box. An empty
  Home is a title and one **Add account** button; once you have an account, Home shows the address,
  a key to make and the model to copy under **Connect a coding tool**. The old Get started card is
  gone, and so is the Quick Start switch in Appearance.
- **Accounts first.** The old Providers pages are now **Accounts**: one row per provider you use with
  a plain status (connected, needs attention, not tested yet), the full catalog behind a closed
  fold, and one **Add account** button. A provider page has one add button, one-line empty states,
  and the model switch and the less used options in closed folds. An account that was never tested
  shows as connected, not as an error.
- **Usage in tabs.** Overview, Requests and Costs share one tab bar and one range selector, with
  the less used parts behind a closed **More** fold. Empty pages are one line, and the console and
  tables fit a phone.
- **Combos and API Keys.** One head, one create button (also when the page is empty), a closed
  **More** fold, rows that fit a phone and a filter that only shows when you have many keys. A combo
  of API-key accounts no longer shows **Needs attention** only because no quota figure exists, and a
  priority combo is not flagged for sending to its first step.
- **Phone first.** Menu entries, breadcrumb links and filter chips are at least 44 px high, and
  Playground chat uses the full width.
- **Clearer words.** Pages say Account instead of Provider and Connection, and the example model
  in Endpoint is written as provider/model.

### Added

- **A list of providers for programs that manage the gateway.** `GET /api/providers/catalog` (the
  command token or a key with the manage scope) lists every provider with how an account is added:
  by key, by device code, by a link and a pasted code, or only in the gateway's own page.
- **A one-time sign-in link.** `POST /api/auth/link` (same rights) answers a link that signs in once
  within 60 seconds and opens the dashboard, so a program does not need the password.

### Security

- **A public address is always treated as from outside.** A request counts as coming from this
  computer only when it arrives over this computer's own loopback, names a loopback address as its
  Host and carries no forwarding header. A tunnel or proxy on the same computer that passes on a
  public name is therefore treated as remote and stays behind the sign-in. Using the dashboard at
  `localhost` or `127.0.0.1` on the computer itself works as before.

### Fixed

- **A removed key stops working at once.** Before, a key that was deleted, switched off or banned
  was still answered for up to a minute, until a restart in some cases, because each part of the
  server kept its own copy of the key cache. Now it is refused on the very next request.
- **The Restart button brings the gateway back.** Started with the `trouteai` command, the gateway
  now starts again on the same port after Restart, also on Windows (before, it only stopped). Started some other way
  (for example `node app.cjs`), Restart says that nothing would start it again and does nothing;
  set `TROUTEAI_RESTART_SUPERVISED=true` when a hosting panel or a service manager restarts it for
  you.
- **A copy installed by one user starts for another.** Before, a copy installed globally by root
  and started by a normal user said it was ready and answered an error to every request. The
  release no longer needs any link made at install or at start. A copy that still cannot be set up
  stops with one sentence that says what to do.
- **A response id is never repeated.** The id the gateway makes when a provider sent none could
  repeat for two answers in the same millisecond. It now has a random part.

### Docs

- `HOST` is empty by default (only this computer), as the command line says; the README now says so,
  and it explains the way out of an EACCES error, how to read the first password and how to make a
  key with `trouteai key create`.
- An install test (`tests/smoke/install-e2e.mjs`) installs the packed build the way the README says,
  starts it, makes a key, asks the model list, stops it, and checks an upgrade from 1.0.10 keeps the
  providers, keys and password. A workflow runs it on Ubuntu, macOS and Windows.

Updating from 1.0.11 changes nothing in your accounts, keys and combos; only the pages look different.

## 1.0.11 (2026-11-25): a priority per key, conversations kept together

- **A default priority per API key.** On a key's page in **API Keys**, choose whether its requests
  wait as interactive, normal or background when a combo is busy. A request's own
  `x-trouteai-priority` header still wins. Keys you already have stay normal, so nothing changes
  until you pick something else.
- **A Responses conversation stays on its account.** A turn that sends only its new input with
  `previous_response_id` now goes to the account that gave that earlier answer, so the
  conversation and its prompt cache stay together. Before, such a turn could land on another
  account. An id the gateway does not know is placed like a new conversation.
- **A new conversation no longer starts on an account whose quota is used up.** It starts on an
  account that can answer. Before, the gateway could pick the used-up account first and only then
  move on.

Updating from 1.0.10 changes nothing in your providers, keys and combos.

## 1.0.10 (2026-11-25): steady under load, honest answers, the prompt cache kept

### Under many requests at once

- **A round-robin combo waits fairly instead of refusing.** Requests for a combo whose accounts are all busy wait
  in one queue for the first free slot (up to two minutes), then get a clear "busy" answer with the seconds to
  wait. Before, a request could be refused while a slot was free. A request can carry the header
  `x-trouteai-priority` to wait in front.
- **A new conversation starts on the least busy account** that can be used, and keeps that account, so the
  provider's own cache keeps working. Before, one account could carry most conversations while others idled.
- **A provider's "high load" answer** is tried again only when nothing of the answer had been sent yet; a
  conversation stays on its account. The account is no longer marked unavailable for it.
- An account of a round-robin combo is used again as soon as its usage limit resets.
- **The runtime page shows what runs and what it costs**: per account and per API key, live.

### The prompt cache

- Clients that speak the OpenAI chat or Responses dialect to the Claude API-key provider keep the prompt cache,
  and every dialect is told how much was read from and written to the cache.

### Answers you can rely on

- A request gets the model it asked for or a clear error; response headers name who answered and whether a
  fallback happened. `count_tokens` returns its own count or a labelled estimate. A missing or false `stream`
  flag returns one JSON answer in every dialect. `/v1/models` lists only what routes, with limits and
  capabilities. An image reaches every model that can see it.
- A usage limit is a 429 with its reset time; an outage is a 5xx, never a 429.

### Security and running

- The command key is a secret file only you can read, no longer derived from a machine id. TRouteAI listens on
  this computer only unless you choose otherwise, accepts both API key headers, shuts down cleanly, and runs
  nothing while idle that need not run.

Updating from 1.0.9 changes nothing in your providers, keys and combos.

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
