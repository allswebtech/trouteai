import { builtinSkills } from "./builtins";
import { TROUTEAI_WEB_SEARCH_FALLBACK_TOOL_NAME } from "@trouteai/open-sse/services/webSearchFallback.ts";
import { TROUTEAI_WEB_FETCH_FALLBACK_TOOL_NAME } from "@trouteai/open-sse/services/webFetchInterception.ts";
import { logger } from "../../../open-sse/utils/logger.ts";

const log = logger("SKILLS_INTERCEPTION");

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ExecutionContext {
  apiKeyId: string;
  sessionId: string;
  requestId: string;
  builtinToolNames?: string[];
  // Threaded through to the web_fetch builtin so it can resolve a per-model
  // pinned fetch backend (interceptionRules.fetchBackend). Optional — every other
  // builtin/skill ignores these.
  provider?: string;
  model?: string;
}

const BUILTIN_TOOL_ALIASES: Record<string, string> = {
  [TROUTEAI_WEB_SEARCH_FALLBACK_TOOL_NAME]: "web_search",
  [TROUTEAI_WEB_FETCH_FALLBACK_TOOL_NAME]: "web_fetch",
};

function resolveBuiltinHandlerName(
  toolName: string,
  context: ExecutionContext
): keyof typeof builtinSkills | null {
  const [rawName] = toolName.includes("@") ? toolName.split("@") : [toolName];
  const canonicalName = BUILTIN_TOOL_ALIASES[rawName] || rawName;
  const allowed = new Set(
    (context.builtinToolNames || []).map((name) => BUILTIN_TOOL_ALIASES[name] || name)
  );

  if (!allowed.has(canonicalName)) {
    return null;
  }

  return canonicalName in builtinSkills ? (canonicalName as keyof typeof builtinSkills) : null;
}

function detectProvider(modelId: string): "openai" | "anthropic" | "google" | "other" {
  const lower = modelId.toLowerCase();

  if (lower.includes("gpt") || lower.includes("openai")) {
    return "openai";
  }
  if (lower.includes("claude") || lower.includes("anthropic")) {
    return "anthropic";
  }
  if (lower.includes("gemini") || lower.includes("google")) {
    return "google";
  }

  return "other";
}

function getResponsesOutputContainer(response: Record<string, unknown> | null | undefined): {
  root: Record<string, unknown>;
  responseRoot: Record<string, unknown>;
  output: unknown[];
} | null {
  if (!response || typeof response !== "object") return null;

  if (Array.isArray(response.output)) {
    return {
      root: response,
      responseRoot: response,
      output: response.output,
    };
  }

  if (
    response.response &&
    typeof response.response === "object" &&
    !Array.isArray(response.response) &&
    Array.isArray((response.response as Record<string, unknown>).output)
  ) {
    return {
      root: response,
      responseRoot: response.response as Record<string, unknown>,
      output: (response.response as Record<string, unknown>).output as unknown[],
    };
  }

  return null;
}

export async function interceptToolCalls(
  toolCalls: ToolCall[],
  context: ExecutionContext
): Promise<{ id: string; result: unknown }[]> {
  const results = await Promise.all(
    toolCalls.map(async (call) => {
      try {
        const builtinHandlerName = resolveBuiltinHandlerName(call.name, context);
        if (builtinHandlerName) {
          log.info("skills.interception.builtin_tool_detected", {
            toolName: call.name,
            builtinHandler: builtinHandlerName,
            callId: call.id,
          });

          const result = await builtinSkills[builtinHandlerName](call.arguments, {
            apiKeyId: context.apiKeyId,
            sessionId: context.sessionId,
            provider: context.provider,
            model: context.model,
          });

          log.info("skills.interception.execution_complete", {
            toolName: call.name,
            callId: call.id,
          });

          return {
            id: call.id,
            result,
          };
        }

        // Only builtin tool calls reach here (see the filter in handleToolCallExecution).
        return {
          id: call.id,
          result: { error: `Unknown tool: ${call.name}` },
        };
      } catch (err) {
        log.error("skills.interception.execution_failed", {
          toolName: call.name,
          callId: call.id,
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          id: call.id,
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    })
  );

  return results;
}

export function extractToolCalls(response: any, modelId: string): ToolCall[] {
  const provider = detectProvider(modelId);

  switch (provider) {
    case "openai": {
      const rootToolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
      const choiceToolCalls = Array.isArray(response?.choices)
        ? response.choices.flatMap((choice: any) =>
            Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
          )
        : [];
      const responsesOutput = getResponsesOutputContainer(response);
      const responsesToolCalls = responsesOutput
        ? responsesOutput.output
            .map((item: unknown) => (item && typeof item === "object" ? (item as any) : null))
            .filter((item: any) => item?.type === "function_call")
        : [];
      const toolCalls =
        rootToolCalls.length > 0
          ? rootToolCalls
          : choiceToolCalls.length > 0
            ? choiceToolCalls
            : responsesToolCalls;

      return toolCalls.map((tc: any) => ({
        id: tc.call_id || tc.id || `call_${Date.now()}`,
        name: tc.function?.name || tc.name || "",
        arguments: parseArguments(tc.function?.arguments || tc.arguments || "{}"),
      }));
    }

    case "anthropic":
      return (response.content || [])
        .filter((c: any) => c.type === "tool_use")
        .map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.input || {},
        }));

    case "google":
      return (response.functionCalls || []).map((fc: any) => ({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: fc.name,
        arguments: fc.args || {},
      }));

    default:
      return [];
  }
}

function parseArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args === "object") {
    return args;
  }

  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export async function handleToolCallExecution(
  response: any,
  modelId: string,
  context: ExecutionContext
): Promise<any> {
  // Only intercept tool calls that resolve to an allowed builtin handler.
  // Unknown tool names are forwarded untouched so client-native tools
  // (Bash, Read, etc.) are not turned into error results.
  const toolCalls = extractToolCalls(response, modelId).filter(
    (call) =>
      typeof call?.name === "string" &&
      Boolean(call.name) &&
      Boolean(resolveBuiltinHandlerName(call.name, context))
  );

  if (toolCalls.length === 0) {
    return response;
  }

  const results = await interceptToolCalls(toolCalls, context);

  const provider = detectProvider(modelId);

  switch (provider) {
    case "openai": {
      const responsesOutput = getResponsesOutputContainer(response);
      if (responsesOutput) {
        const functionOutputs = results.map((result) => ({
          type: "function_call_output",
          call_id: result.id,
          output: JSON.stringify(result.result),
        }));

        if (responsesOutput.root === responsesOutput.responseRoot) {
          return {
            ...response,
            output: [...responsesOutput.output, ...functionOutputs],
          };
        }

        return {
          ...response,
          response: {
            ...responsesOutput.responseRoot,
            output: [...responsesOutput.output, ...functionOutputs],
          },
        };
      }

      return {
        ...response,
        tool_results: results.map((r) => ({
          tool_call_id: r.id,
          output: JSON.stringify(r.result),
        })),
      };
    }

    case "anthropic": {
      // Anthropic only permits tool_result blocks in user messages. This helper
      // returns a single assistant response, so there is no valid place to put a
      // server-side skill result as tool_result here. Keep client-native tool_use
      // blocks untouched, remove the TRouteAI-handled tool_use blocks, and expose
      // their results as plain assistant text instead of corrupting history with
      // assistant-side tool_result blocks.
      //
      // When no client-native tool_use blocks remain (all were handled here), the
      // upstream stop_reason "tool_use" is stale and would make clients wait for
      // tool_use blocks that no longer exist — so it is normalized to "end_turn"
      // (with stop_sequence cleared). The mixed-tool branch keeps the original
      // stop_reason because real native tool_use blocks still need the client.
      const handledToolCallIds = new Set(results.map((r) => r.id));
      const toolNamesById = new Map(toolCalls.map((call) => [call.id, call.name]));
      const remainingContent = (Array.isArray(response.content) ? response.content : []).filter(
        (block: any) => !(block?.type === "tool_use" && handledToolCallIds.has(block.id))
      );
      const resultTextBlocks = results.map((r) => ({
        type: "text",
        text: `[Skill result: ${toolNamesById.get(r.id) || r.id}]\n${JSON.stringify(r.result)}`,
      }));
      const firstRemainingToolUseIndex = remainingContent.findIndex(
        (block: any) => block?.type === "tool_use"
      );

      if (firstRemainingToolUseIndex === -1) {
        return {
          ...response,
          content: [...remainingContent, ...resultTextBlocks],
          stop_reason: "end_turn",
          stop_sequence: null,
        };
      }

      return {
        ...response,
        content: [
          ...remainingContent.slice(0, firstRemainingToolUseIndex),
          ...resultTextBlocks,
          ...remainingContent.slice(firstRemainingToolUseIndex),
        ],
      };
    }

    default:
      return response;
  }
}
