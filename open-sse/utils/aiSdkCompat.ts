/**
 * AI SDK compatibility helpers.
 */

/**
 * Decides whether the client gets an event stream. The body's `stream` field alone decides:
 * `stream: true` streams, anything else (absent, `false`, another value) gets one JSON answer.
 * That is the default of the OpenAI Chat Completions, Responses and Anthropic Messages APIs,
 * where `stream` defaults to false. The Accept header, the user agent and the per-key stream
 * setting never turn a JSON request into a stream: a plain JSON client could not read it.
 * Call it after the non-standard aliases have been folded into `stream`
 * (see `resolveExplicitStreamAlias`).
 */
export function resolveStreamFlag(bodyStream: unknown): boolean {
  return bodyStream === true;
}

/**
 * The same decision for a raw request body, before the aliases are folded in: an alias
 * (`streaming`, `non_stream`, ...) wins over `stream`, as it does in the request pipeline.
 */
export function bodyRequestsStream(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const alias = resolveExplicitStreamAlias(body);
  if (alias !== undefined) return alias;
  return resolveStreamFlag((body as Record<string, unknown>).stream);
}

/**
 * Resolves explicit stream aliases used by non-standard clients.
 * Returns:
 * - `true`  -> explicit streaming intent
 * - `false` -> explicit non-stream intent
 * - `undefined` -> no explicit alias present
 */
export function resolveExplicitStreamAlias(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;

  if (b.streaming === true) return true;
  if (b.streaming === false) return false;
  if (b.non_stream === true) return false;
  if (b.disable_stream === true) return false;
  if (b.disable_streaming === true) return false;

  return undefined;
}

/**
 * Backward-compatible helper used by tests/legacy call sites.
 */
export function hasExplicitNoStreamParam(body: unknown): boolean {
  return resolveExplicitStreamAlias(body) === false;
}

/**
 * Removes surrounding markdown code fences when Claude wraps JSON payloads.
 * Example: ```json\n{"ok":true}\n``` -> {"ok":true}
 */
export function stripMarkdownCodeFence(text: unknown): unknown {
  if (typeof text !== "string") return text;
  const codeBlockRegex = /^```(?:json|javascript|typescript|js|ts)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const match = text.trim().match(codeBlockRegex);
  return match ? match[1].trim() : text;
}
