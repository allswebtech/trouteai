import { getDbInstance } from "../db/core";

// node:sqlite's StatementSync.all() materializes the ENTIRE result set as
// JS objects at once. On a large storage.sqlite (~170 MB+) an unbounded
// `SELECT … FROM call_logs` over the whole table blows the V8 heap during the
// startup cleanup pass (`cleanupExpiredLogs` → `rotateCallLogs`), crashing the
// daemon before it binds. These helpers page through call_logs in bounded chunks
// so peak memory stays flat regardless of table size.
const CALL_LOG_QUERY_PAGE = 5000;

/**
 * Collect every non-null `artifact_relpath` referenced by call_logs, using keyset
 * paging on rowid so a huge table never loads into memory in one `.all()`.
 */
export function collectReferencedArtifacts(): Set<string> {
  const db = getDbInstance();
  const referenced = new Set<string>();
  const stmt = db.prepare(
    "SELECT rowid AS rid, artifact_relpath FROM call_logs WHERE artifact_relpath IS NOT NULL AND rowid > ? ORDER BY rowid LIMIT ?"
  );
  let lastRid = 0;
  for (;;) {
    const rows = stmt.all(lastRid, CALL_LOG_QUERY_PAGE) as Array<{
      rid: number;
      artifact_relpath: string | null;
    }>;
    for (const row of rows) {
      if (typeof row.artifact_relpath === "string") referenced.add(row.artifact_relpath);
    }
    if (rows.length < CALL_LOG_QUERY_PAGE) break;
    lastRid = Number(rows[rows.length - 1].rid);
  }
  return referenced;
}

/**
 * Select one bounded page of call_log ids older than `cutoff` (oldest first).
 * Callers loop until it returns an empty page, deleting each batch, so the id
 * list never grows to the full retention backlog at once.
 */
export function selectCallLogIdsBefore(cutoff: string, limit = CALL_LOG_QUERY_PAGE): string[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT id FROM call_logs WHERE timestamp < ? ORDER BY timestamp ASC LIMIT ?")
    .all(cutoff, limit) as Array<{ id: string }>;
  return rows.map((row) => String(row.id));
}
