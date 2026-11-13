/**
 * Error answers of the Anthropic-format routes in the Messages API's own shape:
 *   { "type": "error", "error": { "type": "<error type>", "message": "..." } }
 * Clients written for api.anthropic.com (SDKs, Claude Code) read `type` and `error.type`.
 * Existing fields (code, correlation_id, upstream_details, ...) are kept; the message is not
 * touched, because Claude Code matches on its wording.
 */
const ANTHROPIC_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "billing_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
  "rate_limit_error",
  "api_error",
  "timeout_error",
  "overloaded_error",
]);

export function anthropicErrorTypeForStatus(status: number): string {
  if (status === 400 || status === 415 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 504 || status === 408) return "timeout_error";
  if (status === 529 || status === 503) return "overloaded_error";
  return status >= 500 ? "api_error" : "invalid_request_error";
}

/** A model id this router cannot route is "not found", as on the Messages API (404). */
const UNKNOWN_MODEL_PATTERN = /Unable to determine provider for model/i;

export function toAnthropicErrorBody(
  status: number,
  body: unknown
): { status: number; body: Record<string, unknown> } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const inner =
    src.error && typeof src.error === "object" && !Array.isArray(src.error)
      ? (src.error as Record<string, unknown>)
      : null;
  const message =
    typeof inner?.message === "string"
      ? inner.message
      : typeof src.error === "string"
        ? src.error
        : typeof src.message === "string"
          ? src.message
          : "";
  if (!message) return null;

  let outStatus = status;
  let type = typeof inner?.type === "string" ? inner.type : "";
  if (status === 400 && UNKNOWN_MODEL_PATTERN.test(message)) {
    outStatus = 404;
    type = "not_found_error";
  }
  if (!ANTHROPIC_ERROR_TYPES.has(type)) type = anthropicErrorTypeForStatus(outStatus);

  const { error: _error, message: _message, ...rest } = src;
  return {
    status: outStatus,
    body: { type: "error", error: { ...(inner || {}), type, message }, ...rest },
  };
}

/** Rewrites a JSON error Response; anything else (success, streams, non-JSON) passes untouched. */
export async function withAnthropicErrorShape(response: Response): Promise<Response> {
  if (!response || response.status < 400) return response;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  if ((parsed as { type?: unknown })?.type === "error") return response;
  const shaped = toAnthropicErrorBody(response.status, parsed);
  if (!shaped) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers });
}
