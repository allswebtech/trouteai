/**
 * Context-fit evaluation for combo routing's compatibility filter (comboStructure.ts:
 * hasKnownCompatibleContextLimit, getTargetCompatibilityFailures).
 *
 * The same rule as the hard gate (knownContextOverflow.ts), chatCore and the auto strategy:
 * the known limit is a persisted per-model context override (operator-set or discovered,
 * Feature 5004) or else the catalog's context window, and a target is "too small" only when
 * the estimated input is clearly over it (CONTEXT_ESTIMATE_TOLERANCE). The catalog's
 * `maxInputTokens` is not used as a cap: it can be a deliberately smaller client-facing hint,
 * and the requested output is not added (current Claude models accept input +
 * max_tokens above the window; other providers answer with an error the combo falls back on).
 * A stricter filter here silently moved long conversations to another model of the combo
 * while the first one would have accepted them.
 */

import { getModelContextOverride } from "../../../src/lib/db/modelContextOverrides";
import { isClearlyOverContextLimit } from "../../utils/contextOverflowError.ts";
import { parseModel } from "../model.ts";

/**
 * `true` when the target's known limit fits the request, `false` when the input is clearly
 * over it, `null` when no limit is known.
 */
export function evaluateContextLimit(
  capabilities: { maxInputTokens?: number | null; contextWindow?: number | null },
  requirements: { estimatedInputTokens: number },
  modelStr?: string
): boolean | null {
  let limit: number | null = null;
  if (modelStr) {
    const parsed = parseModel(modelStr);
    limit = getModelContextOverride(parsed.provider, parsed.model);
  }
  limit ??= capabilities.contextWindow ?? capabilities.maxInputTokens ?? null;
  if (typeof limit !== "number" || limit <= 0) return null;
  return !isClearlyOverContextLimit(requirements.estimatedInputTokens, limit);
}
