/**
 * Token estimates for Claude models, measured against Kiro's own counts on 2026-11-10
 * (31 slices of code, markdown, JSON, YAML, SQL and prose).
 *
 * Two tokenizers: the newer one (Claude 5.x, Opus 4.7 / 4.8: identical counts on every sample)
 * gives about 1.61 tokens per cl100k token (per sample 1.23-2.51; SQL highest, `ls` output
 * lowest) and about 2.5 characters per token; the older one (Sonnet 4.5 / 4.6) about 1.22 and
 * 3.3. On whole Claude Code requests (system + messages + tools) the factor estimate was within
 * 5% of Kiro's number (7 real requests), even though single texts vary more.
 */
export type ClaudeTokenizer = "new" | "old";

const TOKENS_PER_CL100K: Record<ClaudeTokenizer, number> = { new: 1.61, old: 1.22 };
const CHARS_PER_TOKEN: Record<ClaudeTokenizer, number> = { new: 2.5, old: 3.3 };

/** Which Claude tokenizer a model id uses ("kiro/claude-opus-5.5", "claude-opus-5-5", ...). */
export function claudeTokenizerFor(model: unknown): ClaudeTokenizer | null {
  const id = String(model || "")
    .toLowerCase()
    .replace(/^.*\//, "");
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d))?(?:$|[^0-9])/.exec(id);
  if (!m) return null;
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  if (major >= 5) return "new";
  if (m[1] === "opus" && major === 4 && minor >= 7) return "new";
  return "old";
}

/** cl100k token count -> Claude token count (unchanged for other models). */
export function claudeTokensFromCl100k(model: unknown, cl100kTokens: number): number {
  const t = claudeTokenizerFor(model);
  return t ? Math.ceil(cl100kTokens * TOKENS_PER_CL100K[t]) : cl100kTokens;
}

/** Characters per token for a Claude model, or null for other models. */
export function claudeCharsPerToken(model: unknown): number | null {
  const t = claudeTokenizerFor(model);
  return t ? CHARS_PER_TOKEN[t] : null;
}

/**
 * Tokens Kiro adds to every request (its own instructions and wrapping), measured as the count
 * of a request with a one-word system prompt and "Reply with: ok": 1950 on Claude 5.x and Opus
 * 4.8, 6028 on Opus 4.7, about 4150 on Sonnet 4.5 / 4.6.
 */
export function kiroRequestOverheadTokens(model: unknown): number {
  const id = String(model || "")
    .toLowerCase()
    .replace(/^.*\//, "");
  if (/^claude-opus-4[.-]7/.test(id)) return 6028;
  const t = claudeTokenizerFor(id);
  if (t === "new") return 1950;
  if (t === "old") return 4150;
  return 0;
}

function textLength(value: unknown, depth = 0): number {
  if (depth > 6 || value == null) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, v) => n + textLength(v, depth + 1), 0);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    // Images and documents: base64 is not text tokens (Claude counts images by size).
    if (rec.type === "image" || rec.type === "image_url" || rec.type === "document") return 0;
    let n = 0;
    for (const [key, v] of Object.entries(rec)) {
      if (key === "signature" || key === "data" || key === "encrypted_content") continue;
      n += typeof v === "string" ? (key === "type" ? 0 : v.length) : textLength(v, depth + 1);
    }
    return n;
  }
  return 0;
}

/**
 * A quick input token estimate for a request body (system, messages, tools) for the model it
 * goes to: characters / the model's characters per token (4 for non-Claude models), plus
 * Kiro's own per-request tokens for Kiro. Used for `message_start.usage.input_tokens`, which
 * the Messages API fills before the answer starts; the real count follows in `message_delta`.
 */
export function estimateRequestInputTokens(
  body: unknown,
  model: unknown,
  provider?: string | null
): number {
  if (!body || typeof body !== "object") return 0;
  const b = body as Record<string, unknown>;
  let toolChars = 0;
  try {
    toolChars = Array.isArray(b.tools) ? JSON.stringify(b.tools).length : 0;
  } catch {}
  let chars = textLength(b.system) + textLength(b.messages) + toolChars;
  // The provider request (e.g. Kiro's conversationState): its whole JSON, without image bytes.
  if (chars === 0) {
    try {
      chars = JSON.stringify(b, (key, v) =>
        key === "bytes" || key === "data" ? undefined : v
      ).length;
    } catch {
      chars = 0;
    }
  }
  if (chars === 0) return 0;
  const perToken = claudeCharsPerToken(model) || 4;
  const overhead = provider === "kiro" ? kiroRequestOverheadTokens(model) : 0;
  return Math.ceil(chars / perToken) + overhead;
}
