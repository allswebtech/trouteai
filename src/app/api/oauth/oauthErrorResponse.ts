import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@trouteai/open-sse/utils/error";

/**
 * Maps known OAuth/import failures (upstream token refresh/exchange rejected,
 * bad pasted token) to a clear 4xx/502 instead of a generic 500.
 * Returns null for anything else, so callers keep their existing 500 path.
 */

// Upstream token service rejected or failed the call.
const UPSTREAM_FAILURE =
  /^(Token (refresh|exchange|validation) failed|Token refresh retry failed)\b/i;
// The pasted/imported credential itself is malformed.
const BAD_INPUT = /^(Invalid token format|Access token is required|Invalid machine ID format)\b/i;

export function classifyOAuthError(error: unknown): { status: number; message: string } | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = sanitizeErrorMessage(raw);
  if (!message) return null;

  // Typed errors (e.g. KiroAuthError) carry the status to return.
  const status = (error as { status?: unknown } | null)?.status;
  if (
    error instanceof Error &&
    error.name === "KiroAuthError" &&
    typeof status === "number" &&
    status >= 400 &&
    status < 600
  ) {
    return { status, message };
  }
  if (BAD_INPUT.test(message)) return { status: 400, message };
  if (UPSTREAM_FAILURE.test(message)) return { status: 502, message };
  return null;
}

/**
 * Builds the JSON error response for a known failure, logging one warn line
 * (no stack, no tokens). Returns null when the error is not a known kind.
 */
export function oauthErrorResponse(
  error: unknown,
  logTag: string,
  extraBody: Record<string, unknown> = {}
): NextResponse | null {
  const known = classifyOAuthError(error);
  if (!known) return null;
  console.warn(`${logTag} ${known.status}: ${known.message}`);
  return NextResponse.json({ ...extraBody, error: known.message }, { status: known.status });
}
