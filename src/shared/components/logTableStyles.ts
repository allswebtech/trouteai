export const LOG_TABLE_CLASS = "w-full text-left border-collapse text-xs tabular-nums";
export const LOG_TABLE_HEAD_CLASS = "sticky top-0 z-10";
export const LOG_TABLE_ROW_CLASS = "border-b border-border";
export const LOG_TABLE_HEADER_CELL_CLASS =
  "h-9 px-3 py-2 font-medium text-text-muted text-xs border-b border-border";
export const LOG_TABLE_HEADER_CELL_RIGHT_CLASS = `${LOG_TABLE_HEADER_CELL_CLASS} text-right`;
export const LOG_TABLE_HEADER_BG_STYLE = { backgroundColor: "var(--color-surface, #fff)" } as const;

// Status badge: tinted semantic colors (green 2xx, amber 4xx, red 5xx, neutral otherwise).
export const LOG_STATUS_NEUTRAL_CLASS = "border-border bg-surface-2 text-text-muted";

export function getStatusBadgeClass(status: number): string {
  if (status >= 200 && status < 300) return "border-success/30 bg-success/10 text-success";
  if (status >= 400 && status < 500) return "border-warning/30 bg-warning/10 text-warning";
  if (status >= 500) return "border-error/30 bg-error/10 text-error";
  return LOG_STATUS_NEUTRAL_CLASS;
}

// Cache source pill: semantic cache = success, upstream = neutral.
export function getCacheSourceMeta(cacheSource: unknown): {
  key: "semantic" | "upstream";
  className: string;
} {
  if (cacheSource === "semantic") {
    return { key: "semantic", className: "bg-success/10 text-success border border-success/30" };
  }
  return { key: "upstream", className: "bg-surface-2 text-text-muted border border-border" };
}
