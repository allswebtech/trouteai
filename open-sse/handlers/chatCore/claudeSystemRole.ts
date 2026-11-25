/**
 * chatCore Claude system-role lifter (chatCore god-file
 * decomposition).
 *
 * Pure helper extracted from chatCore.ts: lifts any `system`/`developer` role messages out of the
 * messages[] array into the top-level `system` field. Anthropic's Messages API rejects either as a
 * chat role, so they must be hoisted. `developer` is OpenAI's Responses-API rename of `system` and
 * is treated identically. Mutates the payload in place; behaviour is byte-identical to the previous
 * top-level definition (still re-exported from chatCore.ts for existing importers/tests).
 */

/**
 * Models that take a `role: "system"` turn inside `messages` (no beta header): an instruction
 * in the middle of a conversation that leaves the cached prefix, and on models that bind
 * thinking to its conversation the thinking, valid. Claude Sonnet 5 and older models refuse it.
 */
const MID_CONVERSATION_SYSTEM_MODELS = new Set([
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/** True for Anthropic's own API (anthropic, claude) and a model that takes such a turn. */
export function keepsMidConversationSystem(
  provider: string | null | undefined,
  model: string | null | undefined
): boolean {
  if (provider !== "claude" && provider !== "anthropic") return false;
  const id = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/(\d)\.(\d)/g, "$1-$2")
    .replace(/-\d{8}$/, "");
  return MID_CONVERSATION_SYSTEM_MODELS.has(id);
}

type TurnLike = { role?: unknown; content?: unknown; output_config?: unknown };

/** A system turn that only changes effort (`content: []` and `output_config`): valid anywhere. */
function isEffortOnlyTurn(m: TurnLike | undefined): boolean {
  return (
    !!m &&
    String(m.role).toLowerCase() === "system" &&
    Array.isArray(m.content) &&
    m.content.length === 0 &&
    !!m.output_config &&
    typeof m.output_config === "object"
  );
}

/**
 * Whether the system turn at `i` is placed the way the Messages API takes it: text only, after
 * a user turn (or an assistant turn ending in a server tool call), and either last or followed
 * by an assistant turn. Effort-only turns are taken anywhere. A turn that breaks the rules
 * (for example one before the first user turn) is still lifted into the top-level system.
 */
function isValidMidConversationSystemTurn(messages: TurnLike[], i: number): boolean {
  const m = messages[i];
  if (String(m?.role) !== "system") return false;
  if (isEffortOnlyTurn(m)) return true;
  const textOnly =
    (typeof m.content === "string" && m.content.length > 0) ||
    (Array.isArray(m.content) &&
      m.content.length > 0 &&
      (m.content as Array<{ type?: unknown }>).every((b) => b?.type === "text"));
  if (!textOnly) return false;
  let p = i - 1;
  while (p >= 0 && isEffortOnlyTurn(messages[p])) p--;
  const prev = messages[p];
  const prevBlocks = Array.isArray(prev?.content)
    ? (prev.content as Array<{ type?: unknown }>)
    : [];
  const afterUser = prev?.role === "user";
  const afterServerTool =
    prev?.role === "assistant" && prevBlocks[prevBlocks.length - 1]?.type === "server_tool_use";
  if (!afterUser && !afterServerTool) return false;
  let n = i + 1;
  while (n < messages.length && isEffortOnlyTurn(messages[n])) n++;
  return n >= messages.length || messages[n]?.role === "assistant";
}

export function extractSystemRoleMessages(
  payload: Record<string, unknown>,
  options: { keepMidConversation?: boolean } = {}
): void {
  if (!Array.isArray(payload.messages)) return;
  const all = payload.messages as TurnLike[];
  // On a model that takes them, a valid system turn stays where and as the client put it:
  // lifting it changes the top-level system on every turn, which breaks the cached prefix and
  // the thinking bound to the conversation.
  const kept = new Set<TurnLike>(
    options.keepMidConversation
      ? all.filter((_, i) => isValidMidConversationSystemTurn(all, i))
      : []
  );
  const messages = all.filter((m) => !kept.has(m));
  // Treat both `system` and `developer` as system-equivalent (OpenAI's Responses
  // API renamed system → developer). Anthropic rejects either as a chat role, so
  // both must be lifted into the top-level `system` field — parity with the
  // normal-path extractSystemMessagesToBody closure.
  const isSystemRole = (role: unknown): boolean =>
    typeof role === "string" &&
    (role.toLowerCase() === "system" || role.toLowerCase() === "developer");
  const systemMessages = messages.filter((m) => isSystemRole(m.role));
  if (systemMessages.length === 0) return;

  const extraBlocks: Array<Record<string, unknown>> = [];
  for (const sm of systemMessages) {
    if (typeof sm.content === "string" && sm.content.length > 0) {
      extraBlocks.push({ type: "text", text: sm.content });
    } else if (Array.isArray(sm.content)) {
      for (const block of sm.content as Array<Record<string, unknown>>) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          extraBlocks.push({ ...block });
        }
      }
    }
  }
  if (extraBlocks.length > 0) {
    const existingSystem = payload.system;
    if (typeof existingSystem === "string" && existingSystem.length > 0) {
      payload.system = [{ type: "text", text: existingSystem }, ...extraBlocks];
    } else if (Array.isArray(existingSystem)) {
      payload.system = [...(existingSystem as Array<Record<string, unknown>>), ...extraBlocks];
    } else {
      payload.system = extraBlocks;
    }
  }
  payload.messages = all.filter((m) => kept.has(m) || !isSystemRole(m.role));
}
