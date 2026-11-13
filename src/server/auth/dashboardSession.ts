/**
 * Dashboard session tokens (the `auth_token` cookie).
 *
 * A session JWT carries `sv` (session epoch) and `jti` (token id). A token is valid only when
 * its signature checks out, it has not expired, its `sv` matches the stored epoch, and its
 * `jti` was not revoked by a logout.
 *
 * - Logout revokes that one token (other browsers stay signed in).
 * - A password change or reset bumps the epoch, which signs out every browser.
 *
 * Tokens issued before this existed have no `sv`; they count as epoch 0, which is the
 * stored default, so upgrading never signs anyone out. API keys are separate and unaffected.
 *
 * State lives in the existing key_value table (namespaces `auth` and `auth_revoked`), so the
 * CLI `reset-password` command can bump the epoch without the server running.
 */
import { createHash, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";

import { getDbInstance } from "@/lib/db/core";

export const SESSION_COOKIE_NAME = "auth_token";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_REVOKED_ERROR_CODE = "ERR_TROUTEAI_SESSION_REVOKED";

const AUTH_NAMESPACE = "auth";
const EPOCH_KEY = "sessionEpoch";
const REVOKED_NAMESPACE = "auth_revoked";

let readErrorLogged = false;

function getSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

function tokenIdHash(jti: string): string {
  return createHash("sha256").update(jti).digest("base64url");
}

function logReadErrorOnce(error: unknown): void {
  if (readErrorLogged) return;
  readErrorLogged = true;
  console.warn(
    "[Auth] Could not read session state; using signature-only checks:",
    error instanceof Error ? error.message : String(error)
  );
}

/** Current session epoch (0 when never bumped). */
export function getSessionEpoch(): number {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(AUTH_NAMESPACE, EPOCH_KEY) as { value?: string } | undefined;
  const parsed = row?.value ? Number(JSON.parse(row.value)) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isTokenIdRevoked(jti: string): boolean {
  const row = getDbInstance()
    .prepare("SELECT 1 AS hit FROM key_value WHERE namespace = ? AND key = ?")
    .get(REVOKED_NAMESPACE, tokenIdHash(jti));
  return Boolean(row);
}

function revokedError(): Error {
  const error = new Error("Dashboard session was signed out") as Error & { code: string };
  error.code = SESSION_REVOKED_ERROR_CODE;
  return error;
}

/** Sign a new 30-day session token bound to the current epoch. */
export async function signDashboardSession(): Promise<string> {
  const secret = getSecret();
  if (!secret) throw new Error("JWT_SECRET is not set");
  let epoch = 0;
  try {
    epoch = getSessionEpoch();
  } catch (error) {
    logReadErrorOnce(error);
  }
  return new SignJWT({ authenticated: true, sv: epoch })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
}

/**
 * Verify a session token. Throws (jose errors, or SESSION_REVOKED_ERROR_CODE) when invalid.
 * If the session state cannot be read, falls back to the signature check alone so a DB hiccup
 * never locks the owner out of the dashboard.
 */
export async function verifyDashboardSession(token: string): Promise<JWTPayload> {
  const secret = getSecret();
  if (!secret) throw new Error("JWT_SECRET is not set");
  const { payload } = await jwtVerify(token, secret);

  let epoch: number;
  try {
    epoch = getSessionEpoch();
  } catch (error) {
    logReadErrorOnce(error);
    return payload;
  }
  const tokenEpoch = typeof payload.sv === "number" ? payload.sv : 0;
  if (tokenEpoch !== epoch) throw revokedError();

  if (typeof payload.jti === "string") {
    let revoked = false;
    try {
      revoked = isTokenIdRevoked(payload.jti);
    } catch (error) {
      logReadErrorOnce(error);
    }
    if (revoked) throw revokedError();
  }
  return payload;
}

/** True when the token is a valid, unrevoked dashboard session. Never throws. */
export async function isDashboardSessionTokenValid(token: string | null | undefined) {
  if (!token) return false;
  try {
    await verifyDashboardSession(token);
    return true;
  } catch {
    return false;
  }
}

/** Revoke one session token (logout). Expired revocations are pruned on the way. */
export async function revokeDashboardSession(token: string | null | undefined): Promise<void> {
  const secret = getSecret();
  if (!token || !secret) return;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secret));
  } catch {
    return; // invalid or expired: nothing to revoke
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : nowSeconds + SESSION_MAX_AGE_SECONDS;

  if (typeof payload.jti !== "string") {
    // Pre-upgrade token without an id: the only way to end it is a new epoch.
    revokeAllDashboardSessions();
    return;
  }

  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ? AND CAST(value AS INTEGER) < ?").run(
    REVOKED_NAMESPACE,
    nowSeconds
  );
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    REVOKED_NAMESPACE,
    tokenIdHash(payload.jti),
    JSON.stringify(exp)
  );
}

/** Sign out every browser (password change / reset). Returns the new epoch. */
export function revokeAllDashboardSessions(): number {
  const db = getDbInstance();
  const next = getSessionEpoch() + 1;
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    AUTH_NAMESPACE,
    EPOCH_KEY,
    JSON.stringify(next)
  );
  // Revoked token ids belong to older epochs now; they can never validate again.
  db.prepare("DELETE FROM key_value WHERE namespace = ?").run(REVOKED_NAMESPACE);
  return next;
}
