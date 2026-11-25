import { getProviderAlias } from "@/shared/constants/providers";
import { TROUTEAI_RESPONSE_HEADERS } from "@/shared/constants/headers";
import { APP_CONFIG } from "@/shared/constants/appConfig";

type UsageLike = Record<string, unknown> | null | undefined;

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.round(toFiniteNumber(value)));
}

const INVALID_HEADER_VALUE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const ASCII_HEADER_VALUE_PATTERN = /^[\u0020-\u007e]*$/;

function toWellFormedUnicode(value: string): string {
  let result = "";

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[i] + value[i + 1];
        i += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
      continue;
    }
    result += value[i];
  }

  return result;
}

function toHeaderValue(value: string): string {
  const withoutControls = value.replace(INVALID_HEADER_VALUE_CONTROL_CHARS, "");
  if (ASCII_HEADER_VALUE_PATTERN.test(withoutControls)) return withoutControls;
  return encodeURIComponent(toWellFormedUnicode(withoutControls));
}

export function getTRouteAITokenCounts(usage: UsageLike): { input: number; output: number } {
  if (!usage || typeof usage !== "object") {
    return { input: 0, output: 0 };
  }

  return {
    input: toNonNegativeInteger(
      usage.input ??
        usage.prompt_tokens ??
        usage.input_tokens ??
        usage.promptTokens ??
        usage.inputTokens
    ),
    output: toNonNegativeInteger(
      usage.output ??
        usage.completion_tokens ??
        usage.output_tokens ??
        usage.completionTokens ??
        usage.outputTokens
    ),
  };
}

export function formatTRouteAICost(costUsd: unknown): string {
  const normalized = toFiniteNumber(costUsd);
  return normalized > 0 ? normalized.toFixed(10) : "0.0000000000";
}

/**
 * Build the `X-TRouteAI-Decision` composite header value: `strategy=<name>;
 * provider=<alias>; latency_ms=<n>`. Returns `null` when both `strategy` and
 * `provider` are absent/blank (mirrors the per-field guard pattern used for the
 * other optional headers). Reuses `getProviderAlias()` for the provider segment
 * (same alias normalization the `X-TRouteAI-Provider` header already applies)
 * and `toNonNegativeInteger()` for latency. The whole formatted string is passed
 * through `toHeaderValue()` before returning, so a strategy/provider id
 * containing control chars cannot corrupt the header line (this
 * header only ever carries a routing strategy name, the already-public provider
 * alias, and a latency integer; never an error message, stack trace, or secret).
 */
export function buildTRouteAIDecisionHeaderValue({
  strategy = null,
  provider = null,
  latencyMs = 0,
}: {
  strategy?: string | null;
  provider?: string | null;
  latencyMs?: unknown;
}): string | null {
  const hasStrategy = typeof strategy === "string" && strategy.trim().length > 0;
  const hasProvider = typeof provider === "string" && provider.trim().length > 0;
  if (!hasStrategy && !hasProvider) return null;

  const parts: string[] = [];
  if (hasStrategy) parts.push(`strategy=${strategy}`);
  if (hasProvider) parts.push(`provider=${getProviderAlias(provider as string)}`);
  parts.push(`latency_ms=${toNonNegativeInteger(latencyMs)}`);

  return toHeaderValue(parts.join("; "));
}

export function buildTRouteAIResponseMetaHeaders({
  cacheHit = false,
  costUsd = 0,
  costSavedUsd = undefined,
  fallback = null,
  fallbackAttempts = 0,
  latencyMs = 0,
  model = null,
  provider = null,
  requestId = null,
  requestedModel = null,
  strategy = null,
  usage = null,
}: {
  cacheHit?: boolean;
  costUsd?: unknown;
  /**
   * Cost the cache AVOIDED. A semantic-cache HIT serves at ≈0 incremental cost
   * (`costUsd: 0`) but saved the original call's cost — surface it here so billing
   * consumers don't charge for hits while analytics can still see what was saved.
   * Emitted as `X-TRouteAI-Cost-Saved` only when provided (omitted on normal
   * responses); pass `0` to explicitly mark a free-model HIT that saved nothing.
   */
  costSavedUsd?: unknown;
  /** Short reason token(s) when the answer did not come from the first choice. */
  fallback?: string | null;
  fallbackAttempts?: number;
  latencyMs?: unknown;
  model?: string | null;
  provider?: string | null;
  requestId?: string | null;
  /** The model string the client sent. */
  requestedModel?: string | null;
  /**
   * Routing decision (combo strategy name, or `"single"` for a non-combo
   * request) surfaced via `X-TRouteAI-Decision`.
   */
  strategy?: string | null;
  usage?: UsageLike;
}): Record<string, string> {
  const tokens = getTRouteAITokenCounts(usage);
  const headers: Record<string, string> = {
    [TROUTEAI_RESPONSE_HEADERS.cacheHit]: toHeaderValue(String(cacheHit)),
    [TROUTEAI_RESPONSE_HEADERS.latencyMs]: toHeaderValue(String(toNonNegativeInteger(latencyMs))),
    [TROUTEAI_RESPONSE_HEADERS.responseCost]: toHeaderValue(formatTRouteAICost(costUsd)),
    [TROUTEAI_RESPONSE_HEADERS.tokensIn]: toHeaderValue(String(tokens.input)),
    [TROUTEAI_RESPONSE_HEADERS.tokensOut]: toHeaderValue(String(tokens.output)),
    [TROUTEAI_RESPONSE_HEADERS.version]: toHeaderValue(APP_CONFIG.version),
  };

  if (typeof model === "string" && model.trim().length > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.model] = toHeaderValue(model);
  }

  if (typeof requestId === "string" && requestId.trim().length > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.requestId] = toHeaderValue(requestId);
  }

  if (typeof requestedModel === "string" && requestedModel.trim().length > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.requestedModel] = toHeaderValue(requestedModel);
  }

  if (typeof fallback === "string" && fallback.trim().length > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.fallback] = toHeaderValue(fallback);
  }

  if (typeof provider === "string" && provider.trim().length > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.provider] = toHeaderValue(getProviderAlias(provider));
  }

  // Cache-saved cost: emitted only when the caller passes a value (cache HITs), so
  // non-cache responses keep their existing header shape. `0` is a valid saved cost.
  if (costSavedUsd != null) {
    headers[TROUTEAI_RESPONSE_HEADERS.costSaved] = toHeaderValue(formatTRouteAICost(costSavedUsd));
  }

  const attempts = toNonNegativeInteger(fallbackAttempts);
  if (attempts > 0) {
    headers[TROUTEAI_RESPONSE_HEADERS.fallbackAttempts] = toHeaderValue(String(attempts));
  }

  const decisionValue = buildTRouteAIDecisionHeaderValue({ strategy, provider, latencyMs });
  if (decisionValue !== null) {
    headers[TROUTEAI_RESPONSE_HEADERS.decision] = decisionValue;
  }

  return headers;
}

export function buildTRouteAISseMetadataComment(
  options: Parameters<typeof buildTRouteAIResponseMetaHeaders>[0]
): string {
  const headers = buildTRouteAIResponseMetaHeaders(options);
  const lines = Object.entries(headers)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([name, value]) => `: ${name.toLowerCase()}=${value}`);

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Single choke-point for attaching the X-TRouteAI-* response meta headers.
 * Mutates `headers` in place (accepts a Headers instance OR a plain Record).
 * Use at EVERY non-streaming success return so no route forgets the telemetry.
 */
export function attachTRouteAIMetaHeaders(
  headers: Headers | Record<string, string>,
  meta: Parameters<typeof buildTRouteAIResponseMetaHeaders>[0]
): void {
  const built = buildTRouteAIResponseMetaHeaders(meta);
  if (headers instanceof Headers) {
    for (const [name, value] of Object.entries(built)) headers.set(name, value);
  } else {
    Object.assign(headers, built);
  }
}

/**
 * Attach the X-TRouteAI-* meta headers onto an already-built Response, ADDING
 * (never replacing) headers so the original Content-Type / body stay intact.
 * Tries to mutate in place; if the Response headers are immutable, clones the
 * Response carrying over body + status + headers (mirrors
 * `chatHelpers.ts::withSessionHeader`). Use for opaque handler-built Responses
 * (audio streams, passthrough proxies) where the body cannot be re-serialized.
 */
export function attachTRouteAIMetaToResponse(
  response: Response,
  meta: Parameters<typeof buildTRouteAIResponseMetaHeaders>[0]
): Response {
  if (!response) return response;

  try {
    attachTRouteAIMetaHeaders(response.headers, meta);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    attachTRouteAIMetaHeaders(cloned.headers, meta);
    return cloned;
  }
}

/** Joins fallback reason tokens into one comma list, keeping order and dropping repeats. */
export function mergeFallbackTokens(...values: Array<string | null | undefined>): string {
  const seen: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const token of value.split(",")) {
      const t = token.trim();
      if (t && !seen.includes(t)) seen.push(t);
    }
  }
  return seen.join(", ");
}

/**
 * Says who answered, on any Response (an answer or an error, streamed or not): sets the
 * requested-model header when it is missing, adds the answering model and provider only when
 * the response does not name them yet (the innermost layer knows best), appends a fallback
 * token and adds to the fallback-attempts count. Outer layers (a combo, the global fallback)
 * call it after inner ones, so their facts add up instead of replacing each other.
 */
export function withTRouteAIRoutingHeaders(
  response: Response,
  facts: {
    requestedModel?: string | null;
    model?: string | null;
    provider?: string | null;
    fallback?: string | null;
    fallbackAttempts?: number;
  }
): Response {
  if (!response) return response;
  const apply = (headers: Headers) => {
    const H = TROUTEAI_RESPONSE_HEADERS;
    const setIfMissing = (name: string, value: string | null | undefined) => {
      if (typeof value === "string" && value.trim() && !headers.has(name)) {
        headers.set(name, toHeaderValue(value));
      }
    };
    setIfMissing(H.requestedModel, facts.requestedModel);
    setIfMissing(H.model, facts.model);
    if (typeof facts.provider === "string" && facts.provider.trim()) {
      setIfMissing(H.provider, getProviderAlias(facts.provider));
    }
    if (typeof facts.fallback === "string" && facts.fallback.trim()) {
      headers.set(
        H.fallback,
        toHeaderValue(mergeFallbackTokens(headers.get(H.fallback), facts.fallback))
      );
    }
    const added = toNonNegativeInteger(facts.fallbackAttempts);
    if (added > 0) {
      const current = toNonNegativeInteger(headers.get(H.fallbackAttempts));
      headers.set(H.fallbackAttempts, String(current + added));
    }
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const cloned = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    apply(cloned.headers);
    return cloned;
  }
}
