/**
 * Context-overflow errors that coding agents can recover from on their own.
 *
 * Claude Code compacts the conversation by itself when an error says
 * "prompt is too long" (it parses `prompt is too long: N tokens > M maximum` to know how
 * much to drop), and lowers `max_tokens` by itself on
 * "input length and `max_tokens` exceed context limit: a + b > c". Codex and other
 * OpenAI-format agents key off `error.code === "context_length_exceeded"`. Any other
 * wording (a provider's own text, or a router's) leaves the agent stuck: even its
 * /compact request is rejected the same way.
 *
 * TRouteAI's token counts are estimates (characters / 4 of the JSON body), so a request is
 * only blocked locally when the estimate is clearly over the limit; anything closer goes to
 * the provider, whose answer is exact.
 */

/** A request is "clearly" too big only when the estimate is over the limit by this factor. */
export const CONTEXT_ESTIMATE_TOLERANCE = 1.1;

export function isClearlyOverContextLimit(estimatedInputTokens: number, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return estimatedInputTokens > Math.floor(limit * CONTEXT_ESTIMATE_TOLERANCE);
}

/**
 * Output room never clamped below this: the estimate can be high, and a reply cut at a few
 * hundred tokens is worse than a provider's "no room" error, which clients recover from.
 */
export const MIN_OUTPUT_ROOM_TOKENS = 8192;

/** Anthropic's wording; Claude Code compacts automatically when it sees it. */
export function promptTooLongMessage(inputTokens: number, limit: number): string {
  return `prompt is too long: ${Math.ceil(inputTokens)} tokens > ${Math.floor(limit)} maximum`;
}

/** Anthropic's wording; Claude Code retries with a smaller max_tokens when it sees it. */
export function inputPlusMaxTokensMessage(
  inputTokens: number,
  maxTokens: number,
  limit: number
): string {
  return (
    `input length and \`max_tokens\` exceed context limit: ${Math.ceil(inputTokens)} + ` +
    `${Math.ceil(maxTokens)} > ${Math.floor(limit)}, decrease input length or \`max_tokens\` and try again`
  );
}

const GENERIC_PROMPT_TOO_LONG =
  "prompt is too long: the conversation is longer than this model accepts";

const ANTHROPIC_EXACT_RE =
  /prompt is too long: \d+ tokens > \d+ maximum|input length and `max_tokens` exceed context limit: \d+ \+ \d+ > \d+, decrease input length or `max_tokens` and try again/;

// Wording Claude Code already understands: leave it exactly as the provider sent it.
const CLAUDE_UNDERSTOOD_RE =
  /prompt is too long|input is too long for requested model|input length and `max_tokens` exceed context limit/i;

// Context-overflow wording of the providers TRouteAI talks to. Kept specific on purpose,
// because it rewrites what the client sees: output-limit errors ("max_tokens: 200000 >
// 128000, which is the maximum allowed number of output tokens") and rate limits ("tokens
// per min") must not match. accountFallback.CONTEXT_OVERFLOW_PATTERNS is a broader list on
// purpose: it only decides whether a combo tries the next target.
const CONTEXT_OVERFLOW_RES = [
  /prompt is too long/i,
  /\binput is too long\b/i,
  /exceeds? context limit/i,
  /maximum context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /\bexceed(?:s|ed)?\b[^.\n]{0,40}\bcontext (?:window|length|limit)\b/i,
  /\bcontext (?:window|length) (?:exceeded|overflow)/i,
  /input token count[^.\n]{0,40}exceeds the maximum number of tokens/i,
  /prompt token count of \d+ exceeds the limit of \d+/i, // GitHub Copilot
  /model_max_prompt_tokens_exceeded/i,
  /maximum prompt length is \d+/i, // xAI
  /exceeded model token limit/i, // Moonshot / Kimi
  /CONTENT_LENGTH_EXCEEDS_THRESHOLD/,
  /\bprompt (?:is )?too large\b/i,
];

export function isContextOverflowText(text: string): boolean {
  return CONTEXT_OVERFLOW_RES.some((re) => re.test(text));
}

const num = (value: string | undefined) => Number.parseInt(String(value), 10);

type ParsedOverflow = {
  /** "output": the input fits, input + max_tokens does not (a max_tokens problem). */
  kind: "prompt" | "output";
  input: number;
  limit: number;
  output?: number;
};

/** Token numbers from a provider's overflow message, when it gives them. */
function parseOverflow(text: string): ParsedOverflow | null {
  const sized = (input: number, limit: number, output?: number): ParsedOverflow =>
    output !== undefined && input <= limit
      ? { kind: "output", input, limit, output }
      : { kind: "prompt", input, limit, output };
  // vLLM / NVIDIA NIM: "'max_tokens' or 'max_completion_tokens' is too large: 32000. This
  // model's maximum context length is 32768 tokens and your request has 8000 input tokens"
  let m = text.match(
    /is too large: (\d+)\.[\s\S]*?maximum context length is (\d+) tokens and your request has (\d+) input tokens/i
  );
  if (m) return sized(num(m[3]), num(m[2]), num(m[1]));
  // OpenRouter: "maximum context length is 200000 tokens. However, you requested about
  // 250000 tokens (240000 of text input, 0 of tool input, 10000 in the output)"
  m = text.match(
    /maximum context length is (\d+) tokens[\s\S]*?(\d+) of text input,\s*(\d+) of tool input,\s*(\d+) in the output/i
  );
  if (m) return sized(num(m[2]) + num(m[3]), num(m[1]), num(m[4]));
  // OpenAI: "maximum context length is 128000 tokens. However, you requested 140000 tokens
  // (100000 in the messages, 40000 in the completion)."
  m = text.match(
    /maximum context length is (\d+) tokens[\s\S]*?(\d+) in the messages,?\s*(\d+) in the completion/i
  );
  if (m) return sized(num(m[2]), num(m[1]), num(m[3]));
  // OpenAI: "maximum context length is 128000 tokens. However, your messages resulted in
  // 130000 tokens."
  m = text.match(/maximum context length is (\d+) tokens[\s\S]*?resulted in (\d+) tokens/i);
  if (m) return sized(num(m[2]), num(m[1]));
  // Mistral: "Prompt contains 140000 tokens ... too large for model with 128000 maximum
  // context length"
  m = text.match(/contains (\d+) tokens[\s\S]*?(\d+) maximum context length/i);
  if (m) return sized(num(m[1]), num(m[2]));
  // Gemini: "The input token count (1200000) exceeds the maximum number of tokens allowed
  // (1048576)."
  m = text.match(
    /input token count \(?(\d+)\)? exceeds the maximum number of tokens allowed \(?(\d+)\)?/i
  );
  if (m) return sized(num(m[1]), num(m[2]));
  // GitHub Copilot: "prompt token count of 130000 exceeds the limit of 128000"
  m = text.match(/prompt token count of (\d+) exceeds the limit of (\d+)/i);
  if (m) return sized(num(m[1]), num(m[2]));
  // xAI: "This model's maximum prompt length is 131072 but the request contains 140000 tokens."
  m = text.match(/maximum prompt length is (\d+) but (?:the )?request contains (\d+) tokens/i);
  if (m) return sized(num(m[2]), num(m[1]));
  return null;
}

/**
 * Anthropic wording for a provider's context-overflow error, keeping the token numbers when
 * the provider gave them. `null` when the text is not a context overflow, or Claude Code
 * already understands it as sent.
 */
export function toClaudeContextOverflowMessage(text: string): string | null {
  if (!text || CLAUDE_UNDERSTOOD_RE.test(text) || !isContextOverflowText(text)) return null;
  const parsed = parseOverflow(text);
  if (!parsed) return GENERIC_PROMPT_TOO_LONG;
  return parsed.kind === "output"
    ? inputPlusMaxTokensMessage(parsed.input, parsed.output ?? 0, parsed.limit)
    : promptTooLongMessage(parsed.input, parsed.limit);
}

/** The Anthropic sentence for any overflow text (exact one kept, else reworded, else generic). */
export function claudeOverflowMessage(text: string): string {
  return (
    text.match(ANTHROPIC_EXACT_RE)?.[0] ??
    (CLAUDE_UNDERSTOOD_RE.test(text) ? text : null) ??
    toClaudeContextOverflowMessage(text) ??
    GENERIC_PROMPT_TOO_LONG
  );
}

/**
 * In-band SSE error for a context overflow that arrives inside a stream (a Responses
 * `response.failed` with code context_length_exceeded): Anthropic's `event: error` for Claude
 * clients, an OpenAI `data: {"error": …}` chunk for Chat Completions clients. `null` when it
 * is not an overflow or the client format has no such frame.
 */
export function contextOverflowStreamFrame(
  clientFormat: string | undefined,
  error: { code?: string; message?: string }
): string | null {
  const message = String(error?.message || "");
  const isOverflow =
    error?.code === "context_length_exceeded" ||
    isContextOverflowText(`${message} ${error?.code || ""}`);
  if (!isOverflow) return null;
  if (clientFormat === "claude") {
    const event = {
      type: "error",
      error: { type: "invalid_request_error", message: claudeOverflowMessage(message) },
    };
    return `event: error\ndata: ${JSON.stringify(event)}\n\n`;
  }
  if (clientFormat === "openai") {
    const chunk = {
      error: { message, type: "invalid_request_error", code: "context_length_exceeded" },
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
  return null;
}

const CLAUDE_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
]);

/**
 * The end of a stream that failed after it started (Kiro: an EventStream exception, or an
 * answer cut off before its stop reason), in the client's own format, so the client sees an
 * error and retries instead of a cut-off answer marked complete. Claude: `event: error` and
 * `message_stop` (the Anthropic SDK throws on the error; Claude Code then retries); OpenAI chat:
 * a `finish_reason: "error"` chunk with `error` and `[DONE]`; Responses: `response.failed`.
 */
export function inbandStreamErrorFrame(
  clientFormat: string | undefined,
  error: { status?: number; type?: string; code?: string; message?: string }
): string {
  const status = Number(error?.status) || 502;
  const message = String(error?.message || "Upstream stream failed before completion.");
  if (clientFormat === "claude") {
    const type = CLAUDE_ERROR_TYPES.has(String(error?.type))
      ? String(error.type)
      : status === 429
        ? "rate_limit_error"
        : status === 401
          ? "authentication_error"
          : status === 403
            ? "permission_error"
            : status >= 400 && status < 500
              ? "invalid_request_error"
              : "api_error";
    return (
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n` +
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
  }
  const openaiType =
    status === 429
      ? "rate_limit_error"
      : status >= 400 && status < 500
        ? "invalid_request_error"
        : "server_error";
  const code = String(error?.code || (status === 429 ? "rate_limit_exceeded" : "server_error"));
  if (clientFormat === "openai-responses" || clientFormat === "openai-response") {
    const event = {
      type: "response.failed",
      response: { id: null, status: "failed", error: { message, type: openaiType, code } },
    };
    return `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`;
  }
  const chunk = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "error" }],
    error: { message, type: openaiType, code },
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/** An overflow an OpenAI-format agent should compact for (not a max_tokens problem). */
function isPromptOverflowText(text: string): boolean {
  return isContextOverflowText(text) && parseOverflow(text)?.kind !== "output";
}

function errorTextOf(parsed: unknown, raw: string): { message: string; code: string } {
  if (!parsed || typeof parsed !== "object") return { message: raw, code: "" };
  const body = parsed as Record<string, unknown>;
  const error = body.error;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    return {
      message: typeof e.message === "string" ? e.message : raw,
      code: typeof e.code === "string" ? e.code : "",
    };
  }
  if (typeof error === "string") return { message: error, code: "" };
  if (typeof body.message === "string") {
    return { message: body.message, code: typeof body.reason === "string" ? body.reason : "" };
  }
  return { message: raw, code: "" };
}

function rebuild(text: string, response: Response, status = response.status): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("Content-Type", "application/json");
  return new Response(text, { status, statusText: response.statusText, headers });
}

/**
 * Give a client the context-overflow error in the wording its agent recovers from:
 * Anthropic's for `/v1/messages` clients, `code: "context_length_exceeded"` for
 * OpenAI-format clients. Every other response is returned untouched (only 400/413 JSON
 * errors are read).
 */
export async function normalizeContextOverflowResponse(
  response: Response,
  clientFormat: "claude" | "openai"
): Promise<Response> {
  if (!response || response.ok || (response.status !== 400 && response.status !== 413)) {
    return response;
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("json") && !contentType.includes("text/plain")) {
    return response;
  }
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return response;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const { message, code } = errorTextOf(parsed, raw);
  const overflowText = `${message} ${code}`;

  if (clientFormat === "claude") {
    // Anthropic's exact sentence (TRouteAI's own, or a provider's that a wrapper prefixed
    // with "[400]: " or suffixed with combo details) is sent alone, in Anthropic's shape.
    const claudeMessage =
      overflowText.match(ANTHROPIC_EXACT_RE)?.[0] ?? toClaudeContextOverflowMessage(overflowText);
    if (!claudeMessage) return rebuild(raw, response);
    const alreadyAnthropic =
      (parsed as { type?: unknown } | null)?.type === "error" && message === claudeMessage;
    if (alreadyAnthropic) return rebuild(raw, response);
    return rebuild(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: claudeMessage },
      }),
      response,
      400
    );
  }

  if (!isPromptOverflowText(overflowText)) return rebuild(raw, response);
  const parsedError =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).error : null;
  const error =
    parsedError && typeof parsedError === "object"
      ? (parsedError as Record<string, unknown>)
      : null;
  if (error && error.code === "context_length_exceeded") return rebuild(raw, response);
  const next = error
    ? {
        ...(parsed as Record<string, unknown>),
        error: { ...error, type: "invalid_request_error", code: "context_length_exceeded" },
      }
    : {
        error: {
          message,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      };
  return rebuild(JSON.stringify(next), response, 400);
}
