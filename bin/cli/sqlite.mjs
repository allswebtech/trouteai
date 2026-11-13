import fs from "node:fs";
import { resolveDataDir, resolveStoragePath } from "./data-dir.mjs";
import { ensureSettingsSchema, hashManagementPassword, updateSettings } from "./settings-store.mjs";

async function loadSqlite() {
  if (process.versions.bun) {
    return { Database: (await import("bun:sqlite")).Database };
  }
  try {
    return { Database: (await import("better-sqlite3")).default };
  } catch (error) {
    return { error };
  }
}

// Unlike the real server (src/lib/db/adapters/driverFactory.ts::tryOpenSync), this CLI
// helper used to have NO fallback beyond better-sqlite3, so on a machine without the
// better-sqlite3 native binary every CLI DB operation failed even when the server was
// healthy via its own driver cascade. Fall back to Node's built-in `node:sqlite`
// (Node 22.13+), wrapped in the small part of the better-sqlite3 API the CLI uses.
async function openWithSyncDriverFallback(dbPath, options, importError) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw createSqliteNativeError(importError);
  }
  if (options.fileMustExist && !fs.existsSync(dbPath)) {
    throw new Error(`SQLite file does not exist: ${dbPath}`);
  }
  const raw = new DatabaseSync(dbPath, { readOnly: options.readonly === true });
  return {
    prepare: (sql) => raw.prepare(sql),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    transaction:
      (fn) =>
      (...args) => {
        raw.exec("BEGIN");
        try {
          const result = fn(...args);
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          raw.exec("ROLLBACK");
          throw error;
        }
      },
    pragma: (pragmaStr, pragmaOptions) => {
      const rows = raw.prepare(`PRAGMA ${pragmaStr}`).all();
      if (pragmaOptions?.simple) return rows[0] ? (Object.values(rows[0])[0] ?? null) : null;
      return rows;
    },
  };
}

function openBunSqlite(Database, dbPath, options) {
  const raw = new Database(dbPath, options);
  const prepare = (sql) => {
    const statement = raw.query(sql);
    return {
      run: (...params) => statement.run(...normalizeBunSqliteParams(params)),
      get: (...params) => statement.get(...normalizeBunSqliteParams(params)),
      all: (...params) => statement.all(...normalizeBunSqliteParams(params)),
    };
  };
  return {
    prepare,
    query: (sql) => raw.query(sql),
    exec: (sql) => raw.exec(sql),
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
    serialize: () => raw.serialize(),
    pragma: (pragmaStr, pragmaOptions) => {
      const statement = raw.query(`PRAGMA ${pragmaStr}`);
      if (pragmaOptions?.simple) {
        const row = statement.get();
        return row ? (Object.values(row)[0] ?? null) : null;
      }
      return statement.all();
    },
  };
}

export function normalizeBunSqliteParams(params) {
  if (
    params.length !== 1 ||
    params[0] === null ||
    typeof params[0] !== "object" ||
    Array.isArray(params[0]) ||
    params[0] instanceof Uint8Array ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(params[0]))
  ) {
    return params;
  }
  const expanded = {};
  for (const [key, value] of Object.entries(params[0])) {
    if (/^[:@$]/.test(key)) expanded[key] = value;
    else {
      expanded[`@${key}`] = value;
      expanded[`:${key}`] = value;
      expanded[`$${key}`] = value;
    }
  }
  return [expanded];
}

export function createSqliteNativeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("NODE_MODULE_VERSION") || message.includes("ERR_DLOPEN_FAILED")) {
    return new Error(
      "better-sqlite3 native binding is incompatible with this Node.js runtime. " +
        "Reinstall TRouteAI with the Node.js version you run it with (npm install -g trouteai), " +
        "or run `npm rebuild better-sqlite3` in a project checkout."
    );
  }
  if (
    message.includes("Could not locate the bindings file") ||
    message.includes("MODULE_NOT_FOUND") ||
    message.includes("Cannot find module 'better-sqlite3'")
  ) {
    return new Error(
      "better-sqlite3 native binding could not be found (no prebuilt addon for this platform). " +
        "Reinstall TRouteAI (npm install -g trouteai), or run `npm rebuild better-sqlite3` " +
        "in a project checkout."
    );
  }
  return error;
}

async function openSqliteDatabase(dbPath, options = {}) {
  const loaded = await loadSqlite();
  if (process.versions.bun) {
    if (options.fileMustExist && !fs.existsSync(dbPath)) {
      throw new Error(`SQLite file does not exist: ${dbPath}`);
    }
    const bunOptions = options.readonly
      ? { readonly: true }
      : { readwrite: true, create: options.fileMustExist !== true };
    try {
      return openBunSqlite(loaded.Database, dbPath, bunOptions);
    } catch (error) {
      throw createSqliteNativeError(error);
    }
  }
  if (loaded.error) {
    return openWithSyncDriverFallback(dbPath, options, loaded.error);
  }
  try {
    return new loaded.Database(dbPath, options);
  } catch (error) {
    throw createSqliteNativeError(error);
  }
}

export async function withReadonlySqlite(dbPath, callback) {
  const db = await openSqliteDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

export async function readManagementPasswordState(dbPath = resolveStoragePath(resolveDataDir())) {
  if (!fs.existsSync(dbPath)) {
    return { exists: false, hasPassword: false };
  }

  return withReadonlySqlite(dbPath, (db) => {
    const hasSettingsTable = !!db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("key_value");
    if (!hasSettingsTable) {
      return { exists: true, hasPassword: false };
    }
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
      .get("password");
    let password = row?.value;
    if (typeof password === "string") {
      try {
        password = JSON.parse(password);
      } catch {}
    }
    return {
      exists: true,
      hasPassword: typeof password === "string" && password.length > 0,
    };
  });
}

export async function resetManagementPassword(
  password,
  dbPath = resolveStoragePath(resolveDataDir())
) {
  const db = await openSqliteDatabase(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    ensureSettingsSchema(db);
    const hashedPassword = await hashManagementPassword(password);
    updateSettings(db, { password: hashedPassword, requireLogin: true, setupComplete: true });
    // Sign out every dashboard browser: bump the session epoch the server checks.
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'auth' AND key = 'sessionEpoch'")
      .get();
    const current = row?.value ? Number(JSON.parse(row.value)) : 0;
    const next = (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1;
    db.prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('auth', 'sessionEpoch', ?)"
    ).run(JSON.stringify(next));
    db.prepare("DELETE FROM key_value WHERE namespace = 'auth_revoked'").run();
  } finally {
    db.close();
  }
}
