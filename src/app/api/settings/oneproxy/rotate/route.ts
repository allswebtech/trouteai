// Compat redirect: /rotate was retired together with the legacy 1proxy system.
// The closest equivalent now is forcing a sync of the free-proxy sources.
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return new Response(null, {
    status: 308,
    headers: { Location: "/api/settings/free-proxies/sync" },
  });
}
