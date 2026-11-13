import { CORS_HEADERS } from "@/shared/utils/cors";
import { v1CountTokensSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { countTextTokens, type TokenizerContext } from "@/shared/utils/tiktokenCounter";
import { getExecutor } from "@trouteai/open-sse/executors/index.ts";
import { runWithProxyContext } from "@trouteai/open-sse/utils/proxyFetch.ts";
import {
  claudeTokensFromCl100k,
  kiroRequestOverheadTokens,
} from "@trouteai/open-sse/config/claudeTokens.ts";
import { getComboByName } from "@/lib/db/combos";
import { getComboModelString } from "@/lib/combos/steps";
import { getModelInfo } from "@/sse/services/model";
import { extractApiKey, getProviderCredentials, isValidApiKey } from "@/sse/services/auth";
import { safeResolveProxy } from "@/sse/handlers/chatHelpers";
import * as log from "@/sse/utils/logger";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * POST /v1/messages/count_tokens - Hybrid token count response.
 * Uses real provider-side count when supported, falling back to estimation.
 */
export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const validation = validateBody(v1CountTokensSchema, rawBody);
  if (isValidationFailure(validation)) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const body = validation.data;

  const tokenizerContext: TokenizerContext = {
    model: typeof body.model === "string" ? body.model : undefined,
  };
  const requestedModel = typeof body.model === "string" ? body.model : "";
  if (!requestedModel) {
    return buildEstimatedCountResponse(body, tokenizerContext);
  }

  try {
    const modelInfo = await resolveCountTarget(requestedModel);
    const estimated = buildEstimatedCountResponse(body, tokenizerContext, modelInfo);
    if (!modelInfo?.provider || !modelInfo?.model) {
      return estimated;
    }
    // Kiro has no count endpoint: the estimate is all there is (no account is picked for it).
    if (modelInfo.provider === "kiro") {
      return estimated;
    }

    // A model whose provider has no account here (for example a bare `claude-...` name that
    // parses as `anthropic/...`) only means "estimate", not a warning.
    const credentials = await getProviderCredentials(
      modelInfo.provider,
      null,
      null,
      modelInfo.model,
      { quietMissing: true }
    );
    if (!credentials || credentials.allRateLimited) {
      return estimated;
    }

    const executor = await getExecutor(modelInfo.provider);
    // The provider-side count is a real upstream call — it must honor the
    // connection's proxy assignment exactly like chat execution does.
    const proxyInfo = await safeResolveProxy(
      credentials.connectionId,
      undefined,
      modelInfo.provider
    );
    const counted = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      executor?.countTokens?.({
        model: modelInfo.model,
        body,
        credentials,
        log,
      })
    );

    if (!counted || !Number.isFinite(counted.input_tokens)) {
      return estimated;
    }

    return new Response(
      JSON.stringify({
        input_tokens: counted.input_tokens,
        model: modelInfo.model,
        provider: modelInfo.provider,
        source: counted.source || "provider",
      }),
      {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      }
    );
  } catch (error) {
    log.debug(
      "COUNT_TOKENS",
      `Falling back to estimate for ${requestedModel}: ${error instanceof Error ? error.message : String(error)}`
    );
    return buildEstimatedCountResponse(body, tokenizerContext);
  }
}

type CountTarget = { provider?: string | null; model?: string | null } | null;

/**
 * The provider/model a count is for. A combo name ("claude-opus-5-5") counts as its first
 * switched-on model step, so the estimate uses that model's tokenizer.
 */
async function resolveCountTarget(requestedModel: string): Promise<CountTarget> {
  const combo = await getComboByName(requestedModel).catch(() => null);
  const steps = Array.isArray(combo?.models) ? (combo.models as unknown[]) : [];
  for (const step of steps) {
    if (step && typeof step === "object" && (step as { enabled?: unknown }).enabled === false) {
      continue;
    }
    const model = getComboModelString(step);
    if (!model) continue;
    const info = await getModelInfo(model);
    if (info?.provider && info?.model) return info;
  }
  return getModelInfo(requestedModel);
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

function buildEstimatedCountResponse(
  body,
  tokenizerContext: TokenizerContext = {},
  target: CountTarget = null
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
  // of a short request's tokens); they were not counted before.
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
  // 5.x, 1.22x on Sonnet 4.5/4.6, measured against Kiro); Kiro adds its own instructions.
  const model = target?.model || tokenizerContext.model || "";
  inputTokens = claudeTokensFromCl100k(model, inputTokens);
  if (target?.provider === "kiro") inputTokens += kiroRequestOverheadTokens(model);

  return new Response(
    JSON.stringify({
      input_tokens: inputTokens,
      source: "local",
    }),
    {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    }
  );
}
