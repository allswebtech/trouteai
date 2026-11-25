/**
 * Canonical status colors — single source of truth for status HEX, mirroring the
 * semantic tokens in `src/app/globals.css` (--color-success / --color-warning /
 * --color-error). Previously these same hex values were copy-pasted across several
 * components (flow edge styles, token-health badge, cascade nodes…); this module
 * collapses them to one place.
 *
 * Use these HEX values ONLY where a CSS class can't reach — canvas, ReactFlow SVG
 * strokes, or inline styles on third-party nodes. For normal DOM, prefer the Tailwind
 * utilities (`text-success`, `bg-error/10`, …) which already read the same tokens.
 */
export const STATUS_HEX = {
  success: "#16a34a",
  warning: "#d97706",
  error: "#dc2626",
  muted: "#5b6172",
} as const;
