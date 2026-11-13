/**
 * One input-token estimate for a request, used everywhere TRouteAI decides whether a request
 * fits a model (combo gate, auto strategy, the per-target check in chatCore), so they never
 * disagree.
 *
 * It counts what the provider counts: the conversation, the system prompt / instructions,
 * tools and the response format. Reasoning from earlier turns is left out: Anthropic drops
 * previous assistant thinking blocks from the context window (and the Kiro translator does
 * not resend them at all). Counting them made long Claude Code sessions (hundreds of thinking
 * blocks with signatures) look several times bigger than they were. Reasoning of the turn in
 * progress (after the last real user message, e.g. during a tool loop) is kept.
 *
 * The count is characters / 4 of the JSON (contextManager.estimateTokens, which also gives
 * images a bounded size), so callers compare it with a tolerance
 * (utils/contextOverflowError.ts).
 */

import { estimateTokens } from "./contextManager.ts";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);

const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
const TOOL_RESULT_TYPES = new Set(["tool_result", "function_call_output"]);

// An empty array/object (e.g. a default `messages: []` some entrypoints inject) has no real
// content; counting its brackets would charge phantom tokens.
export function hasEstimableContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** A user message the person typed (not one that only carries tool results). */
function isRealUserTurn(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  const content = message.content ?? message.parts;
  if (!Array.isArray(content)) return true;
  return content.some(
    (part) =>
      !isRecord(part) ||
      (!TOOL_RESULT_TYPES.has(String(part.type)) && !("functionResponse" in part))
  );
}

function withoutReasoning(message: JsonRecord): JsonRecord | null {
  // Responses API: reasoning items sit directly in `input[]`.
  if (THINKING_BLOCK_TYPES.has(String(message.type))) return null;
  let next = message;
  if ("reasoning_content" in next || "reasoning" in next) {
    const { reasoning_content: _rc, reasoning: _r, ...rest } = next;
    next = rest;
  }
  for (const key of ["content", "parts"] as const) {
    const parts = next[key];
    if (!Array.isArray(parts)) continue;
    const kept = parts.filter(
      (part) =>
        !(isRecord(part) && (THINKING_BLOCK_TYPES.has(String(part.type)) || part.thought === true))
    );
    if (kept.length !== parts.length) next = { ...next, [key]: kept };
  }
  return next;
}

/** The conversation without the reasoning of earlier turns. */
export function withoutHistoricalReasoning(messages: unknown): unknown {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  let currentTurnStart = messages.length - 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserTurn(messages[i])) {
      currentTurnStart = i;
      break;
    }
  }
  return messages
    .map((message, index) =>
      index >= currentTurnStart || !isRecord(message) ? message : withoutReasoning(message)
    )
    .filter((message) => message !== null);
}

/** Estimated input tokens of a chat request in any supported format. */
export function estimateRequestInputTokens(body: unknown): number {
  if (!isRecord(body)) return 0;
  const request = isRecord(body.request) ? body.request : null; // Antigravity envelope
  const conversation = [body.messages, body.input, body.contents, request?.contents].find(
    hasEstimableContent
  );
  const payload: JsonRecord = {};
  if (conversation !== undefined) payload.conversation = withoutHistoricalReasoning(conversation);
  for (const [key, value] of Object.entries({
    system: body.system,
    instructions: body.instructions,
    systemInstruction: body.systemInstruction ?? request?.systemInstruction,
    tools: body.tools ?? request?.tools,
    functions: body.functions,
    response_format: body.response_format,
  })) {
    if (hasEstimableContent(value)) payload[key] = value;
  }
  return Object.keys(payload).length > 0 ? estimateTokens(payload) : 0;
}
