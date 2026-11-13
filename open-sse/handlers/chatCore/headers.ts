export function getHeaderValueCaseInsensitive(
  headers: Record<string, unknown> | Headers | null | undefined,
  targetName: string
) {
  if (!headers || typeof headers !== "object") return null;
  if (headers instanceof Headers) {
    return headers.get(targetName);
  }
  const lowered = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Per-request opt-out of memory (and skills) injection via the
 * `x-trouteai-no-memory` header. Mirrors the existing `x-trouteai-no-cache`
 * convention. Truthy values: `true` / `1` / `yes` (case-insensitive). Clients that
 * manage their own context (RAG/memory) send this to avoid the gateway injecting
 * up to `memorySettings.maxTokens` (~2k) tokens — and being billed for them — on
 * every chat call.
 */
export function isNoMemoryRequested(
  headers: Record<string, unknown> | Headers | null | undefined
): boolean {
  const value = (getHeaderValueCaseInsensitive(headers, "x-trouteai-no-memory") || "")
    .trim()
    .toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Per-request compression override via the `x-trouteai-compression` header. Mirrors the
 * `x-trouteai-no-memory` convention. Returns the raw trimmed value, or null when
 * absent/blank. The resolver (planFromHeader) owns interpretation and casing rules; this
 * helper only reads the wire.
 */
export function resolveCompressionHeader(
  headers: Record<string, unknown> | Headers | null | undefined
): string | null {
  const value = (getHeaderValueCaseInsensitive(headers, "x-trouteai-compression") || "").trim();
  return value || null;
}

/**
 * Per-request opt-in to unconditionally strip `reasoning_content` from the
 * non-streaming JSON response via the `x-trouteai-strip-reasoning` header.
 * Some clients (e.g. Firecrawl AI SDK) have JSON parsers that break on this
 * non-standard OpenAI extension even though it's syntactically valid, and even
 * on reasoning-only messages that the default sanitizer keeps. Truthy values:
 * `true` / `1` / `yes` (case-insensitive).
 * Reasoning is still captured for the replay cache
 * before this header is consulted, so the cache feature is unaffected.
 */
export function isStripReasoningRequested(
  headers: Record<string, unknown> | Headers | null | undefined
): boolean {
  const value = (getHeaderValueCaseInsensitive(headers, "x-trouteai-strip-reasoning") || "")
    .trim()
    .toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}
