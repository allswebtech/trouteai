// The cost view (/api/usage/live): per account in flight, waiting, limited until and today's
// requests and tokens; per API key today's and this week's requests, input and output tokens and
// the share of input served from a prompt cache. A request retried on another account is counted
// once; an upstream that reports no cache figures is marked as such, never shown as 0 %; the
// route refuses a caller without the dashboard's sign-in. In-process, made-up data only.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-cost-view.mts
import { randomUUID } from "node:crypto";
import fs from "node:fs";

process.env.INITIAL_PASSWORD = "Check-Pass-123";
process.env.JWT_SECRET = randomUUID() + randomUUID();

const { GET } = await import("../../src/app/api/usage/live/route.ts");
const { createProviderConnection, updateProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { saveRequestUsage } = await import("../../src/lib/usage/usageHistory.ts");
const { signDashboardSession } = await import("../../src/server/auth/dashboardSession.ts");
const accountSemaphore = await import("../../open-sse/services/accountSemaphore.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ── Two accounts: "alpha" reports cache figures, "beta" reports none ─────────────────────
const alpha = (await createProviderConnection({
  provider: "claude",
  authType: "apikey",
  name: "alpha",
  apiKey: "sk-alpha-made-up",
})) as { id: string };
const beta = (await createProviderConnection({
  provider: "kiro",
  authType: "apikey",
  name: "beta",
  apiKey: "sk-beta-made-up",
})) as { id: string };
const limitedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
await updateProviderConnection(beta.id, { rateLimitedUntil: limitedUntil });

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const dayStart = new Date(now);
dayStart.setUTCHours(0, 0, 0, 0);
const ts = (ms: number) => new Date(ms).toISOString();
// A moment safely inside today (between midnight and now).
const today = (n: number) => ts(dayStart.getTime() + Math.floor((now - dayStart.getTime()) / 2) + n);

const usage = (o: {
  conn: { id: string };
  provider: string;
  key: string;
  at: string;
  input: number;
  output: number;
  cacheRead?: number;
  success?: boolean;
}) =>
  saveRequestUsage({
    provider: o.provider,
    model: "model-x",
    connectionId: o.conn.id,
    apiKeyId: o.key,
    apiKeyName: o.key,
    tokens: { input: o.input, output: o.output, cacheRead: o.cacheRead ?? 0, cacheCreation: 0 },
    success: o.success ?? true,
    status: o.success === false ? "529" : "200",
    timestamp: o.at,
  } as Parameters<typeof saveRequestUsage>[0]);

// key "shop": two answered requests today on alpha (1000 in / 600 cache reads, 500 in / 200 cache)
await usage({ conn: alpha, provider: "claude", key: "shop", at: today(1), input: 1000, output: 50, cacheRead: 600 });
await usage({ conn: alpha, provider: "claude", key: "shop", at: today(2), input: 500, output: 20, cacheRead: 200 });
// one request today that failed on beta first and was answered on alpha: counted once
await usage({ conn: beta, provider: "kiro", key: "shop", at: today(3), input: 0, output: 0, success: false });
await usage({ conn: alpha, provider: "claude", key: "shop", at: today(4), input: 300, output: 10, cacheRead: 0 });
// yesterday (this week, not today) and eight days ago (neither)
await usage({ conn: alpha, provider: "claude", key: "shop", at: ts(dayStart.getTime() - 1), input: 2000, output: 100, cacheRead: 1000 });
await usage({ conn: alpha, provider: "claude", key: "shop", at: ts(dayStart.getTime() - 7 * DAY), input: 9999, output: 9999 });
// exactly at the week's start (six days before today's midnight): counted in the week
await usage({ conn: alpha, provider: "claude", key: "shop", at: ts(dayStart.getTime() - 6 * DAY), input: 100, output: 1 });

// key "example": only beta, an upstream with no cache figures
await usage({ conn: beta, provider: "kiro", key: "example", at: today(5), input: 4000, output: 400 });
await usage({ conn: beta, provider: "kiro", key: "example", at: today(6), input: 1000, output: 100 });

// One request in flight on alpha and one waiting behind it.
const gateKey = `claude:${alpha.id}`;
const release = await accountSemaphore.acquire(gateKey, { maxConcurrency: 1, timeoutMs: 5000 });
const waiter = accountSemaphore.acquire(gateKey, { maxConcurrency: 1, timeoutMs: 5000 });

// ── Without the dashboard's sign-in ─────────────────────────────────────────────────────
const bare = await GET(new Request("http://127.0.0.1/api/usage/live"));
check("no sign-in: 401", bare.status === 401, `status ${bare.status}`);
const wrong = await GET(
  new Request("http://127.0.0.1/api/usage/live", { headers: { cookie: "auth_token=made-up" } })
);
check("a made-up session cookie: 401", wrong.status === 401, `status ${wrong.status}`);

// ── Signed in ───────────────────────────────────────────────────────────────────────────
const cookie = `auth_token=${await signDashboardSession()}`;
const res = await GET(new Request("http://127.0.0.1/api/usage/live", { headers: { cookie } }));
check("signed in: 200", res.status === 200, `status ${res.status}`);
const body = (await res.json()) as any;

const acc = (id: string) => body.accounts?.find((a: any) => a.connectionId === id);
const a = acc(alpha.id);
const b = acc(beta.id);
check("alpha: 1 in flight, 1 waiting", a?.inFlight === 1 && a?.waiting === 1, JSON.stringify(a));
check("alpha: not limited", a?.limitedUntil === null);
check("alpha: 3 requests today", a?.requestsToday === 3, String(a?.requestsToday));
check("alpha: today's tokens 1800 in / 80 out", a?.inputTokensToday === 1800 && a?.outputTokensToday === 80);
check("beta: limited until its reset", b?.limitedUntil === limitedUntil, String(b?.limitedUntil));
check(
  "beta: 3 requests today, 1 of them failed",
  b?.requestsToday === 3 && b?.failedToday === 1,
  JSON.stringify(b)
);
check("beta: nothing in flight", b?.inFlight === 0 && b?.waiting === 0);

const key = (id: string) => body.keys?.find((k: any) => k.apiKeyId === id);
const shop = key("shop");
check("shop today: 3 requests (the retried one once)", shop?.today.requests === 3, String(shop?.today.requests));
check("shop today: 1800 in / 80 out (no double count)", shop?.today.inputTokens === 1800 && shop?.today.outputTokens === 80, JSON.stringify(shop?.today));
check("shop today: cache share 800 / 1800", Math.abs((shop?.today.cacheShare ?? -1) - 800 / 1800) < 1e-9, String(shop?.today.cacheShare));
check("shop week: 5 requests, 3900 in / 181 out", shop?.week.requests === 5 && shop?.week.inputTokens === 3900 && shop?.week.outputTokens === 181, JSON.stringify(shop?.week));
check("shop week: cache share 1800 / 3900", Math.abs((shop?.week.cacheShare ?? -1) - 1800 / 3900) < 1e-9, String(shop?.week.cacheShare));
check("shop: the eight-day-old row is outside the week", (shop?.week.inputTokens ?? 0) < 9999);

const ex = key("example");
check("example today: 2 requests, 5000 in / 500 out", ex?.today.requests === 2 && ex?.today.inputTokens === 5000 && ex?.today.outputTokens === 500, JSON.stringify(ex?.today));
check("example: no cache figures, share is null (not 0)", ex?.today.noCacheFigures === true && ex?.today.cacheShare === null && ex?.week.cacheShare === null);
check("shop: has cache figures", shop?.today.noCacheFigures === false);

// ── The plain words the page shows for "no cache figures" ───────────────────────────────
const en = JSON.parse(fs.readFileSync(new URL("../../src/i18n/messages/en.json", import.meta.url), "utf8"));
check(
  "the page's words for no cache figures",
  en.runtime?.costNoCacheFigures ===
    "This provider reports no prompt cache figures, so every request is billed in full",
  String(en.runtime?.costNoCacheFigures)
);

release();
(await waiter)();
process.exit(failed ? 1 : 0);
