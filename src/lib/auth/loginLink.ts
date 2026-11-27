import { createHash, randomBytes } from "node:crypto";

/**
 * One-time sign-in links for the gateway's own page. A code lives in memory only (a restart
 * ends every pending link), works once and for 60 seconds. Only a hash of the code is kept, and
 * nothing here runs on a timer: expired entries are dropped when the next link is made.
 */
export const LOGIN_LINK_TTL_SECONDS = 60;
const MAX_PENDING = 20;

const globalStore = globalThis as typeof globalThis & {
  __trouteaiLoginLinks?: Map<string, number>;
};
// One map for every route bundle of this process.
const pending = (globalStore.__trouteaiLoginLinks ??= new Map<string, number>());

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");

export function mintLoginLink(now = Date.now()): string {
  for (const [key, expires] of pending) if (expires <= now) pending.delete(key);
  while (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  const code = randomBytes(32).toString("base64url");
  pending.set(hashOf(code), now + LOGIN_LINK_TTL_SECONDS * 1000);
  return code;
}

/** True once for a live code; a used, late, wrong or empty code is false. */
export function consumeLoginLink(code: unknown, now = Date.now()): boolean {
  if (typeof code !== "string" || code.length === 0 || code.length > 128) return false;
  const key = hashOf(code);
  const expires = pending.get(key);
  if (expires === undefined) return false;
  pending.delete(key);
  return expires > now;
}

export function pendingLoginLinks(): number {
  return pending.size;
}

/**
 * The address a sign-in link names. A link is opened on this computer, so a configured public
 * address that points at this computer's own loopback but at another port than the one the
 * server listens on (a leftover default in an environment file) is a wrong setting: the link
 * then names the listening port. A real public address, and no configured address, are unchanged.
 */
export function loginLinkOrigin(
  origin: string,
  source: string,
  listenPort: string | undefined
): string {
  if (source !== "configured" || !listenPort || !/^\d{1,5}$/.test(listenPort)) return origin;
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (!loopback || url.protocol !== "http:" || url.port === "" || url.port === listenPort) {
      return origin;
    }
    url.port = listenPort;
    return url.origin;
  } catch {
    return origin;
  }
}
