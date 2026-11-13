# Security policy

TRouteAI sits between your apps and your AI providers and stores provider credentials, so
security reports get priority over everything else.

## Supported versions

| Version                 | Supported                         |
| ----------------------- | --------------------------------- |
| Latest stable (`1.0.x`) | Yes                               |
| Beta (`1.0.0`–`1.0.8`)  | No. Update with `trouteai update` |

Fixes are released as a new version on npm. Update with `trouteai update`, or redeploy on your
hosting panel.

## Report a vulnerability

Please do not open a public issue for a security problem.

1. Open the repository's **Security** tab and press **Report a vulnerability**
   ([direct link](https://github.com/allswebtech/trouteai/security/advisories/new)). The report
   is private between you and the maintainers.
2. Tell us what you found, the version (`trouteai --version`), how you run it (npm package,
   source checkout or a hosting panel) and the steps to reproduce it. A short proof of concept
   helps a lot.
3. Remove real API keys, provider tokens, cookies and passwords from logs and screenshots
   before you attach them.

We confirm that we received the report, tell you whether we can reproduce it, and keep you
informed until a fix is released. We credit reporters in the release notes unless you ask us
not to.

## What counts

In scope:

- Reaching the dashboard, the management API or `/v1` without valid credentials
- Reading or changing another API key's data, or leaking stored provider credentials
- Server-side request forgery, path traversal, injection, or code execution through any input
- Weaknesses in session handling, password reset, or the first-start setup
- Secrets written to logs, error messages or the npm package

Out of scope:

- Problems that need an attacker who already has the admin password, shell access to the
  server, or the data folder
- Running with the documented protections switched off (for example `REQUIRE_API_KEY=false` on
  a public address)
- Rate limits and outages of the AI providers themselves
- Reports from automated scanners without a working example

## How TRouteAI protects an install

- The dashboard always needs a password. On the first start a random one is written to a file
  only the server user can read; a setup without a password is possible only from the machine
  itself.
- `/v1` needs an API key created in the dashboard (`REQUIRE_API_KEY=true` by default).
- Provider credentials are encrypted at rest; the secret keys are generated on the first start.
- Login attempts are rate-limited. Sessions end on logout and on a password change.
- Strict security headers: a nonce-based content security policy without `eval`, HSTS, no
  framing.
- Outbound requests made on behalf of a user (web fetch, custom provider URLs) are checked
  against private and loopback addresses.
- No telemetry. Nothing is sent anywhere except to the providers you add.

## Hardening checklist for a public server

- Put TRouteAI behind HTTPS (a hosting panel or a reverse proxy) and set
  `TROUTEAI_TRUST_PROXY` as the README explains.
- Keep `REQUIRE_API_KEY=true`. Give every app its own API key so you can revoke one alone.
- Keep the data folder (`~/.trouteai` or your `DATA_DIR`) private and backed up. `server.env`
  holds the key that decrypts your provider credentials.
- Update when a new version is released.
