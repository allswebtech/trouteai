import {
  CLAUDE_CODE_CLIENT_BILLING_VERSION,
  CLAUDE_CODE_CLIENT_BUILD_REVISION,
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
  getClaudeCodeUserAgent,
} from "@/shared/constants/claudeCodeClient";

export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

const ANTHROPIC_BETA_BASE = Object.freeze([
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
  "advisor-tool-2026-03-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
]);

const CLAUDE_OAUTH_EXTRA_BETAS = Object.freeze(["fine-grained-tool-streaming-2025-05-14"]);

export const ANTHROPIC_BETA_FULL = ANTHROPIC_BETA_BASE.join(",");
export const ANTHROPIC_BETA_API_KEY = ANTHROPIC_BETA_BASE.filter(
  (beta) => beta !== "oauth-2025-04-20"
).join(",");
export const ANTHROPIC_BETA_CLAUDE_OAUTH = [
  ...ANTHROPIC_BETA_BASE.slice(0, 3),
  ...CLAUDE_OAUTH_EXTRA_BETAS,
  ...ANTHROPIC_BETA_BASE.slice(3),
].join(",");

/**
 * Client-negotiated `anthropic-beta` values that are forwarded on top of TRouteAI's own set.
 * The list is an allowlist, not a blind passthrough: each entry is a beta Claude Code itself
 * puts on the wire (read from its 2.1.330 request headers and binary) or one that gates a
 * body field the passthrough keeps. Without the beta the service refuses the field with
 * 400 "Extra inputs are not permitted" (or a message naming the beta), so dropping it breaks
 * the request while the body field still travels:
 *   - per-turn-control / mid-conversation-output-config: message-level `output_config`
 *     (effort changed mid-conversation);
 *   - mid-conversation-tool-changes / inline-tools: tool changes and `tool_addition` blocks
 *     inside `messages`;
 *   - thinking-token-count, thinking-display-updates, thinking-binding-controls: thinking
 *     counters, `thinking.display: "updates"` and `thinking.block_binding`;
 *   - dangerous-tool-use / afk-mode: the auto-mode classifier pair (`safeguards` field);
 *   - message-threads: the top-level `thread` field;
 *   - server-side-fallback (both dates): the top-level `fallbacks` field;
 *   - fast-mode: the top-level `speed` field;
 *   - timing, effort, code-execution: per-turn timing, effort and the code tool;
 *   - tool-search-tool: deferred tools.
 * Two are gated in `mergeClientAnthropicBeta`: `context-1m` on the model that will answer
 * (a combo can move a request to a model the beta is refused for) and `skills` on a
 * code-execution tool in the body (refused without one).
 */
export const FORWARDABLE_CLIENT_BETAS = Object.freeze([
  "tool-search-tool-2025-10-19",
  "context-1m-2025-08-07",
  "code-execution-2025-08-25",
  "skills-2025-10-02",
  "effort-2025-11-24",
  "mid-conversation-output-config-2026-07-01",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "thinking-token-count-2026-05-13",
  "thinking-binding-controls-2026-08-01",
  "thinking-display-updates-2026-08-18",
  "dangerous-tool-use-2026-09-03",
  "afk-mode-2026-01-31",
  "timing-2026-09-09",
  "inline-tools-2026-09-15",
  "message-threads-2026-08-12",
  "server-side-fallback-2026-06-01",
  "server-side-fallback-2026-07-01",
  "fast-mode-2026-02-01",
  // turn-scoped `clear_at` on a system turn kept inside `messages`
  "mid-conversation-system-clear-at-2026-08-21",
]);

export const CONTEXT_1M_BETA = "context-1m-2025-08-07";
export const SKILLS_BETA = "skills-2025-10-02";
export const THINKING_DISPLAY_UPDATES_BETA = "thinking-display-updates-2026-08-18";

/**
 * Models the long-context beta is accepted for. Models whose 1M window is native
 * (Opus 5 and 5.5, Fable 5.1 and 5.2, Haiku 5.5) are not on it.
 */
const CONTEXT_1M_BETA_MODELS = [
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
];

/**
 * True when the model that will answer accepts the long-context beta. A dated alias
 * (`-20251001`) matches its base id; a newer version does not match an older one
 * (`claude-fable-5-2` is not `claude-fable-5`).
 */
export function modelSupportsContext1mBeta(model: string | null | undefined): boolean {
  const normalized = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/-\d{8}$/, "");
  return CONTEXT_1M_BETA_MODELS.some(
    (id) =>
      normalized === id ||
      (normalized.startsWith(`${id}-`) && !/^\d/.test(normalized.slice(id.length + 1)))
  );
}

/** Whether a Claude body declares a code-execution tool (the skills beta needs one). */
export function hasCodeExecutionTool(body: unknown): boolean {
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    const t = tool as { type?: unknown; name?: unknown } | null;
    if (!t || typeof t !== "object") return false;
    return (
      (typeof t.type === "string" && t.type.startsWith("code_execution")) ||
      t.name === "code_execution"
    );
  });
}

/**
 * Union an `anthropic-beta` comma-list with the allowlisted client-negotiated betas,
 * keeping the base order and appending only new tokens (deduped, case-insensitive). A
 * client beta is added only when it is on `allow`, so this never adds a beta the client did
 * not send. With `model`, `context-1m` is forwarded only for a model that accepts it; with
 * `body`, `skills` only when a code-execution tool is declared.
 */
export function mergeClientAnthropicBeta(
  base: string,
  clientBeta: string | null | undefined,
  allow: readonly string[] = FORWARDABLE_CLIENT_BETAS,
  gates: { model?: string | null; body?: unknown } = {}
): string {
  const baseList = base
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (typeof clientBeta !== "string" || !clientBeta.trim()) return baseList.join(",");
  const seen = new Set(baseList.map((s) => s.toLowerCase()));
  const allowSet = new Set(
    allow
      .map((s) => s.toLowerCase())
      .filter((lower) => {
        if (lower === CONTEXT_1M_BETA && gates.model) {
          return modelSupportsContext1mBeta(gates.model);
        }
        if (lower === SKILLS_BETA && gates.body !== undefined) {
          return hasCodeExecutionTool(gates.body);
        }
        return true;
      })
  );
  for (const token of clientBeta
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const lower = token.toLowerCase();
    if (allowSet.has(lower) && !seen.has(lower)) {
      baseList.push(token);
      seen.add(lower);
    }
  }
  return baseList.join(",");
}

/**
 * Collapse a list of comma-list header values into a deduped, trimmed token
 * array. Empty/undefined/null entries are dropped. Used to reconcile the
 * case-variant `anthropic-version` / `anthropic-beta` headers below.
 */
function uniqueCommaValues(values: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      values
        .filter((value) => value !== undefined && value !== null && value !== "")
        .flatMap((value) => String(value).split(","))
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Dedupe case-variant Anthropic headers in-place. Node/undici's fetch merges
 * `anthropic-version` and `Anthropic-Version` into a single `"v, v"` value,
 * which the Anthropic API rejects. Collapse both case variants down to
 * one canonical lowercase header carrying a single value. Same for
 * `anthropic-beta` (joined comma-list, deduped). Mutates `headers`.
 */
export function normalizeAnthropicHeaderVariants(headers: Record<string, string>): void {
  // Only collapse when BOTH case variants are present simultaneously — that is the
  // only situation undici merges into a rejected `"v, v"` value. A lone variant is
  // sent fine on its own, so leave it untouched (preserving the caller's casing
  // instead of silently rewriting it to lowercase).
  if ("anthropic-version" in headers && "Anthropic-Version" in headers) {
    const versionValues = uniqueCommaValues([
      headers["anthropic-version"],
      headers["Anthropic-Version"],
    ]);
    delete headers["Anthropic-Version"];
    delete headers["anthropic-version"];
    if (versionValues.length > 0) {
      headers["anthropic-version"] = versionValues[0];
    }
  }

  if ("anthropic-beta" in headers && "Anthropic-Beta" in headers) {
    const betaValues = uniqueCommaValues([headers["anthropic-beta"], headers["Anthropic-Beta"]]);
    delete headers["Anthropic-Beta"];
    delete headers["anthropic-beta"];
    if (betaValues.length > 0) {
      headers["anthropic-beta"] = betaValues.join(",");
    }
  }
}

export const CLAUDE_CLI_VERSION = CLAUDE_CODE_CLIENT_VERSION;
export const CLAUDE_CLI_BUILD_REVISION = CLAUDE_CODE_CLIENT_BUILD_REVISION;
export const CLAUDE_CLI_BILLING_VERSION = CLAUDE_CODE_CLIENT_BILLING_VERSION;
export const CLAUDE_CLI_USER_AGENT = getClaudeCodeUserAgent("cli");
export const CLAUDE_CLI_STAINLESS_PACKAGE_VERSION = CLAUDE_CODE_SDK_PACKAGE_VERSION;
export const CLAUDE_CLI_STAINLESS_RUNTIME_VERSION = CLAUDE_CODE_RUNTIME_VERSION;
