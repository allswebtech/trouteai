// Resolves the persisted per-engine DETAIL sub-object (settings.headroom / .sessionDedup /
// .ccr) for a stacked-pipeline step. Extracted out of strategySelector.ts to keep that
// file small rather than growing it inline.
//
// settings.headroom.minRows is wired into buildStepOptions so the dashboard value takes
// effect even when the stacked-pipeline step itself carries no config. It also applies the same
// merge to session-dedup and ccr, whose detail settings previously had nowhere to persist to
// (see compressionDetailNormalizers.ts on the DB write side of the same gap).
import type { CompressionConfig, CompressionPipelineStep } from "./types.ts";

export function resolveStepDetailConfig(
  engine: CompressionPipelineStep["engine"],
  config: CompressionConfig | undefined
) {
  switch (engine) {
    case "headroom":
      return config?.headroom ?? {};
    case "session-dedup":
      return config?.sessionDedup ?? {};
    case "ccr":
      return config?.ccr ?? {};
    default:
      return {};
  }
}
