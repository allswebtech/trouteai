/**
 * Quota Cache — Domain Layer
 *
 * In-memory cache of provider quota data per connectionId.
 * Populated by:
 *   - Dashboard usage endpoint (GET /api/usage/[connectionId])
 *   - 429 responses marking account as exhausted
 *
 * Background refresh runs every 1 minute:
 *   - Active accounts (quota > 0%): refetch every 5 minutes
 *   - Exhausted accounts: refetch every 5 minutes (or immediately after resetAt passes)
 *
 * @module domain/quotaCache
 */

import { getUsageForProvider } from "@trouteai/open-sse/services/usage.ts";
import { getCachedProviderConnectionById, resolveProxyForConnection } from "@/lib/localDb";
import { runWithProxyContext } from "@trouteai/open-sse/utils/proxyFetch.ts";
import { safePercentage } from "@/shared/utils/formatting";
import {
  saveQuotaSnapshot,
  cleanupOldSnapshots,
  getLatestQuotaSnapshotsForConnection,
} from "@/lib/db/quotaSnapshots";
import { recordProviderQuotaResetEventIfChanged } from "@/lib/db/quotaResetEvents";
import { getCodexQuotaWindowFilterForModel } from "@trouteai/open-sse/config/codexQuotaScopes.ts";
import { getAntigravityQuotaFamily } from "@trouteai/open-sse/services/antigravityQuotaFamily.ts";
import { isClaudeOverageAllowed } from "@/lib/providers/claudeExtraUsage";

// ─── Types ──────────────────────────────────────────────────────────────────

interface QuotaInfo {
  remainingPercentage: number;
  resetAt: string | null;
}

interface QuotaCacheEntry {
  connectionId: string;
  provider: string;
  quotas: Record<string, QuotaInfo>;
  fetchedAt: number;
  exhausted: boolean;
  nextResetAt: string | null;
  windowDurationMs?: number | null; // Optional rolling window duration
  /** Paid overage keeps the account usable after a window is used up (Claude extra usage). */
  overageAllowed?: boolean;
}

interface QuotaWindowStatus {
  remainingPercentage: number;
  usedPercentage: number;
  resetAt: string | null;
  reachedThreshold: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ACTIVE_TTL_MS = 5 * 60 * 1000; // 5 minutes for active accounts
const EXHAUSTED_TTL_MS = 5 * 60 * 1000; // 5 minutes for 429-sourced entries (no resetAt)
const EXHAUSTED_REFRESH_MS = 5 * 60 * 1000; // 5 minutes: recheck exhausted accounts (aligned with TTL)
const REFRESH_INTERVAL_MS = 60 * 1000; // Background tick every 1 minute
export const DEFAULT_QUOTA_THRESHOLD_PERCENT = 99;

// ─── State ──────────────────────────────────────────────────────────────────
//
// Next.js `output: "standalone"` builds can load this module from
// independent webpack chunks (e.g. the instrumentation-hook-started
// `providerLimitsSyncScheduler` write path vs an API-route/SSE-handler read
// path such as `auth.ts::evaluateQuotaLimitPolicy()`) — each gets its OWN
// top-level module state, so a bare module-scope `Map` silently splits the
// cache in two. Anchor all mutable state on `globalThis` so every chunk
// shares one instance. Mirrors the identical fix already applied for
// `src/lib/pricingSync.ts` (commit de9d748dac) and the same pattern in
// `src/lib/credentialHealth/cache.ts`.

interface QuotaCacheState {
  cache: Map<string, QuotaCacheEntry>;
  refreshingSet: Set<string>;
  refreshTimer: ReturnType<typeof setInterval> | null;
  tickRunning: boolean;
}

declare global {
  var __trouteaiQuotaCacheState: QuotaCacheState | undefined;
}

function getState(): QuotaCacheState {
  if (!globalThis.__trouteaiQuotaCacheState) {
    globalThis.__trouteaiQuotaCacheState = {
      cache: new Map(),
      refreshingSet: new Set(),
      refreshTimer: null,
      tickRunning: false,
    };
  }
  return globalThis.__trouteaiQuotaCacheState;
}

const MAX_CONCURRENT_REFRESHES = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

// Snapshot raw_data marker: this connection's paid overage was allowed when it was saved.
const OVERAGE_SNAPSHOT_MARK = '{"overageAllowed":true}';

// ─── Usage-limit windows ────────────────────────────────────────────────────
//
// A subscription account (Claude, Codex, Kimi, GLM, MiniMax, OpenCode...) has several
// time windows, e.g. "session (5h)" and "weekly (7d)". It is blocked as soon as ANY time
// window is used up, until that window resets — not only when every window is at 0%.
// Credit-style windows (Kiro credits, a balance) keep the old rule: all at 0%.
// Claude's per-model weekly windows ("weekly opus (7d)") only block that model.

const TIME_WINDOW_RE =
  /(^|[^a-z])(5h|session|weekly|7d|daily|24h|monthly|30d|hourly|window[ _]?(5h|weekly|monthly))([^a-z]|$)/i;
const MODEL_WINDOW_RE = /^weekly (.+) \(7d\)$/i;
const GENERIC_WEEKLY_NAMES = new Set(["", "all", "oauth apps", "overage included"]);

function windowModelScope(windowName: string): string | null {
  const match = MODEL_WINDOW_RE.exec(windowName.trim());
  if (!match) return null;
  const scope = match[1].trim().toLowerCase().replace(/_/g, " ");
  return GENERIC_WEEKLY_NAMES.has(scope) ? null : scope;
}

// Windows that meter something other than chat requests never block the account.
const NON_CHAT_WINDOW_RE = /mcp|image|search|tool|video|audio|embedding/i;

function isTimeWindow(windowName: string): boolean {
  return TIME_WINDOW_RE.test(windowName) && !NON_CHAT_WINDOW_RE.test(windowName);
}

// Providers whose 5h / weekly / monthly windows each stop the WHOLE account when used up.
// Others keep their own rules: Codex and Antigravity scope windows per model family
// (isCodexQuotaExhausted / isAntigravityQuotaExhausted), CodeBuddy's daily/monthly entries
// are credit refills beside bonus packs, Xiaomi's are local estimates.
// Kimi Code: its usage parser reads the live /coding/v1/usages shape (limits[] limit/used,
// usages{} used_ratio), so a used-up 5h or monthly window blocks the account until it resets.
const WINDOW_RULE_PROVIDERS = new Set([
  "claude",
  "kimi-coding",
  "kimi-coding-apikey",
  "glm",
  "glm-cn",
  "glmt",
  "zai",
  "minimax",
  "minimax-cn",
  "opencode",
  "opencode-go",
  "opencode-zen",
  "xai-oauth",
  "xao",
]);

/** Whether a used-up time window blocks this provider's account (see WINDOW_RULE_PROVIDERS). */
function usesWindowRule(provider: string | null | undefined): boolean {
  if (!provider) return false;
  // Claude-compatible servers report the same anthropic-ratelimit-unified-* windows.
  return WINDOW_RULE_PROVIDERS.has(provider) || provider.startsWith("anthropic-compatible-");
}

/**
 * The reset time of the used-up window that blocks this account (the LATEST one when
 * several are used up, because the account is usable only after all of them reset), or
 * null when nothing blocks. A window whose reset time has passed never blocks.
 * requestedModel null = account-wide check (model-scoped windows are ignored).
 */
function blockingWindowResetAt(
  quotas: Record<string, QuotaInfo>,
  requestedModel: string | null,
  now: number,
  provider: string | null | undefined
): string | null {
  if (!usesWindowRule(provider)) return null;
  let latest: string | null = null;
  let latestMs = -Infinity;
  const model = (requestedModel || "").toLowerCase();
  for (const [name, q] of Object.entries(quotas)) {
    if (!q || q.remainingPercentage > 0 || !q.resetAt) continue;
    if (!isTimeWindow(name)) continue;
    const scope = windowModelScope(name);
    if (scope && !(model && model.includes(scope))) continue;
    const ms = parseDate(q.resetAt);
    if (ms === null || ms <= now) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = q.resetAt;
    }
  }
  return latest;
}

/** Exhaustion state of a set of windows: blocked + the time it is usable again. */
function exhaustionOf(
  quotas: Record<string, QuotaInfo>,
  provider: string | null | undefined,
  overageAllowed = false
): {
  exhausted: boolean;
  nextResetAt: string | null;
} {
  // Paid overage carries the account past its used-up windows.
  if (overageAllowed) return { exhausted: false, nextResetAt: null };
  const blockingReset = blockingWindowResetAt(quotas, null, Date.now(), provider);
  if (blockingReset) return { exhausted: true, nextResetAt: blockingReset };
  const entries = Object.values(quotas);
  const allEmpty = entries.length > 0 && entries.every((q) => q.remainingPercentage <= 0);
  return { exhausted: allEmpty, nextResetAt: allEmpty ? earliestResetAt(quotas) : null };
}

/**
 * Auto-advance quota window.
 * If we know the window duration, advance past the expired window(s) to
 * avoid blocking requests when the quota reset already happened but the
 * background refresh hasn't run yet.
 */
function advancedWindowResetAt(entry: QuotaCacheEntry, now: number): { exhausted: false } | null {
  if (!entry.nextResetAt) return null;

  const resetMs = parseDate(entry.nextResetAt);
  if (resetMs === null) return null;

  // If the window's resetAt is in the past, the quota has been renewed.
  // Eagerly mark as available so requests don't wait for the 5-min TTL.
  if (resetMs <= now) {
    return { exhausted: false };
  }

  return null;
}

function parseDate(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function normalizeWindowKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveQuotaWindow(
  quotas: Record<string, QuotaInfo>,
  windowName: string
): QuotaInfo | null {
  const direct = quotas[windowName];
  if (direct) return direct;

  const normalizedTarget = normalizeWindowKey(windowName);
  if (!normalizedTarget) return null;

  const prefixMatches: Array<{ key: string; quota: QuotaInfo }> = [];
  for (const [key, quota] of Object.entries(quotas)) {
    const normalizedKey = normalizeWindowKey(key);
    if (!normalizedKey) continue;
    if (normalizedKey === normalizedTarget) return quota;
    // Support canonical selection of generic windows from labeled windows,
    // e.g. "weekly" from "weekly (7d)" or "session" from "session (5h)".
    if (normalizedKey.startsWith(`${normalizedTarget} `)) {
      prefixMatches.push({ key, quota });
    }
  }

  // Deterministic fallback: choose the lexicographically first matching key.
  if (prefixMatches.length > 0) {
    prefixMatches.sort((a, b) => a.key.localeCompare(b.key));
    return prefixMatches[0].quota;
  }

  return null;
}

function earliestResetAt(quotas: Record<string, QuotaInfo>): string | null {
  let earliest: string | null = null;
  let earliestMs = Infinity;
  for (const q of Object.values(quotas)) {
    if (!q.resetAt) continue;
    const ms = parseDate(q.resetAt);
    if (ms !== null && ms < earliestMs) {
      earliestMs = ms;
      earliest = q.resetAt;
    }
  }
  return earliest;
}

/**
 * Decide whether a quota snapshot row is worth persisting.
 *
 * The background refresh ticks every 60s for ALL connections, so idle accounts
 * (whose quota never changes) were generating 400K+ identical snapshot rows/day.
 * Returns true only when this window has no prior cached observation, or when its
 * `remaining_percentage` / `is_exhausted` differs from the last cached entry — so
 * the first observation and every real change persist, but idle no-op refreshes
 * stop writing. Pure (no I/O) for trivial unit testing.
 */
export function quotaSnapshotChanged(
  prior:
    | { quotas?: Record<string, { remainingPercentage: number }>; exhausted?: boolean }
    | null
    | undefined,
  windowKey: string,
  remainingPercentage: number,
  exhausted: boolean
): boolean {
  if (!prior) return true;
  const priorWindow = prior.quotas?.[windowKey];
  if (!priorWindow) return true;
  return (
    priorWindow.remainingPercentage !== remainingPercentage ||
    (prior.exhausted ?? false) !== exhausted
  );
}

function normalizeQuotas(rawQuotas: Record<string, any>): Record<string, QuotaInfo> {
  const result: Record<string, QuotaInfo> = {};
  for (const [key, q] of Object.entries(rawQuotas)) {
    if (q && typeof q === "object") {
      result[key] = {
        remainingPercentage:
          safePercentage(q.remainingPercentage) ??
          (q.total > 0 ? Math.round(((q.total - (q.used || 0)) / q.total) * 100) : 0),
        resetAt: q.resetAt || null,
      };
    }
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function __clearForTests() {
  getState().cache.clear();
}

function isAntigravityQuotaExhausted(
  connectionId: string,
  entry: QuotaCacheEntry,
  requestedModel: string | null
): boolean {
  if (!requestedModel) return entry.exhausted;
  const quotaNames = Object.keys(entry.quotas || {});
  if (quotaNames.length === 0) return entry.exhausted;
  const requestedFamily = getAntigravityQuotaFamily(requestedModel);
  const cleanRequestedModel = requestedModel.replace(/^(antigravity|agy)\//, "");
  const matchingWindows = quotaNames.filter((windowName) => {
    if (requestedFamily === "other") {
      return windowName.replace(/^(antigravity|agy)\//, "") === cleanRequestedModel;
    }
    return getAntigravityQuotaFamily(windowName) === requestedFamily;
  });
  return (
    matchingWindows.length > 0 &&
    matchingWindows.every(
      (windowName) => getQuotaWindowStatus(connectionId, windowName, 100)?.reachedThreshold
    )
  );
}

function isCodexQuotaExhausted(
  connectionId: string,
  entry: QuotaCacheEntry,
  requestedModel: string | null
): boolean {
  if (!requestedModel) return entry.exhausted;
  const quotaNames = Object.keys(entry.quotas || {});
  if (quotaNames.length === 0) return entry.exhausted;
  const filterWindow = getCodexQuotaWindowFilterForModel(requestedModel);
  const scopedWindowNames = quotaNames.filter((windowName) => filterWindow?.(windowName));
  return (
    scopedWindowNames.length > 0 &&
    scopedWindowNames.every(
      (windowName) => getQuotaWindowStatus(connectionId, windowName, 100)?.reachedThreshold
    )
  );
}

function isStandardQuotaExhausted(
  entry: QuotaCacheEntry,
  now: number,
  requestedModel: string | null = null
): boolean {
  // A used-up time window (5h, weekly, a per-model weekly window for this model) blocks
  // until its own reset time, whatever the other windows say.
  if (
    !entry.overageAllowed &&
    blockingWindowResetAt(entry.quotas || {}, requestedModel, now, entry.provider)
  ) {
    return true;
  }
  if (!entry.exhausted) return false;
  const age = now - entry.fetchedAt;
  if (!entry.nextResetAt && age > EXHAUSTED_TTL_MS) return false;
  return true;
}

export function isQuotaExhaustedForRequest(
  connectionId: string,
  provider: string,
  requestedModel: string | null = null
): boolean {
  const entry = getState().cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return false;

  const now = Date.now();
  const advanced = advancedWindowResetAt(entry, now);
  if (advanced) {
    entry.exhausted = false;
    return false;
  }

  if (provider === "antigravity" || provider === "agy") {
    return isAntigravityQuotaExhausted(connectionId, entry, requestedModel);
  }

  if (provider === "codex") {
    return isCodexQuotaExhausted(connectionId, entry, requestedModel);
  }

  // Standard (non-per-model-quota) providers: any used-up time window, else the aggregate
  return isStandardQuotaExhausted(entry, now, requestedModel);
}

/**
 * The owner reset the account by hand: its used-up windows stop blocking now and after a
 * restart. The windows are kept (at 1%, reset unknown) so the next usage sync or response
 * headers replace them with real numbers; a blocking snapshot is superseded by a new row.
 */
export function clearQuotaCacheEntry(connectionId: string): void {
  const state = getState();
  const entry = state.cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return;
  const quotas: Record<string, QuotaInfo> = {};
  for (const [name, q] of Object.entries(entry.quotas || {})) {
    const blocked = q.remainingPercentage <= 0;
    quotas[name] = blocked ? { remainingPercentage: 1, resetAt: null } : q;
    if (!blocked) continue;
    try {
      saveQuotaSnapshot({
        provider: entry.provider,
        connection_id: connectionId,
        window_key: name,
        remaining_percentage: 1,
        is_exhausted: 0,
        next_reset_at: null,
        window_duration_ms: null,
        raw_data: null,
      });
    } catch (error) {
      console.error("[quotaCache] Failed to save snapshot:", error);
    }
  }
  state.cache.set(connectionId, {
    ...entry,
    quotas,
    fetchedAt: Date.now(),
    exhausted: false,
    nextResetAt: null,
  });
}

/**
 * When this account is blocked by a used-up usage window (for this model), the time it is
 * usable again (ISO), else null. Memory only: never reads the network.
 */
export function getQuotaBlockedUntil(
  connectionId: string,
  requestedModel: string | null = null
): string | null {
  const entry = getState().cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry || entry.overageAllowed) return null;
  return blockingWindowResetAt(entry.quotas || {}, requestedModel, Date.now(), entry.provider);
}

/**
 * Store quota data for a connection (called by usage endpoint and background refresh).
 */
export function setQuotaCache(
  connectionId: string,
  provider: string,
  rawQuotas: Record<string, any>,
  options: { overageAllowed?: boolean } = {}
) {
  const quotas = normalizeQuotas(rawQuotas);
  const overageAllowed = options.overageAllowed === true;
  const { exhausted, nextResetAt } = exhaustionOf(quotas, provider, overageAllowed);
  // Capture the prior entry BEFORE overwriting the cache so we can skip
  // redundant snapshot writes for idle connections whose quota didn't change.
  const prior = getState().cache.get(connectionId);
  const entry: QuotaCacheEntry = {
    connectionId,
    provider,
    quotas,
    fetchedAt: Date.now(),
    exhausted,
    nextResetAt,
    ...(overageAllowed ? { overageAllowed: true } : {}),
  };
  getState().cache.set(connectionId, entry);

  if (entry && rawQuotas) {
    for (const [windowKey, quotaInfo] of Object.entries(rawQuotas)) {
      if (!quotaInfo || typeof quotaInfo !== "object") continue;
      const remainingPercentage =
        safePercentage(quotaInfo.remainingPercentage) ??
        (quotaInfo.total > 0
          ? Math.round(((quotaInfo.total - (quotaInfo.used || 0)) / quotaInfo.total) * 100)
          : 0);
      recordProviderQuotaResetEventIfChanged({
        provider,
        connectionId,
        windowKey,
        currentResetAt: quotaInfo.resetAt ?? null,
        currentRemainingPercentage: remainingPercentage,
        previousObservation: prior?.quotas?.[windowKey]
          ? {
              resetAt: prior.quotas[windowKey].resetAt,
              remainingPercentage: prior.quotas[windowKey].remainingPercentage,
            }
          : null,
      });
      // is_exhausted must reflect THIS window's own remaining
      // percentage, not the connection-wide AND-across-all-windows aggregate
      // (`entry.exhausted`). A connection with one 0% window and other non-zero
      // windows previously never flagged that window's row as exhausted.
      const windowExhausted = remainingPercentage <= 0;
      // Only persist on the first observation or a real change (an overage
      // change counts: a restart must know a used-up window does not block this account).
      const overageChanged = (prior?.overageAllowed === true) !== overageAllowed;
      if (
        !overageChanged &&
        !quotaSnapshotChanged(prior, windowKey, remainingPercentage, windowExhausted)
      ) {
        continue;
      }
      try {
        saveQuotaSnapshot({
          provider,
          connection_id: connectionId,
          window_key: windowKey,
          remaining_percentage: remainingPercentage,
          is_exhausted: windowExhausted ? 1 : 0,
          next_reset_at: quotaInfo.resetAt ?? null,
          window_duration_ms: entry.windowDurationMs ?? null,
          raw_data: overageAllowed ? OVERAGE_SNAPSHOT_MARK : null,
        });
      } catch (error) {
        console.error("[quotaCache] Failed to save snapshot:", error);
      }
    }
  }
}

/**
 * Get cached quota entry (returns null if not cached).
 */
export function getQuotaCache(connectionId: string): QuotaCacheEntry | null {
  return getState().cache.get(connectionId) || null;
}

function hydrateQuotaCacheFromSnapshots(connectionId: string): QuotaCacheEntry | null {
  const { cache } = getState();
  if (cache.has(connectionId)) return cache.get(connectionId) || null;

  let snapshots;
  try {
    snapshots = getLatestQuotaSnapshotsForConnection(connectionId);
  } catch {
    return null;
  }
  if (!snapshots.length) return null;

  const quotas: Record<string, QuotaInfo> = {};
  let provider = "";
  let fetchedAt = 0;
  let windowDurationMs: number | null = null;
  let overageAllowed = false;

  for (const snapshot of snapshots) {
    const rawData = (snapshot as { rawData?: unknown }).rawData ?? snapshot.raw_data;
    if (rawData === OVERAGE_SNAPSHOT_MARK) overageAllowed = true;
    const camelSnapshot = snapshot as unknown as {
      windowKey?: string;
      remainingPercentage?: number | null;
      isExhausted?: number;
      nextResetAt?: string | null;
      windowDurationMs?: number | null;
      createdAt?: string;
    };
    const windowKey = camelSnapshot.windowKey ?? snapshot.window_key;
    if (!windowKey) continue;
    provider = provider || snapshot.provider || "";
    quotas[windowKey] = {
      remainingPercentage: clampPercent(
        Number(camelSnapshot.remainingPercentage ?? snapshot.remaining_percentage ?? 0)
      ),
      resetAt: camelSnapshot.nextResetAt ?? snapshot.next_reset_at ?? null,
    };
    const snapshotWindowDurationMs =
      camelSnapshot.windowDurationMs ?? snapshot.window_duration_ms ?? null;
    if (snapshotWindowDurationMs && snapshotWindowDurationMs > 0) {
      windowDurationMs = snapshotWindowDurationMs;
    }
    const createdAtVal = camelSnapshot.createdAt ?? snapshot.created_at;
    const createdAtMs = createdAtVal ? parseDate(createdAtVal) : null;
    if (createdAtMs !== null) fetchedAt = Math.max(fetchedAt, createdAtMs);
  }

  if (Object.keys(quotas).length === 0) return null;
  const { exhausted, nextResetAt } = exhaustionOf(quotas, provider, overageAllowed);

  const entry: QuotaCacheEntry = {
    connectionId,
    provider,
    quotas,
    fetchedAt: fetchedAt || Date.now(),
    exhausted,
    nextResetAt,
    windowDurationMs,
    ...(overageAllowed ? { overageAllowed: true } : {}),
  };
  cache.set(connectionId, entry);
  return entry;
}

/**
 * Check if an account's quota is exhausted based on cached data.
 * Returns false if no cache entry exists (unknown = assume available).
 */
export function isAccountQuotaExhausted(connectionId: string): boolean {
  const entry = getState().cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return false;
  if (!entry.exhausted) return false;

  const now = Date.now();

  // Auto window advance: if resetAt is in the past, eagerly treat as not exhausted.
  // This prevents stale exhaustion blocking when background refresh hasn't run yet.
  const advanced = advancedWindowResetAt(entry, now);
  if (advanced) {
    // Optimistically clear the exhausted flag so we unblock requests immediately.
    // The next background refresh will update with the real quota state.
    entry.exhausted = false;
    return false;
  }

  // Exhausted entries without resetAt expire after fixed TTL
  const age = now - entry.fetchedAt;
  if (!entry.nextResetAt && age > EXHAUSTED_TTL_MS) return false;

  return true;
}

/**
 * Return quota window status for a connection (e.g., session/weekly).
 * Returns null when no cache or no window data is available.
 */
export function getQuotaWindowStatus(
  connectionId: string,
  windowName: string,
  thresholdPercent = DEFAULT_QUOTA_THRESHOLD_PERCENT
): QuotaWindowStatus | null {
  const entry = getState().cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  if (!entry) return null;

  const now = Date.now();

  const window = resolveQuotaWindow(entry.quotas, windowName);
  if (!window) return null;

  const remainingPercentage = clampPercent(window.remainingPercentage);
  const usedPercentage = clampPercent(100 - remainingPercentage);

  let resetAt = window.resetAt || null;
  let windowExpired = false;
  if (resetAt) {
    const resetMs = parseDate(resetAt);
    if (resetMs !== null && resetMs <= now) {
      resetAt = null;
      windowExpired = true;
    }
  }

  return {
    remainingPercentage,
    usedPercentage,
    resetAt,
    // If reset time has already passed, avoid stale cached percentages blocking selection.
    reachedThreshold: windowExpired ? false : usedPercentage >= thresholdPercent,
  };
}

/**
 * Flag the account exhausted after a usage-limit 429. The known windows are kept: it stays
 * blocked until the latest used-up window's reset, else for EXHAUSTED_TTL_MS (5 minutes).
 */
export function markAccountExhaustedFrom429(connectionId: string, provider: string) {
  // Keep the windows we already know (they carry the real reset times); only flag the entry.
  const prior = getState().cache.get(connectionId);
  const quotas = prior?.quotas || {};
  getState().cache.set(connectionId, {
    connectionId,
    provider,
    quotas,
    fetchedAt: Date.now(),
    exhausted: true,
    // a prior reset that already passed would unblock the 429 mark at once: drop it
    nextResetAt:
      blockingWindowResetAt(quotas, null, Date.now(), provider) ||
      (prior?.nextResetAt && (parseDate(prior.nextResetAt) ?? 0) > Date.now()
        ? prior.nextResetAt
        : null),
    windowDurationMs: prior?.windowDurationMs ?? null,
  });
}

// ─── Usage headers on every response (Claude) ───────────────────────────────
//
// Claude answers every request with its subscription usage (names and meaning as read in
// the Claude Code 2.1.319 client): anthropic-ratelimit-unified-{5h,7d}-utilization is a 0..1
// fraction, -{5h,7d}-reset is epoch seconds, -status is allowed | allowed_warning | rejected,
// and a refusal names the used-up window in -representative-claim with its -reset. Paid
// overage keeps an account usable, so it is blocked only when -overage-status is missing or
// rejected. Reading them costs nothing (no extra request) and keeps the windows current.

const UNIFIED = "anthropic-ratelimit-unified-";
const CLAIM_WINDOW: Record<string, string> = {
  five_hour: "session (5h)",
  seven_day: "weekly (7d)",
  seven_day_opus: "weekly opus (7d)",
  seven_day_sonnet: "weekly sonnet (7d)",
};

// The longest window Claude reports is 7 days; a reset further away is not trusted.
const MAX_HEADER_RESET_MS = 8 * 24 * 3600 * 1000;

function epochSecondsToIso(value: string | undefined): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Math.round(n) * 1000;
  if (ms > Date.now() + MAX_HEADER_RESET_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * Update the cached windows of a connection from Claude's usage headers. A response without
 * them (every other provider) changes nothing.
 */
export function applyUnifiedUsageHeaders(
  connectionId: string,
  provider: string,
  headers: Record<string, string> | null | undefined
): void {
  if (!connectionId || !headers) return;
  const status = headers[`${UNIFIED}status`];
  if (!status) return;

  const state = getState();
  const prior = state.cache.get(connectionId) || hydrateQuotaCacheFromSnapshots(connectionId);
  const quotas: Record<string, QuotaInfo> = { ...(prior?.quotas || {}) };

  for (const [suffix, name] of [
    ["5h", "session (5h)"],
    ["7d", "weekly (7d)"],
  ] as const) {
    const utilization = Number(headers[`${UNIFIED}${suffix}-utilization`]);
    const resetAt = epochSecondsToIso(headers[`${UNIFIED}${suffix}-reset`]);
    const windowStatus = headers[`${UNIFIED}${suffix}-status`];
    if (!Number.isFinite(utilization) && !resetAt && !windowStatus) continue;
    let remaining = Number.isFinite(utilization)
      ? clampPercent(Math.round(100 - utilization * 100))
      : (quotas[name]?.remainingPercentage ?? 100);
    // Headers block an account only when Claude itself refuses: a window it still serves
    // (overage, rounding) never reads as used up.
    if (windowStatus === "rejected") remaining = 0;
    else if (remaining <= 0) remaining = 1;
    quotas[name] = {
      remainingPercentage: remaining,
      resetAt: resetAt ?? quotas[name]?.resetAt ?? null,
    };
  }

  const overage = headers[`${UNIFIED}overage-status`];
  const rejected = status === "rejected" && (!overage || overage === "rejected");
  // Answered (or allowed) while a window is used up = paid overage is carrying the account.
  const overageAllowed = !rejected && (overage === "allowed" || overage === "allowed_warning");
  const claim = headers[`${UNIFIED}representative-claim`] || "";
  const claimReset = epochSecondsToIso(headers[`${UNIFIED}reset`]);
  let windowName: string | null = null;
  if (rejected) {
    windowName = CLAIM_WINDOW[claim] || null;
    if (windowName && claimReset) {
      quotas[windowName] = { remainingPercentage: 0, resetAt: claimReset };
    }
  } else {
    // An account that answered is not blocked by a per-model window it no longer reports.
    for (const name of Object.keys(quotas)) {
      if (windowModelScope(name) && quotas[name].remainingPercentage <= 0) {
        const ms = quotas[name].resetAt ? parseDate(quotas[name].resetAt as string) : null;
        if (ms === null || ms <= Date.now()) delete quotas[name];
      }
    }
  }

  const { exhausted, nextResetAt } = exhaustionOf(quotas, provider, overageAllowed);
  state.cache.set(connectionId, {
    connectionId,
    provider,
    quotas,
    fetchedAt: Date.now(),
    exhausted,
    nextResetAt,
    windowDurationMs: prior?.windowDurationMs ?? null,
    ...(overageAllowed ? { overageAllowed: true } : {}),
  });

  // Persist only when the blocking state changes (restart-safe, one row per change).
  const wasBlocked = Boolean(
    prior &&
    !prior.overageAllowed &&
    blockingWindowResetAt(prior.quotas || {}, null, Date.now(), provider)
  );
  const nowBlocked = Boolean(
    !overageAllowed && blockingWindowResetAt(quotas, null, Date.now(), provider)
  );
  const changedModelWindow =
    rejected && windowName !== null && windowModelScope(windowName) !== null;
  const changedOverage = (prior?.overageAllowed === true) !== overageAllowed;
  if (wasBlocked !== nowBlocked || changedModelWindow || changedOverage) {
    for (const [windowKey, q] of Object.entries(quotas)) {
      try {
        saveQuotaSnapshot({
          provider,
          connection_id: connectionId,
          window_key: windowKey,
          remaining_percentage: q.remainingPercentage,
          is_exhausted: q.remainingPercentage <= 0 ? 1 : 0,
          next_reset_at: q.resetAt ?? null,
          window_duration_ms: null,
          raw_data: overageAllowed ? OVERAGE_SNAPSHOT_MARK : null,
        });
      } catch (error) {
        console.error("[quotaCache] Failed to save snapshot:", error);
      }
    }
  }
}

// ─── Background Refresh ─────────────────────────────────────────────────────

async function refreshEntry(entry: QuotaCacheEntry) {
  const { cache, refreshingSet } = getState();
  if (refreshingSet.has(entry.connectionId)) return;
  refreshingSet.add(entry.connectionId);

  try {
    const connection = await getCachedProviderConnectionById(entry.connectionId);
    if (!connection || !connection.isActive) {
      cache.delete(entry.connectionId);
      return;
    }
    if (connection.authType !== "oauth") {
      // No usage endpoint to ask: keep a block learned from response headers until it resets.
      if (!blockingWindowResetAt(entry.quotas || {}, null, Date.now(), entry.provider)) {
        cache.delete(entry.connectionId);
      }
      return;
    }

    const proxyInfo = await resolveProxyForConnection(entry.connectionId);
    const usage = await runWithProxyContext(proxyInfo?.proxy || null, () =>
      getUsageForProvider(connection)
    );

    if (usage?.quotas) {
      setQuotaCache(entry.connectionId, entry.provider, usage.quotas, {
        overageAllowed: isClaudeOverageAllowed(connection, usage),
      });
    }
  } catch (err) {
    console.warn(
      `[QuotaCache] Refresh failed for ${entry.connectionId.slice(0, 8)}:`,
      (err as any)?.message || err
    );
  } finally {
    refreshingSet.delete(entry.connectionId);
  }
}

function needsRefresh(entry: QuotaCacheEntry, now: number): boolean {
  const age = now - entry.fetchedAt;
  if (entry.exhausted) {
    if (entry.nextResetAt) {
      const resetMs = parseDate(entry.nextResetAt);
      if (resetMs !== null && resetMs <= now) return true;
    }
    return age >= EXHAUSTED_REFRESH_MS;
  }
  return age >= ACTIVE_TTL_MS;
}

async function backgroundRefreshTick() {
  const state = getState();
  if (state.tickRunning) return;
  state.tickRunning = true;

  try {
    cleanupOldSnapshots();
    const now = Date.now();
    const pending = [...state.cache.values()].filter((e) => needsRefresh(e, now));

    // Refresh in batches to avoid thundering herd
    for (let i = 0; i < pending.length; i += MAX_CONCURRENT_REFRESHES) {
      const batch = pending.slice(i, i + MAX_CONCURRENT_REFRESHES);
      await Promise.allSettled(batch.map(refreshEntry));
    }
  } finally {
    state.tickRunning = false;
  }
}

/**
 * Start the background refresh timer.
 */
export function startBackgroundRefresh() {
  const state = getState();
  if (state.refreshTimer) return;
  state.refreshTimer = setInterval(backgroundRefreshTick, REFRESH_INTERVAL_MS);
  state.refreshTimer?.unref?.();
}

/**
 * Stop the background refresh timer.
 */
export function stopBackgroundRefresh() {
  const state = getState();
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

/**
 * Get cache stats (for debugging/dashboard).
 */
export function getQuotaCacheStats() {
  const entries: Array<{
    connectionId: string;
    provider: string;
    exhausted: boolean;
    nextResetAt: string | null;
    ageMs: number;
  }> = [];

  const { cache } = getState();
  for (const entry of cache.values()) {
    entries.push({
      connectionId: entry.connectionId.slice(0, 8) + "...",
      provider: entry.provider,
      exhausted: entry.exhausted,
      nextResetAt: entry.nextResetAt,
      ageMs: Date.now() - entry.fetchedAt,
    });
  }

  return { total: cache.size, entries };
}
