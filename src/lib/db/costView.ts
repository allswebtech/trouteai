import { getDbInstance } from "./core";

/**
 * Read-only sums for the "what it costs" view on the runtime page (/api/usage/live).
 *
 * Source: `usage_history`, one row per upstream attempt. A request that was retried on another
 * account leaves a failed row (no tokens) for the first attempt and a row with the tokens for the
 * attempt that answered, so a key's requests are its answered rows and its tokens are summed once.
 *
 * "Today" starts at 00:00 UTC; "this week" is the last seven UTC days, today included.
 * `tokens_input` already holds every input token, cache reads included, so the cache share is
 * cache reads / input, counted only over upstreams that report cache figures at all.
 */

export interface CostWindows {
  dayStart: string;
  weekStart: string;
}

export interface KeyCostRow {
  apiKeyId: string | null;
  apiKeyName: string | null;
  today: KeyCostWindow;
  week: KeyCostWindow;
}

export interface KeyCostWindow {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Input tokens sent to upstreams that report prompt cache figures. */
  inputWithCacheFigures: number;
  /** cacheReadTokens / inputWithCacheFigures, or null when no upstream of this key reports any. */
  cacheShare: number | null;
  /** True when none of this window's input went to an upstream that reports cache figures. */
  noCacheFigures: boolean;
}

export interface AccountCostRow {
  connectionId: string;
  requestsToday: number;
  failedToday: number;
  inputTokensToday: number;
  outputTokensToday: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getCostWindows(nowMs: number = Date.now()): CostWindows {
  const day = new Date(nowMs);
  day.setUTCHours(0, 0, 0, 0);
  return {
    dayStart: day.toISOString(),
    weekStart: new Date(day.getTime() - 6 * DAY_MS).toISOString(),
  };
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function buildWindow(
  requests: unknown,
  input: unknown,
  output: unknown,
  cacheRead: unknown,
  inputWithFigures: unknown
): KeyCostWindow {
  const covered = num(inputWithFigures);
  const read = num(cacheRead);
  return {
    requests: num(requests),
    inputTokens: num(input),
    outputTokens: num(output),
    cacheReadTokens: read,
    inputWithCacheFigures: covered,
    cacheShare: covered > 0 ? read / covered : null,
    noCacheFigures: covered === 0,
  };
}

// Providers that reported a cache figure this week: a cache read or write in usage_history, or a
// non-null cache field in call_logs (a reported 0 is still a figure).
const REPORTING_PROVIDERS = `
  SELECT provider FROM usage_history
   WHERE timestamp >= @weekStart AND (tokens_cache_read > 0 OR tokens_cache_creation > 0)
  UNION
  SELECT provider FROM call_logs
   WHERE timestamp >= @weekStart
     AND (tokens_cache_read IS NOT NULL OR tokens_cache_creation IS NOT NULL)`;

export function getKeyCostSums(nowMs: number = Date.now()): KeyCostRow[] {
  const { dayStart, weekStart } = getCostWindows(nowMs);
  const rows = getDbInstance()
    .prepare(
      `WITH reporting AS (${REPORTING_PROVIDERS})
       SELECT api_key_id AS apiKeyId, MAX(api_key_name) AS apiKeyName,
         SUM(CASE WHEN timestamp >= @dayStart AND success = 1 THEN 1 ELSE 0 END) AS reqDay,
         SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS reqWeek,
         SUM(CASE WHEN timestamp >= @dayStart THEN tokens_input ELSE 0 END) AS inDay,
         SUM(tokens_input) AS inWeek,
         SUM(CASE WHEN timestamp >= @dayStart THEN tokens_output ELSE 0 END) AS outDay,
         SUM(tokens_output) AS outWeek,
         SUM(CASE WHEN timestamp >= @dayStart THEN tokens_cache_read ELSE 0 END) AS cacheDay,
         SUM(tokens_cache_read) AS cacheWeek,
         SUM(CASE WHEN timestamp >= @dayStart AND provider IN (SELECT provider FROM reporting)
                  THEN tokens_input ELSE 0 END) AS coveredDay,
         SUM(CASE WHEN provider IN (SELECT provider FROM reporting)
                  THEN tokens_input ELSE 0 END) AS coveredWeek
       FROM usage_history
       WHERE timestamp >= @weekStart
       GROUP BY api_key_id
       ORDER BY inWeek DESC`
    )
    .all({ dayStart, weekStart }) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    apiKeyId: (r.apiKeyId as string | null) ?? null,
    apiKeyName: (r.apiKeyName as string | null) ?? null,
    today: buildWindow(r.reqDay, r.inDay, r.outDay, r.cacheDay, r.coveredDay),
    week: buildWindow(r.reqWeek, r.inWeek, r.outWeek, r.cacheWeek, r.coveredWeek),
  }));
}

export function getAccountCostSums(nowMs: number = Date.now()): AccountCostRow[] {
  const { dayStart } = getCostWindows(nowMs);
  const rows = getDbInstance()
    .prepare(
      `SELECT connection_id AS connectionId,
         COUNT(*) AS requestsToday,
         SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END) AS failedToday,
         SUM(tokens_input) AS inputTokensToday,
         SUM(tokens_output) AS outputTokensToday
       FROM usage_history
       WHERE timestamp >= @dayStart AND connection_id IS NOT NULL
       GROUP BY connection_id`
    )
    .all({ dayStart }) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    connectionId: String(r.connectionId),
    requestsToday: num(r.requestsToday),
    failedToday: num(r.failedToday),
    inputTokensToday: num(r.inputTokensToday),
    outputTokensToday: num(r.outputTokensToday),
  }));
}
