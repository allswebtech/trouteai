// Providers that accept a system message only at index 0 (a later one gets HTTP 400).
// Add a provider only when it is documented as strict.
const PROVIDERS_SYSTEM_MUST_BE_FIRST = new Set(["xiaomi-mimo", "mimo"]);

export function systemMessageMustBeFirst(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return PROVIDERS_SYSTEM_MUST_BE_FIRST.has(provider.toLowerCase().trim());
}

type Message = { role: string; content: unknown; [key: string]: unknown };

function toTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: unknown } => {
        return (
          Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
        );
      })
      .map((part) => String(part.text ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * Hoist every `system`-role message onto index 0 for providers that reject a
 * non-first system message (`systemMessageMustBeFirst()`).
 *
 * `translateRequest()` is the single outbound choke point every request passes through,
 * including same-format (OpenAI→OpenAI) passthrough where none of the format-specific
 * translators run — so a client-injected `system` message landing mid-array (OpenCode /
 * Kilo Code style clients) previously reached the upstream untouched.
 *
 * Merge, never drop: multiple offending system messages are folded (in original order)
 * into the single leading system message, like `openai-to-claude.ts`'s system-array merge.
 *
 * No-op (same array reference) whenever the provider is not strict, or the request is
 * already compliant — required for prompt-cache prefix stability.
 */
export function hoistLeadingSystemMessage(
  messages: Message[],
  provider: string | null | undefined
): Message[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (!systemMessageMustBeFirst(provider)) return messages;

  const offendingIndices: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "system") offendingIndices.push(i);
  }
  if (offendingIndices.length === 0) return messages;

  const offending = offendingIndices.map((i) => messages[i]);
  const rest = messages.filter((_, i) => !offendingIndices.includes(i));

  const mergedText = [
    rest[0]?.role === "system" ? toTextContent(rest[0].content) : null,
    ...offending.map((m) => toTextContent(m.content)),
  ]
    .filter((text): text is string => Boolean(text))
    .join("\n");

  if (rest[0]?.role === "system") {
    const mergedFirst: Message = { ...rest[0], content: mergedText };
    return [mergedFirst, ...rest.slice(1)];
  }

  const leadingSystem: Message = { role: "system", content: mergedText };
  return [leadingSystem, ...rest];
}
