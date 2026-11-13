import {
  BaseExecutor,
  mergeUpstreamExtraHeaders,
  type ExecuteInput,
  type ExecutorLog,
  type ProviderCredentials,
} from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import {
  getKiroMachineId,
  getKiroUserAgentHeaders,
  resolveKiroProfileArn,
} from "../config/kiroIdentity.ts";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.ts";
import {
  isExternalIdpAuthMethod,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE,
} from "../services/kiroExternalIdp.ts";
import {
  splitInlineThinking,
  flushPendingThinking,
  type KiroThinkingState,
} from "./kiroThinking.ts";
import { ByteQueue, TEXT_ENCODER, parseEventFrame } from "./kiro/eventstream.ts";
import {
  findKiroProfileArn,
  kiroRuntimeHost,
  resolveKiroRuntimeRegion,
} from "../services/kiroRegion.ts";
import { estimateOutputTokens } from "../utils/usageTracking.ts";
import { claudeCharsPerToken } from "../config/claudeTokens.ts";
import { getModelContextLimit } from "../../src/lib/modelCapabilities.ts";

type JsonRecord = Record<string, unknown>;

type UsageSummary = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type KiroStreamState = {
  endDetected: boolean;
  finishEmitted: boolean;
  startEmitted: boolean;
  stopSeen: boolean;
  hasToolCalls: boolean;
  toolCallIndex: number;
  seenToolIds: Map<string, number>;
  toolArgsEmitted: Map<string, string>;
  toolArgsBuffered: Map<string, { toolIndex: number; canonical: string }>;
  totalContentLength?: number;
  contextUsagePercentage?: number;
  // The model's context window: contextUsagePercentage is a share of it.
  contextWindowTokens?: number;
  hasContextUsage?: boolean;
  hasMeteringEvent?: boolean;
  usage?: UsageSummary;
  hasReasoningContent?: boolean;
  reasoningChunkCount?: number;
  // Kiro's own stop reason from `metadataEvent` (END_TURN, MAX_TOKENS, CONTENT_FILTERED, ...).
  stopReason?: string;
  // Anthropic `stop_details` of a refusal (category, explanation), sent with the finish chunk.
  refusalDetails?: JsonRecord;
  // Frame types seen and an EventStream exception, for the "ended without a stop reason" log.
  frameCounts?: Record<string, number>;
  exception?: string;
  // The client's stop sequence that ended the answer (applied here: Kiro has none).
  stopSequence?: string;
  // Inline-thinking splitter state (populated only when thinkingExpected=true).
  thinking?: KiroThinkingState;
};

/**
 * Flush buffered tool arguments at finish boundaries.
 *
 * Kiro/CodeWhisperer streams toolUseEvent.input as PARTIAL OBJECTS that grow over time
 * (e.g. {command:"cat /home"} then {command:"cat /home/user"}). Re-stringifying each one
 * and emitting it as an OpenAI argument delta produces overlapping prefixes that
 * concatenate into unparseable garbage downstream ("Unterminated string").
 *
 * Fix: defer object-form payloads into state.toolArgsBuffered keyed by toolCallId, keep
 * only the latest canonical, and emit ONCE here as the complete arguments string (the
 * final object is the source of truth — intermediate states are noise). String-form
 * payloads are already concatenable deltas and are emitted incrementally.
 */
export function flushBufferedToolArgs(
  state: Pick<KiroStreamState, "toolArgsBuffered" | "toolArgsEmitted" | "totalContentLength">,
  controller: { enqueue: (chunk: Uint8Array) => void },
  ctx: { responseId: string; created: number; model: string }
): void {
  if (!state.toolArgsBuffered || state.toolArgsBuffered.size === 0) return;
  const { responseId, created, model } = ctx;
  for (const [toolCallId, info] of state.toolArgsBuffered) {
    const alreadyEmitted = state.toolArgsEmitted.get(toolCallId) || "";
    if (info.canonical && info.canonical !== alreadyEmitted) {
      const argsChunk: JsonRecord = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: info.toolIndex,
                  function: { arguments: info.canonical },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
      state.toolArgsEmitted.set(toolCallId, info.canonical);
      // Count the final tool arguments once for the output-token estimate.
      state.totalContentLength = (state.totalContentLength || 0) + info.canonical.length;
    }
  }
  state.toolArgsBuffered.clear();
}

function buildKiroFinishChunk(
  state: KiroStreamState,
  responseId: string,
  created: number,
  model: string,
  includeUsage: boolean
): JsonRecord {
  const finishChunk: JsonRecord = {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: state.hasToolCalls ? "tool_calls" : kiroFinishReason(state.stopReason),
        // Read by the OpenAI -> Claude step (stop_reason "stop_sequence"); ignored elsewhere.
        ...(state.stopSequence !== undefined && !state.hasToolCalls
          ? { stop_sequence: state.stopSequence }
          : {}),
        // Read by the OpenAI -> Claude step (Anthropic's `stop_details` of a refusal).
        ...(state.refusalDetails &&
        !state.hasToolCalls &&
        kiroFinishReason(state.stopReason) === "content_filter"
          ? { stop_details: state.refusalDetails }
          : {}),
      },
    ],
  };

  if (includeUsage && state.usage) {
    finishChunk.usage = state.usage;
  }

  return finishChunk;
}

/** An error inside a Kiro answer, as the client should see it (OpenAI-shaped `error`). */
export type KiroStreamError = { status: number; type: string; code: string; message: string };

/**
 * A Kiro EventStream exception (`:message-type` exception / error) as the error the client gets,
 * by the AWS exception type (CodeWhisperer streaming: ThrottlingException, ValidationException,
 * AccessDeniedException, InternalServerException, ...).
 */
export function kiroStreamErrorOf(exceptionType: string, message: string): KiroStreamError {
  const t = exceptionType.toLowerCase();
  const text = (message || "").trim() || `Kiro stopped the answer (${exceptionType || "error"})`;
  if (t.includes("throttl") || t.includes("quota")) {
    return { status: 429, type: "rate_limit_error", code: exceptionType, message: text };
  }
  if (t.includes("validation")) {
    return { status: 400, type: "invalid_request_error", code: exceptionType, message: text };
  }
  if (t.includes("accessdenied")) {
    return { status: 403, type: "permission_error", code: exceptionType, message: text };
  }
  return {
    status: 500,
    type: "api_error",
    code: exceptionType || "kiro_stream_error",
    message: text,
  };
}

/** Every complete Kiro answer ends with these (all 16 models, text and tool calls, 2026-11-10). */
function kiroAnswerClosed(state: KiroStreamState): boolean {
  return !!(state.stopReason || state.hasContextUsage || state.hasMeteringEvent || state.stopSeen);
}

/** A Kiro answer that stopped before its end: Claude Code and other clients retry an error. */
const KIRO_INCOMPLETE_ANSWER: KiroStreamError = {
  status: 502,
  type: "api_error",
  code: "kiro_stream_incomplete",
  message: "Kiro ended the answer before it was complete. Please retry.",
};

function kiroErrorChunk(error: KiroStreamError): Uint8Array {
  return TEXT_ENCODER.encode(`data: ${JSON.stringify({ error })}\n\n`);
}
const KIRO_DEFAULT_CONTEXT_WINDOW = 200000;

/** The client's `stop` / `max_tokens`, stashed by the request builder as `_clientLimits`. */
export type KiroClientLimits = { stop?: string[]; maxTokens?: number };

function readKiroClientLimits(body: unknown): KiroClientLimits | null {
  const raw = (body as JsonRecord | null | undefined)?._clientLimits as JsonRecord | undefined;
  if (!raw || typeof raw !== "object") return null;
  const stop = Array.isArray(raw.stop)
    ? raw.stop.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const maxTokens = typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? raw.maxTokens : 0;
  if (!stop.length && !maxTokens) return null;
  return { ...(stop.length ? { stop } : {}), ...(maxTokens ? { maxTokens } : {}) };
}

function kiroHistoryEntries(body: unknown): JsonRecord[] {
  const state = (body as JsonRecord | null | undefined)?.conversationState as
    JsonRecord | undefined;
  return Array.isArray(state?.history) ? (state.history as JsonRecord[]) : [];
}

/** True when the request sends earlier thinking back (assistantResponseMessage.reasoningContent). */
export function kiroHistoryHasReasoning(body: unknown): boolean {
  return kiroHistoryEntries(body).some(
    (h) => !!(h?.assistantResponseMessage as JsonRecord | undefined)?.reasoningContent
  );
}

/** Remove earlier thinking from the history (in place). */
export function stripKiroHistoryReasoning(body: unknown): void {
  for (const h of kiroHistoryEntries(body)) {
    const msg = h?.assistantResponseMessage as JsonRecord | undefined;
    if (msg && "reasoningContent" in msg) delete msg.reasoningContent;
  }
}

/**
 * Kiro ends every answer with a `metadataEvent` carrying its stop reason. A model refusal is
 * `{"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{"category":"CYBER"|
 * "REASONING_EXTRACTION"|...,"explanation":"The selected model cannot continue this
 * conversation. Please select a different model, ..."}}}` with no content frames at all
 * (seen live 2026-11-10 on Claude Opus 5.5 / Sonnet 5.5 / Opus 5).
 */
export function readKiroStopMetadata(payload: unknown): {
  stopReason: string;
  refused: boolean;
  category: string;
  explanation: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as JsonRecord;
  const stopReason = typeof p.stopReason === "string" ? p.stopReason.toUpperCase() : "";
  const details = p.stopDetails as JsonRecord | undefined;
  const refusal =
    details && typeof details === "object"
      ? (details.refusal as JsonRecord | undefined)
      : undefined;
  if (!stopReason && !refusal) return null;
  const category = refusal && typeof refusal.category === "string" ? refusal.category : "";
  const explanation = refusal && typeof refusal.explanation === "string" ? refusal.explanation : "";
  return {
    stopReason: stopReason || "CONTENT_FILTERED",
    refused: !!refusal || stopReason === "CONTENT_FILTERED",
    category,
    explanation,
  };
}

/**
 * Anthropic's `stop_details` for a refusal: `{type: "refusal", category, explanation}` with the
 * category in lower case ("cyber", "reasoning_extraction", ...) or null when there is none.
 */
export function kiroRefusalStopDetails(category: string, explanation: string): JsonRecord {
  return {
    type: "refusal",
    category: category ? category.toLowerCase() : null,
    explanation: explanation || null,
  };
}

/** Kiro stop reason → OpenAI finish_reason ("content_filter" becomes Claude's "refusal"). */
export function kiroFinishReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "CONTENT_FILTERED":
    case "GUARDRAIL_INTERVENED":
      return "content_filter";
    case "MAX_TOKENS":
    case "MAX_OUTPUT_TOKENS":
    case "LENGTH":
      return "length";
    default:
      return "stop";
  }
}

/**
 * The model to answer with when Kiro's model refuses a request outright. Kiro's own message says
 * "Please select a different model": the newest Claude models carry extra safeguards that refuse
 * some ordinary agent requests (for example Claude Code's auto-mode safety check, which asks for
 * a `<thinking>` section), while the model one step below answers them. Empty = no fallback.
 * `TROUTEAI_KIRO_REFUSAL_FALLBACK=0` switches this off (the refusal is then passed on as is).
 */
const KIRO_REFUSAL_FALLBACK: Record<string, string> = {
  "claude-opus-5.5": "claude-opus-4.8",
  "claude-opus-5": "claude-opus-4.8",
  "claude-sonnet-5.5": "claude-sonnet-5",
};

export function kiroRefusalFallbackModel(modelId: string): string {
  if (process.env.TROUTEAI_KIRO_REFUSAL_FALLBACK === "0") return "";
  return KIRO_REFUSAL_FALLBACK[modelId] || "";
}

function kiroCurrentModelId(body: Record<string, unknown> | undefined): string {
  const modelId = kiroCurrentUserMessage(body).modelId;
  return typeof modelId === "string" ? modelId : "";
}

/**
 * A Kiro answer that failed before any content (an EventStream exception first, or a stream
 * that ended with no answer and no stop reason) as a plain HTTP error in Kiro's own JSON shape,
 * so the request goes through the normal error path (retry, other account, next combo step)
 * instead of reaching the client as an empty 200 stream. Null when the answer started fine.
 */
function kiroFailureBeforeContent(
  peeked: { exception: KiroStreamError | null; empty: boolean },
  modelId: string,
  log?: ExecutorLog | null
): Response | null {
  const error = peeked.exception
    ? peeked.exception
    : peeked.empty
      ? { ...KIRO_INCOMPLETE_ANSWER, message: "Kiro ended the stream without an answer" }
      : null;
  if (!error) return null;
  log?.warn?.("KIRO", `${modelId} failed before answering: ${error.code} ${error.message}`);
  return new Response(JSON.stringify({ message: error.message, reason: error.code }), {
    status: error.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The SSE answer for a refusal with no output: an empty turn that stops with "content_filter". */
function kiroRefusalSseResponse(model: string, category = "", explanation = ""): Response {
  const base = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "content_filter",
          stop_details: kiroRefusalStopDetails(category, explanation),
        },
      ],
    },
  ];
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function kiroCurrentUserMessage(body: Record<string, unknown> | undefined): JsonRecord {
  const state = body?.conversationState as JsonRecord | undefined;
  const current = state?.currentMessage as JsonRecord | undefined;
  return (current?.userInputMessage as JsonRecord | undefined) || {};
}

function kiroThinkingDirectiveSent(body: Record<string, unknown> | undefined): boolean {
  const content = kiroCurrentUserMessage(body).content;
  return typeof content === "string" && content.includes("<thinking_mode>enabled</thinking_mode>");
}

function kiroBodyWithModel(
  body: Record<string, unknown> | undefined,
  fromModelId: string,
  toModelId: string
): string {
  return JSON.stringify(body)
    .split(`"modelId":${JSON.stringify(fromModelId)}`)
    .join(`"modelId":${JSON.stringify(toModelId)}`);
}

// Helper prompts that a model refused for REASONING_EXTRACTION, kept in memory for a while.
// Only single-shot requests without tools and history qualify (Claude Code's auto-mode safety
// check is one): their first 4 KB is the helper's own fixed instruction text, so the key never
// matches a normal conversation, whose requests always carry tools or history.
const KIRO_HELPER_REFUSAL_TTL_MS = 30 * 60_000;
const KIRO_HELPER_REFUSAL_MAX = 200;
const kiroHelperRefusals = new Map<string, number>();

/** The text of a history that is only [system turn, "(empty)"], else null. */
function kiroSplitSystemTurnText(history: unknown): string | null {
  if (!Array.isArray(history) || history.length !== 2) return null;
  const user = (history[0] as JsonRecord | undefined)?.userInputMessage as JsonRecord | undefined;
  const answer = (history[1] as JsonRecord | undefined)?.assistantResponseMessage as
    JsonRecord | undefined;
  if (!user || typeof user.content !== "string" || user.userInputMessageContext) return null;
  if (!answer || answer.content !== "(empty)" || answer.toolUses) return null;
  return user.content;
}

export function kiroHelperPromptKey(body: Record<string, unknown> | undefined): string {
  const state = body?.conversationState as JsonRecord | undefined;
  const history = state?.history;
  // A helper's system prompt is its own first turn ("(empty)" answer after it, see
  // splitSystemTurn in openai-to-kiro.ts); any other history means a real conversation.
  const systemTurn = kiroSplitSystemTurnText(history);
  if (Array.isArray(history) && history.length > 0 && systemTurn === null) return "";
  const user = kiroCurrentUserMessage(body);
  const context = user.userInputMessageContext as JsonRecord | undefined;
  if (Array.isArray(context?.tools) && context.tools.length > 0) return "";
  if (Array.isArray(context?.toolResults) && context.toolResults.length > 0) return "";
  // The request builder puts per-request lines first (the current time, a thinking directive).
  const content =
    systemTurn ??
    (typeof user.content === "string" ? user.content : "")
      .replace(/^(?:\[Context: Current time is [^\]\n]*\]|<thinking_mode>[^\n]*)\n\n/, "")
      .replace(/^(?:\[Context: Current time is [^\]\n]*\]|<thinking_mode>[^\n]*)\n\n/, "");
  const modelId = typeof user.modelId === "string" ? user.modelId : "";
  if (content.length < 4096 || !modelId) return "";
  return createHash("sha256")
    .update(modelId)
    .update("\n")
    .update(content.slice(0, 4096))
    .digest("hex");
}

function kiroHelperRefusalRemembered(key: string): boolean {
  const until = kiroHelperRefusals.get(key);
  if (!until) return false;
  if (until > Date.now()) return true;
  kiroHelperRefusals.delete(key);
  return false;
}

function rememberKiroHelperRefusal(key: string): void {
  if (kiroHelperRefusals.size >= KIRO_HELPER_REFUSAL_MAX) {
    const oldest = kiroHelperRefusals.keys().next().value;
    if (oldest !== undefined) kiroHelperRefusals.delete(oldest);
  }
  kiroHelperRefusals.set(key, Date.now() + KIRO_HELPER_REFUSAL_TTL_MS);
}

function forgetKiroHelperRefusal(key: string): void {
  kiroHelperRefusals.delete(key);
}

const KIRO_CONTENT_EVENTS = new Set([
  "assistantResponseEvent",
  "reasoningContentEvent",
  "toolUseEvent",
  "codeEvent",
]);
const KIRO_PEEK_LIMIT_BYTES = 256 * 1024;

/**
 * Read the start of a Kiro answer until it is clear whether the model refused before writing
 * anything. Returns the verdict and a Response that replays the bytes already read, so nothing
 * is lost and nothing is delayed (the first frame Kiro sends is content or the stop metadata).
 */
export async function peekKiroRefusal(response: Response): Promise<{
  refused: boolean;
  category: string;
  explanation: string;
  // An EventStream exception before any content, or a stream that ended with no answer at all:
  // the request failed before the client saw anything, so it can go to another account.
  exception: KiroStreamError | null;
  empty: boolean;
  response: Response;
}> {
  if (!response.body) {
    return {
      refused: false,
      category: "",
      explanation: "",
      exception: null,
      empty: false,
      response,
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const queue = new ByteQueue();
  let total = 0;
  let refused = false;
  let category = "";
  let explanation = "";
  let exception: KiroStreamError | null = null;
  let decided = false;
  let ended = false;
  try {
    while (!decided && total < KIRO_PEEK_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      if (!value) continue;
      chunks.push(value);
      total += value.length;
      queue.push(value);
      while (queue.length >= 16) {
        const len = queue.peekUint32BE(0);
        if (!len || len < 16 || len > queue.length) break;
        const frame = queue.read(len);
        if (!frame) break;
        const event = parseEventFrame(frame);
        if (!event) continue;
        const type = event.headers[":event-type"] || "";
        const messageType = event.headers[":message-type"] || "";
        if (messageType === "exception" || messageType === "error") {
          const p = event.payload as JsonRecord | undefined;
          const text =
            typeof p?.message === "string" ? p.message : event.headers[":error-message"] || "";
          exception = kiroStreamErrorOf(
            event.headers[":exception-type"] || event.headers[":error-code"] || "",
            text
          );
          decided = true;
          break;
        }
        if (KIRO_CONTENT_EVENTS.has(type)) {
          decided = true;
          break;
        }
        if (type === "metadataEvent") {
          const meta = readKiroStopMetadata(event.payload);
          if (meta) {
            decided = true;
            refused = meta.refused;
            category = meta.category;
            explanation = meta.explanation;
            break;
          }
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const empty = ended && !decided;

  // The caller cancels this replay when it asks another model or reports the failure.
  let index = 0;
  const replay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      if (ended) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else if (value) controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
  return {
    refused,
    category,
    explanation,
    exception,
    empty,
    response: new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

function ensureKiroUsage(state: KiroStreamState, model = "") {
  // Output estimate covers text, reasoning, code and tool calls (names + final args). Claude's
  // tokenizer makes about 2.5 characters a token (5.x), not 3.5 (config/claudeTokens.ts).
  const charsPerToken = claudeCharsPerToken(model);
  const contentLength = state.totalContentLength || 0;
  const estimatedOutputTokens =
    charsPerToken && contentLength > 0
      ? Math.max(1, Math.ceil(contentLength / charsPerToken))
      : estimateOutputTokens(contentLength);

  if (state.usage) {
    // Keep real metricsEvent counts; only backfill a missing output count.
    if (!state.usage.completion_tokens && estimatedOutputTokens > 0) {
      state.usage.completion_tokens = estimatedOutputTokens;
      state.usage.total_tokens = (state.usage.prompt_tokens || 0) + estimatedOutputTokens;
    }
    return;
  }

  // Kiro reports how full the model's window is, not a token count. Use the model's own
  // window (1M for Claude Opus/Sonnet 5.x): a fixed 200k reported a fifth of the real input,
  // so agents such as Claude Code never compacted in time. The share already includes this
  // answer, hidden thinking too (measured 2026-11-10: +1500 for a 3,460-character answer; a
  // 4000-token thinking budget filled exactly), so the input is that total minus the output.
  const windowTokens = state.contextWindowTokens || KIRO_DEFAULT_CONTEXT_WINDOW;
  const contextTokens =
    state.contextUsagePercentage && state.contextUsagePercentage > 0
      ? Math.floor((state.contextUsagePercentage * windowTokens) / 100)
      : 0;
  const estimatedInputTokens =
    contextTokens > 0 ? Math.max(0, contextTokens - estimatedOutputTokens) : 0;

  if (estimatedInputTokens <= 0 && estimatedOutputTokens <= 0) return;

  state.usage = {
    prompt_tokens: estimatedInputTokens,
    completion_tokens: estimatedOutputTokens,
    total_tokens: contextTokens > 0 ? contextTokens : estimatedOutputTokens,
  };
}

/**
 * Resolve the RUNTIME AWS region for a Kiro/CodeWhisperer connection.
 *
 * The runtime region is the region of the Amazon Q Developer profile (embedded in the
 * profileArn — always us-east-1 or eu-central-1), NOT the IAM Identity Center / OIDC token
 * region. An enterprise IdC instance may live in eu-north-1 (or any region), but the Q Developer
 * profile that serves generateAssistantResponse only exists in us-east-1 / eu-central-1, so a
 * runtime call must target the profileArn's region — routing to q.{idcRegion}.amazonaws.com
 * (a host that does not exist) is what caused "no limits + 502 on every request". Delegates to
 * the shared resolver (profileArn region → valid stored profile region → us-east-1). The IdC
 * token region is used only for oidc.{region} token mint/refresh, elsewhere.
 */
export function resolveKiroRegion(
  credentials: { providerSpecificData?: unknown } | null | undefined
): string {
  return resolveKiroRuntimeRegion(
    (credentials?.providerSpecificData || {}) as { region?: unknown; profileArn?: unknown }
  );
}

// Re-exported from the shared region module so existing importers (and tests) that pull
// kiroRuntimeHost from this executor keep working.
export { kiroRuntimeHost };

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor(providerId = "kiro") {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.kiro);
  }

  buildHeaders(credentials: ProviderCredentials, stream = true) {
    void stream;
    const authMethod =
      typeof credentials.providerSpecificData?.authMethod === "string"
        ? credentials.providerSpecificData.authMethod
        : undefined;
    const isApiKey = authMethod === "api_key";
    const token = isApiKey
      ? credentials.apiKey || credentials.accessToken
      : credentials.accessToken;

    const headers = {
      ...this.config.headers,
      // Kiro refuses requests without a current KiroIDE version in User-Agent (403 "This
      // version of Kiro is no longer supported").
      ...getKiroUserAgentHeaders(
        "streaming",
        getKiroMachineId(credentials.providerSpecificData, token)
      ),
      // Kiro IDE sends these on its chat client too: agent mode, and no use of the content
      // for service improvement (its setting when content collection is off).
      "x-amzn-kiro-agent-mode": "vibe",
      "x-amzn-codewhisperer-optout": "true",
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4(),
      "x-amzn-bedrock-cache-control": "enable",
      "anthropic-beta": "prompt-caching-2024-07-31",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      // Long-lived Kiro/CodeWhisperer API keys authenticate with `tokentype: API_KEY`.
      if (isApiKey) headers["tokentype"] = "API_KEY";

      // Enterprise / Microsoft Entra "Your organization" (external_idp) logins send an
      // org-IdP-issued access token. CodeWhisperer only binds it to the Amazon Q Developer
      // profile when the request carries `TokenType: EXTERNAL_IDP`; without it every call
      // returns `ValidationException: Invalid ARN <clientId>` (the service falls back to the
      // token's client id as the resource ARN). AWS SSO (Builder ID / IDC) and social tokens
      // must NOT send this header, so it is gated on the persisted authMethod.
      if (isExternalIdpAuthMethod(authMethod)) {
        headers[KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER] = KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE;
      }
    }

    return headers;
  }

  transformRequest(model: string, body: unknown, stream: boolean, credentials: unknown): unknown {
    void stream;
    void credentials;
    const b = body as Record<string, unknown>;

    // Kiro API is strict and rejects any unknown top-level fields (like 'tools', 'stream', 'model', etc.)
    // We only preserve the fields specifically built by the openai-to-kiro translator.
    const kiroPayload: Record<string, unknown> = {};
    if (b.conversationState !== undefined) kiroPayload.conversationState = b.conversationState;
    if (b.profileArn !== undefined) kiroPayload.profileArn = b.profileArn;
    if (b.inferenceConfig !== undefined) kiroPayload.inferenceConfig = b.inferenceConfig;
    // Thinking control: `additionalModelRequestFields` ({output_config.effort,
    // thinking:{type:"adaptive"}, max_tokens}) is a recognized top-level field on
    // GenerateAssistantResponse — it steers adaptive reasoning. Built by the
    // openai-to-kiro translator only when the request asked for thinking.
    if (b.additionalModelRequestFields !== undefined)
      kiroPayload.additionalModelRequestFields = b.additionalModelRequestFields;

    // Fallback: if somehow conversationState isn't there, return the rest without model
    // (for backward compatibility if something else bypasses the translator)
    if (!kiroPayload.conversationState) {
      const { model: _model, ...rest } = b;
      return rest;
    }

    return kiroPayload;
  }

  /**
   * The profileArn for this request. Current Kiro clients must send one on every call (400
   * "profileArn is required for this request."). Order: the stored profile, else the account's
   * profile from ListAvailableProfiles (looked up once per account and kept in memory, see
   * findKiroProfileArn), else Kiro IDE's fixed Builder ID / social profile.
   *
   * The looked-up profile is NOT written to the connection: one Q Developer profile is shared by
   * every account of an organization, and the Kiro import routes match an existing connection by
   * profileArn (findKiroConnectionByIdentity), so a stored shared profile would make a later
   * import overwrite another account.
   */
  async resolveRequestProfileArn(credentials: ProviderCredentials): Promise<string | undefined> {
    const psd = (credentials.providerSpecificData || {}) as Record<string, unknown>;
    const stored = typeof psd.profileArn === "string" ? psd.profileArn.trim() : "";
    if (stored) return stored;

    const isApiKey = psd.authMethod === "api_key";
    const found = isApiKey
      ? undefined
      : await findKiroProfileArn(credentials.accessToken, psd, {
          cacheKey: typeof credentials.connectionId === "string" ? credentials.connectionId : null,
        });
    return found || resolveKiroProfileArn(psd);
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response
   */
  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    upstreamExtraHeaders,
  }: ExecuteInput) {
    const profileArn = await this.resolveRequestProfileArn(credentials);
    // Route to the region-specific CodeWhisperer/Amazon Q endpoint. Enterprise IAM Identity
    // Center accounts (e.g. eu-central-1) are rejected by the default us-east-1 host; only the
    // regional endpoint accepts the region-bound token + profileArn. The region follows the
    // profile actually sent.
    const psd = (credentials.providerSpecificData || {}) as { region?: unknown };
    const region = resolveKiroRuntimeRegion({ region: psd.region, profileArn });
    const url = `${kiroRuntimeHost(region)}/generateAssistantResponse`;
    const headers = this.buildHeaders(credentials, stream);
    mergeUpstreamExtraHeaders(headers, upstreamExtraHeaders);
    const transformedBody = (await this.transformRequest(model, body, stream, credentials)) as
      Record<string, unknown> | undefined;
    if (profileArn && transformedBody?.conversationState) transformedBody.profileArn = profileArn;

    // A helper prompt (no tools, no history) that this model refused a moment ago for asking
    // it to write out its reasoning will be refused again: go to the fallback model directly
    // and save the refused round trip (about 5 s and a full prompt of credits each time).
    const helperKey = kiroHelperPromptKey(transformedBody);
    const knownRefusalFallback =
      helperKey && kiroHelperRefusalRemembered(helperKey)
        ? kiroRefusalFallbackModel(kiroCurrentModelId(transformedBody))
        : "";
    if (knownRefusalFallback) {
      const direct = await fetch(url, {
        method: "POST",
        headers,
        body: kiroBodyWithModel(
          transformedBody,
          kiroCurrentModelId(transformedBody),
          knownRefusalFallback
        ),
        signal,
      });
      if (direct.ok) {
        const tbDirect = transformedBody as Record<string, unknown>;
        const peekedDirect = await peekKiroRefusal(direct);
        const failedDirect = kiroFailureBeforeContent(peekedDirect, knownRefusalFallback, log);
        if (failedDirect) {
          await peekedDirect.response.body?.cancel().catch(() => {});
          return { response: failedDirect, url, headers, transformedBody };
        }
        // The answer comes from the fallback model, and says so (as the real API's `model`).
        const directResponse = this.transformEventStreamToSSE(
          peekedDirect.response,
          knownRefusalFallback,
          {
            thinkingExpected: kiroThinkingDirectiveSent(tbDirect),
            limits: readKiroClientLimits(body),
          }
        );
        directResponse.headers.set("x-trouteai-answering-model", knownRefusalFallback);
        return { response: directResponse, url, headers, transformedBody };
      }
      await direct.body?.cancel().catch(() => {});
      forgetKiroHelperRefusal(helperKey);
    }

    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    });

    // Earlier thinking whose signature Kiro did not issue (for example one written by another
    // provider of a combo) gets 400 THINKING_SIGNATURE_INVALID. Send once more without it.
    if (response.status === 400 && kiroHistoryHasReasoning(transformedBody)) {
      const errorText = await response
        .clone()
        .text()
        .catch(() => "");
      if (errorText.includes("THINKING_SIGNATURE_INVALID")) {
        await response.body?.cancel().catch(() => {});
        stripKiroHistoryReasoning(transformedBody);
        log?.warn?.(
          "KIRO",
          "Kiro did not accept the signature of earlier thinking; sending the request without it"
        );
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal,
        });
      }
    }

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    // A refusal before any output ("The selected model cannot continue this conversation.
    // Please select a different model"): ask the fallback model once, as Kiro suggests. Without
    // a fallback (or when it cannot be asked) the refusal goes to the client as a refusal stop.
    const sentModelId = kiroCurrentModelId(transformedBody);
    const fallbackModelId = kiroRefusalFallbackModel(sentModelId);
    // The model named in the answer: the fallback model when it answered (as the Messages API
    // reports the model that produced the message), else the requested one.
    let answeringModel = model;
    const peeked = await peekKiroRefusal(response);
    response = peeked.response;
    const failedBeforeContent = kiroFailureBeforeContent(peeked, sentModelId, log);
    if (failedBeforeContent) {
      await response.body?.cancel().catch(() => {});
      return { response: failedBeforeContent, url, headers, transformedBody };
    }
    if (fallbackModelId && peeked.refused) {
      await response.body?.cancel().catch(() => {});
      log?.warn?.(
        "KIRO",
        `${sentModelId} refused this request (${peeked.category || "content filtered"}); asking ${fallbackModelId} instead`
      );
      if (helperKey && peeked.category === "REASONING_EXTRACTION") {
        rememberKiroHelperRefusal(helperKey);
      }
      const retry = await fetch(url, {
        method: "POST",
        headers,
        body: kiroBodyWithModel(transformedBody, sentModelId, fallbackModelId),
        signal,
      });
      if (retry.ok) {
        response = retry;
        answeringModel = fallbackModelId;
      } else {
        // The fallback could not be asked (limit, model not on this plan, ...): the answer
        // stays what Kiro gave, a refusal. It must not become an error or a second charge.
        await retry.body?.cancel().catch(() => {});
        return {
          response: kiroRefusalSseResponse(model, peeked.category, peeked.explanation),
          url,
          headers,
          transformedBody,
        };
      }
    }

    // For Kiro, we need to transform the binary EventStream to SSE.
    // Create a TransformStream to convert binary to SSE text.
    //
    // When the user enabled thinking, Claude on Kiro streams its reasoning
    // **inline** as `<thinking>…</thinking>` blocks inside
    // `assistantResponseEvent.content` rather than as separate
    // `reasoningContentEvent` frames. We pass a hint so the transform stream
    // can split that inline reasoning into the OpenAI `delta.reasoning_content`
    // channel.
    const thinkingExpected = kiroThinkingDirectiveSent(transformedBody as Record<string, unknown>);
    const transformedResponse = this.transformEventStreamToSSE(response, answeringModel, {
      thinkingExpected,
      limits: readKiroClientLimits(body),
    });
    if (answeringModel !== model) {
      transformedResponse.headers.set("x-trouteai-answering-model", answeringModel);
    }

    return { response: transformedResponse, url, headers, transformedBody };
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream.
   * Using TransformStream instead of ReadableStream.pull() to avoid Workers timeout.
   *
   * @param response        Upstream raw fetch response (binary EventStream).
   * @param model           Logical model id (kept in OpenAI chunks for clients).
   * @param opts
   * @param opts.thinkingExpected  When true, scan inbound
   *   `assistantResponseEvent.content` for inline `<thinking>…</thinking>`
   *   blocks and split them into the OpenAI `delta.reasoning_content` channel.
   *   Required for Claude on Kiro when `<thinking_mode>enabled</thinking_mode>`
   *   is in the system prompt, because Kiro streams reasoning inline rather
   *   than as separate `reasoningContentEvent` frames.
   */
  transformEventStreamToSSE(
    response: Response,
    model: string,
    opts: { thinkingExpected?: boolean; limits?: KiroClientLimits | null } = {}
  ) {
    const thinkingExpected = !!opts.thinkingExpected;
    // The client's stop sequences and max_tokens, applied to the visible text (Kiro applies
    // neither).
    const stopList = (opts.limits?.stop || []).filter((x) => typeof x === "string" && x.length > 0);
    // Characters per token: about 2.5 on Claude 5.x (config/claudeTokens.ts), 4 otherwise.
    const maxChars =
      opts.limits?.maxTokens && opts.limits.maxTokens > 0
        ? Math.ceil(opts.limits.maxTokens * (claudeCharsPerToken(model) || 4))
        : 0;
    const gated = stopList.length > 0 || maxChars > 0;
    let heldText = "";
    let emittedChars = 0;
    let cut = false;
    let cutAt = 0;
    const buffer = new ByteQueue();
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state: KiroStreamState = {
      endDetected: false,
      finishEmitted: false,
      startEmitted: false,
      stopSeen: false,
      hasToolCalls: false,
      toolCallIndex: 0,
      seenToolIds: new Map(),
      toolArgsEmitted: new Map(),
      toolArgsBuffered: new Map(),
      hasReasoningContent: false,
      reasoningChunkCount: 0,
      thinking: thinkingExpected ? { thinkingMode: false, pendingTag: "" } : undefined,
      contextWindowTokens: getModelContextLimit("kiro", model) || KIRO_DEFAULT_CONTEXT_WINDOW,
    };

    type Sink = { enqueue: (chunk: Uint8Array) => void };
    const emitText = (controller: Sink, text: string) => {
      if (!text) return;
      const out: JsonRecord = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: chunkIndex === 0 ? { role: "assistant", content: text } : { content: text },
            finish_reason: null,
          },
        ],
      };
      chunkIndex++;
      controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(out)}\n\n`));
    };
    // Visible text goes through here. With limits it stops at the first stop sequence (holding
    // back a tail that may be the start of one) or at the max_tokens estimate.
    const writeText = (controller: Sink, text: string, final = false) => {
      if (!gated) {
        emitText(controller, text);
        return;
      }
      if (cut) return;
      const buf = heldText + text;
      heldText = "";
      let stopIdx = -1;
      let stopSeq = "";
      for (const seq of stopList) {
        const i = buf.indexOf(seq);
        if (i !== -1 && (stopIdx === -1 || i < stopIdx)) {
          stopIdx = i;
          stopSeq = seq;
        }
      }
      let out = stopIdx !== -1 ? buf.slice(0, stopIdx) : buf;
      if (stopIdx === -1 && !final) {
        let hold = 0;
        for (const seq of stopList) {
          for (let k = Math.min(seq.length - 1, buf.length); k > hold; k--) {
            if (buf.endsWith(seq.slice(0, k))) {
              hold = k;
              break;
            }
          }
        }
        if (hold > 0) {
          heldText = buf.slice(buf.length - hold);
          out = buf.slice(0, buf.length - hold);
        }
      }
      let hitMax = false;
      if (maxChars > 0 && emittedChars + out.length > maxChars) {
        out = out.slice(0, Math.max(0, maxChars - emittedChars));
        hitMax = true;
      }
      if (out) {
        emittedChars += out.length;
        state.totalContentLength = (state.totalContentLength || 0) + out.length;
        emitText(controller, out);
      }
      if (hitMax) state.stopReason = "MAX_TOKENS";
      else if (stopIdx !== -1) state.stopSequence = stopSeq;
      if (hitMax || stopIdx !== -1) {
        cut = true;
        cutAt = Date.now();
        heldText = "";
      }
    };
    // After a cut the rest of Kiro's answer is not needed: finish now and stop reading it.
    const finishEarly = (controller: TransformStreamDefaultController<Uint8Array>) => {
      if (!state.finishEmitted) {
        state.finishEmitted = true;
        ensureKiroUsage(state, model);
        const finishChunk = buildKiroFinishChunk(state, responseId, created, model, true);
        controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
      }
      controller.terminate();
    };

    const transformStream = new TransformStream(
      {
        async transform(chunk, controller) {
          if (state.finishEmitted) return;
          buffer.push(chunk);

          // Parse events from buffer
          let iterations = 0;
          const maxIterations = 1000;
          while (buffer.length >= 16 && iterations < maxIterations) {
            iterations++;
            const totalLength = buffer.peekUint32BE(0);

            if (!totalLength || totalLength < 16 || totalLength > buffer.length) break;

            const eventData = buffer.read(totalLength);
            if (!eventData) break;

            const event = parseEventFrame(eventData);
            if (!event) continue;

            // Emit a role-only start chunk on the FIRST successfully-parsed AWS
            // EventStream frame. CodeWhisperer sends framing/metadata events before
            // the first content token, and on large/agentic contexts the gap before
            // that first `assistantResponseEvent` can be many seconds. The backend
            // stream-readiness gate (ensureStreamReadiness) holds the ENTIRE response
            // from the client until it observes a useful SSE frame, so without an
            // early frame the client sees a frozen connection for that whole window
            // (up to STREAM_READINESS_TIMEOUT_MS — 180s as configured by VibeProxy),
            // then a burst — the "minutes instead of seconds, not streaming" symptom.
            // A role-only `chat.completion.chunk` is a non-ping structured payload, so
            // it satisfies hasStreamReadinessSignal and hands the stream off
            // immediately. Mirrors the early lifecycle frame other executors already
            // emit (Claude message_start / OpenAI response.created). The downstream
            // idle timeout still guards genuine post-start stalls.
            if (!state.startEmitted) {
              state.startEmitted = true;
              const startChunk: JsonRecord = {
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              };
              chunkIndex++;
              controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(startChunk)}\n\n`));
            }

            const eventType = event.headers[":event-type"] || "";

            // Every normal Kiro answer ends with metadataEvent + contextUsageEvent +
            // meteringEvent (40+ real answers, 2026-11-10). Count what arrives, and keep an
            // EventStream exception (`:message-type` exception/error), so an answer that ends
            // without a stop reason can be explained in the log.
            {
              const messageType = event.headers[":message-type"] || "";
              const key =
                messageType === "exception" || messageType === "error"
                  ? `${messageType}:${event.headers[":exception-type"] || event.headers[":error-code"] || "-"}`
                  : eventType || "-";
              state.frameCounts = state.frameCounts || {};
              state.frameCounts[key] = (state.frameCounts[key] || 0) + 1;
              if (messageType === "exception" || messageType === "error") {
                const p = event.payload as JsonRecord | undefined;
                const text =
                  typeof p?.message === "string"
                    ? p.message
                    : event.headers[":error-message"] || "";
                state.exception = `${key} ${String(text).slice(0, 200)}`.trim();
                // An exception before Kiro's stop reason ends an unfinished answer: send it to
                // the client as an error (Claude Code retries one) instead of a normal finish
                // with a cut-off answer, and stop reading.
                if (!state.stopReason && !cut && !state.finishEmitted) {
                  const exceptionType =
                    event.headers[":exception-type"] || event.headers[":error-code"] || "";
                  console.warn(
                    `[Kiro] ${model} answer stopped by ${state.exception}: frames ${JSON.stringify(state.frameCounts)}; sent to the client as an error`
                  );
                  state.finishEmitted = true;
                  controller.enqueue(kiroErrorChunk(kiroStreamErrorOf(exceptionType, text)));
                  controller.terminate();
                  return;
                }
              }
            }

            // Track total content length for token estimation
            if (!state.totalContentLength) state.totalContentLength = 0;
            if (!state.contextUsagePercentage) state.contextUsagePercentage = 0;

            // After a stop sequence / max_tokens cut only the closing usage frames matter;
            // they normally follow at once. Do not wait long for a model that keeps writing.
            if (cut && KIRO_CONTENT_EVENTS.has(eventType)) {
              if (Date.now() - cutAt > 2500) {
                finishEarly(controller);
                return;
              }
              continue;
            }

            // Native reasoning frames. Verified against the live CodeWhisperer
            // stream (2026-07): with adaptive thinking enabled (via
            // additionalModelRequestFields), Kiro streams reasoning as a dedicated
            // `reasoningContentEvent` frame carrying `{ text, signature }` — NOT
            // inline `<thinking>` tags and NOT `assistantResponseEvent`. Some
            // models/variants instead use a `reasoningText` object or a flat
            // `{ text }` (cf. javargasm/pi-kiro `src/event-parser.ts`). TRouteAI
            // had no handler for this event, so the reasoning was silently dropped;
            // route it to the OpenAI `reasoning_content` channel.
            {
              const rp = event.payload as Record<string, unknown> | undefined;
              const rt = rp?.reasoningText;
              if (eventType === "reasoningContentEvent" || rt !== undefined) {
                let nativeReasoning = "";
                if (rt && typeof rt === "object") {
                  const rto = rt as { text?: unknown; Text?: unknown };
                  nativeReasoning =
                    typeof rto.text === "string"
                      ? rto.text
                      : typeof rto.Text === "string"
                        ? rto.Text
                        : "";
                } else if (typeof rt === "string") {
                  nativeReasoning = rt;
                } else if (typeof rp?.text === "string") {
                  nativeReasoning = rp.text as string;
                }
                if (nativeReasoning) {
                  state.hasReasoningContent = true;
                  state.totalContentLength += nativeReasoning.length;
                  const reasoningDelta: JsonRecord =
                    (state.reasoningChunkCount ?? 0) === 0 && chunkIndex === 0
                      ? { role: "assistant", reasoning_content: nativeReasoning }
                      : { reasoning_content: nativeReasoning };
                  const chunk: JsonRecord = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: reasoningDelta, finish_reason: null }],
                  };
                  chunkIndex++;
                  state.reasoningChunkCount = (state.reasoningChunkCount ?? 0) + 1;
                  controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                // The reasoning block ends with one `{signature}` frame (measured 2026-11-10:
                // 740-1408 characters). It is passed on as `reasoning_signature` so a Claude
                // client gets `signature_delta` and can send the block back; Kiro checks it then
                // (a changed one gets 400 THINKING_SIGNATURE_INVALID). Only after reasoning text:
                // with thinking switched off (display "omitted") the client gets no thinking block.
                const signature =
                  typeof rp?.signature === "string"
                    ? rp.signature
                    : rt &&
                        typeof rt === "object" &&
                        typeof (rt as JsonRecord).signature === "string"
                      ? ((rt as JsonRecord).signature as string)
                      : "";
                if (signature && (state.reasoningChunkCount ?? 0) > 0) {
                  state.hasReasoningContent = true;
                  const chunk: JsonRecord = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      { index: 0, delta: { reasoning_signature: signature }, finish_reason: null },
                    ],
                  };
                  chunkIndex++;
                  controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                // Encrypted reasoning (`{redactedContent}`, the SDK's ReasoningContentEvent
                // shape): passed on as `reasoning_redacted` so a Claude client gets a
                // `redacted_thinking` block and sends it back; Kiro reads it from
                // `reasoningContent.redactedContent` in the history.
                const redacted =
                  typeof rp?.redactedContent === "string" ? (rp.redactedContent as string) : "";
                if (redacted) {
                  state.hasReasoningContent = true;
                  const chunk: JsonRecord = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      { index: 0, delta: { reasoning_redacted: redacted }, finish_reason: null },
                    ],
                  };
                  chunkIndex++;
                  controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                // Consume the reasoning frame (incl. signature-only) so it never
                // falls through to the content handlers below.
                continue;
              }
            }

            // Handle assistantResponseEvent
            if (eventType === "assistantResponseEvent") {
              const content =
                typeof event.payload?.content === "string" ? event.payload.content : "";
              if (!content) {
                continue;
              }
              // Raw length before the inline <thinking> split, so text and reasoning count once.
              // With client limits the text is counted as it is written (writeText).
              if (!gated) state.totalContentLength += content.length;

              if (thinkingExpected && state.thinking) {
                // Claude on Kiro emits reasoning inline as `<thinking>…</thinking>`
                // when `<thinking_mode>enabled</thinking_mode>` is in the system prompt.
                // Split it into the OpenAI `reasoning_content` channel so downstream
                // consumers see the same shape they would get from a native reasoning model.
                const thinkingState = state.thinking;
                splitInlineThinking(
                  thinkingState,
                  content,
                  (text) => writeText(controller, text),
                  (reasoning) => {
                    if (!reasoning) return;
                    if (gated)
                      state.totalContentLength = (state.totalContentLength || 0) + reasoning.length;
                    state.hasReasoningContent = true;
                    const reasoningDelta: JsonRecord =
                      (state.reasoningChunkCount ?? 0) === 0 && chunkIndex === 0
                        ? { role: "assistant", reasoning_content: reasoning }
                        : { reasoning_content: reasoning };
                    const chunk: JsonRecord = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: reasoningDelta,
                          finish_reason: null,
                        },
                      ],
                    };
                    chunkIndex++;
                    state.reasoningChunkCount = (state.reasoningChunkCount ?? 0) + 1;
                    controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                );
              } else {
                writeText(controller, content);
              }
            }

            // Handle codeEvent
            if (eventType === "codeEvent" && event.payload?.content) {
              if (!gated) state.totalContentLength += String(event.payload.content).length;
              writeText(controller, String(event.payload.content));
            }

            // Handle toolUseEvent
            if (eventType === "toolUseEvent" && event.payload) {
              state.hasToolCalls = true;
              const toolUse = event.payload;
              const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

              for (const singleToolUse of toolUses) {
                const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
                const toolName = singleToolUse.name || "";
                const toolInput = singleToolUse.input;

                let toolIndex;
                const isNewTool = !state.seenToolIds.has(toolCallId);

                if (isNewTool) {
                  toolIndex = state.toolCallIndex++;
                  state.seenToolIds.set(toolCallId, toolIndex);
                  state.totalContentLength += String(toolName).length;

                  const startChunk = {
                    id: responseId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                          tool_calls: [
                            {
                              index: toolIndex,
                              id: toolCallId,
                              type: "function",
                              function: {
                                name: toolName,
                                arguments: "",
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  chunkIndex++;
                  controller.enqueue(
                    TEXT_ENCODER.encode(`data: ${JSON.stringify(startChunk)}\n\n`)
                  );
                } else {
                  toolIndex = state.seenToolIds.get(toolCallId);
                }

                if (toolInput !== undefined) {
                  if (typeof toolInput === "string") {
                    // String-form payloads are already concatenable incremental deltas —
                    // emit immediately and track what we've sent.
                    state.totalContentLength += toolInput.length;
                    state.toolArgsEmitted.set(
                      toolCallId,
                      (state.toolArgsEmitted.get(toolCallId) || "") + toolInput
                    );

                    const argsChunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            tool_calls: [
                              {
                                index: toolIndex,
                                function: {
                                  arguments: toolInput,
                                },
                              },
                            ],
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    chunkIndex++;
                    controller.enqueue(
                      TEXT_ENCODER.encode(`data: ${JSON.stringify(argsChunk)}\n\n`)
                    );
                  } else if (typeof toolInput === "object" && toolInput !== null) {
                    // Object-form payloads are PARTIAL OBJECTS that grow over time. Buffer
                    // the latest canonical and flush once at a finish boundary, otherwise the
                    // overlapping JSON prefixes concatenate into unparseable garbage.
                    state.toolArgsBuffered.set(toolCallId, {
                      toolIndex,
                      canonical: JSON.stringify(toolInput),
                    });
                  }
                }
              }
            }

            // Kiro's stop reason (END_TURN, MAX_TOKENS, CONTENT_FILTERED + refusal details).
            if (eventType === "metadataEvent") {
              const meta = readKiroStopMetadata(event.payload);
              // After our own cut (stop sequence / max_tokens) that cut is the stop reason.
              if (meta && !cut) {
                state.stopReason = meta.stopReason;
                if (meta.refused) {
                  state.refusalDetails = kiroRefusalStopDetails(meta.category, meta.explanation);
                }
              }
            }

            // Handle messageStopEvent
            if (eventType === "messageStopEvent") {
              flushBufferedToolArgs(state, controller, { responseId, created, model });
              state.stopSeen = true;
            }

            // Handle contextUsageEvent to extract contextUsagePercentage
            if (eventType === "contextUsageEvent") {
              const contextUsage =
                typeof event.payload?.contextUsagePercentage === "number"
                  ? event.payload.contextUsagePercentage
                  : 0;
              if (contextUsage <= 0) {
                continue;
              }
              state.contextUsagePercentage = contextUsage;
              // Mark that we received context usage event
              state.hasContextUsage = true;
              if (cut) {
                finishEarly(controller);
                return;
              }
            }

            // Handle meteringEvent - mark that we received it
            if (eventType === "meteringEvent") {
              state.hasMeteringEvent = true;
            }

            // Handle metricsEvent for token usage
            if (eventType === "metricsEvent") {
              // Extract usage data from metricsEvent payload
              const metrics = event.payload?.metricsEvent || event.payload;
              if (metrics && typeof metrics === "object") {
                const inputTokens =
                  typeof (metrics as JsonRecord).inputTokens === "number"
                    ? ((metrics as JsonRecord).inputTokens as number)
                    : 0;
                const outputTokens =
                  typeof (metrics as JsonRecord).outputTokens === "number"
                    ? ((metrics as JsonRecord).outputTokens as number)
                    : 0;

                const cacheReadTokens =
                  typeof (metrics as JsonRecord).cacheReadTokens === "number"
                    ? ((metrics as JsonRecord).cacheReadTokens as number)
                    : 0;

                const cacheCreationTokens =
                  typeof (metrics as JsonRecord).cacheCreationTokens === "number"
                    ? ((metrics as JsonRecord).cacheCreationTokens as number)
                    : 0;

                if (inputTokens > 0 || outputTokens > 0) {
                  state.usage = {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                    ...(cacheReadTokens > 0 && { cache_read_input_tokens: cacheReadTokens }),
                    ...(cacheCreationTokens > 0 && {
                      cache_creation_input_tokens: cacheCreationTokens,
                    }),
                  };
                }
              }
            }
          }

          if (iterations >= maxIterations) {
            console.warn("[Kiro] Max iterations reached in event parsing");
          }
        },

        flush(controller) {
          // Flush any buffered tool arguments (partial-object payloads) before finishing —
          // idempotent against toolArgsEmitted if messageStopEvent already flushed them.
          flushBufferedToolArgs(state, controller, { responseId, created, model });

          // Drain any pending inline-thinking tag fragment so we don't drop
          // trailing characters when the stream ends mid-tag (e.g. `<thi`).
          if (thinkingExpected && state.thinking) {
            const thinkingState = state.thinking;
            flushPendingThinking(
              thinkingState,
              (text) => writeText(controller, text),
              (reasoning) => {
                if (!reasoning) return;
                const chunk: JsonRecord = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    { index: 0, delta: { reasoning_content: reasoning }, finish_reason: null },
                  ],
                };
                chunkIndex++;
                controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            );
          }

          // Text held back as a possible start of a stop sequence that never completed.
          if (gated && !cut) writeText(controller, "", true);

          // Already finished early (stop sequence / max_tokens): nothing more to send.
          if (state.finishEmitted) return;

          // No stop reason and none of Kiro's closing frames: the answer was cut off (seen on
          // long Opus 5.5 answers, 6 in 7,800 on 2026-11-10). A normal finish would hand the
          // client half an answer as complete (Claude Code then ends its turn); an error makes
          // it retry.
          if (!cut && !kiroAnswerClosed(state)) {
            console.warn(
              `[Kiro] ${model} answer ended without a stop reason: frames ${JSON.stringify(state.frameCounts || {})}` +
                `, reasoning ${state.reasoningChunkCount || 0} chunks, tool calls ${state.hasToolCalls ? "yes" : "no"}` +
                (state.exception ? `, exception ${state.exception}` : "") +
                "; sent to the client as an error"
            );
            state.finishEmitted = true;
            controller.enqueue(kiroErrorChunk(KIRO_INCOMPLETE_ANSWER));
            return;
          }

          if (!state.stopReason) {
            console.warn(
              `[Kiro] ${model} answer ended without a stop reason: frames ${JSON.stringify(state.frameCounts || {})}` +
                `, reasoning ${state.reasoningChunkCount || 0} chunks, tool calls ${state.hasToolCalls ? "yes" : "no"}` +
                (state.exception ? `, exception ${state.exception}` : "")
            );
          }

          // Emit the finish chunk
          state.finishEmitted = true;
          ensureKiroUsage(state, model);
          const finishChunk = buildKiroFinishChunk(state, responseId, created, model, true);
          controller.enqueue(TEXT_ENCODER.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));

          // Send final done message
          controller.enqueue(TEXT_ENCODER.encode("data: [DONE]\n\n"));
        },
      },
      { highWaterMark: 16384 },
      { highWaterMark: 16384 }
    );

    // Pipe response body through transform stream
    const transformedStream = response.body.pipeThrough(transformStream);

    return new Response(transformedStream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  async refreshCredentials(credentials: ProviderCredentials, log?: ExecutorLog | null) {
    if (credentials.providerSpecificData?.authMethod === "api_key") return null;
    if (!credentials.refreshToken) return null;

    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log
      );

      if (!result || result.error) return result;

      // If client was re-registered (expired/invalid clientId/clientSecret after DB import,
      // TTL expiry, or browser conflict), update providerSpecificData with new credentials.
      if (result._newClientId) {
        const updatedPsd = {
          ...(credentials.providerSpecificData || {}),
          clientId: result._newClientId,
          clientSecret: result._newClientSecret,
          clientSecretExpiresAt: result._newClientSecretExpiresAt,
        };
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
          providerSpecificData: updatedPsd,
        };
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log?.error?.("TOKEN", `Kiro refresh error: ${err.message}`);
      return null;
    }
  }
}

export default KiroExecutor;
