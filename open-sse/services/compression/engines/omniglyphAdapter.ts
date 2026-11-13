/**
 * OmniGlyph — context-as-image compression (Anthropic/Fable 5 only).
 * Renders the system prompt, tool docs, old history and large tool_results
 * as dense PNG pages; the model reads the pages instead of the text for ~10×
 * fewer tokens in the converted block (59-70% end to end, measured).
 *
 * GATES (all fail-closed; every skip becomes a `skip:<reason>` technique in the stats):
 *  - supportsVision !== true            → skip:no_vision
 *  - model outside the measured allowlist → skip:model_not_approved
 *  - providerTransport !== 'direct'     → skip:transport_not_direct
 *    (aggregators resize images and destroy legibility — measured)
 *  - body is not native Claude format   → skip:source_format_not_claude
 *  - omniglyph's own profitability gate decides the rest (exact 28px
 *    patches; sparse/small text passes through) → skip:not_profitable
 *
 * `sampling: true`: the loss is INTENTIONAL (byte-exact values travel in the text
 * factsheet) — the fidelity gate skips this engine by design, not by accident.
 */
import type { CompressionEngine, CompressionEngineApplyOptions } from "./types.ts";
import type { CompressionResult } from "../types.ts";
import { createCompressionStats } from "../stats.ts";

function skip(body: Record<string, unknown>, reason: string): CompressionResult {
  try {
    return {
      body,
      compressed: false,
      stats: createCompressionStats(body, body, "stacked", [`skip:${reason}`]),
    };
  } catch {
    // Fail-open guard: a non-serializable body (e.g. circular reference) makes
    // createCompressionStats' internal JSON.stringify throw too — stats become
    // best-effort telemetry, never a reason to propagate the error.
    return { body, compressed: false, stats: null };
  }
}

/** Native Claude format: system at the top, never role:"system" inside messages. */

// The context-as-image renderer (third-party "omniglyph" package) is not bundled with
// TRouteAI. The engine id stays registered so saved compression configs keep validating,
// but it always skips and leaves the request unchanged.
async function applyOmniglyph(
  body: Record<string, unknown>,
  _options?: CompressionEngineApplyOptions
): Promise<CompressionResult> {
  return skip(body, "not_bundled");
}

export const omniglyphEngine: CompressionEngine = {
  id: "omniglyph",
  name: "Image context",
  description: "Context as images. Not included in this build, so it never changes requests.",
  icon: "image",
  targets: ["messages", "tool_results"],
  stackable: true,
  stackPriority: 90, // last: RTK/Caveman clean the text first; omniglyph renders what is left
  sampling: true, // intentional loss + factsheet → the fidelity gate skips it by design
  metadata: {
    id: "omniglyph",
    name: "Image context",
    description: "Context as images. Not included in this build.",
    inputScope: "mixed",
    targetLatencyMs: 250, // render + PNG encode of large pages
    supportsPreview: true,
    stable: false, // preview — promote after an end-to-end check
  },
  // Interface contract: async-only engines keep a synchronous apply as a safe pass-through.
  apply(body) {
    return { body, compressed: false, stats: null };
  },
  applyAsync: applyOmniglyph,
  compress(body, config) {
    return this.apply(body, { stepConfig: config });
  },
  getConfigSchema() {
    return [];
  },
  validateConfig() {
    return { valid: true, errors: [] };
  },
};
