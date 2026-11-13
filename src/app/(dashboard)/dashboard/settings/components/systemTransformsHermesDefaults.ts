/**
 * Hermes (NousResearch/hermes-agent) system-transform anchors — client-side
 * mirror constant shared by RoutingTab.tsx and the
 * UI-parity snapshot. Extracted to a standalone module to keep RoutingTab.tsx
 * under its frozen file-size baseline.
 *
 * Server source of truth: open-sse/services/systemTransforms.ts
 * (HERMES_PARAGRAPH_ANCHORS / HERMES_IDENTITY_PREFIXES).
 */
export const HERMES = {
  anchors: ["hermes-agent.nousresearch.com", "github.com/NousResearch/hermes-agent"],
  prefixes: ["You are Hermes Agent"],
};
