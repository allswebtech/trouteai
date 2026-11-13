/**
 * chatCore non-streaming success response headers (chatCore god-file
 * decomposition).
 *
 * Extracted from handleChatCore's non-streaming success path: build the response header map for a
 * cache-MISS JSON response — the static Content-Type + cache marker, the TRouteAI meta headers
 * (provider/model/latency/usage/cost/request-id), and the optional compression header. Pure builder
 * (returns a fresh map; only mutates the map it owns). Behaviour is byte-identical to the previous
 * inline block, including `latencyMs: now - startTime`.
 */
import { TROUTEAI_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { attachTRouteAIMetaHeaders as defaultAttachMeta } from "@/domain/trouteaiResponseMeta";

export function buildNonStreamingResponseHeaders(
  args: {
    provider: string | null | undefined;
    model: string | null | undefined;
    startTime: number;
    responseUsage: unknown;
    estimatedCost: number;
    requestId: unknown;
    compressionResponseMeta?: string | null | undefined;
    comboStrategy?: string | null | undefined;
  },
  deps: { attachTRouteAIMetaHeaders: typeof defaultAttachMeta; now: () => number } = {
    attachTRouteAIMetaHeaders: defaultAttachMeta,
    now: Date.now,
  }
): Record<string, string> {
  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    [TROUTEAI_RESPONSE_HEADERS.cache]: "MISS",
  };
  deps.attachTRouteAIMetaHeaders(responseHeaders, {
    provider: args.provider,
    model: args.model,
    cacheHit: false,
    latencyMs: deps.now() - args.startTime,
    usage: args.responseUsage,
    costUsd: args.estimatedCost,
    requestId: args.requestId,
    strategy: args.comboStrategy ?? "single",
  });
  if (args.compressionResponseMeta) {
    responseHeaders[TROUTEAI_RESPONSE_HEADERS.compression] = args.compressionResponseMeta;
  }
  return responseHeaders;
}
