#!/usr/bin/env node
/**
 * TRouteAI — Zero-Config Bootstrap
 *
 * Auto-generates required secrets (JWT_SECRET, STORAGE_ENCRYPTION_KEY) if
 * missing or empty, persists them to {DATA_DIR}/server.env so they survive
 * restarts and upgrades.
 *
 * Called from scripts/dev/run-next.mjs, which every start path uses
 * (npm start, app.cjs and the global `trouteai` command in bin/trouteai.mjs).
 *
 * Priority (lowest → highest):
 *   1. Auto-generated defaults
 *   2. {DATA_DIR}/server.env  (persisted on first boot)
 *   3. Preferred config .env  (./.env -> DATA_DIR/.env -> ~/.trouteai/.env, first one found)
 *   4. process.env            (shell environment, highest priority)
 *
 * A project checkout keeps its settings in ./.env. The global `trouteai` command runs from
 * the package folder (no .env there) and loads DATA_DIR/.env into process.env itself.
 */

import { randomBytes, createDecipheriv, scryptSync, createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { getDefaultDataDir } from "../../bin/cli/data-dir.mjs";

const require = createRequire(import.meta.url);

// ── OAuth secrets that are optional but warn if missing ─────────────────────
// Only integrations with NO built-in fallback belong here: Antigravity ships a public
// client secret via open-sse/utils/publicCreds.ts (resolvePublicCred), so it works unset.
const OPTIONAL_OAUTH_SECRETS = [{ keys: ["QODER_OAUTH_CLIENT_SECRET"], label: "Qoder OAuth" }];

// ── Resolve DATA_DIR ─────────────────────────────────────────────────────────
// The default comes from bin/cli/data-dir.mjs, the same rule as src/lib/dataPaths.ts,
// so bootstrap and the server always use the same folder.
function resolveDataDir(overridePath, env = process.env) {
  if (overridePath?.trim()) return resolve(overridePath);
  const configured = env.DATA_DIR?.trim();
  return configured ? resolve(configured) : getDefaultDataDir();
}

function getPreferredEnvFilePath(env = process.env) {
  // The project .env comes first so a checkout never switches to ~/.trouteai/.env (the
  // global command's settings file) just because that file exists on the same machine.
  const candidates = [join(process.cwd(), ".env")];

  if (env.DATA_DIR?.trim()) {
    candidates.push(join(resolve(env.DATA_DIR.trim()), ".env"));
  }

  candidates.push(join(resolveDataDir(null, env), ".env"));

  return candidates.find((filePath) => existsSync(filePath)) ?? null;
}

function isNativeSqliteLoadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;

  return (
    message.includes("Module did not self-register") ||
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("ERR_DLOPEN_FAILED") ||
    message.includes("Could not locate the bindings file") ||
    message.includes("Cannot find module 'better-sqlite3'") ||
    code === "ERR_DLOPEN_FAILED" ||
    code === "MODULE_NOT_FOUND"
  );
}

/**
 * Open the DB read-only: better-sqlite3 when it loads, else node:sqlite (the same
 * fallback the server uses). Returns null when neither driver is available.
 */
function openReadonlySqlite(dbPath) {
  try {
    const Database = require("better-sqlite3");
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (!isNativeSqliteLoadError(error)) throw error;
  }
  let DatabaseSync;
  try {
    // Keep the terminal quiet: node:sqlite prints an ExperimentalWarning on some Node versions.
    const originalEmit = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : warning?.message;
      if (String(text).includes("SQLite")) return;
      return originalEmit.call(process, warning, ...rest);
    };
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } finally {
      process.emitWarning = originalEmit;
    }
  } catch {
    return null;
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function hasEncryptedCredentials(dataDir) {
  const dbPath = join(dataDir, "storage.sqlite");
  if (!existsSync(dbPath)) return false;

  try {
    const db = openReadonlySqlite(dbPath);
    // No SQLite driver at all: cannot inspect, keep the old behaviour.
    if (!db) return false;
    try {
      const row = db
        .prepare(
          `SELECT 1
             FROM provider_connections
            WHERE access_token LIKE 'enc:v1:%'
               OR refresh_token LIKE 'enc:v1:%'
               OR api_key LIKE 'enc:v1:%'
               OR id_token LIKE 'enc:v1:%'
            LIMIT 1`
        )
        .get();
      return !!row;
    } finally {
      db.close();
    }
  } catch (error) {
    if (isNativeSqliteLoadError(error)) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to inspect existing database at ${dbPath}: ${message}`);
  }
}

// ── Parse a simple KEY=VALUE env file ───────────────────────────────────────
function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = unquoteEnvValue(trimmed.slice(eqIdx + 1).trim());
    env[key] = val;
  }
  return env;
}

function unquoteEnvValue(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return value;
  return value.slice(1, -1);
}

// ── Write a simple KEY=VALUE env file ───────────────────────────────────────
function writeEnvFile(filePath, env) {
  const lines = [
    "# Auto-generated by TRouteAI bootstrap — do not delete",
    `# Created: ${new Date().toISOString()}`,
    "",
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  writeFileSync(filePath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
}

// ── Main bootstrap function ──────────────────────────────────────────────────
/**
 * `showInfo(mergedEnv)` decides whether informational notes are printed (default: yes).
 * Warnings that need action (key mismatch, unsafe password, unwritable data folder) always are.
 *
 * @param {{ dataDirOverride?: string; quiet?: boolean; showInfo?: (env: Record<string, string>) => boolean }} options
 * @returns {Record<string, string>} merged env to pass to child process
 */
export function bootstrapEnv({ dataDirOverride, quiet = false, showInfo } = {}) {
  const notes = [];
  const log = (msg) => notes.push(msg);
  const alert = quiet ? () => {} : (msg) => process.stderr.write(`[bootstrap] ${msg}\n`);

  const preferredEnvPath = getPreferredEnvFilePath(process.env);
  const preferredEnv = preferredEnvPath ? parseEnvFile(preferredEnvPath) : {};
  const dataDir = resolveDataDir(dataDirOverride, { ...preferredEnv, ...process.env });
  const serverEnvPath = join(dataDir, "server.env");

  // Before 1.0.4 bootstrap used APPDATA (Windows) or XDG_CONFIG_HOME (Linux) even when
  // ~/.trouteai existed, while the server used ~/.trouteai. Copy that server.env once so
  // the secrets (STORAGE_ENCRYPTION_KEY, JWT_SECRET, API_KEY_SECRET) are not regenerated.
  const mergedEnv = { ...preferredEnv, ...process.env };
  if (!dataDirOverride?.trim() && !mergedEnv.DATA_DIR?.trim() && !existsSync(serverEnvPath)) {
    let legacyDir = null;
    if (process.platform === "win32") {
      legacyDir = join(mergedEnv.APPDATA || join(homedir(), "AppData", "Roaming"), "trouteai");
    } else if (mergedEnv.XDG_CONFIG_HOME?.trim()) {
      legacyDir = join(resolve(mergedEnv.XDG_CONFIG_HOME.trim()), "trouteai");
    }
    const legacyPath = legacyDir ? join(legacyDir, "server.env") : null;
    if (legacyPath && resolve(legacyPath) !== resolve(serverEnvPath) && existsSync(legacyPath)) {
      try {
        mkdirSync(dataDir, { recursive: true });
        copyFileSync(legacyPath, serverEnvPath);
        try {
          chmodSync(serverEnvPath, 0o600);
        } catch {}
        alert(`Copied saved secrets from ${legacyPath} to ${serverEnvPath}`);
      } catch (e) {
        alert(`⚠️  Could not copy ${legacyPath} to ${serverEnvPath}: ${e.message}`);
      }
    }
  }

  // ── Layer 1: Load persisted server.env ────────────────────────────────────
  let persisted = parseEnvFile(serverEnvPath);

  // ── Layer 2: Load the same preferred .env that the CLI wrapper uses ───────
  // This keeps run-next consistent with `bin/trouteai.mjs`.
  //
  // We strip empty values from preferredEnv so an empty placeholder
  // (e.g. `STORAGE_ENCRYPTION_KEY=` in the project .env template) does not
  // override the real value persisted in server.env. Only the .env entries
  // that the operator actually set should win.
  const preferredEnvFiltered = Object.fromEntries(
    Object.entries(preferredEnv).filter(([, v]) => typeof v === "string" && v.length > 0)
  );
  // Filter empty strings from process.env so that an exported `KEY=` (which sets an
  // empty string) does not override real values persisted in server.env or set
  // in .env. Only shell vars that the operator actually set should win.
  // Mirrors the filtering already applied to preferredEnv above.
  const processEnvFiltered = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string" && v.length > 0)
  );
  const merged = { ...persisted, ...preferredEnvFiltered, ...processEnvFiltered };

  // `next build` compiles NEXT_PUBLIC_* values into the bundles, so a prebuilt package (and a
  // build made before the value changed) only sees NEXT_PUBLIC_BASE_URL through code that
  // reads it at runtime. TROUTEAI_PUBLIC_BASE_URL is the runtime name for the same address.
  // Hosting panels (SixPanel) set NEXT_PUBLIC_SITE_URL to the site's https address.
  const publicBase = merged.NEXT_PUBLIC_BASE_URL?.trim() || merged.NEXT_PUBLIC_SITE_URL?.trim();
  if (publicBase && !merged.TROUTEAI_PUBLIC_BASE_URL?.trim()) {
    merged.TROUTEAI_PUBLIC_BASE_URL = publicBase;
  }

  // ── Auto-generate required secrets ────────────────────────────────────────
  let needsPersist = false;

  if (!merged.JWT_SECRET?.trim()) {
    persisted.JWT_SECRET = randomBytes(64).toString("hex");
    merged.JWT_SECRET = persisted.JWT_SECRET;
    needsPersist = true;
    log("✨ JWT_SECRET auto-generated (first run)");
  }

  if (!merged.STORAGE_ENCRYPTION_KEY?.trim()) {
    if (hasEncryptedCredentials(dataDir)) {
      throw new Error(
        `Refusing to auto-generate STORAGE_ENCRYPTION_KEY: encrypted credentials already exist in ${join(
          dataDir,
          "storage.sqlite"
        )}. Restore the key via ${preferredEnvPath ?? "an appropriate .env file"}, ${serverEnvPath}, or process.env.`
      );
    }
    persisted.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    merged.STORAGE_ENCRYPTION_KEY = persisted.STORAGE_ENCRYPTION_KEY;
    needsPersist = true;
    log("✨ STORAGE_ENCRYPTION_KEY auto-generated (first run)");
  }

  if (!merged.STORAGE_ENCRYPTION_KEY_VERSION?.trim()) {
    persisted.STORAGE_ENCRYPTION_KEY_VERSION = "v1";
    merged.STORAGE_ENCRYPTION_KEY_VERSION = persisted.STORAGE_ENCRYPTION_KEY_VERSION;
    needsPersist = true;
  }

  if (!merged.API_KEY_SECRET?.trim()) {
    persisted.API_KEY_SECRET = randomBytes(32).toString("hex");
    merged.API_KEY_SECRET = persisted.API_KEY_SECRET;
    needsPersist = true;
    log("✨ API_KEY_SECRET auto-generated (first run)");
  }

  // ── Persist new secrets ────────────────────────────────────────────────────
  if (needsPersist) {
    try {
      mkdirSync(dataDir, { recursive: true });
      // Only persist keys that we auto-generated (not .env or process.env vals)
      writeEnvFile(serverEnvPath, persisted);
      log(`📁 Secrets persisted to: ${serverEnvPath}`);
    } catch (e) {
      alert(`⚠️  Could not persist secrets to ${serverEnvPath}: ${e.message}`);
    }
  }

  // ── Mark as bootstrapped ───────────────────────────────────────────────────
  if (needsPersist) {
    merged.TROUTEAI_BOOTSTRAPPED = "true";
  }

  // ── Warn about missing optional OAuth secrets ──────────────────────────────
  const missingOauth = OPTIONAL_OAUTH_SECRETS.filter(
    ({ keys }) => !keys.some((key) => merged[key]?.trim())
  );
  if (missingOauth.length > 0) {
    log("ℹ️  The following OAuth integrations are not configured:");
    for (const { keys, label } of missingOauth) {
      log(`   • ${label} (${keys.join(" or ")}) — set in .env or ${serverEnvPath}`);
    }
    log("   These providers will not work until configured.");
  }

  // ── Note about the admin password ─────────────────────────────────────────
  if (merged.INITIAL_PASSWORD?.trim() === "CHANGEME") {
    alert(
      "⚠  INITIAL_PASSWORD=CHANGEME is a well-known default. Set a strong password (8+ characters)."
    );
  } else if (!merged.INITIAL_PASSWORD?.trim() && !existsSync(join(dataDir, "storage.sqlite"))) {
    log(
      `ℹ  INITIAL_PASSWORD is not set. On first start a random admin password is saved to ${join(dataDir, "initial-admin-password.txt")}`
    );
  }

  // ── Decrypt-probe: verify STORAGE_ENCRYPTION_KEY matches encrypted data ──
  if (merged.STORAGE_ENCRYPTION_KEY?.trim() && hasEncryptedCredentials(dataDir)) {
    try {
      const db = openReadonlySqlite(join(dataDir, "storage.sqlite"));
      if (!db) throw new Error("no SQLite driver");
      try {
        const row = db
          .prepare(
            `SELECT api_key, access_token, refresh_token, id_token
               FROM provider_connections
              WHERE api_key LIKE 'enc:v1:%'
                 OR access_token LIKE 'enc:v1:%'
                 OR refresh_token LIKE 'enc:v1:%'
                 OR id_token LIKE 'enc:v1:%'
              LIMIT 1`
          )
          .get();
        if (row) {
          const ciphertext = row.api_key || row.access_token || row.refresh_token || row.id_token;
          if (ciphertext?.startsWith("enc:v1:")) {
            const parts = ciphertext.split(":");
            // enc:v1:<iv>:<ct>:<tag>
            if (parts.length >= 5) {
              const iv = Buffer.from(parts[2], "hex");
              const ct = Buffer.from(parts[3], "hex");
              const tag = Buffer.from(parts[4], "hex");

              // Try decrypting with both key derivation methods matching encryption.ts
              const tryDecrypt = (derivedKey) => {
                const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
                decipher.setAuthTag(tag);
                decipher.update(ct);
                decipher.final();
              };

              // Dynamic salt (current): scryptSync(secret, sha256(secret).slice(0,16), 32)
              const dynamicSalt = createHash("sha256")
                .update(merged.STORAGE_ENCRYPTION_KEY)
                .digest()
                .slice(0, 16);
              const dynamicKey = scryptSync(merged.STORAGE_ENCRYPTION_KEY, dynamicSalt, 32);

              // Legacy salt (fallback): scryptSync(secret, "trouteai-field-encryption-v1", 32)
              const legacySalt = "trouteai-field-encryption-v1";
              const legacyKey = scryptSync(merged.STORAGE_ENCRYPTION_KEY, legacySalt, 32);

              let keyMatched = false;
              try {
                tryDecrypt(dynamicKey);
                keyMatched = true;
              } catch {
                // Try legacy key as fallback
                try {
                  tryDecrypt(legacyKey);
                  keyMatched = true;
                } catch {
                  // Both failed — key truly doesn't match
                }
              }

              if (!keyMatched) {
                alert(
                  "⛔ STORAGE_ENCRYPTION_KEY does not match the key used to encrypt your stored credentials."
                );
                alert(
                  `   Restore your previous key in ${serverEnvPath} or in your .env file (STORAGE_ENCRYPTION_KEY).`
                );
              }
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // Non-fatal — probe is best-effort
    }
  }

  // The server (src/lib/dataPaths.ts) then uses the exact folder bootstrap used.
  merged.DATA_DIR ||= dataDir;

  if (!quiet && (showInfo ? showInfo(merged) : true)) {
    for (const note of notes) process.stderr.write(`[bootstrap] ${note}\n`);
  }

  return merged;
}

// ── CLI usage: node scripts/build/bootstrap-env.mjs ──────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("bootstrap-env.mjs")) {
  const env = bootstrapEnv();
  process.stderr.write(`[bootstrap] Done. DATA_DIR resolved to: ${resolveDataDir()}\n`);
  process.stderr.write(`[bootstrap] JWT_SECRET length: ${env.JWT_SECRET?.length ?? 0}\n`);
  process.stderr.write(
    `[bootstrap] STORAGE_ENCRYPTION_KEY length: ${env.STORAGE_ENCRYPTION_KEY?.length ?? 0}\n`
  );
}
