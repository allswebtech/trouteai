import { NextResponse } from "next/server";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { classifyIpScope } from "@/lib/ipUtils";
import { getCachedSettings } from "@/lib/localDb";
import { SESSION_MAX_AGE_SECONDS, signDashboardSession } from "@/server/auth/dashboardSession";
import { cookies } from "next/headers";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { loginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";
import { shouldUseSecureCookie } from "@/server/origin/publicOrigin";

// SECURITY: No hardcoded fallback — JWT_SECRET must be configured.
if (!process.env.JWT_SECRET) {
  console.error("[SECURITY] FATAL: JWT_SECRET is not set. Login authentication is disabled.");
}

// Test seam for cookie store injection without affecting runtime behavior.
export const authRouteInternals = {
  getCookieStore: cookies,
};

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);

  try {
    // Fail-fast if JWT_SECRET is not configured
    if (!process.env.JWT_SECRET) {
      logAuditEvent({
        action: "auth.login.misconfigured",
        actor: "system",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_jwt_secret" },
      });
      return NextResponse.json(
        { error: "Server misconfigured: JWT_SECRET not set. Contact administrator." },
        { status: 500 }
      );
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "body", message: "Invalid JSON body" }],
          },
        },
        { status: 400 }
      );
    }

    // Zod validation
    const validation = validateBody(loginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const password = typeof validation.data.password === "string" ? validation.data.password : "";
    if (!password) {
      return NextResponse.json({ error: "Invalid password payload" }, { status: 400 });
    }
    const settings = await getCachedSettings();
    const bruteForceEnabled = settings.bruteForceProtection !== false;
    const clientIp = auditContext.ipAddress || null;

    const guardCheck = checkLoginGuard(clientIp, { enabled: bruteForceEnabled });
    if (!guardCheck.allowed) {
      logAuditEvent({
        action: "auth.login.locked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: clientIp || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guardCheck.retryAfterSeconds || 0 },
      });
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: guardCheck.retryAfterSeconds
            ? { "Retry-After": String(guardCheck.retryAfterSeconds) }
            : {},
        }
      );
    }

    const passwordState = await ensurePersistentManagementPasswordHash({
      settings,
      source: "auth.login",
    });
    const storedHash = getStoredManagementPassword(passwordState.settings);

    if (!storedHash) {
      logAuditEvent({
        action: "auth.login.setup_required",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_persisted_password" },
      });
      return NextResponse.json(
        { error: "No password configured. Complete onboarding first.", needsSetup: true },
        { status: 403 }
      );
    }

    const isValid = await verifyManagementPassword(password, storedHash);

    if (isValid) {
      // Secure-cookie decision via the shared helper: honors AUTH_COOKIE_SECURE
      // and the real HTTPS connection always, but only trusts X-Forwarded-Proto
      // behind a configured proxy hop so a direct plain-HTTP client cannot forge
      // the flag. See src/server/origin/publicOrigin.ts.
      const useSecureCookie = shouldUseSecureCookie(request);

      const token = await signDashboardSession();

      const cookieStore = await authRouteInternals.getCookieStore();
      cookieStore.set("auth_token", token, {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: "lax",
        path: "/",
        // 30 days — bound the cookie lifetime to the JWT's 30d expiry so the browser
        // drops it on the same schedule the token stops being valid (Seg3 hardening).
        maxAge: SESSION_MAX_AGE_SECONDS,
      });

      logAuditEvent({
        action: "auth.login.success",
        actor: "admin",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "success",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          hasStoredPassword: Boolean(storedHash),
          passwordMigrated: passwordState.migrated,
          secureCookie: useSecureCookie,
        },
      });

      clearLoginAttempts(clientIp);
      return NextResponse.json({ success: true });
    }

    const failureDecision = recordLoginFailure(clientIp, { enabled: bruteForceEnabled });

    // Tag the origin scope so the audit view can distinguish a mistyped
    // password from the host itself / the LAN (loopback / private) from a
    // genuinely external attempt, instead of every failure reading as intrusion.
    const sourceScope = classifyIpScope(auditContext.ipAddress);

    logAuditEvent({
      action: "auth.login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        reason: "invalid_password",
        lockedOut: failureDecision.allowed === false,
        sourceScope,
        internalOrigin: sourceScope === "loopback" || sourceScope === "private",
      },
    });

    if (!failureDecision.allowed) {
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: failureDecision.retryAfterSeconds
            ? { "Retry-After": String(failureDecision.retryAfterSeconds) }
            : {},
        }
      );
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    console.error("[AUTH] Login failed:", error);
    logAuditEvent({
      action: "auth.login.error",
      actor: "system",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        message: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
