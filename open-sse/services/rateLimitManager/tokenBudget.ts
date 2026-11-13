/**
 * Per-connection token budget enforcement (TPM / TPD).
 *
 * Bottleneck's reservoir rate-limits REQUEST counts, not tokens. This module
 * adds a parallel sliding-window TOKEN tracker keyed by the SAME limiter key
 * the request limiter uses, so a connection's configured tokens-per-minute
 * (tpm) and tokens-per-day (tpd) overrides are actually enforced at dispatch.
 *
 * Design:
 *  - Two windows per key: a 60s sliding minute window (tpm) and a calendar-day
 *    window (tpd). Each stores (timestamp, tokens) pairs in a flat number[]
 *    (even index = timestamp, odd index = token count), pruned on access so
 *    memory stays bounded to one window's worth of entries per active key.
 *  - RESERVATION is strict and race-safe: `reserve()` prunes, checks the
 *    budget, and — only if it fits — appends the entry in one synchronous,
 *    non-yielding step. Node runs this to completion with no await in between,
 *    so two concurrent callers can never both pass a nearly-exhausted budget.
 *  - Because the real completion-token total is not known until a (possibly
 *    streaming) response finishes, we reserve an ESTIMATE of the PROMPT tokens
 *    up front and do NOT reconcile the actual total afterwards (by design — see
 *    below). This makes the budget deliberately CONSERVATIVE: it counts input
 *    tokens only, so it under-counts total usage and is therefore slightly more
 *    permissive than a token-exact limiter. It never OVER-counts, so it can
 *    never fabricate a false 429 or throttle a request that was within budget.
 *    Prompt tokens dominate the budget for the throttling this feature exists
 *    to provide (protecting an upstream from bursty large-context traffic).
 *  - `reconcileTokenUsage()` is exported so a caller that knows the real total
 *    (e.g. after a non-streaming response) can true the window up for exact
 *    accounting. It is intentionally NOT wired into the request path yet:
 *    doing so correctly for STREAMING responses needs a stream-completion hook
 *    in chatCore, and the conservative-reserve behavior above is already safe
 *    (never a false 429). Wire it only alongside that hook, not piecemeal.
 *  - OFF by default: a key with tpm<=0 and tpd<=0 bypasses everything.
 */

interface TokenWindows {
  // Flat [ts, tokens, ts, tokens, ...] for the sliding 60s window.
  minute: number[];
  // Flat [ts, tokens, ...] for the current UTC day; reset when the day rolls.
  day: number[];
  dayKey: string;
}

const windows = new Map<string, TokenWindows>();

// Hard cap on tracked keys so a pathological churn of unique keys cannot grow
// the map without bound. LRU-ish: when exceeded, drop the least-recently-seen.
const MAX_KEYS = 5000;
const lastSeen = new Map<string, number>();

function nowMs(): number {
  return Date.now();
}

function dayKeyOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function touch(key: string, ts: number): void {
  lastSeen.set(key, ts);
  if (lastSeen.size > MAX_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, t] of lastSeen) {
      if (t < oldestTs) {
        oldestTs = t;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      lastSeen.delete(oldestKey);
      windows.delete(oldestKey);
    }
  }
}

function pruneMinute(entries: number[], now: number): void {
  const cutoff = now - 60_000;
  let i = 0;
  while (i < entries.length && entries[i] < cutoff) i += 2;
  if (i > 0) entries.splice(0, i);
}

function getWindows(key: string, now: number): TokenWindows {
  let w = windows.get(key);
  const today = dayKeyOf(now);
  if (!w) {
    w = { minute: [], day: [], dayKey: today };
    windows.set(key, w);
  }
  if (w.dayKey !== today) {
    w.day = [];
    w.dayKey = today;
  }
  pruneMinute(w.minute, now);
  return w;
}

function sumTokens(entries: number[]): number {
  let total = 0;
  for (let i = 1; i < entries.length; i += 2) total += entries[i];
  return total;
}

export interface TokenBudget {
  tpm: number; // tokens per minute, <=0 = unlimited
  tpd: number; // tokens per day, <=0 = unlimited
}

/** True when neither limit is active — callers skip all budget work. */
export function isTokenBudgetActive(budget: TokenBudget | null | undefined): boolean {
  return !!budget && ((budget.tpm ?? 0) > 0 || (budget.tpd ?? 0) > 0);
}

/**
 * How many ms until `tokens` would fit under both windows, or 0 if it fits now.
 * Returns the time until the oldest blocking entry ages out (minute window) or
 * until the next UTC day (day window), whichever is the binding constraint.
 * Never returns a negative value.
 */
function msUntilFits(key: string, tokens: number, budget: TokenBudget, now: number): number {
  const w = getWindows(key, now);
  let waitMs = 0;

  if (budget.tpm > 0) {
    const used = sumTokens(w.minute);
    if (used + tokens > budget.tpm) {
      // A single request larger than the whole per-minute budget can never fit;
      // let it through rather than hang forever (it will be the only one in the
      // window). Otherwise wait for the oldest entry to age out of the 60s window.
      if (tokens >= budget.tpm) return 0;
      const oldestTs = w.minute.length > 0 ? w.minute[0] : now;
      waitMs = Math.max(waitMs, oldestTs + 60_000 - now);
    }
  }

  if (budget.tpd > 0) {
    const used = sumTokens(w.day);
    if (used + tokens > budget.tpd) {
      if (tokens >= budget.tpd) return 0;
      // Day budget resets at the next UTC midnight.
      const nextMidnight = Date.parse(dayKeyOf(now) + "T00:00:00.000Z") + 24 * 60 * 60 * 1000;
      waitMs = Math.max(waitMs, nextMidnight - now);
    }
  }

  return Math.max(0, waitMs);
}

/**
 * Atomically (single synchronous step, no await) try to reserve `tokens`.
 * Returns true and records the usage if it fits under both windows right now;
 * returns false without recording otherwise. Race-safe: the prune+check+append
 * runs to completion before any other microtask, so concurrent callers cannot
 * both pass a nearly-exhausted budget.
 */
function tryReserve(key: string, tokens: number, budget: TokenBudget, now: number): boolean {
  const w = getWindows(key, now);
  if (budget.tpm > 0 && tokens < budget.tpm && sumTokens(w.minute) + tokens > budget.tpm) {
    return false;
  }
  if (budget.tpd > 0 && tokens < budget.tpd && sumTokens(w.day) + tokens > budget.tpd) {
    return false;
  }
  if (budget.tpm > 0) w.minute.push(now, tokens);
  if (budget.tpd > 0) w.day.push(now, tokens);
  touch(key, now);
  return true;
}

/**
 * Block until `tokens` fit under the configured tpm/tpd windows, then reserve
 * them. Mirrors the request limiter's wait-rather-than-error behavior. Honors
 * `maxWaitMs` (0 = wait indefinitely) and an optional AbortSignal. On timeout
 * it reserves anyway and returns — the budget is a throttle, not a hard wall,
 * and refusing here would turn a slow caller into a failed request.
 */
export async function awaitTokenBudget(
  key: string,
  estimatedTokens: number,
  budget: TokenBudget,
  opts: { maxWaitMs?: number; signal?: AbortSignal | null } = {}
): Promise<void> {
  if (!isTokenBudgetActive(budget)) return;
  const tokens = Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : 1;
  const maxWaitMs = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : 0;
  const deadline = maxWaitMs > 0 ? nowMs() + maxWaitMs : Infinity;

  // Fast path: reserve immediately if it fits.
  if (tryReserve(key, tokens, budget, nowMs())) return;

  while (true) {
    if (opts.signal?.aborted) {
      const reason = opts.signal.reason;
      if (reason instanceof Error) throw reason;
      const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
      err.name = "AbortError";
      throw err;
    }

    const now = nowMs();
    if (tryReserve(key, tokens, budget, now)) return;

    let wait = msUntilFits(key, tokens, budget, now);
    if (wait <= 0) wait = 25; // windows say it fits but reserve lost a race — retry soon
    if (now + wait > deadline) {
      // Out of budget window: reserve regardless so the request proceeds.
      forceRecord(key, tokens, budget, now);
      return;
    }
    // Cap each sleep so an aborted signal is observed promptly and day-long
    // waits still poll (the day window may free earlier via reconcile()).
    const sleep = Math.min(wait, 1000);
    await new Promise<void>((resolve) => setTimeout(resolve, sleep));
  }
}

/** Record usage without a budget check (used on wait-timeout, and reconcile). */
function forceRecord(key: string, tokens: number, budget: TokenBudget, now: number): void {
  if (tokens <= 0) return;
  const w = getWindows(key, now);
  if (budget.tpm > 0) w.minute.push(now, tokens);
  if (budget.tpd > 0) w.day.push(now, tokens);
  touch(key, now);
}

/**
 * True up a prior reservation with the real token usage once the response
 * completes. Pass the DELTA (actualTotal - estimatedReserved); positive adds
 * the under-counted remainder, a non-positive delta is ignored (we never
 * retroactively credit tokens — that could let a burst slip the window).
 */
export function reconcileTokenUsage(
  key: string,
  deltaTokens: number,
  budget: TokenBudget | null | undefined
): void {
  if (!isTokenBudgetActive(budget) || !Number.isFinite(deltaTokens) || deltaTokens <= 0) return;
  forceRecord(key, deltaTokens, budget as TokenBudget, nowMs());
}

/** Current minute-window token total for a key (diagnostics / tests). */
export function getMinuteTokenUsage(key: string): number {
  const w = windows.get(key);
  if (!w) return 0;
  pruneMinute(w.minute, nowMs());
  return sumTokens(w.minute);
}

/** Drop a key's windows (called when its limiter is evicted). */
export function clearTokenBudget(key: string): void {
  windows.delete(key);
  lastSeen.delete(key);
}
