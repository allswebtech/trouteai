// The differences check-claude-upstream.mts expects between what the coding client sent and what
// reaches the Claude service. Change an entry only on purpose, together with the code that causes
// it. `CLAUDE_UPSTREAM_PRINT=<file>` makes the check write the lists it found.
//
// Why each difference exists (from the code that makes it):
// - url `?beta=true`: both providers' registry URL carries it, as the real client's does.
// - api-key `accept` text/event-stream: the plain path asks for an event stream on streams
//   (executors/default.ts buildHeaders); the client itself sends application/json.
// - api-key betas added: the registry's static API-key set (config/anthropicHeaders.ts) is sent
//   on every request; the client's own betas are merged in only from an allowlist, so the
//   client betas not on it are dropped.
// - api-key client headers removed (x-app, x-stainless-*, session id, browser-access): the plain
//   path builds its own header set and forwards only the user agent and a few client headers.
// - api-key count: the count call uses no client headers at all, so the user agent goes too.
// - tools `type: "custom"`: a missing tool type is set to its documented default, because strict
//   Anthropic-format relays reject tools without it (handlers/chatCore/claudeToolDefaults.ts).
// - api-key `max_tokens` 128000 -> 65536: a fixed cap per provider (config/constants.ts).
// - subscription user agent, billing line, betas, metadata.user_id, session id, request id,
//   connection and accept-encoding: the subscription path presents one client identity per
//   account, never the client's (executors/base.ts, claudeIdentity.ts). The identity is the
//   proven set of one client build (2.1.319, build 250, SDK 0.128.0, runtime v26.12.1), so a
//   2.1.330 client's user agent and billing line are replaced by it. An override
//   (claudeCodeClientVersion, TROUTEAI_CLAUDE_CODE_VERSION) changes the version only.
// - subscription `system[1].cache_control` removed: the two identity blocks put first must not
//   carry a cache marker; the client's own marker on its identity block goes with it.
// - subscription helper call: the identity block is put in front of the client's system text.
// - no `temperature: 1` for these models: the subscription path pins it when thinking is on,
//   but sampling parameters are removed for every model that refuses them
//   (services/claudeCodeConstraints.ts stripRefusedSamplingParams).
// - subscription count: the count call uses the registry header set, not the identity path.
// - a `role: "system"` turn inside `messages` is not listed: these fixtures ask for Opus 5.5,
//   which takes such a turn, so it stays where the client put it (handlers/chatCore/
//   claudeSystemRole.ts). For a model that refuses it, it is still lifted into `system`.
// - client betas the allowlist forwards (config/anthropicHeaders.ts FORWARDABLE_CLIENT_BETAS)
//   are not listed: they arrive unchanged. The subscription helper call keeps the client's
//   claude-code and advanced-tool-use betas out: they belong to the full agent shape only.
export const EXPECTED: Record<string, string[]> = {
  "api-key / main turn": [
    "url /v1/messages?beta=true",
    "header ~ accept: application/json -> text/event-stream",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +structured-outputs-2025-12-15",
    "header anthropic-beta +fast-mode-2026-02-01",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +token-efficient-tools-2026-03-28",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header - anthropic-dangerous-direct-browser-access",
    "header - x-app",
    "header - x-claude-code-session-id",
    "header - x-stainless-arch",
    "header - x-stainless-lang",
    "header - x-stainless-os",
    "header - x-stainless-package-version",
    "header - x-stainless-retry-count",
    "header - x-stainless-runtime",
    "header - x-stainless-runtime-version",
    "header - x-stainless-timeout",
    'body + tools[0].type: "custom"',
    'body + tools[1].type: "custom"',
    'body + tools[2].type: "custom"',
    "body ~ max_tokens: 128000 -> 65536",
  ],
  "api-key / tool-result turn": [
    "url /v1/messages?beta=true",
    "header ~ accept: application/json -> text/event-stream",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +structured-outputs-2025-12-15",
    "header anthropic-beta +fast-mode-2026-02-01",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +token-efficient-tools-2026-03-28",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header - anthropic-dangerous-direct-browser-access",
    "header - x-app",
    "header - x-claude-code-session-id",
    "header - x-stainless-arch",
    "header - x-stainless-lang",
    "header - x-stainless-os",
    "header - x-stainless-package-version",
    "header - x-stainless-retry-count",
    "header - x-stainless-runtime",
    "header - x-stainless-runtime-version",
    "header - x-stainless-timeout",
    'body + tools[0].type: "custom"',
    'body + tools[1].type: "custom"',
    'body + tools[2].type: "custom"',
    "body ~ max_tokens: 128000 -> 65536",
  ],
  "api-key / helper call": [
    "url /v1/messages?beta=true",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +structured-outputs-2025-12-15",
    "header anthropic-beta +fast-mode-2026-02-01",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +token-efficient-tools-2026-03-28",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header - anthropic-dangerous-direct-browser-access",
    "header - x-app",
    "header - x-claude-code-session-id",
    "header - x-stainless-arch",
    "header - x-stainless-lang",
    "header - x-stainless-os",
    "header - x-stainless-package-version",
    "header - x-stainless-retry-count",
    "header - x-stainless-runtime",
    "header - x-stainless-runtime-version",
    "header - x-stainless-timeout",
  ],
  "api-key / count": [
    "url /v1/messages/count_tokens?beta=true",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +structured-outputs-2025-12-15",
    "header anthropic-beta +fast-mode-2026-02-01",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +token-efficient-tools-2026-03-28",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header anthropic-beta -per-turn-control-2026-07-01",
    "header anthropic-beta -mid-conversation-tool-changes-2026-07-01",
    "header anthropic-beta -thinking-token-count-2026-05-13",
    "header - anthropic-dangerous-direct-browser-access",
    "header - user-agent",
    "header - x-app",
    "header - x-claude-code-session-id",
    "header - x-stainless-arch",
    "header - x-stainless-lang",
    "header - x-stainless-os",
    "header - x-stainless-package-version",
    "header - x-stainless-retry-count",
    "header - x-stainless-runtime",
    "header - x-stainless-runtime-version",
    "header - x-stainless-timeout",
  ],
  "subscription / main turn": [
    "url /v1/messages?beta=true",
    "header + accept-encoding: gzip, deflate, br, zstd",
    "header anthropic-beta +oauth-2025-04-20",
    "header anthropic-beta +mid-conversation-system-2026-04-07",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header + connection: keep-alive",
    "header ~ user-agent: claude-cli/2.1.330 (external, cli) -> claude-cli/2.1.319 (external, cli)",
    "header ~ x-claude-code-session-id: <uuid> -> <uuid>",
    "header + x-client-request-id: <uuid>",
    'body ~ system[0].text: "x-anthropic-billing-header: cc_version=2.1.330.f86; cc_entrypoint=cli;" -> "x-anthropic-billing-header: cc_version=2.1.319.250; cc_entrypoint=cli; cch=<hash>;"',
    "body - system[1].cache_control",
    'body + tools[0].type: "custom"',
    'body + tools[1].type: "custom"',
    'body + tools[2].type: "custom"',
    'body ~ metadata.user_id: "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"<uuid>\\"}" -> "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"<uuid>\\",\\"session_id\\":\\"<uuid>\\"}"',
  ],
  "subscription / tool-result turn": [
    "url /v1/messages?beta=true",
    "header + accept-encoding: gzip, deflate, br, zstd",
    "header anthropic-beta +oauth-2025-04-20",
    "header anthropic-beta +mid-conversation-system-2026-04-07",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header + connection: keep-alive",
    "header ~ user-agent: claude-cli/2.1.330 (external, cli) -> claude-cli/2.1.319 (external, cli)",
    "header ~ x-claude-code-session-id: <uuid> -> <uuid>",
    "header + x-client-request-id: <uuid>",
    'body ~ system[0].text: "x-anthropic-billing-header: cc_version=2.1.330.f86; cc_entrypoint=cli;" -> "x-anthropic-billing-header: cc_version=2.1.319.250; cc_entrypoint=cli; cch=<hash>;"',
    "body - system[1].cache_control",
    'body + tools[0].type: "custom"',
    'body + tools[1].type: "custom"',
    'body + tools[2].type: "custom"',
    'body ~ metadata.user_id: "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"<uuid>\\"}" -> "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"<uuid>\\",\\"session_id\\":\\"<uuid>\\"}"',
  ],
  "subscription / helper call": [
    "url /v1/messages?beta=true",
    "header + accept-encoding: gzip, deflate, br, zstd",
    "header anthropic-beta +oauth-2025-04-20",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta -claude-code-20250219",
    "header anthropic-beta -advanced-tool-use-2025-11-20",
    "header + connection: keep-alive",
    "header ~ user-agent: claude-cli/2.1.330 (external, cli) -> claude-cli/2.1.319 (external, cli)",
    "header ~ x-claude-code-session-id: <uuid> -> <uuid>",
    "header + x-client-request-id: <uuid>",
    'body ~ system[0].text: "x-anthropic-billing-header: cc_version=2.1.330.f86; cc_entrypoint=cli;" -> "x-anthropic-billing-header: cc_version=2.1.319.250; cc_entrypoint=cli; cch=<hash>;"',
    'body ~ system[1].text: "Summarize this coding conversation in a short title." -> "You are Claude Code, Anthropic\'s official CLI for Claude."',
    'body + system[2]: {"type":"text","text":"Summarize this coding conversation in a short title."}',
    'body ~ metadata.user_id: "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"\\",\\"session_id\\":\\"<uuid>\\"}" -> "{\\"device_id\\":\\"<hex64>\\",\\"account_uuid\\":\\"<uuid>\\",\\"session_id\\":\\"<uuid>\\"}"',
  ],
  "subscription / count": [
    "url /v1/messages/count_tokens?beta=true",
    "header anthropic-beta +oauth-2025-04-20",
    "header anthropic-beta +fine-grained-tool-streaming-2025-05-14",
    "header anthropic-beta +prompt-caching-scope-2026-01-05",
    "header anthropic-beta +structured-outputs-2025-12-15",
    "header anthropic-beta +fast-mode-2026-02-01",
    "header anthropic-beta +redact-thinking-2026-02-12",
    "header anthropic-beta +token-efficient-tools-2026-03-28",
    "header anthropic-beta +advisor-tool-2026-03-01",
    "header anthropic-beta +extended-cache-ttl-2025-04-11",
    "header anthropic-beta +cache-diagnosis-2026-04-07",
    "header anthropic-beta -per-turn-control-2026-07-01",
    "header anthropic-beta -mid-conversation-tool-changes-2026-07-01",
    "header anthropic-beta -thinking-token-count-2026-05-13",
    "header ~ user-agent: claude-cli/2.1.330 (external, cli) -> claude-cli/2.1.319 (external, cli)",
    "header - x-claude-code-session-id",
    "header + x-stainless-helper-method: stream",
  ],
};
