import { CORS_HEADERS } from "@/shared/utils/cors";
import { v1CountTokensSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { countTextTokens, type TokenizerContext } from "@/shared/utils/tiktokenCounter";
import { withAnthropicErrorShape } from "@/shared/utils/anthropicErrorShape";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";
import { getExecutor } from "@trouteai/open-sse/executors/index.ts";
import { runWithProxyContext } from "@trouteai/open-sse/utils/proxyFetch.ts";
import { buildErrorBody } from "@trouteai/open-sse/utils/error.ts";
import { isAccountUnavailable } from "@trouteai/open-sse/services/accountFallback.ts";
import {
  claudeTokensFromCl100k,
  providerRequestOverheadTokens,
} from "@trouteai/open-sse/config/claudeTokens.ts";
import { getComboByName } from "@/lib/db/combos";
import { getModelIsHidden } from "@/lib/db/models";
import { getProviderConnections } from "@/lib/db/providers";
import { getComboModelString } from "@/lib/combos/steps";
import { getModelInfo } from "@/sse/services/model";
import { extractApiKey, getProviderCredentials, getProviderSearchPool } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { constrainConnectionsToQuota, resolveQuotaKeyScope } from "@/lib/quota/quotaKey";
import { handleNoCredentials, safeResolveProxy } from "@/sse/handlers/chatHelpers";
import * as log from "@/sse/utils/logger";

// What the number in the answer is made of, so a client can tell a provider's own count from an
// estimate and see the tokens a provider adds around the client's content.
const COUNT_HEADER = "x-trouteai-count";
const OVERHEAD_HEADER = "x-trouteai-count-overhead";
const REASON_HEADER = "x-trouteai-count-reason";
const BASE_HEADERS = {
  "Content-Type": "application/json",
  ...CORS_HEADERS,
  "Access-Control-Expose-Headers": `${COUNT_HEADER}, ${OVERHEAD_HEADER}, ${REASON_HEADER}`,
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * POST /v1/messages/count_tokens
 *
 * A target with its own count endpoint (Claude and other Anthropic-format providers) answers
 * with the provider's number; when that call fails the client gets the error, never a quiet
 * estimate. Every other target gets an estimate of the client's content, marked as one.
 * Errors leave in the Messages API's own shape.
 */
export async function POST(request) {
  return withAnthropicErrorShape(await countTokens(request));
}

async function countTokens(request): Promise<Response> {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: BASE_HEADERS,
    });
  }

  const validation = validateBody(v1CountTokensSchema, rawBody);
  if (isValidationFailure(validation)) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: BASE_HEADERS,
    });
  }
  const body = validation.data;

  const tokenizerContext: TokenizerContext = {
    model: typeof body.model === "string" ? body.model : undefined,
  };
  const requestedModel = typeof body.model === "string" ? body.model : "";
  if (!requestedModel) {
    return buildEstimatedCountResponse(body, tokenizerContext, null, "unknown-target");
  }

  let target: CountTarget = null;
  let executor;
  let countUrl: string | null = null;
  try {
    target = await resolveCountTarget(requestedModel);
    if (target?.provider && target?.model) {
      executor = getExecutor(target.provider);
      countUrl = executor?.buildCountTokensUrl?.(target.model, null) || null;
    }
  } catch (error) {
    log.debug(
      "COUNT_TOKENS",
      `No count target for ${requestedModel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!target?.provider || !target?.model) {
    return buildEstimatedCountResponse(body, tokenizerContext, null, "unknown-target");
  }
  // Kiro and OpenAI-format providers have no count endpoint: the estimate is all there is, and
  // no account is picked for it.
  if (!executor || !countUrl) {
    return buildEstimatedCountResponse(body, tokenizerContext, target, "no-provider-count");
  }

  const provider = target.provider;
  const model = target.model;
  // The dashboard's own status probes treat a missing account as normal, so the lookup stays
  // quiet; the client gets the same error a chat request would.
  // The count asks the service through an account, so it may use only the accounts the
  // caller's key may use for a chat: the same allowed-account and quota-pool rules.
  const allowedConnections = await allowedConnectionsForKey(request);
  const credentials =
    Array.isArray(allowedConnections) && allowedConnections.length === 0
      ? null
      : await getProviderCredentials(provider, null, allowedConnections, model, {
          quietMissing: true,
          ...(target.connectionId ? { forcedConnectionId: target.connectionId } : {}),
        });
  if (!credentials || credentials.allRateLimited || !credentials.connectionId) {
    return countErrorFromResponse(
      handleNoCredentials(credentials, null, provider, model, null, null)
    );
  }

  try {
    // The provider-side count is a real upstream call: it must honor the connection's proxy
    // assignment exactly like chat execution does.
    const proxyInfo = await safeResolveProxy(credentials.connectionId, undefined, provider);
    const counted = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      executor.countTokens({
        model,
        body,
        credentials,
        log,
        throwOnError: true,
      })
    );
    // The account's own settings (a custom base URL) can leave a provider without a count.
    if (!counted) {
      return buildEstimatedCountResponse(body, tokenizerContext, target, "no-provider-count");
    }
    return new Response(
      JSON.stringify({
        input_tokens: counted.input_tokens,
        model,
        provider,
        source: counted.source || "provider",
      }),
      { headers: { ...BASE_HEADERS, [COUNT_HEADER]: "provider" } }
    );
  } catch (error) {
    const failure = describeCountFailure(error);
    if (failure.unsupported) {
      return buildEstimatedCountResponse(body, tokenizerContext, target, "no-provider-count");
    }
    log.warn(
      "COUNT_TOKENS",
      `${provider}/${model} count failed (${failure.status}): ${failure.message}`
    );
    return countErrorResponse(failure.status, failure.message, failure.type, failure.retryAfter);
  }
}

type CountTarget = {
  provider?: string | null;
  model?: string | null;
  connectionId?: string | null;
} | null;

type CountFailure = {
  status: number;
  message: string;
  type?: string;
  retryAfter?: string | null;
  /** The provider has no count endpoint after all (405, 501, a 404 that is not its own error). */
  unsupported?: boolean;
};

/**
 * The upstream status and message of a failed count. An Anthropic error body keeps its own
 * type and message; a timeout is a 504, a failure without an answer a 502. A 401 means the
 * provider refused the gateway's account, not the caller's key, so it leaves as a 502: a client
 * must not take it for its own key being wrong.
 */
function describeCountFailure(error: unknown): CountFailure {
  const err = (error && typeof error === "object" ? error : {}) as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    retryAfter?: unknown;
  };
  const retryAfter = typeof err.retryAfter === "string" && err.retryAfter ? err.retryAfter : null;
  const raw = typeof err.message === "string" ? err.message : String(error ?? "");
  if (err.name === "AbortError" || err.name === "TimeoutError") {
    return { status: 504, message: "The provider's token count timed out", type: "timeout_error" };
  }
  const status = Number(err.status);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return { status: 502, message: `The provider's token count failed: ${raw}`, retryAfter };
  }
  let message = raw || `HTTP ${status}`;
  let type: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.error;
    if (inner && typeof inner === "object" && typeof inner.message === "string") {
      message = inner.message;
      type = typeof inner.type === "string" ? inner.type : undefined;
    }
  } catch {
    // not a JSON error body: the text itself is the message
  }
  if (status === 405 || status === 501 || (status === 404 && !type)) {
    return { status, message, unsupported: true };
  }
  if (status === 401) {
    return {
      status: 502,
      message: `The provider refused the account used for the count: ${message}`,
      type: "api_error",
    };
  }
  return { status, message, type, retryAfter };
}

// `x-should-retry: false`: a client that cannot get the count estimates it itself at once
// (Claude Code does), which beats waiting for a retry of a call that only sizes the content.
function countErrorResponse(
  status: number,
  message: string,
  type?: string,
  retryAfter?: string | null
): Response {
  const errorBody = buildErrorBody(status, message, undefined, type ? { type } : undefined);
  return new Response(JSON.stringify(errorBody), {
    status,
    headers: {
      ...BASE_HEADERS,
      "x-should-retry": "false",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });
}

/** The chat's answer for a provider without a usable account, with this route's headers. */
function countErrorFromResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) headers.set(name, value);
  headers.set("x-should-retry", "false");
  return new Response(response.body, { status: response.status, headers });
}

const TERMINAL_ACCOUNT_STATES = new Set(["expired", "banned", "credits_exhausted"]);

/**
 * Whether a provider (or one pinned account of it) has an account that can answer now. Only
 * reads the stored state: a count must not move the account rotation of the chat requests.
 */
/**
 * The accounts the request's API key may use: null when it is not limited, an empty list when
 * no account is left (the count then fails the way a chat would).
 */
async function allowedConnectionsForKey(request): Promise<string[] | null> {
  const key = extractApiKey(request);
  if (!key) return null;
  const info = await getApiKeyMetadata(key).catch(() => null);
  if (!info) return null;
  const listed = Array.isArray(info.allowedConnections)
    ? info.allowedConnections.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  let allowed: string[] | null = listed.length > 0 ? listed : null;
  if (Array.isArray(info.allowedQuotas) && info.allowedQuotas.length > 0) {
    const scope = await resolveQuotaKeyScope(info.allowedQuotas);
    allowed = constrainConnectionsToQuota(allowed ?? [], scope.connectionIds);
  }
  return allowed;
}

async function hasUsableAccount(provider: string, connectionId?: string | null) {
  if (provider in NOAUTH_PROVIDERS) return true;
  // The same ids and aliases the chat's account lookup searches (nvidia / nvidia_nim, ...).
  const pool = await getProviderSearchPool(provider);
  const lists = await Promise.all(
    pool.map((id) => getProviderConnections({ provider: id, isActive: true }))
  );
  return lists.flat().some((connection) => {
    const c = connection as { id?: unknown; rateLimitedUntil?: unknown; testStatus?: unknown };
    if (connectionId && c.id !== connectionId) return false;
    if (typeof c.testStatus === "string" && TERMINAL_ACCOUNT_STATES.has(c.testStatus)) {
      return false;
    }
    const until = c.rateLimitedUntil;
    if (typeof until === "number") return !isAccountUnavailable(new Date(until));
    return !isAccountUnavailable(typeof until === "string" ? until : null);
  });
}

/**
 * The provider/model a count is for. A combo name counts as the step that would answer first:
 * the first switched-on step whose model is not hidden and whose provider has a usable account.
 * When no step can answer, the first switched-on step (the chat would fail on it too).
 */
async function resolveCountTarget(requestedModel: string): Promise<CountTarget> {
  const combo = await getComboByName(requestedModel).catch(() => null);
  const steps = Array.isArray(combo?.models) ? (combo.models as unknown[]) : [];
  let firstEnabled: CountTarget = null;
  for (const step of steps) {
    if (step && typeof step === "object" && (step as { enabled?: unknown }).enabled === false) {
      continue;
    }
    const model = getComboModelString(step);
    if (!model) continue;
    const info = await getModelInfo(model);
    if (!info?.provider || !info?.model) continue;
    const pinned = (step as { connectionId?: unknown })?.connectionId;
    const candidate = {
      provider: info.provider,
      model: info.model,
      connectionId: typeof pinned === "string" && pinned ? pinned : null,
    };
    firstEnabled ??= candidate;
    let hidden = false;
    try {
      hidden = getModelIsHidden(candidate.provider, candidate.model);
    } catch {}
    if (hidden) continue;
    if (await hasUsableAccount(candidate.provider, candidate.connectionId)) return candidate;
  }
  return firstEnabled ?? getModelInfo(requestedModel);
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// Estimate tokens for a single Anthropic content block. Real agentic
// conversations carry most of their tokens in `tool_use` inputs, `tool_result`
// content, and `thinking` blocks — counting only `text` (as before) reported
// near-zero for those messages and silently broke Claude Code's auto-compaction.
// Image / redacted_thinking blocks are not text-estimable and count 0.
function estimateContentBlockTokens(part, tokenizerContext: TokenizerContext) {
  if (!part || typeof part !== "object") return 0;
  let tokens = 0;
  switch (part.type) {
    case "text":
      if (typeof part.text === "string") tokens += countTextTokens(part.text, tokenizerContext);
      break;
    case "tool_use":
      if (typeof part.name === "string") tokens += countTextTokens(part.name, tokenizerContext);
      if (part.input !== undefined)
        tokens += countTextTokens(safeStringify(part.input), tokenizerContext);
      break;
    case "tool_result":
      tokens += estimateToolResultTokens(part.content, tokenizerContext);
      break;
    case "thinking":
      if (typeof part.thinking === "string")
        tokens += countTextTokens(part.thinking, tokenizerContext);
      break;
    default:
      break;
  }
  return tokens;
}

// A `tool_result` content can be a plain string or an array of nested blocks
// (text / image). Count string content and nested text blocks.
function estimateToolResultTokens(content, tokenizerContext: TokenizerContext) {
  if (typeof content === "string") return countTextTokens(content, tokenizerContext);
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        tokens += countTextTokens(block.text, tokenizerContext);
      }
    }
    return tokens;
  }
  return 0;
}

/**
 * An estimate of the client's own content (messages, system, tools) as the target counts it.
 * Tokens the provider adds around it are reported in a header, not added: Claude Code counts
 * single pieces with this endpoint (a file, a tool result, each part of its context view), and a
 * fixed per-request amount added to every piece would make each of them look far too large.
 */
function buildEstimatedCountResponse(
  body,
  tokenizerContext: TokenizerContext = {},
  target: CountTarget = null,
  reason = ""
) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let inputTokens = 0;

  for (const msg of messages) {
    if (typeof msg?.content === "string") {
      inputTokens += countTextTokens(msg.content, tokenizerContext);
      continue;
    }

    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        inputTokens += estimateContentBlockTokens(part, tokenizerContext);
      }
    }
  }

  if (typeof body?.system === "string") {
    inputTokens += countTextTokens(body.system, tokenizerContext);
  } else if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      if (block?.type === "text" && typeof block.text === "string") {
        inputTokens += countTextTokens(block.text, tokenizerContext);
      }
    }
  }

  // Tool definitions are part of the prompt too (Claude Code sends 12-18 of them, about a third
  // of a short request's tokens).
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      const definition = safeStringify({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
      });
      inputTokens += countTextTokens(definition, tokenizerContext);
    }
  }

  // The counter above is cl100k. Claude's tokenizers make more tokens (about 1.61x on Claude
  // 5.x, 1.22x on Sonnet 4.5/4.6, measured against Kiro).
  const model = target?.model || tokenizerContext.model || "";
  inputTokens = claudeTokensFromCl100k(model, inputTokens);
  const overhead = providerRequestOverheadTokens(target?.provider, model);

  return new Response(
    JSON.stringify({
      input_tokens: inputTokens,
      source: "local",
    }),
    {
      headers: {
        ...BASE_HEADERS,
        [COUNT_HEADER]: "estimated",
        ...(reason ? { [REASON_HEADER]: reason } : {}),
        ...(overhead > 0 ? { [OVERHEAD_HEADER]: String(overhead) } : {}),
      },
    }
  );
}
