import { NextResponse } from "next/server";
import { getStats as getAccountSemaphoreStats } from "@trouteai/open-sse/services/accountSemaphore.ts";
import { getStats as getRateLimitSemaphoreStats } from "@trouteai/open-sse/services/rateLimitSemaphore.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnections } from "@/lib/db/providers";
import { getAccountCostSums, getCostWindows, getKeyCostSums } from "@/lib/db/costView";
import { getPendingRequests } from "@/lib/usage/usageHistory";

export const dynamic = "force-dynamic";

const laterOf = (a: string | null, b: string | null, nowMs: number): string | null => {
  const future = [a, b].filter((v): v is string => !!v && Date.parse(v) > nowMs);
  if (future.length === 0) return null;
  return future.reduce((x, y) => (Date.parse(x) >= Date.parse(y) ? x : y));
};

/** What each account and each API key is doing now and what it used today and this week. */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const nowMs = Date.now();
  const accountGates = getAccountSemaphoreStats();
  const pending = getPendingRequests().byAccount;
  const sums = new Map(getAccountCostSums(nowMs).map((row) => [row.connectionId, row]));
  const connections = (await getProviderConnections()) as Array<Record<string, unknown>>;

  const accounts = connections.map((conn) => {
    const id = String(conn.id);
    const provider = String(conn.provider || "");
    // The account gate is keyed provider:connectionId; it exists only when the account has a
    // concurrency cap. Without one, the request tracker gives the number in flight.
    const gate = accountGates[`${provider}:${id}`];
    const tracked = Object.values(pending[id] || {}).reduce((a, b) => a + Number(b || 0), 0);
    const day = sums.get(id);
    return {
      connectionId: id,
      provider,
      name: String(conn.name || conn.displayName || conn.email || id),
      inFlight: gate ? gate.running : tracked,
      waiting: gate ? gate.queued : 0,
      slots: gate ? gate.maxConcurrency : null,
      limitedUntil: laterOf(
        (conn.rateLimitedUntil as string | null) ?? null,
        gate?.blockedUntil ?? null,
        nowMs
      ),
      requestsToday: day?.requestsToday ?? 0,
      failedToday: day?.failedToday ?? 0,
      inputTokensToday: day?.inputTokensToday ?? 0,
      outputTokensToday: day?.outputTokensToday ?? 0,
    };
  });

  // Combo targets: the per-model gates the combo loop waits in.
  const comboTargets = Object.entries(getRateLimitSemaphoreStats()).map(([key, s]) => ({
    key,
    inFlight: s.running,
    waiting: s.queued,
  }));

  return NextResponse.json({
    timestamp: new Date(nowMs).toISOString(),
    windows: getCostWindows(nowMs),
    accounts,
    comboTargets,
    keys: getKeyCostSums(nowMs),
  });
}
