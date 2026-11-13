import { NextResponse } from "next/server";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { cookies } from "next/headers";
import { revokeDashboardSession, SESSION_COOKIE_NAME } from "@/server/auth/dashboardSession";

export const logoutRouteInternals = {
  getCookieStore: cookies,
};

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);
  const cookieStore = await logoutRouteInternals.getCookieStore();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  try {
    await revokeDashboardSession(token);
  } catch (error) {
    console.warn(
      "[Auth] Could not record logout revocation:",
      error instanceof Error ? error.message : String(error)
    );
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
  logAuditEvent({
    action: "auth.logout.success",
    actor: "admin",
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
  });
  return NextResponse.json({ success: true });
}
