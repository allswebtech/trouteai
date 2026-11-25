import { handleChat } from "@/sse/handlers/chat";
import { withAnthropicErrorShape } from "@/shared/utils/anthropicErrorShape";
import { initTranslators } from "@trouteai/open-sse/translator/index.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { requireJsonContentType } from "@/shared/middleware/requireJsonContentType";
import { bodyRequestsStream } from "@trouteai/open-sse/utils/aiSdkCompat.ts";
import {
  withEarlyStreamKeepalive,
  ANTHROPIC_PING_FRAME,
} from "@trouteai/open-sse/utils/earlyStreamKeepalive";
import {
  resolveKeepaliveThreshold,
  resolveStreamFlagKeepaliveThreshold,
} from "@trouteai/open-sse/utils/keepaliveThreshold";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/messages");
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 *
 * `preParsedBody` is threaded from withInjectionGuard so the body is
 * parsed at most once per request.
 */
async function postHandler(request: any, context: any, preParsedBody: any = null) {
  // Reject non-JSON Content-Type with 415 before touching the body — mirrors OpenAI's
  // reference API and matches /v1/chat/completions.
  const ctRejection = requireJsonContentType(request);
  if (ctRejection) return ctRejection;

  await ensureInitialized();
  // Streaming Anthropic clients (Claude Code, the Anthropic SDK) drop the connection
  // when no bytes arrive while a large prompt is processed before the first token — a
  // big context can exceed the client's stream/first-token watchdog. TRouteAI holds
  // the response until the first useful upstream byte (ensureStreamReadiness), so keep
  // the connection warm with early keepalives during that gap — same wrapper used by
  // /v1/responses. Anthropic clients ignore SSE comments for their watchdog, so
  // emit a real `event: ping` (ANTHROPIC_PING_FRAME).
  // Whether the answer is a stream is decided by the body's `stream` field alone (see
  // resolveStreamFlag). The wrapper is used only when the body asks for a stream AND the
  // Accept header names text/event-stream. Once the wrapper has sent its first ping, the
  // answer is a 200 for good, so a failure that comes later (a 429 with its retry-after
  // and limit headers, a 402, a 5xx) can only reach the client as an error event. A client
  // that does not ask for an event stream in Accept keeps the real HTTP status, which
  // programs in front of the gateway act on (for example, moving to another account on a
  // 429). The body parsed here is handed on so it is read once.
  let body = preParsedBody;
  if (body == null) {
    try {
      body = await request
        .clone()
        .json()
        .catch(() => null);
    } catch {
      body = null;
    }
  }
  const accept = String(request.headers?.get?.("accept") || "").toLowerCase();
  if (bodyRequestsStream(body) && accept.includes("text/event-stream")) {
    const model = body?.model;
    return await withEarlyStreamKeepalive(handleChat(request, null, body), {
      signal: request.signal,
      thresholdMs: resolveKeepaliveThreshold(model),
      keepaliveFrame: ANTHROPIC_PING_FRAME,
    });
  }
  // `stream: true` without an event-stream Accept (the SDKs send application/json): the
  // keep-alive stream opens only after a long silence (keepaliveThreshold.ts), so a failure
  // in the usual time keeps its HTTP status and a proxy still never sees a silent connection.
  const streamFlagThreshold = bodyRequestsStream(body)
    ? resolveStreamFlagKeepaliveThreshold(body?.model)
    : null;
  if (streamFlagThreshold !== null) {
    return await withEarlyStreamKeepalive(handleChat(request, null, body), {
      signal: request.signal,
      thresholdMs: streamFlagThreshold,
      keepaliveFrame: ANTHROPIC_PING_FRAME,
    });
  }
  return await handleChat(request, null, body);
}

const guardedPost = withInjectionGuard(postHandler);

// Errors leave this route in the Messages API's own shape ({type: "error", error: {type, ...}}).
export async function POST(request: any, context: any) {
  return withAnthropicErrorShape(await guardedPost(request, context));
}
