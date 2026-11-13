// Window rule checks for src/domain/quotaCache.ts: which used-up windows block which account.
// Run from the repository root, with a throwaway data folder:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-quota-windows.mts
import {
  setQuotaCache,
  isQuotaExhaustedForRequest,
  getQuotaBlockedUntil,
  applyUnifiedUsageHeaders,
} from "../../src/domain/quotaCache.ts";

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const q = (remainingPercentage: number, resetAt: string | null) => ({
  remainingPercentage,
  resetAt,
});

let n = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  n++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function account(provider: string, quotas: Record<string, unknown>, opts = {}) {
  const id = `${provider}-${n}-${Math.random().toString(36).slice(2, 8)}`;
  setQuotaCache(id, provider, quotas, opts);
  return id;
}

// Claude: 5h used up, weekly left → blocked until the 5h reset
{
  const id = account("claude", {
    "session (5h)": q(0, inHours(2)),
    "weekly (7d)": q(40, inHours(90)),
  });
  check(
    "claude 5h used up, weekly 40%: blocked",
    isQuotaExhaustedForRequest(id, "claude", "claude-opus-5-5")
  );
  const until = getQuotaBlockedUntil(id, null);
  check(
    "claude: blocked until the 5h reset",
    !!until && Math.abs(new Date(until).getTime() - Date.now() - 2 * 3600_000) < 5000,
    String(until)
  );
}
// Claude: 5h and weekly used up → blocked until the LATER reset
{
  const id = account("claude", {
    "session (5h)": q(0, inHours(2)),
    "weekly (7d)": q(0, inHours(50)),
  });
  const until = getQuotaBlockedUntil(id, null);
  check(
    "claude 5h + weekly used up: until the weekly reset",
    !!until && new Date(until).getTime() > Date.now() + 49 * 3600_000,
    String(until)
  );
}
// Claude: reset already passed → not blocked
{
  const id = account("claude", { "session (5h)": q(0, ago(1)), "weekly (7d)": q(40, inHours(90)) });
  check(
    "claude window reset already passed: usable",
    !isQuotaExhaustedForRequest(id, "claude", "claude-opus-5-5")
  );
}
// Claude: Opus-only weekly → Opus blocked, Sonnet usable
{
  const id = account("claude", {
    "session (5h)": q(60, inHours(2)),
    "weekly (7d)": q(50, inHours(90)),
    "weekly opus (7d)": q(0, inHours(30)),
  });
  check(
    "claude opus weekly used up: opus blocked",
    isQuotaExhaustedForRequest(id, "claude", "claude-opus-5-5")
  );
  check(
    "claude opus weekly used up: sonnet usable",
    !isQuotaExhaustedForRequest(id, "claude", "claude-sonnet-5")
  );
  check(
    "claude opus weekly used up: account not blocked as a whole",
    getQuotaBlockedUntil(id, null) === null
  );
}
// Claude with paid overage allowed → usable
{
  const id = account("claude", { "session (5h)": q(0, inHours(2)) }, { overageAllowed: true });
  check(
    "claude overage allowed: usable",
    !isQuotaExhaustedForRequest(id, "claude", "claude-opus-5-5")
  );
}
// Codex: spark weekly used up must not block normal Codex
{
  const id = account("codex", {
    session: q(70, inHours(3)),
    weekly: q(50, inHours(100)),
    gpt_5_3_codex_spark_session: q(0, inHours(3)),
    gpt_5_3_codex_spark_weekly: q(0, inHours(100)),
    code_review_weekly: q(0, inHours(100)),
  });
  check(
    "codex spark/code-review used up: normal codex usable",
    !isQuotaExhaustedForRequest(id, "codex", "gpt-5.5-codex")
  );
  check(
    "codex spark/code-review used up: account not blocked as a whole",
    getQuotaBlockedUntil(id, "gpt-5.5-codex") === null
  );
}
// Antigravity: claude_gpt weekly used up must not block Gemini
{
  const id = account("antigravity", {
    claude_gpt_weekly: q(0, inHours(40)),
    gemini_weekly: q(80, inHours(40)),
  });
  check(
    "antigravity claude_gpt weekly used up: gemini not blocked account-wide",
    getQuotaBlockedUntil(id, "gemini-3-pro") === null
  );
}
// CodeBuddy: a used-up Monthly refill beside a bonus pack with credit stays usable
{
  const id = account("codebuddy-cn", { Monthly: q(0, inHours(200)), "Bonus Pack 1": q(60, null) });
  check(
    "codebuddy monthly refill used up, bonus pack left: usable",
    !isQuotaExhaustedForRequest(id, "codebuddy-cn", "x")
  );
}
// Kiro credits: unchanged (all at 0% only)
{
  const id = account("kiro", { credit: q(30, inHours(300)) });
  check("kiro credits left: usable", !isQuotaExhaustedForRequest(id, "kiro", "claude-opus-5.5"));
}
// Overage survives a restart (the entry is rebuilt from snapshot rows)
{
  const id = account("claude", { "session (5h)": q(0, inHours(2)) }, { overageAllowed: true });
  const state = Object.values(globalThis as Record<string, any>).find(
    (v) => v && v.cache instanceof Map && v.refreshingSet
  );
  state.cache.delete(id);
  check(
    "claude overage after a restart: still usable",
    !isQuotaExhaustedForRequest(id, "claude", "claude-opus-5-5")
  );
}
// A reset time far in the future from headers is not trusted (no months-long block)
{
  const id = `hdr-${n}`;
  applyUnifiedUsageHeaders(id, "anthropic-compatible-x", {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 400 * 86400),
  });
  check("header reset 400 days away: not blocked", getQuotaBlockedUntil(id, null) === null);
  const id2 = `hdr2-${n}`;
  applyUnifiedUsageHeaders(id2, "anthropic-compatible-x", {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3 * 3600),
  });
  check("header reset 3 h away: blocked", getQuotaBlockedUntil(id2, null) !== null);
}
// GLM / Kimi: 5h used up → GLM blocked; Kimi keeps the all-at-0% rule (parser unverified)
{
  const id = account("glm", {
    session: q(0, inHours(1)),
    weekly: q(50, inHours(90)),
    mcp_monthly: q(0, inHours(500)),
  });
  check("glm session used up: blocked", isQuotaExhaustedForRequest(id, "glm", "glm-5"));
  const id2 = account("glm", {
    session: q(40, inHours(1)),
    weekly: q(50, inHours(90)),
    mcp_monthly: q(0, inHours(500)),
  });
  check("glm only mcp_monthly used up: usable", !isQuotaExhaustedForRequest(id2, "glm", "glm-5"));
  const id3 = account("kimi-coding", {
    "session (5h)": q(0, inHours(1)),
    "weekly (7d)": q(30, inHours(90)),
  });
  check(
    "kimi 5h window used up: blocked until its reset (window rule since the live usage shape is read)",
    isQuotaExhaustedForRequest(id3, "kimi-coding", "kimi-k3")
  );
}
// Kimi Code: the live /coding/v1/usages shape (limits[] limit/used, usages{} used_ratio)
{
  const { getKimiUsage } = await import("../../open-sse/services/usage/kimi.ts");
  const realFetch = globalThis.fetch;
  const payload = (used5h: string, monthRatio: number) => ({
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: used5h, resetTime: inHours(2) },
      },
    ],
    usages: {
      limit_5h: { used_ratio: Number(used5h) / 100, reset_time: inHours(2) },
      limit_month_total: { used_ratio: monthRatio, reset_time: inHours(300) },
      limit_month_code: { used_ratio: 0, reset_time: inHours(300) },
    },
  });
  const usageOf = async (p: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(p), { status: 200 })) as never;
    try {
      return (await getKimiUsage("", "sk-test", {})) as { quotas?: Record<string, any> };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const fresh = await usageOf(payload("20", 0.0795));
  check(
    "kimi live payload: 5h window 80% left (limit - used, no remaining field)",
    fresh.quotas?.["session (5h)"]?.remainingPercentage === 80,
    JSON.stringify(fresh.quotas?.["session (5h)"])
  );
  check(
    "kimi live payload: monthly (total) 92.05% left, monthly (code) 100%, limit_5h not doubled",
    Math.abs((fresh.quotas?.["monthly (total)"]?.remainingPercentage ?? 0) - 92.05) < 0.01 &&
      fresh.quotas?.["monthly (code)"]?.remainingPercentage === 100 &&
      Object.keys(fresh.quotas || {}).length === 3,
    Object.keys(fresh.quotas || {}).join(",")
  );
  const idFresh = account("kimi-coding", fresh.quotas || {});
  check(
    "kimi fresh account: usable",
    !isQuotaExhaustedForRequest(idFresh, "kimi-coding", "kimi-k3")
  );
  const spent = await usageOf(payload("100", 1));
  const idSpent = account("kimi-coding", spent.quotas || {});
  const until = getQuotaBlockedUntil(idSpent, null);
  check(
    "kimi 5h and monthly used up: blocked until the monthly reset",
    isQuotaExhaustedForRequest(idSpent, "kimi-coding", "kimi-k3") &&
      !!until &&
      new Date(until).getTime() > Date.now() + 299 * 3600_000,
    String(until)
  );
}

console.log(`\n${n - failed}/${n} passed`);
process.exit(failed ? 1 : 0);
