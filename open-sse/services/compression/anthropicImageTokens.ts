/**
 * Anthropic vision token estimate for an image block (used by compression telemetry).
 *
 * Anthropic bills images in 28×28 px patches after resizing the image so that its long
 * edge is at most 1568 px and it fits within 1568 patches ("standard" tier). A small
 * fixed overhead is billed per image block on top of the patches.
 */

const PATCH_PX = 28;
const STANDARD_LONG_EDGE_MAX = 1568;
const STANDARD_TOKEN_CAP = 1568;

/** Extra tokens billed per image block (framing, not pixels). */
export const ANTHROPIC_IMAGE_BLOCK_OVERHEAD_TOKENS = 4;

function patches(width: number, height: number): number {
  return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
}

/** Visual-token cost of a width×height image, excluding the per-block overhead. */
export function anthropicImageTokens(
  width: number,
  height: number,
  _tier: "standard" = "standard"
) {
  if (!(width > 0) || !(height > 0)) return 0;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long <= STANDARD_LONG_EDGE_MAX && patches(width, height) <= STANDARD_TOKEN_CAP) {
    return patches(width, height);
  }
  // Largest aspect-preserving long edge that satisfies both caps (patch count only grows
  // with the long edge, so a binary search is exact).
  const at = (edge: number) => patches(edge, Math.round((short * edge) / long));
  let lo = PATCH_PX;
  let hi = Math.min(STANDARD_LONG_EDGE_MAX, long);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (at(mid) <= STANDARD_TOKEN_CAP) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}
