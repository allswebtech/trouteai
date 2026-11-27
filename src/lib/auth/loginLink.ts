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
