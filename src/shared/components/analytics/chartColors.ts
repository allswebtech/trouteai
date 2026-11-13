import { CHART_SERIES_PALETTE, getChartSeriesColor } from "@/shared/constants/chartPalette";

/**
 * Chart series palette for analytics (theme-aware, see chartPalette.ts).
 * Semantic series (errors, success, warnings) should use the semantic
 * tokens directly instead of this list.
 */
export const PROVIDER_COLORS: readonly string[] = CHART_SERIES_PALETTE;

/** Series color by index (same palette as PROVIDER_COLORS). */
export function getSeriesColor(index: number) {
  return getChartSeriesColor(index);
}
