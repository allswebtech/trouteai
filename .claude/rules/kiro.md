---
paths:
  - "open-sse/**/*kiro*"
  - "open-sse/**/*Kiro*"
  - "open-sse/translator/request/openai-to-kiro/**"
  - "src/**/*kiro*"
  - "src/**/*Kiro*"
---

# Kiro provider

Kiro's API differs from the Anthropic Messages API in ways that are easy to break. Each point
below has a check in `tests/checks/`; run `npm test` after any change here.

- **Client identity.** Every Kiro call takes its headers from `open-sse/config/kiroIdentity.ts`.
  Kiro refuses old client versions with 403, so the version lives in that one file.
- **Profile.** Calls send the account's own profile, looked up by `findKiroProfileArn()` and
  kept in memory only. Never store it on the connection: an organisation profile is shared, and
  the import routes match accounts by it.
- **Effort and thinking.** Model-name suffixes (`-low` … `-max`) and the client's settings are
  mapped by the table in `translator/request/openai-to-kiro/adaptiveThinking.ts`, which mirrors
  Kiro's own model schema. A wrong entry gets a 400 from Kiro.
- **Thinking cannot be switched off on Kiro.** A client's "thinking off" becomes low effort with
  the thinking display omitted.
- **Refusals.** Kiro answers a refusal with HTTP 200, no content and a `CONTENT_FILTERED` stop
  reason. `readKiroStopMetadata` / `kiroFinishReason` turn it into a refusal for the client, and
  `KIRO_REFUSAL_FALLBACK` asks a lower model once when nothing was sent yet. Never a 502, never
  an account cooldown.
- **Thinking signatures.** Pass a signature on only after reasoning text. Signed thinking goes
  back to Kiro only; other OpenAI-format upstreams never see `reasoning_signature`.
- **Prompt caching.** Kiro caches prompt prefixes at message boundaries. Anything that changes
  an earlier history turn breaks it. The system prompt is its own first turn (`splitSystemTurn`).
  A change to the request shape must be checked against what reads it: `kiroHelperPromptKey`,
  the conversation id seed, and tool promotion.
- **`max_tokens` and stop sequences.** Kiro applies neither. The request builder stashes the
  client's values as `_clientLimits` (never sent upstream) and the executor applies them to the
  visible text only. Thinking and tool calls are never cut.
- **Finished or not.** `kiroAnswerClosed` decides whether an answer finished. A failure before
  content becomes an HTTP error so retries and other accounts run; after content it becomes an
  in-stream error. Never a normal "stop".
- **Structured output.** Kiro has no format field; `kiroJsonOutputInstruction` turns the
  client's schema into an instruction.

Tests never call `/api/oauth/kiro/auto-import` and never use a real account. The fake Kiro
server is `tests/smoke/mock-kiro.mjs`.
