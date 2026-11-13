import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createBetterSqliteAdapter } from "./betterSqliteAdapter";
import { createBunSqliteAdapter, type BunSqliteDatabaseLike } from "./bunSqliteAdapter";
import {
  createNodeSqliteAdapterFromDatabase,
  type NodeSqliteDatabaseLike,
} from "./nodeSqliteShared";
import type { SqliteAdapter } from "./types";

const _require = createRequire(import.meta.url);

type DriverLoader = (moduleName: string) => unknown;

type NodeSqliteOptions = {
  readOnly?: boolean;
};

function toNodeSqliteOptions(options?: Record<string, unknown>): NodeSqliteOptions | undefined {
  if (options?.readonly !== true) return undefined;
  return { readOnly: true };
}

/**
 * Logs the underlying cause of a swallowed sync-driver failure.
 * tryOpenSync() used to swallow both driver errors in
 * empty catch {} blocks, so an ABI mismatch or permission error never
 * reached the logs — only the generic "(falhou)"/"(indisponível)" strings
 * in core.ts's thrown message survived, making the failure undiagnosable.
 */
function logSwallowedDriverError(driver: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.debug(`[DB] Sync driver '${driver}' failed to open, will try next driver: ${message}`);
}

declare global {
  var __trouteaiSqlJsAdapters: Map<string, SqliteAdapter> | undefined;
  var __trouteaiSqlJsInitPromises: Map<string, Promise<SqliteAdapter>> | undefined;
  var __trouteaiSqlJsPreInitErrors: Map<string, string> | undefined;
}

function getSqlJsCache(): Map<string, SqliteAdapter> {
  if (!globalThis.__trouteaiSqlJsAdapters) {
    globalThis.__trouteaiSqlJsAdapters = new Map();
  }
  return globalThis.__trouteaiSqlJsAdapters;
}

function getSqlJsPreInitErrorCache(): Map<string, string> {
  if (!globalThis.__trouteaiSqlJsPreInitErrors) {
    globalThis.__trouteaiSqlJsPreInitErrors = new Map();
  }
  return globalThis.__trouteaiSqlJsPreInitErrors;
}

/**
 * Real cause of the most recent failed preInitSqlJs() attempt for a
 * filePath, if any. Lets callers replace the generic/misleading
 * "sql.js WASM ainda não foi pré-inicializado" message with the actual
 * reason sql.js itself couldn't open the file, once pre-init was genuinely
 * attempted (as opposed to never having run at all).
 */
export function getSqlJsPreInitError(filePath: string): string | undefined {
  return getSqlJsPreInitErrorCache().get(filePath);
}

/**
 * Cache of IN-FLIGHT initialization promises (not resolved yet), per filePath.
 * Separate from getSqlJsCache() (which only holds the resolved adapter) so that
 * concurrent callers (BATCH/STARTUP/HealthCheck/ProviderLimitsSync at boot)
 * share ONE read+decode of the file instead of each calling
 * fs.readFileSync + WASM decode on its own (thundering herd).
 */
function getSqlJsPendingCache(): Map<string, Promise<SqliteAdapter>> {
  if (!globalThis.__trouteaiSqlJsInitPromises) {
    globalThis.__trouteaiSqlJsInitPromises = new Map();
  }
  return globalThis.__trouteaiSqlJsInitPromises;
}

/**
 * @internal
 *
 * Builds the synchronous driver cascade. Keeping the loader injectable makes
 * the real node:sqlite branch testable without changing the public adapter API.
 */
export function createSyncDriverFactory(load: DriverLoader) {
  return function tryOpenSync(
    filePath: string,
    options?: Record<string, unknown>
  ): SqliteAdapter | null {
    // Bun ships a supported SQLite implementation. Prefer it over the native
    // Node addon, which Bun intentionally skips because its ABI is incompatible.
    if (process.versions.bun) {
      try {
        const { Database } = load("bun:sqlite") as {
          Database: new (p: string, options?: Record<string, unknown>) => BunSqliteDatabaseLike;
        };
        if (options?.fileMustExist === true && filePath !== ":memory:" && !existsSync(filePath)) {
          throw new Error(`SQLite file does not exist: ${filePath}`);
        }
        const db = new Database(filePath, {
          ...(options?.readonly === true
            ? { readonly: true }
            : { readwrite: true, create: options?.fileMustExist !== true }),
        });
        return createBunSqliteAdapter(db, filePath);
      } catch (err) {
        logSwallowedDriverError("bun:sqlite", err);
      }
    }

    // better-sqlite3: fast, native — skipped on Bun
    if (!process.versions.bun) {
      try {
        const BetterSqlite = load("better-sqlite3") as {
          new (p: string, o?: object): import("better-sqlite3").Database;
        };
        const db = new BetterSqlite(filePath, options);
        return createBetterSqliteAdapter(db);
      } catch (err) {
        // continue with the next driver
        logSwallowedDriverError("better-sqlite3", err);
      }
    }

    // node:sqlite: built-in desde Node 22.5 — skip em Bun
    if (!process.versions.bun) {
      const [maj, min] = (process.versions.node ?? "0.0").split(".").map(Number);
      if (maj > 22 || (maj === 22 && min >= 5)) {
        try {
          if (options?.fileMustExist === true && filePath !== ":memory:" && !existsSync(filePath)) {
            throw new Error(`SQLite file does not exist: ${filePath}`);
          }
          const { DatabaseSync } = load("node:sqlite") as {
            DatabaseSync: new (p: string, options?: NodeSqliteOptions) => NodeSqliteDatabaseLike;
          };
          const nodeOptions = toNodeSqliteOptions(options);
          const db = nodeOptions
            ? new DatabaseSync(filePath, nodeOptions)
            : new DatabaseSync(filePath);
          return createNodeSqliteAdapterFromDatabase(db, filePath);
        } catch (err) {
          // continua
          logSwallowedDriverError("node:sqlite", err);
        }
      }
    }

    return null;
  };
}

/** Tries to open with better-sqlite3 and node:sqlite synchronously. Returns null if both fail. */
export const tryOpenSync = createSyncDriverFactory(_require);

/**
 * Pre-initializes sql.js for a filePath.
 * Stores it on globalThis for later access via getSqlJsAdapter().
 * Idempotent — safe to call several times.
 */
export async function preInitSqlJs(filePath: string): Promise<SqliteAdapter> {
  const cache = getSqlJsCache();
  const existing = cache.get(filePath);
  if (existing) {
    if (existing.open) return existing;
    // Stale handle left over by a prior close/reload (e.g. gracefulShutdown or
    // resetDbInstance closed the underlying WASM db but this globalThis-backed
    // cache — deliberately shared across re-invocations for idempotency — still
    // holds the reference). Reusing it would make every subsequent query throw
    // the raw string "Database closed" straight from sql.js. Evict and
    // recreate instead of returning a dead connection.
    cache.delete(filePath);
  }

  // Share one in-flight load across concurrent callers for the same filePath:
  // without this, each of BATCH/STARTUP/HealthCheck/ProviderLimitsSync
  // independently fs.readFileSync + WASM-decode the same (possibly 300+MB) file
  // at boot, multiplying peak memory pressure by the number of racing callers.
  const pending = getSqlJsPendingCache();
  const inflight = pending.get(filePath);
  if (inflight !== undefined) return inflight;

  const initPromise = (async () => {
    const { createSqlJsAdapter } = await import("./sqljsAdapter");
    const adapter = await createSqlJsAdapter(filePath);
    cache.set(filePath, adapter);
    getSqlJsPreInitErrorCache().delete(filePath);
    return adapter;
  })();
  pending.set(filePath, initPromise);
  try {
    return await initPromise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getSqlJsPreInitErrorCache().set(filePath, message);
    throw err;
  } finally {
    pending.delete(filePath);
  }
}

/** Returns the pre-initialized sql.js adapter, or null if it is not initialized yet. */
export function getSqlJsAdapter(filePath: string): SqliteAdapter | null {
  return getSqlJsCache().get(filePath) ?? null;
}

/**
 * Full async factory: tries every driver in turn.
 * Order: bun:sqlite → better-sqlite3 → node:sqlite → sql.js
 */
export async function openDatabaseAsync(
  filePath: string,
  options?: Record<string, unknown>
): Promise<SqliteAdapter> {
  const sync = tryOpenSync(filePath, options);
  if (sync) {
    console.log(`[DB] Driver: ${sync.driver} | file: ${filePath}`);
    return sync;
  }

  console.warn("[DB] Synchronous drivers unavailable — falling back to sql.js (WASM)");
  const adapter = await preInitSqlJs(filePath);
  console.log(`[DB] Driver: sql.js | file: ${filePath}`);
  return adapter;
}
