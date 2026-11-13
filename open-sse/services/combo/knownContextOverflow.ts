/**
 * Known context-overflow rejection for combos: a request whose input is clearly larger
 * than every target's known context window is rejected up front (in the wording clients
 * recover from) instead of being sent to every target in turn.
 */

import { getModelContextLimitForModelString } from "./comboStructure.ts";
import type { ResolvedComboTarget } from "./types.ts";
import { estimateRequestInputTokens } from "../requestTokenEstimate.ts";
import { isClearlyOverContextLimit } from "../../utils/contextOverflowError.ts";

export type KnownContextOverflow = {
  estimatedInputTokens: number;
  maxKnownContextTokens: number;
};

/**
 * Return a hard context-overflow decision only when every target has a known context
 * window (a per-model override, or the model's catalog entry — the same limit chatCore and
 * the auto strategy use) and the estimated input is clearly over every one of them
 * (CONTEXT_ESTIMATE_TOLERANCE). The requested output is not added: current Claude models
 * accept input + max_tokens above the window, and providers that do not answer with an error
 * the client recovers from. Unknown metadata keeps the fail-open behavior, and a request
 * close to the limit goes to the provider, whose answer is exact.
 */
export function getKnownContextOverflow(
  targets: ResolvedComboTarget[],
  body: Record<string, unknown>
): KnownContextOverflow | null {
  if (targets.length === 0) return null;
  const estimatedInputTokens = estimateRequestInputTokens(body);
  if (estimatedInputTokens <= 0) return null;

  const limits = targets.map((target) => getModelContextLimitForModelString(target.modelStr));
  if (limits.some((limit) => typeof limit !== "number" || limit <= 0)) return null;

  const maxKnownContextTokens = Math.max(...(limits as number[]));
  if (!isClearlyOverContextLimit(estimatedInputTokens, maxKnownContextTokens)) return null;
  return { estimatedInputTokens, maxKnownContextTokens };
}
