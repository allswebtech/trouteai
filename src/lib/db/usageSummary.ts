import { getDbInstance } from "./core.ts";
import type { SqliteAdapter } from "./adapters/types.ts";

/** Total input+output tokens rolled up in daily_usage_summary for the current calendar month. */
export function sumUsageTokensThisMonth(db: SqliteAdapter = getDbInstance()): number {
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS used
         FROM daily_usage_summary
         WHERE date >= strftime('%Y-%m-01','now')`
      )
      .get() as { used: number } | undefined;
    return row?.used ?? 0;
  } catch {
    return 0; // table may not exist yet on a fresh install — treat as 0 used
  }
}

/** Ids of the provider connections that served a request at or after `sinceIso`. */
export function getConnectionIdsUsedSince(
  sinceIso: string,
  db: SqliteAdapter = getDbInstance()
): Set<string> {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT connection_id AS id FROM usage_history
         WHERE timestamp >= ? AND connection_id IS NOT NULL`
      )
      .all(sinceIso) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } catch {
    return new Set();
  }
}
