/**
 * Kiro/AWS CodeWhisperer only accepts the adaptive-thinking `additionalModelRequestFields`
 * envelope (`output_config.effort` + `thinking:{type:"adaptive"}` + `max_tokens`) for some
 * models, and checks the effort value against a per-model list. This table mirrors Kiro's live
 * `ListAvailableModels` → `additionalModelRequestFieldsSchema` (read 2026-11-10 with a real
 * account, every row also confirmed with a real request):
 *   - Claude 5.x and Opus 4.7 / 4.8: effort low | medium | high | xhigh | max
 *   - Opus 4.6 / Sonnet 4.6: low | medium | high | max (xhigh → 400 "does not have a value in
 *     the enumeration")
 *   - Sonnet 4.5 / Haiku 4.5 / Opus 4.5 and non-Claude models: no schema; the field gets 400
 *     "additionalModelRequestFields is not supported for this model", so they
 *     are left out.
 * The generic Anthropic-API capability table (`supportsReasoning()` in `@/lib/modelCapabilities`)
 * is not the right source here. Keep this in sync with Kiro's live schema.
 */
const KIRO_EFFORTS_ALL = ["low", "medium", "high", "xhigh", "max"] as const;
const KIRO_EFFORTS_NO_XHIGH = ["low", "medium", "high", "max"] as const;
const KIRO_ADAPTIVE_THINKING_EFFORTS: Record<string, readonly string[]> = {
  "claude-opus-5.5": KIRO_EFFORTS_ALL,
  "claude-sonnet-5.5": KIRO_EFFORTS_ALL,
  "claude-haiku-5.5": KIRO_EFFORTS_ALL,
  "claude-opus-5": KIRO_EFFORTS_ALL,
  "claude-sonnet-5": KIRO_EFFORTS_ALL,
  "claude-opus-4.8": KIRO_EFFORTS_ALL,
  "claude-opus-4.7": KIRO_EFFORTS_ALL,
  "claude-opus-4.6": KIRO_EFFORTS_NO_XHIGH,
  "claude-sonnet-4.6": KIRO_EFFORTS_NO_XHIGH,
};

export function supportsKiroAdaptiveThinking(normalizedModel: string): boolean {
  return Object.hasOwn(KIRO_ADAPTIVE_THINKING_EFFORTS, normalizedModel);
}

/**
 * The effort to send for `normalizedModel`, or "" when the model takes no effort field. A level
 * the model does not list falls back to the nearest one it has (xhigh → high on the 4.6 models).
 */
export function kiroEffortForModel(normalizedModel: string, effort: string): string {
  const allowed = KIRO_ADAPTIVE_THINKING_EFFORTS[normalizedModel];
  if (!allowed || !effort) return "";
  if (allowed.includes(effort)) return effort;
  if (effort === "xhigh" && allowed.includes("high")) return "high";
  return "";
}

const KIRO_UNSUPPORTED_AGENTIC_MESSAGE =
  "Kiro agentic aliases are not supported. The '-agentic' suffix did not change the " +
  "upstream request; select a real Kiro model instead.";
const KIRO_UNSUPPORTED_THINKING_MESSAGE =
  "This Kiro model does not support the '-thinking' alias. Use a model returned by Kiro's " +
  "live catalog with Thinking capability.";
const KIRO_REMOVED_AUTO_ALIAS_MESSAGE =
  "'auto-kiro' is not a real Kiro upstream model. Select a model returned by the live catalog.";

export function resolveKiroModelAlias(model: unknown): {
  upstream: string;
  thinking: boolean;
  /** Reasoning effort taken from a Claude `-low|-medium|-high|-xhigh|-max` id suffix. */
  effort: string;
} {
  let upstream = String(model || "");
  if (upstream.endsWith("-agentic")) throw new Error(KIRO_UNSUPPORTED_AGENTIC_MESSAGE);
  if (upstream === "auto-kiro") throw new Error(KIRO_REMOVED_AUTO_ALIAS_MESSAGE);

  // Catalog effort variants (e.g. claude-opus-5.5-high) are not real Kiro ids: strip the
  // suffix so Kiro gets the base model, and hand the level to the effort logic.
  let effort = "";
  const effortMatch = /^(claude-.+)-(xhigh|max|high|medium|low)$/i.exec(upstream);
  if (effortMatch) {
    upstream = effortMatch[1];
    effort = effortMatch[2].toLowerCase();
  }

  const thinking = upstream.endsWith("-thinking");
  if (thinking) upstream = upstream.slice(0, -"-thinking".length);
  upstream = upstream.replace(/^(claude-(?:opus|sonnet|haiku|3-\d+)-\d+)-(\d{1,2})$/, "$1.$2");

  if (thinking && !supportsKiroAdaptiveThinking(upstream)) {
    throw new Error(KIRO_UNSUPPORTED_THINKING_MESSAGE);
  }
  return { upstream, thinking, effort };
}
