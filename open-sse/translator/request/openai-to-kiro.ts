/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../registry.ts";
import { FORMATS } from "../formats.ts";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { capMaxOutputTokens, capThinkingBudget } from "@/lib/modelCapabilities";
import {
  parseToolInput,
  normalizeKiroToolSchema,
  serializeToolResultContent,
} from "./openai-to-kiro/messageHelpers.ts";
import {
  kiroEffortForModel,
  resolveKiroModelAlias,
  supportsKiroAdaptiveThinking,
} from "./openai-to-kiro/adaptiveThinking.ts";

/**
 * Anthropic's direct-provider `[1m]` context-1m beta suffix. Kiro is AWS
 * Bedrock-backed and does not honor it, so forwarding a `kr/*` model id that
 * carries `[1m]` produces a malformed upstream model id at Bedrock.
 */
export const KIRO_UNSUPPORTED_CONTEXT_1M_SUFFIX = "[1m]";
export const KIRO_UNSUPPORTED_CONTEXT_1M_MESSAGE =
  "[kr/*] '[1m]' suffix is not supported by Kiro upstream. Kiro is AWS " +
  "Bedrock-backed and does not honor Anthropic's context-1m beta. Use a " +
  "direct-Anthropic provider for 1M-context routing.";

/**
 * Kiro is AWS Bedrock-backed, so Anthropic's direct-provider `[1m]` context
 * beta cannot be forwarded as part of a `kr/*` model id.
 */
export function hasUnsupportedKiroContextSuffix(model: unknown): boolean {
  return (
    typeof model === "string" && model.toLowerCase().includes(KIRO_UNSUPPORTED_CONTEXT_1M_SUFFIX)
  );
}

/**
 * Wrap system-prompt content in <system-reminder> tags before it is merged into
 * a Kiro user message. Kiro/CodeWhisperer has no `system` role, so without this
 * the system prompt would appear as raw user text.
 */
function wrapSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * Convert OpenAI messages to Kiro format
 * Rules: system/tool/user -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model) {
  let history = [];
  let currentMessage = null;

  // Kiro caches a prompt prefix up to a message boundary (measured 2026-11-10 with a 140 KB
  // prompt sent again: 47% fewer credits on Sonnet 5, 66-72% on Opus 5.5). A system prompt in a
  // request without earlier turns (Claude Code's auto-mode check, session titles, a subagent's
  // first call) used to land in the current message together with the question and the time
  // line, so it was never cached. As its own first turn it is, whatever the question.
  const firstNonSystem = Array.isArray(messages)
    ? messages.findIndex((m) => m?.role !== "system")
    : -1;
  // Every request with a system prompt gets it as its own first turn (measured 2026-11-10,
  // kiro-session-cache-probe.mts: a session's second call then reuses the first call's cached
  // system prompt, 0.075 instead of 0.135 credits on Sonnet 5; before, only calls without an
  // assistant turn were split). TROUTEAI_KIRO_SPLIT_SYSTEM=first restores the old rule.
  const splitSystemTurn =
    firstNonSystem > 0 &&
    (process.env.TROUTEAI_KIRO_SPLIT_SYSTEM !== "first" ||
      !messages.some((m) => m?.role === "assistant"));
  if (splitSystemTurn) {
    messages = [
      ...messages.slice(0, firstNonSystem),
      { role: "assistant", content: "(empty)" },
      ...messages.slice(firstNonSystem),
    ];
  }

  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages: Array<{ format: string; source: { bytes: string } }> = [];
  // Earlier reasoning for the next assistant history entry: signed text, or Kiro's encrypted
  // (redacted) reasoning.
  let pendingReasoning: { text: string; signature: string } | { redacted: string } | null = null;
  let currentRole = null;
  let toolsAttached = false;

  // Only Claude models support images in Kiro. Kiro also routes non-Claude
  // models (deepseek, minimax, glm, qwen3-coder-next) that do not accept image
  // attachments — gate image extraction behind a Claude check so we never
  // attach images those models would reject.
  const supportsImages = typeof model === "string" && model.toLowerCase().includes("claude");

  const flushPending = () => {
    if (currentRole === "user") {
      // Kiro accepts an empty user `content` when the turn carries toolResults or
      // images (the agentic tool-loop case), so the "(empty)" placeholder is only
      // needed for a genuinely bare turn. Without this check, a trailing
      // tool-result-only turn (no follow-up user text) would get the literal
      // "(empty)" injected as if the user had typed it, which can confuse Kiro.
      //  for the same bug class.
      const text = pendingUserContent.join("\n\n").trim();
      const hasContext = pendingToolResults.length > 0 || pendingImages.length > 0;
      const content = text || (hasContext ? "" : "(empty)");
      const userMsg: {
        userInputMessage: {
          content: string;
          modelId: string;
          images?: Array<{ format: string; source: { bytes: string } }>;
          origin: string;
          userInputMessageContext?: {
            toolResults?: Array<Record<string, unknown>>;
            tools?: Array<Record<string, unknown>>;
          };
        };
      } = {
        userInputMessage: {
          content: content,
          modelId: "",
          origin: "AI_EDITOR",
        },
      };

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        };
      }

      // Attach images to userInputMessage (NOT userInputMessageContext)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      // Add tools to the first emitted user turn. We track a flag instead of
      // relying on `history.length === 0` because the first few messages may
      // be assistant turns (e.g. when role=undefined collapses to a prior
      // assistant turn), in which case the first user flush would already see
      // a non-empty history and lose the tools schema.
      if (tools && tools.length > 0 && !toolsAttached) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        // Kiro API rejects requests with tool descriptions > ~10000 chars.
        // Move long descriptions to system prompt (same approach as kiro-gateway).
        const TOOL_DESC_MAX = 10000;
        const toolDocs: string[] = [];
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map((t) => {
          const name = t.function?.name || t.name;
          let description = t.function?.description || t.description || "";

          if (!description.trim()) {
            description = `Tool: ${name}`;
          }

          if (description.length > TOOL_DESC_MAX) {
            toolDocs.push(`## Tool: ${name}\n\n${description}`);
            description = `[Full documentation in system prompt under '## Tool: ${name}']`;
          }

          return {
            toolSpecification: {
              name,
              description,
              inputSchema: {
                json: normalizeKiroToolSchema(
                  t.function?.parameters || t.parameters || t.input_schema || {}
                ),
              },
            },
          };
        });
        // The long descriptions go into this first user turn: the system prompt's own turn when
        // there is one (the descriptions point there), which stays the same for the whole
        // session, so Kiro caches it. They used to ride on the current message only and were
        // lost in every conversation with history (Claude Code's Bash tool: 10,748 characters).
        if (toolDocs.length > 0) {
          userMsg.userInputMessage.content = `${userMsg.userInputMessage.content}\n\n# Tool Documentation\n\n${toolDocs.join("\n\n---\n\n")}`;
        }
        toolsAttached = true;
      }

      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "(empty)";
      // Earlier thinking goes back with its signature, in the shape of AWS's CodeWhisperer
      // AssistantResponseMessage.reasoningContent (one per message). Kiro checks the signature
      // and hands the block to the model (measured 2026-11-10).
      const assistantMsg = {
        assistantResponseMessage: {
          content: content,
          ...(pendingReasoning
            ? {
                reasoningContent:
                  "redacted" in pendingReasoning
                    ? { redactedContent: pendingReasoning.redacted }
                    : { reasoningText: pendingReasoning },
              }
            : {}),
        },
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
      pendingReasoning = null;
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role;

    // Normalize: system/tool -> user
    if (role === "system" || role === "tool") {
      role = "user";
    }

    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;

    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((c) => c.type === "text" || c.text)
          .map((c) => c.text || "");
        content = textParts.join("\n");

        // Extract images (OpenAI image_url and Anthropic image formats).
        // Skip entirely for models that do not support images — see supportsImages.
        for (const block of msg.content) {
          if (supportsImages && block.type === "image_url") {
            const url: string = block.image_url?.url || "";
            if (url.startsWith("data:")) {
              // data:image/jpeg;base64,<data>
              const [header, bytes] = url.split(",", 2);
              const mediaType = header.split(";")[0].replace("data:", ""); // e.g. "image/jpeg"
              const format = mediaType.split("/")[1] || "jpeg";
              if (bytes) pendingImages.push({ format, source: { bytes } });
            }
          } else if (supportsImages && block.type === "image" && block.source?.type === "base64") {
            const format = (block.source.media_type || "image/jpeg").split("/")[1] || "jpeg";
            if (block.source.data)
              pendingImages.push({ format, source: { bytes: block.source.data } });
          } else if (supportsImages && block.type === "image" && typeof block.image === "string") {
            // AI SDK-style image part: { type: "image", image: "data:...;base64,..." }
            const url = block.image;
            if (url.startsWith("data:")) {
              const [header, bytes] = url.split(",", 2);
              const mediaType = header.split(";")[0].replace("data:", "");
              const format = mediaType.split("/")[1] || "jpeg";
              if (bytes) pendingImages.push({ format, source: { bytes } });
            }
          }
        }

        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter((c) => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach((block) => {
            const text = serializeToolResultContent(block.content);
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: block.is_error ? "error" : "success",
              content: [{ text: text }],
            });
          });
        }
      }

      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        // Reuse the shared serializer so non-string content (arrays, structured/JSON
        // blocks, images) is never collapsed to an empty string. CodeWhisperer rejects a
        // toolResult whose content is [{ text: "" }] with 400 "Improperly formed request"
        // — the same failure mode that hit the Anthropic tool_result path.
        const toolContent = serializeToolResultContent(msg.content);
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: "success",
          content: [{ text: toolContent }],
        });
      } else if (content) {
        // Kiro/CodeWhisperer has no `system` role, so system messages are
        // normalized to `user`. Wrap their content in <system-reminder> tags so
        // the model can tell the system prompt apart from real user input instead
        // of treating the full Claude Code prompt as something the user typed.
        pendingUserContent.push(msg.role === "system" ? wrapSystemReminder(content) : content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];

      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((c) => c.type === "text");
        textContent = textBlocks
          .map((b) => b.text)
          .join("\n")
          .trim();

        const toolUseBlocks = msg.content.filter((c) => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }

      // Signed thinking from an earlier Kiro answer (claude -> openai keeps it only for Kiro).
      // Unsigned reasoning is not sent: Kiro answers 400 "thinking.signature: Field required".
      // TROUTEAI_KIRO_SEND_THINKING=0 switches this off (the behaviour before 2026-11-10).
      if (
        !pendingReasoning &&
        process.env.TROUTEAI_KIRO_SEND_THINKING !== "0" &&
        typeof msg.reasoning_signature === "string" &&
        msg.reasoning_signature !== ""
      ) {
        pendingReasoning = {
          text: typeof msg.reasoning_content === "string" ? msg.reasoning_content : "",
          signature: msg.reasoning_signature,
        };
      } else if (
        !pendingReasoning &&
        process.env.TROUTEAI_KIRO_SEND_THINKING !== "0" &&
        typeof msg.reasoning_redacted === "string" &&
        msg.reasoning_redacted !== ""
      ) {
        pendingReasoning = { redacted: msg.reasoning_redacted };
      }

      if (textContent) {
        pendingAssistantContent.push(textContent);
      }

      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }

        // Flush to create assistant message with toolUses
        flushPending();

        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          const NAMESPACE_KIRO_TOOLUSE = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
          lastMsg.assistantResponseMessage.toolUses = toolUses.map((tc, idx) => {
            if (tc.function) {
              const stableId =
                tc.id || uuidv5(`${tc.function.name}:${idx}`, NAMESPACE_KIRO_TOOLUSE);
              return {
                toolUseId: stableId,
                name: tc.function.name,
                input: parseToolInput(tc.function.arguments),
              };
            } else {
              const stableId = tc.id || uuidv5(`${tc.name}:${idx}`, NAMESPACE_KIRO_TOOLUSE);
              return {
                toolUseId: stableId,
                name: tc.name,
                input: parseToolInput(tc.input),
              };
            }
          });
        }

        currentRole = null;
      }
    }
  }

  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }

  // Kiro requires currentMessage to be a user turn. If the request ends with a
  // user turn, move that final turn into currentMessage. If it ends with an
  // assistant/tool turn, synthesize a neutral filler ("...") instead of the
  // literal "Continue", which Kiro can read as a real instruction.
  if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentMessage = history.pop();
  } else {
    currentMessage = {
      userInputMessage: {
        content: "...",
        modelId: model,
      },
    };
  }

  // Promote the tools schema to currentMessage. Tools may have been attached
  // to any user turn in history (e.g. when the first message was assistant or
  // had an undefined role, the first user flush lands further down). Scan the
  // whole history so we never lose the schema.
  if (!currentMessage?.userInputMessage?.userInputMessageContext?.tools) {
    const carrier = history.find((item) => item?.userInputMessage?.userInputMessageContext?.tools);
    if (carrier?.userInputMessage?.userInputMessageContext?.tools) {
      if (!currentMessage.userInputMessage.userInputMessageContext) {
        currentMessage.userInputMessage.userInputMessageContext = {};
      }
      currentMessage.userInputMessage.userInputMessageContext.tools =
        carrier.userInputMessage.userInputMessageContext.tools;
    }
  }

  // Fallback: if the schema was never attached to any user turn (e.g. the
  // input contained no user messages and currentMessage is a synthesized
  // neutral-filler turn), attach the provided tools directly to currentMessage so
  // Kiro still sees the schema it needs to validate assistant.toolUses in
  // history.
  if (
    !toolsAttached &&
    tools &&
    tools.length > 0 &&
    !currentMessage?.userInputMessage?.userInputMessageContext?.tools
  ) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools.map((t) => {
      const name = t.function?.name || t.name;
      const description = t.function?.description || t.description || `Tool: ${name}`;
      return {
        toolSpecification: {
          name,
          description,
          inputSchema: {
            json: normalizeKiroToolSchema(
              t.function?.parameters || t.parameters || t.input_schema || {}
            ),
          },
        },
      };
    });
    toolsAttached = true;
  }

  // Clean up history for Kiro API compatibility
  history.forEach((item) => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }

    if (
      item.userInputMessage?.userInputMessageContext &&
      Object.keys(item.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete item.userInputMessage.userInputMessageContext;
    }

    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }

    // Kiro API requires `origin` on every userInputMessage
    if (item.userInputMessage && !item.userInputMessage.origin) {
      item.userInputMessage.origin = "AI_EDITOR";
    }
  });

  // Kiro expects history to alternate between user and assistant turns. After
  // normalizing `system`/`tool` roles into `userInputMessage`, the history can
  // contain adjacent user turns, which Kiro can reject. Merge consecutive
  // `userInputMessage` entries by concatenating their content and preserving
  // any attached `userInputMessageContext` (e.g. accumulated toolResults).
  //
  // Why this is not redundant with the `flushPending` grouping in the main
  // loop: the assistant branch resets `currentRole = null` after emitting
  // `toolUses`. Any following `tool` role (normalized to user) and a
  // subsequent `user` role therefore each open their own flush, producing
  // two adjacent `userInputMessage` entries in history. This pass collapses
  // those.
  const mergedHistory: typeof history = [];
  for (const item of history) {
    const previous = mergedHistory[mergedHistory.length - 1];
    if (item.userInputMessage && previous?.userInputMessage) {
      const previousContent = previous.userInputMessage.content || "";
      const currentContent = item.userInputMessage.content || "";
      previous.userInputMessage.content = previousContent
        ? `${previousContent}\n\n${currentContent}`
        : currentContent;

      if (item.userInputMessage.userInputMessageContext) {
        const previousContext = previous.userInputMessage.userInputMessageContext || {};
        const nextContext = item.userInputMessage.userInputMessageContext;
        const mergedContext: Record<string, unknown> = { ...previousContext };

        for (const [key, value] of Object.entries(nextContext)) {
          const existing = (previousContext as Record<string, unknown>)[key];
          if (Array.isArray(existing) && Array.isArray(value)) {
            mergedContext[key] = [...existing, ...value];
          } else {
            mergedContext[key] = value;
          }
        }

        previous.userInputMessage.userInputMessageContext = mergedContext;
      }
    } else if (item.assistantResponseMessage && previous?.assistantResponseMessage) {
      // Kiro API also rejects consecutive assistant messages. Merge them.
      const previousContent = previous.assistantResponseMessage.content || "";
      const currentContent = item.assistantResponseMessage.content || "";
      previous.assistantResponseMessage.content = previousContent
        ? `${previousContent}\n\n${currentContent}`
        : currentContent;

      if (item.assistantResponseMessage.toolUses) {
        const existingToolUses = previous.assistantResponseMessage.toolUses || [];
        previous.assistantResponseMessage.toolUses = [
          ...existingToolUses,
          ...item.assistantResponseMessage.toolUses,
        ];
      }
      // One reasoningContent per message: the first one stays.
      if (
        item.assistantResponseMessage.reasoningContent &&
        !previous.assistantResponseMessage.reasoningContent
      ) {
        previous.assistantResponseMessage.reasoningContent =
          item.assistantResponseMessage.reasoningContent;
      }
    } else {
      mergedHistory.push(item);
    }
  }

  // Ensure first message is user. Kiro API requires conversations to start
  // with a user message (fixes "Improperly formed request" for assistant-first).
  if (mergedHistory.length > 0 && mergedHistory[0].assistantResponseMessage) {
    const syntheticUserTurn = {
      userInputMessage: {
        content: "(empty)",
        modelId: model,
        origin: "AI_EDITOR",
      },
    };
    // Mark as synthetic (non-enumerable so it doesn't leak to upstream JSON)
    // so conversationId derivation can skip it — otherwise every
    // assistant-first conversation collapses onto the same uuidv5(empty)
    // namespace and leaks AWS Builder ID context across unrelated sessions.
    Object.defineProperty(syntheticUserTurn, "__synthetic", {
      value: true,
      enumerable: false,
      configurable: true,
    });
    mergedHistory.unshift(syntheticUserTurn);
  }

  // Ensure assistant exists before toolResults. Kiro API validates that every
  // toolResults array has a preceding assistantResponseMessage with toolUses.
  // When the assistant message is missing (truncated conversation), we strip
  // the orphaned toolResults and convert them to text to preserve context.
  for (let i = 0; i < mergedHistory.length; i++) {
    const item = mergedHistory[i];
    if (!item.userInputMessage?.userInputMessageContext?.toolResults) continue;

    const prev = mergedHistory[i - 1];
    const hasPrecedingAssistant =
      prev?.assistantResponseMessage?.toolUses && prev.assistantResponseMessage.toolUses.length > 0;

    if (!hasPrecedingAssistant) {
      const toolResults = item.userInputMessage.userInputMessageContext.toolResults as Array<{
        toolUseId?: string;
        content?: Array<{ text?: string }>;
      }>;
      const toolResultTexts = toolResults
        .map((tr) => {
          const id = tr.toolUseId || "";
          const text = tr.content?.map((c) => c.text || "").join("\n") || "";
          return id ? `[Tool Result (${id})]\n${text}` : `[Tool Result]\n${text}`;
        })
        .join("\n\n");

      const originalContent = item.userInputMessage.content || "";
      item.userInputMessage.content = originalContent
        ? `${originalContent}\n\n${toolResultTexts}`
        : toolResultTexts;
      delete item.userInputMessage.userInputMessageContext.toolResults;

      if (Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
        delete item.userInputMessage.userInputMessageContext;
      }
    }
  }

  // Also check currentMessage for orphaned toolResults (not in history)
  if (currentMessage?.userInputMessage?.userInputMessageContext?.toolResults) {
    const lastHistory = mergedHistory[mergedHistory.length - 1];
    const hasPrecedingAssistant =
      lastHistory?.assistantResponseMessage?.toolUses &&
      lastHistory.assistantResponseMessage.toolUses.length > 0;

    if (!hasPrecedingAssistant) {
      const toolResults = currentMessage.userInputMessage.userInputMessageContext
        .toolResults as Array<{ toolUseId?: string; content?: Array<{ text?: string }> }>;
      const toolResultTexts = toolResults
        .map((tr) => {
          const id = tr.toolUseId || "";
          const text = tr.content?.map((c) => c.text || "").join("\n") || "";
          return id ? `[Tool Result (${id})]\n${text}` : `[Tool Result]\n${text}`;
        })
        .join("\n\n");

      const originalContent = currentMessage.userInputMessage.content || "";
      currentMessage.userInputMessage.content = originalContent
        ? `${originalContent}\n\n${toolResultTexts}`
        : toolResultTexts;
      delete currentMessage.userInputMessage.userInputMessageContext.toolResults;

      if (Object.keys(currentMessage.userInputMessage.userInputMessageContext).length === 0) {
        delete currentMessage.userInputMessage.userInputMessageContext;
      }
    }
  }

  // Ensure alternating roles by inserting synthetic assistant messages
  // between consecutive user turns that couldn't be merged.
  const alternatingHistory: typeof mergedHistory = [];
  for (const item of mergedHistory) {
    const last = alternatingHistory[alternatingHistory.length - 1];
    if (item.userInputMessage && last?.userInputMessage) {
      const syntheticAssistantTurn = {
        assistantResponseMessage: { content: "(empty)" },
      };
      Object.defineProperty(syntheticAssistantTurn, "__synthetic", {
        value: true,
        enumerable: false,
        configurable: true,
      });
      alternatingHistory.push(syntheticAssistantTurn);
    }
    alternatingHistory.push(item);
  }

  // The split system turn and its "(empty)" answer are not the conversation's first message:
  // the conversationId is still derived from the real question, as before.
  if (splitSystemTurn) {
    for (const item of alternatingHistory.slice(0, 2)) {
      Object.defineProperty(item, "__synthetic", {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  return { history: alternatingHistory, currentMessage, toolsAttached };
}

/** The instruction that stands in for OpenAI's `response_format` (JSON schema / JSON object). */
function kiroJsonOutputInstruction(responseFormat: unknown): string {
  const rf = responseFormat as
    { type?: unknown; json_schema?: { schema?: unknown } } | null | undefined;
  if (!rf || typeof rf !== "object") return "";
  if (rf.type === "json_schema" && rf.json_schema?.schema) {
    let schema = "";
    try {
      schema = JSON.stringify(rf.json_schema.schema);
    } catch {
      return "";
    }
    return (
      "Reply with exactly one JSON value that matches this JSON Schema, and nothing else: no code " +
      `fence, no text before or after it.\nSchema: ${schema}`
    );
  }
  if (rf.type === "json_object") {
    return "Reply with exactly one JSON object and nothing else: no code fence, no text before or after it.";
  }
  return "";
}

/** Kiro's accepted reasoning-effort levels (`output_config.effort`). */
const KIRO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Resolve the Kiro effort level for a request, or "" when no reasoning was asked
 * for. Effort sources, in priority order:
 *   1. OpenAI-style `reasoning_effort`
 *   2. Anthropic adaptive-thinking `output_config.effort` (the canonical field)
 *   3. Anthropic `thinking` block — `{type:"enabled", budget_tokens}` mapped to a
 *      level via {@link effortFromBudget}; `{type:"adaptive"}` (no explicit
 *      effort) defaults to `high`, matching Anthropic's documented default
 *      (omitting `effort` ≡ `high`).
 * OpenAI's `minimal` collapses to `low` (Kiro has no `minimal`).
 */
function resolveKiroEffort(body: Record<string, unknown>): string {
  let effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : "";

  if (!effort) {
    const outputConfig = body.output_config as Record<string, unknown> | undefined;
    if (
      outputConfig &&
      typeof outputConfig === "object" &&
      typeof outputConfig.effort === "string"
    ) {
      effort = outputConfig.effort.toLowerCase();
    }
  }

  if (!effort) {
    const thinking = body.thinking as Record<string, unknown> | undefined;
    if (thinking && typeof thinking === "object") {
      if (thinking.type === "enabled") {
        effort = effortFromBudget(Number(thinking.budget_tokens) || 0);
      } else if (thinking.type === "adaptive") {
        effort = "high";
      }
    }
  }

  if (effort === "minimal") effort = "low";
  return KIRO_EFFORT_LEVELS.includes(effort) ? effort : "";
}

/** Map an Anthropic `thinking.budget_tokens` to a coarse Kiro effort level. */
function effortFromBudget(budget: number): string {
  if (budget >= 32000) return "high";
  if (budget >= 16000) return "medium";
  if (budget > 0) return "low";
  return "";
}

/**
 * Soft `<max_thinking_length>` budget for the Kiro prompt directive, per effort
 * level. Anthropic publishes no effort→token mapping (effort is "a behavioral
 * signal, not a strict token budget"), so this is a heuristic tuned against the
 * live CodeWhisperer stream, where a larger budget measurably deepens reasoning
 * up to the model cap. It is a hint the model may honor, not a hard cap (the hard
 * enable signal is `<thinking_mode>`); the caller clamps it to the model's cap.
 */
function thinkingLengthForEffort(effort: string): number {
  switch (effort) {
    case "max":
      return 120000;
    case "xhigh":
      return 64000;
    case "high":
      return 32000;
    case "medium":
      return 16000;
    default:
      return 8000; // low
  }
}

/**
 * Build Kiro payload from OpenAI format
 */
export function buildKiroPayload(model, body, stream, credentials) {
  // Reject the Anthropic-only `[1m]` context beta before it reaches Bedrock —
  // Kiro cannot honor it and a forwarded `kr/*[1m]` id is malformed upstream.
  if (hasUnsupportedKiroContextSuffix(model)) {
    throw new Error(KIRO_UNSUPPORTED_CONTEXT_1M_MESSAGE);
  }
  // Normalize model name: Claude Code sends dashes (claude-sonnet-4-6),
  // Kiro API expects dots (claude-sonnet-4.6). Convert trailing version segment.
  // The minor group is bounded to 1-2 digits so date-suffixed ids (e.g.
  // claude-opus-4-20250514) are never mistaken for a dash-separated minor
  // version and corrupted into claude-opus-4.20250514.
  // The supported `-thinking` selector is a local alias: strip it before the request leaves
  // TRouteAI so Kiro only receives a real upstream model ID. Non-functional agentic and
  // auto-kiro aliases are rejected above instead of silently degrading to another model.
  const {
    upstream: normalizedModel,
    thinking: modelRequestsThinking,
    effort: suffixEffort,
  } = resolveKiroModelAlias(model);
  const messages = body.messages || [];
  let tools = body.tools || [];
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? 32000;
  const temperature = body.temperature;
  const topP = body.top_p;

  // Kiro rejects history that references toolUses/toolResults without a tools
  // schema in userInputMessageContext. When callers omit body.tools but the
  // message history still contains assistant.tool_calls / role=tool turns,
  // synthesize a minimal tool schema from the tool names present in history
  // so Kiro accepts the request instead of returning `Improperly formed
  // request`. This preserves tool-call history and is a no-op when body.tools
  // is already populated.
  if (tools.length === 0) {
    const seen = new Set<string>();
    const synthesized: Array<Record<string, unknown>> = [];
    const pushName = (name: unknown) => {
      if (typeof name === "string" && name && !seen.has(name)) {
        seen.add(name);
        synthesized.push({
          type: "function",
          function: {
            name,
            description: `Tool: ${name}`,
            parameters: { type: "object", properties: {}, required: [] },
          },
        });
      }
    };
    for (const msg of messages) {
      if (msg?.role !== "assistant") continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          pushName(tc?.function?.name || tc?.name);
        }
      }
      // Anthropic-style assistant blocks: content:[{type:"tool_use", name, ...}]
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_use") {
            pushName(block.name);
          }
        }
      }
    }
    if (synthesized.length > 0) {
      tools = synthesized;
    }
  }

  const { history, currentMessage, toolsAttached } = convertMessages(
    messages,
    tools,
    normalizedModel
  );

  const profileArn = credentials?.providerSpecificData?.profileArn || "";

  let finalContent = currentMessage?.userInputMessage?.content || "";
  // Kiro has no structured-output field: a JSON answer is asked for in words (measured
  // 2026-11-10: Sonnet 5, Haiku 5.5, Opus 5.5 answered valid schema JSON 6 of 6 times).
  const jsonInstruction = kiroJsonOutputInstruction(body.response_format);
  if (jsonInstruction) finalContent = `${finalContent}\n\n${jsonInstruction}`.trim();
  const timestamp = new Date().toISOString();
  finalContent = `[Context: Current time is ${timestamp}]\n\n${finalContent}`;

  const payload: {
    conversationState: {
      chatTriggerType: string;
      conversationId: string;
      currentMessage: {
        userInputMessage: {
          content: string;
          modelId: string;
          origin: string;
          images?: Array<{ format: string; source: { bytes: string } }>;
          userInputMessageContext?: Record<string, unknown>;
        };
      };
      history: unknown[];
    };
    profileArn?: string;
    inferenceConfig?: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
    };
    additionalModelRequestFields?: {
      thinking?: { type: string; display?: string };
      output_config?: { effort: string };
      max_tokens?: number;
    };
  } = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(), // We must override this with deterministic ID
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: normalizedModel,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.images?.length && {
            images: currentMessage.userInputMessage.images,
          }),
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext,
          }),
        },
      },
      history: history,
    },
  };

  // Deterministic session caching for Kiro.
  // Skip synthetic placeholder turns ("(empty)" injected for assistant-first
  // conversations or alternating-role gaps) — otherwise unrelated assistant-
  // first chats would all hash to the same uuidv5(empty) and reuse the same
  // upstream Kiro/AWS conversation context, leaking prior state across
  // sessions. See conversionMessages() above for the `__synthetic` marker.
  const NAMESPACE_KIRO = "34f7193f-561d-4050-bc84-9547d953d6bf";

  // Priority 1: Extract first user message from pre-compression body (passed by chatCore before
  // compressContext runs). This keeps conversationId stable even when compression alters content.
  // Priority 2: Deterministic hash from first user message in translated history (fallback).
  const preCompressionBody = credentials?._preCompressionBody as
    Record<string, unknown> | null | undefined;
  const preCompressionMessages = Array.isArray(preCompressionBody?.messages)
    ? preCompressionBody.messages
    : null;
  const preCompressionFirstUser = preCompressionMessages?.find(
    (m: Record<string, unknown>) => m.role === "user"
  );
  const seedFromPreCompression = preCompressionFirstUser
    ? typeof preCompressionFirstUser.content === "string"
      ? preCompressionFirstUser.content
      : Array.isArray(preCompressionFirstUser.content)
        ? (preCompressionFirstUser.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text || "")
            .join(" ")
        : ""
    : "";
  const firstRealUserTurn = history.find((h) => h?.userInputMessage?.content && !h.__synthetic);
  // Without a history the question itself (not finalContent, which starts with the changing
  // time line) seeds the id, so call 1 and call 2 of a session get the same one.
  const firstContent =
    seedFromPreCompression ||
    firstRealUserTurn?.userInputMessage?.content ||
    currentMessage?.userInputMessage?.content ||
    finalContent;

  // Use uuidv5 with the hash of the system prompt / first message to maintain AWS Builder ID context cache
  payload.conversationState.conversationId = uuidv5(
    (firstContent || "").substring(0, 4000),
    NAMESPACE_KIRO
  );

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  // Thinking mode for Claude models on Kiro (ported from javargasm/pi-kiro).
  // Two coordinated signals steer reasoning on the CodeWhisperer surface:
  //   1. a `<thinking_mode>enabled</thinking_mode><max_thinking_length>N</...>`
  //      directive prepended to the user message — makes Claude emit reasoning
  //      INLINE, split back into `reasoning_content` by the executor (kiroThinking.ts);
  //   2. top-level `additionalModelRequestFields` (output_config.effort +
  //      thinking:{type:"adaptive"} + a clamped max_tokens), forwarded to AWS by
  //      the Kiro executor's transformRequest allowlist — the graded effort lever,
  //      gated on Kiro's adaptive-thinking allowlist, not supportsReasoning().
  const requestedEffort =
    resolveKiroEffort(body) || suffixEffort || (modelRequestsThinking ? "high" : "");
  const kiroEffort = kiroEffortForModel(normalizedModel, requestedEffort);
  if (kiroEffort) {
    // `<thinking_mode>` / `<max_thinking_length>` are Kiro/CodeWhisperer prompt
    // conventions (NOT Anthropic API params); the length is a soft hint (the hard
    // enable signal is `<thinking_mode>`), clamped to the model's thinking cap.
    const thinkingLength = capThinkingBudget(normalizedModel, thinkingLengthForEffort(kiroEffort));
    const directive =
      `<thinking_mode>enabled</thinking_mode>` +
      `<max_thinking_length>${thinkingLength}</max_thinking_length>`;
    payload.conversationState.currentMessage.userInputMessage.content = `${directive}\n\n${payload.conversationState.currentMessage.userInputMessage.content}`;

    const fields: {
      output_config: { effort: string };
      thinking: { type: string; display: string };
      max_tokens?: number;
    } = {
      output_config: { effort: kiroEffort },
      thinking: { type: "adaptive", display: "summarized" },
    };
    // Forward max_tokens only when the client set one, clamped to the model's
    // output window (floor 1024) — matches pi-kiro and avoids an over-budget reject.
    if (maxTokens > 0) {
      const capped = capMaxOutputTokens(normalizedModel, maxTokens) ?? maxTokens;
      fields.max_tokens = Math.max(Math.floor(capped), 1024);
    }
    payload.additionalModelRequestFields = fields;

    // Adaptive-only Claude models (Opus 4.7/4.8, Sonnet 5, Fable 5) reject a
    // non-default temperature / top_p with a 400 while thinking is active, so
    // strip both. Drop inferenceConfig entirely if nothing else remains.
    if (payload.inferenceConfig) {
      delete payload.inferenceConfig.temperature;
      delete payload.inferenceConfig.topP;
      if (Object.keys(payload.inferenceConfig).length === 0) {
        delete payload.inferenceConfig;
      }
    }
  }

  // Kiro ignores `inferenceConfig.maxTokens` and has no stop sequences (measured 2026-11-10:
  // max 1 still answers in full). The executor applies both to the answer itself; this field
  // never leaves TRouteAI (the executor's transformRequest only forwards Kiro's own fields).
  const clientStop = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter(
    (s: unknown): s is string => typeof s === "string" && s.length > 0
  );
  const clientMaxTokens = Number(body.max_tokens ?? body.max_completion_tokens);
  if (clientStop.length > 0 || clientMaxTokens > 0) {
    (payload as Record<string, unknown>)._clientLimits = {
      ...(clientStop.length > 0 ? { stop: clientStop } : {}),
      ...(clientMaxTokens > 0 ? { maxTokens: Math.floor(clientMaxTokens) } : {}),
    };
  }

  // Thinking switched off by the client (`reasoning_effort: "none"`, Anthropic
  // `thinking: {type: "disabled"}`). Kiro's schema only knows "adaptive" (a "disabled" value
  // gets 400), and without any field Opus 5.5 thinks by itself: measured 2026-11-10 on a
  // 140 KB prompt, 8.5-10.5 s with a reasoning block against 4.9 s with the lowest effort and
  // hidden thinking. So that is what "off" becomes; every model of the table accepts it.
  if (!kiroEffort && !requestedEffort && isKiroThinkingSwitchedOff(body)) {
    if (supportsKiroAdaptiveThinking(normalizedModel)) {
      payload.additionalModelRequestFields = {
        output_config: { effort: "low" },
        thinking: { type: "adaptive", display: "omitted" },
      };
      if (payload.inferenceConfig) {
        delete payload.inferenceConfig.temperature;
        delete payload.inferenceConfig.topP;
        if (Object.keys(payload.inferenceConfig).length === 0) delete payload.inferenceConfig;
      }
    }
  }

  return payload;
}

function isKiroThinkingSwitchedOff(body: Record<string, unknown>): boolean {
  if (typeof body.reasoning_effort === "string") {
    return body.reasoning_effort.toLowerCase() === "none";
  }
  const thinking = body.thinking as Record<string, unknown> | undefined;
  return !!thinking && typeof thinking === "object" && thinking.type === "disabled";
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null);
