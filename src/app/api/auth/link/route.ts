import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { LOGIN_LINK_TTL_SECONDS, mintLoginLink } from "@/lib/auth/loginLink";
import { resolvePublicOrigin } from "@/server/origin/publicOrigin";

// POST /api/auth/link - a one-time sign-in link for this gateway's own page (see
// src/app/login/link/route.ts). Management only: the command token or a key with the manage scope.
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  // Without the session secret the link could not sign anyone in.
  if (!process.env.JWT_SECRET) {
    return NextResponse.json({ error: "Sign-in is not set up" }, { status: 503 });
  }

  const code = mintLoginLink();
  const origin = resolvePublicOrigin(request).origin.replace(/\/+$/, "");
  return NextResponse.json(
    { url: `${origin}/login/link?code=${code}`, expiresIn: LOGIN_LINK_TTL_SECONDS },
    { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } }
  );
}
