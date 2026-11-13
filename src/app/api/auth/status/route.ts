import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyDashboardSession } from "@/server/auth/dashboardSession";

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    const secret = getJwtSecret();

    if (!token || !secret) {
      return NextResponse.json({ authenticated: false });
    }

    await verifyDashboardSession(token);
    return NextResponse.json({ authenticated: true });
  } catch {
    return NextResponse.json({ authenticated: false });
  }
}
