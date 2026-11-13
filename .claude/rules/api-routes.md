---
paths:
  - "src/app/api/**"
  - "src/proxy.ts"
  - "src/server/**"
---

# API routes

- **Management routes** (`src/app/api/*`, used by the dashboard) start with
  `const authError = await requireManagementAuth(request); if (authError) return authError;`
  (`@/lib/api/requireManagementAuth`).
- **Every input is checked with Zod**: `validateBody` / `isValidationFailure` from
  `@/shared/validation/helpers`, schemas in `@/shared/validation/schemas`.
- **No SQL in a route.** Call a function from the matching `src/lib/db/<module>.ts`.
- **Errors** never carry a raw `err.message` or stack. Use `buildErrorBody()` /
  `sanitizeErrorMessage()` from `open-sse/utils/error.ts`.
- **Client API** (`src/app/api/v1/*`) must keep the exact shapes clients expect. Anthropic
  format: `msg_` ids, `{ "type": "error", "error": { "type", "message" } }`, 404 for a model
  that cannot be routed. OpenAI format: the OpenAI error object.
- **`/v1` always needs an API key** unless the user turned `REQUIRE_API_KEY` off.
- **"From this machine"** is decided only by `isTrustedLoopbackRequest()`
  (`src/shared/utils/apiAuth.ts`), never by the Host header or `X-Forwarded-For`.
- **Forwarded headers** are trusted only when `TROUTEAI_TRUST_PROXY` says so.
- **Outbound requests on a user's behalf** go through `safeOutboundFetch` (public addresses
  only).
- **New path?** The auth pipeline runs for the paths in `src/server/security/proxyRoutes.ts`;
  keep it and the matcher in `src/proxy.ts` in sync.
- **Never index.** The dashboard and the API send `noindex`; do not add public pages.
