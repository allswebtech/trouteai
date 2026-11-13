/**
 * Optional white-label credit line, read from the environment at runtime:
 *
 *   BRAND_CREDIT="Your credit line"
 *   BRAND_CREDIT_URL=https://example.com   (optional; makes the line a link)
 *
 * When BRAND_CREDIT is empty (the default) nothing is shown. Restart the app after
 * changing it; no rebuild is needed. Shown in the sidebar footer and on the login page
 * via the public GET /api/settings/require-login response.
 */
export interface BrandCredit {
  text: string;
  url: string;
}

const MAX_CREDIT_LENGTH = 120;

export function getBrandCredit(): BrandCredit | null {
  const text = (process.env.BRAND_CREDIT || "").trim().slice(0, MAX_CREDIT_LENGTH);
  if (!text) return null;
  const rawUrl = (process.env.BRAND_CREDIT_URL || "").trim();
  // Only plain http(s) links; anything else is dropped and the text renders unlinked.
  const url = /^https?:\/\/[^\s"'<>]+$/i.test(rawUrl) ? rawUrl : "";
  return { text, url };
}
