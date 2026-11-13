---
paths:
  - "open-sse/**"
---

# Routing engine (`open-sse/`)

A request travels `handlers/chatCore.ts` → `services/combo.ts` (when the model is a combo) →
an executor in `executors/` → a translator in `translator/` when the client and the provider
speak different formats.

- **One middle format.** Translators convert through an OpenAI-shaped middle step. A field that
  only one target understands (for example `reasoning_signature`, or `response_format` kept for
  a provider without a format field) is kept for that target only. Other OpenAI-format upstreams
  reject unknown fields.
- **Never change the conversation silently.** A request reaches the provider as the client
  built it. Nothing is trimmed unless prompt compression is switched on. A request that is too
  long gets an overflow error in the wording clients recover from
  (`utils/contextOverflowError.ts`); keep that wording.
- **A failure inside a stream stays an error.** End the client stream with
  `inbandStreamErrorFrame`, never with a normal finish. A coding agent that sees "stop" ends its
  turn on half an answer.
- **A model refusal is not a server error.** It becomes `content_filter` in the middle format
  and `stop_reason: "refusal"` for Anthropic clients. No 502, no account cooldown.
- **Combo exhaustion.** When a failing step is pinned to one account (`pinnedConnectionId`),
  mark only that account. Mark the whole provider only for unpinned steps.
- **Token numbers for Claude models** come from `config/claudeTokens.ts`. Claude's tokenizer is
  not the OpenAI one; do not swap in a generic estimate.
- **Hot path.** No synchronous database call per request in `combo.ts`; read from the caches.
  No state shared between concurrent requests; keep it request-scoped.
- **Idle cost.** No timer, poll or scheduler that runs while nobody sends a request.
- **Errors** leave through `buildErrorBody()` / `sanitizeErrorMessage()` (`utils/error.ts`).
- **Provider client identifiers** are read with `resolvePublicCred()`, never typed as literals.

Check a change here with `npm run build && npm test`; for context size and usage limits also
`npm run test:all`.
