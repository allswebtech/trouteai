/**
 * Credential Health Check Scheduler
 *
 * Background scheduler that periodically tests provider credential health.
 * Follows the pattern from localHealthCheck.ts — runs on a configurable
 * interval with exponential backoff on failure.
 *
 * Reuses the existing testSingleConnection() infrastructure so all 20+
 * provider-specific validators work automatically.
 *
 * Schedule:
 *   - Initial delay: 30s after server boot (allows DB migrations to complete)
 *   - Interval: configurable via CREDENTIAL_HEALTH_CHECK_INTERVAL (default 5 min)
 *   - OAuth connections: tested less frequently (2x interval)
 *   - Backoff on failure: 10min -> 30min -> max 2h
 *   - Resets to default on success
 *   - Each connection has its own next-due time; the sweep ticks at the base interval
 */

import { testSingleConnection } from "@/app/api/providers/[id]/test/route";
import { getProviderConnections } from "@/lib/localDb";
import {
  setCredentialHealth,
  removeCredentialHealth,
  initCredentialCache,
} from "@/lib/credentialHealth/cache";
import { emit } from "@/lib/events/eventBus";
import { isAutomatedTestProcess, isBuildProcess } from "@/shared/utils/testProcess";

// ── Config ────────────────────────────────────────────────────────────────

const BACKOFF_SCHEDULE = [300_000, 600_000, 1_800_000, 7_200_000]; // index 0 unused: first failure already counts 1 -> 10min, 30min, 2h
const INITIAL_DELAY_MS = 30_000; // Wait for server boot
const OAUTH_INTERVAL_MULTIPLIER = 2; // OAuth tested 2x less frequently
const DUE_SLACK_MS = 5_000; // Timer jitter tolerance when checking next-due times
const CONCURRENCY_LIMIT = 5; // Max simultaneous connection tests
const LOG_PREFIX = "[CredentialHealth]";
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

// ── State (globalThis singleton) ──────────────────────────────────────────

declare global {
  var __trouteaiCredentialHC:
    | {
        initialized: boolean;
        sweepTimer: ReturnType<typeof setTimeout> | null;
        sweepInProgress: boolean;
        /** Track consecutive scheduler failures per connection for backoff */
        failureCounts: Map<string, number>;
        /** Epoch ms when each connection is due for its next test */
        nextDueAt: Map<string, number>;
      }
    | undefined;
}

function getSchedulerState() {
  if (!globalThis.__trouteaiCredentialHC) {
    globalThis.__trouteaiCredentialHC = {
      initialized: false,
      sweepTimer: null,
      sweepInProgress: false,
      failureCounts: new Map(),
      nextDueAt: new Map(),
    };
  }
  // Older singleton from before nextDueAt existed (HMR)
  if (!globalThis.__trouteaiCredentialHC.nextDueAt) {
    globalThis.__trouteaiCredentialHC.nextDueAt = new Map();
  }
  return globalThis.__trouteaiCredentialHC;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isCredentialHealthCheckDisabled(): boolean {
  if (isBuildProcess() || isAutomatedTestProcess()) return true;
  const val = process.env.TROUTEAI_DISABLE_CREDENTIAL_HEALTH_CHECK;
  return val ? TRUE_ENV_VALUES.has(val.trim().toLowerCase()) : false;
}

function getSweepInterval(): number {
  const envVal = process.env.CREDENTIAL_HEALTH_CHECK_INTERVAL;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed >= 10_000) return parsed;
  }
  return 300_000; // default 5 min
}

function getNextBackoff(connectionId: string): number {
  const state = getSchedulerState();
  const failures = state.failureCounts.get(connectionId) ?? 0;
  return BACKOFF_SCHEDULE[Math.min(failures, BACKOFF_SCHEDULE.length - 1)];
}

function markTested(connectionId: string, isOAuth: boolean, success: boolean): void {
  const state = getSchedulerState();
  const interval = getSweepInterval();
  const delay = success
    ? isOAuth
      ? interval * OAUTH_INTERVAL_MULTIPLIER
      : interval
    : getNextBackoff(connectionId);
  state.nextDueAt.set(connectionId, Date.now() + delay);
}

// ── Core Sweep Logic ─────────────────────────────────────────────────────

async function testConnection(
  connectionId: string,
  provider: string,
  isOAuth: boolean
): Promise<void> {
  const startTime = Date.now();

  let oldStatus: string | undefined;
  try {
    const { getCredentialHealth } = await import("@/lib/credentialHealth/cache");
    const prev = getCredentialHealth(connectionId);
    oldStatus = prev?.status;
  } catch {}
  try {
    const result = await testSingleConnection(connectionId, undefined, { background: true });

    const latencyMs = Date.now() - startTime;
    const state = getSchedulerState();

    if (result.valid) {
      // Success — reset failure count, update cache
      state.failureCounts.delete(connectionId);
      markTested(connectionId, isOAuth, true);
      setCredentialHealth(
        connectionId,
        provider,
        "active",
        undefined,
        undefined,
        undefined,
        latencyMs
      );
      emit("credential.health.changed", {
        connectionId,
        provider,
        oldStatus: oldStatus || "unknown",
        newStatus: "active",
        timestamp: Date.now(),
      });
    } else {
      // Failure — increment failure count, update cache with error
      const currentFailures = (state.failureCounts.get(connectionId) ?? 0) + 1;
      state.failureCounts.set(connectionId, currentFailures);
      markTested(connectionId, isOAuth, false);

      const diagnosis = result.diagnosis as { type?: string; source?: string } | undefined;

      setCredentialHealth(
        connectionId,
        provider,
        "error",
        result.error || "Unknown error",
        diagnosis?.type || "unknown",
        diagnosis?.source || "unknown",
        latencyMs
      );
      emit("credential.health.changed", {
        connectionId,
        provider,
        oldStatus: oldStatus || "unknown",
        newStatus: "error",
        timestamp: Date.now(),
      });

      // Log state transition on consecutive failures
      if (currentFailures <= 2) {
        const backoff = getNextBackoff(connectionId);
        console.log(
          LOG_PREFIX,
          `❌ ${provider}/${connectionId} — ${result.error || "Connection failed"}` +
            ` [${latencyMs}ms] (failure #${currentFailures}, next check in ${backoff / 1000}s)`
        );
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Scheduler error";
    const latencyMs = Date.now() - startTime;
    const state = getSchedulerState();

    const currentFailures = (state.failureCounts.get(connectionId) ?? 0) + 1;
    state.failureCounts.set(connectionId, currentFailures);
    markTested(connectionId, isOAuth, false);

    setCredentialHealth(connectionId, provider, "error", message);

    if (currentFailures <= 2) {
      console.log(
        LOG_PREFIX,
        `⚠️ ${provider}/${connectionId} — ${message} [${latencyMs}ms] (failure #${currentFailures})`
      );
    }
  }
}

/**
 * Single sweep: test all provider connections in parallel (with concurrency limit).
 */
export async function sweep(): Promise<void> {
  const state = getSchedulerState();
  if (state.sweepInProgress) return;
  state.sweepInProgress = true;

  try {
    // Get all provider connections (API-key + OAuth)
    let connections: Array<{
      id: string;
      provider: string;
      authType?: string;
    }>;

    try {
      const raw = await getProviderConnections({});
      connections = (Array.isArray(raw) ? raw : []).filter(
        (conn: any) => conn && conn.id && (conn.authType === "apikey" || conn.authType === "oauth")
      ) as Array<{
        id: string;
        provider: string;
        authType?: string;
      }>;
    } catch (err) {
      console.error(LOG_PREFIX, "Failed to load provider connections:", err);
      return;
    }

    // Drop scheduler and cache state for connections that no longer exist
    const liveIds = new Set(connections.map((conn) => conn.id));
    for (const id of state.nextDueAt.keys()) {
      if (!liveIds.has(id)) {
        state.nextDueAt.delete(id);
        state.failureCounts.delete(id);
        removeCredentialHealth(id);
      }
    }
    for (const id of state.failureCounts.keys()) {
      if (!liveIds.has(id)) state.failureCounts.delete(id);
    }

    if (connections.length === 0) return;

    // Small slack so a connection due just after this tick is not pushed a full interval
    const now = Date.now() + DUE_SLACK_MS;
    const dueConnections = connections.filter((conn) => (state.nextDueAt.get(conn.id) ?? 0) <= now);

    if (dueConnections.length === 0) return;

    console.debug(
      LOG_PREFIX,
      `Testing ${dueConnections.length}/${connections.length} connections...`
    );

    // Process with concurrency limit
    const batches: Array<typeof dueConnections> = [];
    for (let i = 0; i < dueConnections.length; i += CONCURRENCY_LIMIT) {
      batches.push(dueConnections.slice(i, i + CONCURRENCY_LIMIT));
    }

    for (const batch of batches) {
      await Promise.allSettled(
        batch.map((conn) => testConnection(conn.id, conn.provider, conn.authType === "oauth"))
      );
    }
  } finally {
    state.sweepInProgress = false;
    scheduleSweep();
  }
}

function scheduleSweep(): void {
  const state = getSchedulerState();
  if (!state.initialized) return;
  if (state.sweepTimer) clearTimeout(state.sweepTimer);

  // Fixed tick; per-connection nextDueAt decides who gets tested
  state.sweepTimer = setTimeout(() => {
    sweep().catch((err) => console.error(LOG_PREFIX, "Sweep failed:", err));
  }, getSweepInterval());
  state.sweepTimer.unref?.();
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Start the credential health check scheduler (idempotent).
 */
export function initCredentialHealthCheck(): void {
  const state = getSchedulerState();
  if (state.initialized || isCredentialHealthCheckDisabled()) return;
  state.initialized = true;
  initCredentialCache();

  console.log(
    LOG_PREFIX,
    `Starting credential health check (initial delay ${INITIAL_DELAY_MS / 1000}s, interval ${getSweepInterval() / 1000}s)`
  );

  state.sweepTimer = setTimeout(() => {
    sweep().catch((err) => console.error(LOG_PREFIX, "Initial sweep failed:", err));
  }, INITIAL_DELAY_MS);
  state.sweepTimer.unref?.();
}

/**
 * Stop the scheduler (for tests / hot-reload).
 */
export function stopCredentialHealthCheck(): void {
  const state = getSchedulerState();
  if (state.sweepTimer) {
    clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }
  state.initialized = false;
}

/**
 * Force an immediate sweep (for manual refresh / testing).
 */
export async function forceSweep(): Promise<void> {
  const state = getSchedulerState();
  state.initialized = true;
  initCredentialCache();
  await sweep();
}

// Auto-initialize on first import
initCredentialHealthCheck();
