/**
 * Per-token cooldown for the Claude OAuth usage endpoint
 * (`https://api.anthropic.com/api/oauth/usage`).
 *
 * Anthropic rate-limits this quota endpoint independently of `/v1/messages`.
 * When polled from multiple connections at once (dashboard auto-refresh + the
 * combo health-scheduler), it spams `429` and that surfaces as noisy provider
 * errors plus increased upstream load. Chat with the same token still works.
 *
 * We track a per-access-token "skip until" timestamp. When we see a `429`,
 * we suppress further OAuth-usage polls for that token until the cooldown
 * expires and the caller falls back to the legacy settings/org endpoint
 * (which is what `getClaudeUsage` does on every non-OK response).
 *
 * Pure helpers (no fetch, no timers) keep this TDD-friendly.
 *
 * Inspired-by `79df34ca`.
 */

import { createHash } from "node:crypto";

export const OAUTH_USAGE_429_COOLDOWN_MS = 180_000; // 3 minutes: the floor and the default
// The ceiling stays above what the service asks for (a retry-after of about an hour): a poll
// sent before that is refused again and starts the window over.
export const OAUTH_USAGE_429_MAX_COOLDOWN_MS = 6 * 60 * 60_000;
const MAX_DATE_MS = 8.64e15;

/** Map key for a token: a hash, so the map never holds the token itself. */
function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

const oauthCooldown = new Map<string, number>();

/** Returns true while `accessToken` is still inside its 429 cooldown window. */
export function isClaudeOauthUsageCoolingDown(
  accessToken: string | undefined,
  now: number = Date.now()
): boolean {
  if (!accessToken) return false;
  const until = oauthCooldown.get(tokenKey(accessToken));
  if (until === undefined) return false;
  if (until > now) return true;
  // Lazy GC of expired entries — keeps the Map bounded by active tokens.
  oauthCooldown.delete(tokenKey(accessToken));
  return false;
}

/** Record a 429 from the OAuth usage endpoint for `accessToken`. */
export function markClaudeOauthUsage429(
  accessToken: string | undefined,
  now: number = Date.now(),
  cooldownMs: number = OAUTH_USAGE_429_COOLDOWN_MS
): void {
  if (!accessToken) return;
  oauthCooldown.set(tokenKey(accessToken), now + cooldownMs);
}

/** `retry-after` as seconds or an HTTP date, as milliseconds from `now`, or null. */
function parseRetryAfterMs(value: string | null, now: number): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** An `anthropic-ratelimit-*-reset` value (epoch s, epoch ms or ISO) as ms from `now`, or null. */
function parseResetMs(value: string | null, now: number): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  const at = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(text);
  return Number.isFinite(at) && at > now && at <= MAX_DATE_MS ? at - now : null;
}

/**
 * How long to wait after a 429 from the usage endpoint: `retry-after` when present, else the
 * latest `anthropic-ratelimit-*-reset`, kept between the 3-minute floor and the 6-hour ceiling.
 */
export function computeClaudeUsageRetryMs(
  headers: Headers | null | undefined,
  now: number = Date.now()
): number {
  let wait: number | null = null;
  if (headers) {
    wait = parseRetryAfterMs(headers.get("retry-after"), now);
    if (wait === null) {
      headers.forEach((value, name) => {
        if (!/^anthropic-ratelimit-.+-reset$/i.test(name)) return;
        const candidate = parseResetMs(value, now);
        if (candidate !== null && (wait === null || candidate > wait)) wait = candidate;
      });
    }
  }
  return Math.min(
    OAUTH_USAGE_429_MAX_COOLDOWN_MS,
    Math.max(OAUTH_USAGE_429_COOLDOWN_MS, wait ?? OAUTH_USAGE_429_COOLDOWN_MS)
  );
}

/** Test-only: clear all entries. */
export function _resetClaudeOauthUsageCooldown(): void {
  oauthCooldown.clear();
}
