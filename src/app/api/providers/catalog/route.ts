import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildProviderCatalog } from "@/lib/providers/addFlow";

// GET /api/providers/catalog - the providers this gateway knows and how an account is added to
// each. Static facts of the code: no account data and no secret.
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json(
    { providers: buildProviderCatalog() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
