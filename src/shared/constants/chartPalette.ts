/**
 * Shared chart series palette. Theme-aware: every entry is a CSS variable or a
 * color-mix() of theme tokens, so it follows light and dark mode and keeps
 * enough contrast against bg-surface in both. Order: primary first, then
 * neutral tones, then a few calm distinct hues for charts with many series.
 *
 * Use it for categorical series only (providers, models, keys, slices).
 * Semantic series (error, warning, success) should use those tokens directly.
 * Works in inline styles and in SVG fill/stroke (recharts).
 */
export const CHART_SERIES_PALETTE: readonly string[] = [
  "var(--color-primary)",
  "var(--color-text-muted)",
  "var(--color-info)",
  "color-mix(in srgb, var(--color-primary) 60%, var(--color-text-main))",
  "color-mix(in srgb, var(--color-text-main) 80%, var(--color-surface))",
  "color-mix(in srgb, var(--color-info) 60%, var(--color-text-main))",
  "color-mix(in srgb, var(--color-primary) 50%, var(--color-text-muted))",
  "color-mix(in srgb, var(--color-info) 50%, var(--color-text-muted))",
];

/** Series color by index; wraps around the palette. */
export function getChartSeriesColor(index: number): string {
  const n = CHART_SERIES_PALETTE.length;
  return CHART_SERIES_PALETTE[((index % n) + n) % n];
}
