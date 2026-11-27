import { NextResponse } from "next/server";
import { consumeLoginLink } from "@/lib/auth/loginLink";
import { SESSION_MAX_AGE_SECONDS, signDashboardSession } from "@/server/auth/dashboardSession";
import { shouldUseSecureCookie } from "@/server/origin/publicOrigin";

// GET /login/link?code=... - public, one use, 60 seconds. Signs in like POST /api/auth/login (the
// same cookie, the same flags) and goes to the dashboard. A used, late or wrong code goes to the
// sign-in page and says nothing more. The code is never logged. This page sits outside the authz
// pipeline (src/server/security/proxyRoutes.ts), so it is public for GET without any list entry.
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

// A relative Location, so the browser stays on the address it used.
function goTo(path: string): NextResponse {
  const response = new NextResponse(null, { status: 302, headers: PRIVATE_HEADERS });
  response.headers.set("Location", path);
  return response;
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!process.env.JWT_SECRET || !consumeLoginLink(code)) return goTo("/login");

  let token: string;
  try {
    token = await signDashboardSession();
  } catch {
    return goTo("/login");
  }
  const response = goTo("/dashboard");
  response.cookies.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
