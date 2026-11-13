// Content-Security-Policy builder shared by next.config.mjs (static fallback header) and
// src/proxy.ts (per-request nonce header for HTML pages). Plain ESM on purpose: the
// production server loads next.config.mjs with plain Node, without a TypeScript loader.
//
// Two variants, identical except for script-src:
// - nonce (pages the proxy covers): script-src 'self' 'nonce-X' 'strict-dynamic' blob:
//   Only scripts carrying this request's nonce run, plus the scripts they load (Next.js
//   chunks). Next.js reads the nonce from the request CSP header and adds it to its own
//   scripts; src/app/layout.tsx adds it to the two inline init scripts.
// - static (API responses and anything the proxy does not run on, e.g. public files):
//   script-src 'self' 'unsafe-inline' blob:  (unchanged from before; no HTML runs there)
//
// style-src keeps 'unsafe-inline' in both: React `style={...}` props become inline style
// attributes, which a nonce cannot cover (nonces only apply to <style>/<script> elements).
// Inline styles cannot run code, so this does not weaken the script protection.
//
// 'unsafe-eval' is added only for the dev server (React dev tooling and HMR use eval).

/** Request header that carries the per-request nonce from the proxy to server code. */
export const CSP_NONCE_HEADER = "x-nonce";

/** Lowercase on purpose: next.config.mjs and the proxy must use the same header key. */
export const CSP_HEADER = "content-security-policy";

// Same character set Next.js accepts when it extracts the nonce from the CSP header.
const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/**
 * @param {{ nonce?: string | null, isDev?: boolean }} [options]
 * @returns {string}
 */
export function buildContentSecurityPolicy({ nonce = null, isDev = false } = {}) {
  if (nonce !== null && !NONCE_PATTERN.test(nonce)) {
    throw new Error("Invalid CSP nonce");
  }
  const evalSource = isDev ? " 'unsafe-eval'" : "";
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evalSource} blob:`
    : `script-src 'self' 'unsafe-inline'${evalSource} blob:`;
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // Provider logos may come from provider CDNs.
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    // The browser only talks to this app (API + same-origin live WebSocket).
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** 128 random bits, base64. Works in the Node.js and edge runtimes. */
export function createCspNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The nonce the proxy stamped on this request, or undefined when the proxy did not run
 * (then the static CSP applies and inline scripts need no nonce).
 * @param {{ get(name: string): string | null }} headers
 * @returns {string | undefined}
 */
export function readCspNonce(headers) {
  const value = headers.get(CSP_NONCE_HEADER);
  return value && NONCE_PATTERN.test(value) ? value : undefined;
}
