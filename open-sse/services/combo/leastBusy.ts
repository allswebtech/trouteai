/**
 * Where a NEW conversation of a round-robin combo starts.
 *
 * A turn of a known conversation keeps its account (that account holds its prompt cache). A new
 * conversation starts on the account that is least busy right now among the usable ones (not
 * limited, not cooling down, not paused), and among equally busy ones on the one used least
 * recently. Without this, conversations that share a system text all hashed onto one account
 * while the others stood idle.
 */
import { getCachedProviderConnections } from "../../../src/lib/db/readCache";
import * as semaphore from "../rateLimitSemaphore.ts";

export interface StartCandidate {
  /** The combo slot gate of the target (`combo:<name>:<executionKey>`). */
  key: string;
  /** False when the target is limited, cooling down or paused right now. */
  usable: boolean;
}

// When each slot gate was last used, as a running number: two uses in the same millisecond
// must still tell which came first.
const lastUsed = new Map<string, number>();
const MAX_TRACKED = 2000;
let useSeq = 0;

/**
 * True when the request is the first turn of a conversation: only system and user messages,
 * no answer and no tool call yet. Anything without a role (a Responses tool item) is not.
 */
export function isFirstTurn(messages: Array<{ role?: string; content?: unknown }> | null): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.every(
    (m) =>
      !!m &&
      typeof m === "object" &&
      (m.role === "user" || m.role === "system" || m.role === "developer") &&
      !("type" in m && (m as { type?: unknown }).type !== "message")
  );
}

/** Candidate indexes in the order a new conversation tries them: usable, least busy, least recently used. */
export function rankStartCandidates(candidates: StartCandidate[]): number[] {
  const rows = candidates.map((candidate, index) => ({
    index,
    usable: candidate.usable,
    running: semaphore.runningCount(candidate.key),
    used: lastUsed.get(candidate.key) ?? -1,
  }));
  rows.sort(
    (a, b) =>
      Number(b.usable) - Number(a.usable) ||
      a.running - b.running ||
      a.used - b.used ||
      a.index - b.index
  );
  // The pick is noted at once: requests that arrive together are ranked before any of them
  // takes a slot, and would otherwise all tie and start on the same account.
  if (rows.length > 0) recordSlotUse(candidates[rows[0].index].key);
  return rows.map((row) => row.index);
}

/** Notes that a request took a slot of this gate now. */
export function recordSlotUse(key: string): void {
  lastUsed.delete(key);
  lastUsed.set(key, useSeq++);
  if (lastUsed.size > MAX_TRACKED) {
    const oldest = lastUsed.keys().next().value;
    if (oldest !== undefined) lastUsed.delete(oldest);
  }
}

const TERMINAL_STATUSES = new Set(["credits_exhausted", "banned", "expired"]);

/**
 * Accounts of these providers that are limited until later, durably out, or whose quota is used
 * up (the quota cache says so: a usage-limit answer or the provider's own figures). Fail-open:
 * empty.
 */
export async function readLimitedConnectionIds(providers: string[]): Promise<Set<string>> {
  const limited = new Set<string>();
  const nowMs = Date.now();
  let quotaUsedUp: (connectionId: string) => boolean = () => false;
  try {
    const quota = await import("../../../src/domain/quotaCache");
    quotaUsedUp = (connectionId) => Boolean(quota.isAccountQuotaExhausted(connectionId));
  } catch {
    // without the quota cache only the account rows decide
  }
  await Promise.all(
    [...new Set(providers.filter((p) => p && p !== "unknown"))].map(async (provider) => {
      try {
        const rows = (await getCachedProviderConnections({ provider, isActive: true })) as Array<
          Record<string, unknown>
        >;
        for (const row of Array.isArray(rows) ? rows : []) {
          const id = typeof row?.id === "string" ? row.id : "";
          if (!id) continue;
          const until = row.rateLimitedUntil ? Date.parse(String(row.rateLimitedUntil)) : NaN;
          const status = typeof row.testStatus === "string" ? row.testStatus : "";
          if (
            (Number.isFinite(until) && until > nowMs) ||
            TERMINAL_STATUSES.has(status) ||
            quotaUsedUp(id)
          ) {
            limited.add(id);
          }
        }
      } catch {
        // an unread account counts as usable; the call itself still checks it
      }
    })
  );
  return limited;
}

/** For tests only. */
export function resetSlotUse(): void {
  lastUsed.clear();
  useSeq = 0;
}
