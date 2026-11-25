/**
 * Claude Code API constraints.
 *
 * Enforces Anthropic API requirements that real Claude Code handles:
 * 1. Sampling params under extended thinking: temperature=1 and top_p>=0.95
 *    (or unset) when thinking is enabled/adaptive
 * 2. Disable thinking when tool_choice forces a specific tool
 * 3. Enforce max 4 cache_control breakpoints
 * 4. Normalize cache_control TTL ordering
 */

/**
 * Anthropic's extended-thinking contract rejects non-default sampling params:
 * with thinking enabled/adaptive, `temperature` may only be 1 and `top_p` must
 * be >= 0.95 (or unset) — otherwise the Messages API returns HTTP 400
 * ("`temperature` may only be set to 1 ..." / "`top_p` must be greater than or
 * equal to 0.95 ..."). Clients such as the VS Code Copilot "Ollama" provider
 * routinely send other values (e.g. temperature 0.7, top_p 0.9), and thinking
 * can be injected by per-model requestDefaults *after* the request is built, so
 * normalize here: pin temperature to 1 and drop top_p (Anthropic's "unset"
 * branch — which also preserves the "never send both temperature and top_p"
 * invariant).
 */
export function enforceThinkingTemperature(body: Record<string, unknown>): void {
  const thinking = body.thinking as Record<string, unknown> | undefined;
  if (thinking?.type === "enabled" || thinking?.type === "adaptive") {
    body.temperature = 1;
    if (body.top_p !== undefined) {
      delete body.top_p;
    }
  }
}

export function disableThinkingIfToolChoiceForced(body: Record<string, unknown>): void {
  const toolChoice = body.tool_choice as Record<string, unknown> | string | undefined;
  if (!toolChoice) return;

  const isForced =
    toolChoice === "any" ||
    (typeof toolChoice === "object" && (toolChoice.type === "any" || toolChoice.type === "tool"));

  if (isForced && body.thinking) {
    delete body.thinking;
    delete body.context_management;
  }
}

const MAX_CACHE_CONTROL_BLOCKS = 4;

export function enforceCacheControlLimit(body: Record<string, unknown>): void {
  let count = 0;

  // Count in system blocks
  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control) count++;
    }
  }

  // Count in messages
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.cache_control) count++;
      }
    }
  }

  // Count in tools
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control) count++;
    }
  }

  if (count <= MAX_CACHE_CONTROL_BLOCKS) return;

  // Strip excess cache_control blocks from the end (keep first 4)
  let remaining = MAX_CACHE_CONTROL_BLOCKS;

  if (Array.isArray(system)) {
    for (const block of system) {
      if (block.cache_control) {
        if (remaining > 0) {
          remaining--;
        } else {
          delete block.cache_control;
        }
      }
    }
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.cache_control) {
          if (remaining > 0) {
            remaining--;
          } else {
            delete block.cache_control;
          }
        }
      }
    }
  }

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool.cache_control) {
        if (remaining > 0) {
          remaining--;
        } else {
          delete tool.cache_control;
        }
      }
    }
  }
}

export function ensureCacheControlOnLastUserMessage(body: Record<string, unknown>): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (String(messages[i].role) === "user") {
      const content = messages[i].content;
      if (Array.isArray(content) && content.length > 0) {
        const lastBlock = content[content.length - 1] as Record<string, unknown>;
        if (!lastBlock.cache_control) {
          lastBlock.cache_control = { type: "ephemeral" };
        }
      }
      break;
    }
  }
}

/**
 * The service refuses a longer cache TTL after a shorter one ("a ttl='1h' cache_control block
 * must not come after a ttl='5m' block"; an unset ttl is 5m). In render order (tools, system,
 * messages), every marker before a 1h marker is raised to 1h. Markers are otherwise left as
 * sent: a missing ttl is not changed, so the client's cache cost stays its own choice.
 */
export function normalizeCacheControlTtlOrder(body: Record<string, unknown>): void {
  const markers: Array<Record<string, unknown>> = [];
  const collect = (block: unknown) => {
    const cc = (block as Record<string, unknown> | null)?.cache_control as
      Record<string, unknown> | undefined;
    if (cc && typeof cc === "object" && cc.type === "ephemeral") markers.push(cc);
  };
  if (Array.isArray(body.tools)) body.tools.forEach(collect);
  if (Array.isArray(body.system)) body.system.forEach(collect);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages as Array<Record<string, unknown>>) {
      if (Array.isArray(message?.content)) message.content.forEach(collect);
    }
  }
  let last1h = -1;
  markers.forEach((cc, i) => {
    if (cc.ttl === "1h") last1h = i;
  });
  for (let i = 0; i < last1h; i++) markers[i].ttl = "1h";
}

/**
 * Models that refuse an assistant prefill (a request ending on an assistant turn): every
 * Claude model from the 4.6 generation on. Haiku 4.5, Sonnet 4.5 and Opus 4.5 still take one.
 */
export function modelRefusesAssistantPrefill(model: string | null | undefined): boolean {
  const match = String(model || "")
    .toLowerCase()
    .match(/claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] && match[2].length <= 2 ? Number(match[2]) : 0;
  return major >= 5 || (major === 4 && minor >= 6);
}

/**
 * A request that ends on an assistant turn is a prefill. The service refuses trailing
 * whitespace at its end ("final assistant content cannot end with trailing whitespace"), so
 * the last text block is trimmed at the end. For a model that refuses prefill altogether, a
 * trailing text-only assistant turn is dropped (it would be a 400); one holding a tool call
 * or thinking is left to the service.
 */
export function normalizeTrailingAssistantTurn(
  messages: Array<Record<string, unknown>>,
  model: string | null | undefined
): Array<Record<string, unknown>> {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  let content = last.content;
  if (typeof content === "string") {
    content = content.trimEnd();
  } else if (Array.isArray(content)) {
    const blocks = [...(content as Array<Record<string, unknown>>)];
    while (blocks.length > 0) {
      const tail = blocks[blocks.length - 1];
      if (tail?.type !== "text") break;
      const text = typeof tail.text === "string" ? tail.text.trimEnd() : "";
      if (text) {
        blocks[blocks.length - 1] = { ...tail, text };
        break;
      }
      blocks.pop();
    }
    content = blocks;
  } else {
    return messages;
  }
  const empty = typeof content === "string" ? content === "" : (content as unknown[]).length === 0;
  const textOnly =
    typeof content === "string" ||
    (content as Array<Record<string, unknown>>).every((b) => b?.type === "text");
  const rest = messages.slice(0, -1);
  if ((empty || (textOnly && modelRefusesAssistantPrefill(model))) && rest.length > 0) return rest;
  if (JSON.stringify(content) === JSON.stringify(last.content)) return messages;
  return [...rest, { ...last, content }];
}

/**
 * Models that refuse sampling parameters: `temperature`, `top_p` and `top_k` are removed (a 400
 * at any value) on Opus 4.7 and later, Sonnet 5, and every Fable and Mythos model, and refused
 * at any non-default value on Sonnet 5.5 and Haiku 5.5, where leaving them out is the default.
 * Opus 4.6, Sonnet 4.6, Haiku 4.5 and older still take them.
 */
export function modelRefusesSamplingParams(model: string | null | undefined): boolean {
  const match = String(model || "")
    .toLowerCase()
    .match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/);
  if (!match) return false;
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] && match[3].length <= 2 ? Number(match[3]) : 0;
  if (family === "fable" || family === "mythos") return true;
  if (family === "opus") return major >= 5 || (major === 4 && minor >= 7);
  return major >= 5;
}

/** Remove the sampling parameters for a model that refuses them; returns what was removed. */
export function stripRefusedSamplingParams(
  body: Record<string, unknown>,
  model: string | null | undefined
): string[] {
  if (!body || !modelRefusesSamplingParams(model)) return [];
  const removed: string[] = [];
  for (const param of ["temperature", "top_p", "top_k"]) {
    if (Object.hasOwn(body, param)) {
      delete body[param];
      removed.push(param);
    }
  }
  return removed;
}

/** Models that take `thinking.display: "updates"` (with its beta). */
const DISPLAY_UPDATES_MODELS = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
]);

export function modelTakesDisplayUpdates(model: string | null | undefined): boolean {
  const id = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/-\d{8}$/, "");
  return DISPLAY_UPDATES_MODELS.has(id);
}

/**
 * `thinking.display` accepts "summarized" and "omitted" on every thinking model; "updates" only
 * with the beta `thinking-display-updates-2026-08-18` and only on the models above. Any other
 * value would be a 400 ("Input should be 'summarized', 'omitted'"), so it becomes "summarized"
 * and thinking stays visible. `outgoingBeta` is the anthropic-beta header that will be sent.
 */
export function normalizeThinkingDisplay(
  body: Record<string, unknown>,
  model: string | null | undefined,
  outgoingBeta: string | null | undefined
): void {
  const th = body?.thinking as Record<string, unknown> | undefined;
  if (!th || typeof th !== "object" || typeof th.display !== "string") return;
  if (th.display === "summarized" || th.display === "omitted") return;
  const betaSent = String(outgoingBeta || "")
    .toLowerCase()
    .split(",")
    .map((t) => t.trim())
    .includes("thinking-display-updates-2026-08-18");
  if (th.display === "updates" && betaSent && modelTakesDisplayUpdates(model)) return;
  body.thinking = { ...th, display: "summarized" };
}
