// Load playback against a running TRouteAI and mock-load.mjs: many agents asking one
// round-robin combo of three accounts (alpha, bravo with a few slots each; charlie with its
// quota used up) for the same model at once.
//
// It sends 40 requests at once, then 10 more every second for LOAD_SECONDS (default 60) plus
// the first second (650 in all by default), half streamed, each with a unique id
// "load-req-<n>" in its message. It then reads the stand-in's own timeline (/__stats) and
// prints one JSON summary and a short table.
//
// Usage: node load-e2e.mjs <base-url> <admin-password> <mock-url> <summary-file> [app-log]
import fs from "node:fs";

const [base, password, mockUrl, summaryFile, appLog] = process.argv.slice(2);
const SECONDS = Math.max(0, Number(process.env.LOAD_SECONDS ?? 60));
const BURST = 40;
const PER_SECOND = 10;
const BUDGET_MS = 120_000;
const COMBO = "load-combo";
const MODEL = "claude-opus-mock";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "";
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json, headers: res.headers };
}
function need(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  setup: ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exit(1);
}

// ── setup ───────────────────────────────────────────────────────────────────
const login = await api("/api/auth/login", { method: "POST", body: { password } });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
need("login", login.status === 200, `status ${login.status}`);
const node = await api("/api/provider-nodes", {
  method: "POST",
  body: { name: "Load Mock", prefix: "lm", type: "anthropic-compatible", baseUrl: mockUrl + "/v1" },
});
const nodeId = node.json?.node?.id;
need("anthropic-compatible node", !!nodeId, `status ${node.status}`);
const ids = {};
for (const name of ["alpha", "bravo", "charlie"]) {
  const r = await api("/api/providers", {
    method: "POST",
    body: { provider: nodeId, name, apiKey: name },
  });
  ids[name] = r.json?.connection?.id;
  need(`connection ${name}`, !!ids[name], `status ${r.status}`);
}
// lift the local requests-per-minute queue: this measures the combo, not that queue
const rq = await api("/api/resilience", {
  method: "PATCH",
  body: { requestQueue: { requestsPerMinute: 100000, minTimeBetweenRequestsMs: 0 } },
});
need("raise the local request queue limit", rq.status === 200, `status ${rq.status}`);
const combo = await api("/api/combos", {
  method: "POST",
  body: {
    name: COMBO,
    strategy: "round-robin",
    models: ["alpha", "bravo", "charlie"].map((n) => ({
      kind: "model",
      model: `lm/${MODEL}`,
      connectionId: ids[n],
      weight: 1,
    })),
  },
});
need("round-robin combo of three", combo.status < 300, `status ${combo.status}`);
const keyRes = await api("/api/keys", { method: "POST", body: { name: "load-key" } });
const apiKey = keyRes.json?.key;
need("api key", !!apiKey);
await fetch(mockUrl + "/__reset", { method: "POST" });

// ── playback ────────────────────────────────────────────────────────────────
const client = [];
async function one(id) {
  const stream = id % 2 === 1;
  const rec = { id, stream, sent: Date.now(), done: 0, status: 0, account: null, model: null };
  client.push(rec);
  try {
    const res = await fetch(base + "/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(300_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: COMBO,
        stream,
        max_tokens: 50,
        messages: [{ role: "user", content: `load-req-${id}: say hi` }],
      }),
    });
    const text = await res.text();
    rec.status = res.status;
    rec.retryAfter = res.headers.get("retry-after");
    rec.account = (text.match(/Hello from account ([a-z]+)/) || [])[1] || null;
    if (stream) {
      rec.model = (text.match(/"type":"message_start".*?"model":"([^"]+)"/) || [])[1] || null;
      const err =
        text.match(/"type":"error".*?"message":"((?:[^"\\]|\\.)*)"/) ||
        text.match(/event: error\ndata: .*?"message":"((?:[^"\\]|\\.)*)"/);
      if (err) rec.error = err[1];
    } else {
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {}
      rec.model = j?.model ?? null;
      if (j?.error) rec.error = String(j.error.message ?? j.error);
    }
    if (res.status !== 200 && !rec.error) rec.error = text.slice(0, 300);
    if (res.status === 200 && !rec.account) rec.error = rec.error || text.slice(0, 300);
  } catch (e) {
    rec.status = -1;
    rec.error = String(e?.message || e);
  }
  rec.done = Date.now();
}

const t0 = Date.now();
const pending = [];
let next = 1;
for (let i = 0; i < BURST; i++) {
  pending.push(one(next++));
  await sleep(1000 / BURST);
}
for (let s = 0; s <= SECONDS; s++) {
  const at = t0 + (s + 1) * 1000;
  for (let i = 0; i < PER_SECOND; i++) {
    const slot = at + (i * 1000) / PER_SECOND;
    if (slot > Date.now()) await sleep(slot - Date.now());
    pending.push(one(next++));
  }
}
const sentMs = Date.now() - t0;
await Promise.all(pending);
const totalMs = Date.now() - t0;
const stats = await (await fetch(mockUrl + "/__stats")).json();

// ── conversations ───────────────────────────────────────────────────────────
// Agents of one tool share one system text. CONVERSATIONS new conversations start one every
// CONV_GAP_MS on /v1/chat/completions, each with CONV_TURNS turns one after the other; the
// stand-in answers fast so the accounts are not full. Each conversation must keep its account
// (its prompt cache), and the new ones must spread over the accounts with quota.
const CONVERSATIONS = 10;
const CONV_TURNS = 4;
const CONV_GAP_MS = 600;
const CONV_THINK_MS = 300;
const SYSTEM = "You are a coding agent of the load playback. Work in the repository the user names.";
await fetch(mockUrl + "/__reset", { method: "POST", body: JSON.stringify({ answerMs: 300 }) });
const convs = [];
async function conversation(c) {
  const conv = { c, turns: [] };
  convs.push(conv);
  const messages = [{ role: "system", content: SYSTEM }];
  for (let t = 1; t <= CONV_TURNS; t++) {
    messages.push({ role: "user", content: `load-conv-${c}-${t}: change src/part${t}.ts` });
    const turn = { t, sent: Date.now(), done: 0, status: 0, account: null };
    conv.turns.push(turn);
    try {
      const res = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(300_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: COMBO, max_tokens: 50, messages }),
      });
      const text = await res.text();
      turn.status = res.status;
      turn.account = (text.match(/Hello from account ([a-z]+)/) || [])[1] || null;
    } catch (e) {
      turn.status = -1;
      turn.error = String(e?.message || e);
    }
    turn.done = Date.now();
    messages.push({ role: "assistant", content: `Hello from account ${turn.account}` });
    await sleep(CONV_THINK_MS);
  }
}
const convPending = [];
for (let c = 1; c <= CONVERSATIONS; c++) {
  convPending.push(conversation(c));
  await sleep(CONV_GAP_MS);
}
await Promise.all(convPending);
const convTurns = convs.flatMap((v) => v.turns);
const convFirst = {};
for (const v of convs) {
  const a = v.turns[0]?.account ?? "none";
  convFirst[a] = (convFirst[a] || 0) + 1;
}
const convTurnShare = {};
for (const t of convTurns) convTurnShare[t.account ?? "none"] = (convTurnShare[t.account ?? "none"] || 0) + 1;
const convJumped = convs.filter((v) => new Set(v.turns.map((t) => t.account)).size > 1);
const convFailed = convTurns.filter((t) => t.status !== 200 || !t.account);
const convWaits = convTurns.map((t) => t.done - t.sent);

// ── numbers ─────────────────────────────────────────────────────────────────
const SLOTS = stats.slots;
const QUOTA = ["alpha", "bravo"];
// occupancy step function per account from the stand-in's own start/end times
const timeline = {};
for (const a of QUOTA) {
  const ev = [];
  for (const r of stats.records) {
    if (r.account !== a || r.start == null) continue;
    ev.push([r.start, 1], [r.end ?? Infinity, -1]);
  }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const seg = [[-Infinity, 0]];
  let occ = 0;
  for (const [t, d] of ev) {
    occ += d;
    if (seg[seg.length - 1][0] === t) seg[seg.length - 1][1] = occ;
    else seg.push([t, occ]);
  }
  timeline[a] = seg;
}
// was a slot free on an account with quota at any moment inside [from, to]?
function slotFree(from, to) {
  for (const a of QUOTA) {
    const seg = timeline[a];
    let lo = 0;
    let hi = seg.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (seg[mid][0] <= from) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < seg.length && seg[i][0] <= to; i++) if (seg[i][1] < SLOTS) return true;
  }
  return false;
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null;
};
const answered = client.filter((r) => r.status === 200 && r.account);
const refused = client.filter((r) => !(r.status === 200 && r.account));
const words = (r) =>
  /usage limit|rate limit/i.test(r.error || "")
    ? "usage limit"
    : /busy|in use|waiting/i.test(r.error || "")
      ? "busy"
      : "other";
const byStatus = {};
const byWords = {};
for (const r of refused) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  byWords[words(r)] = (byWords[words(r)] || 0) + 1;
}
const share = {};
for (const r of answered) share[r.account] = (share[r.account] || 0) + 1;
const sharePct = Object.fromEntries(
  Object.entries(share).map(([a, n]) => [a, Math.round((1000 * n) / answered.length) / 10])
);
const waits = client.map((r) => r.done - r.sent);
const r429 = client.filter((r) => r.status === 429);
const refusedWhileSlotFree = refused.filter(
  (r) => r.done - r.sent <= BUDGET_MS && slotFree(r.sent, r.done)
);
const usageLimit429 = r429.filter((r) => words(r) === "usage limit");
const no429RetryAfter = r429.filter((r) => !/^\d+$/.test(String(r.retryAfter ?? "")));
const wrongModel = answered.filter((r) => r.model !== COMBO);
const upstream = {};
for (const r of stats.records) {
  const u = (upstream[r.account] ||= {});
  u[r.outcome] = (u[r.outcome] || 0) + 1;
}
// a high-load 500 that became a cool-down: no request to that account in the next 5 s
const highLoad = stats.records.filter((r) => r.outcome === "high-load-500");
const highLoadThenQuiet = highLoad.filter(
  (h) =>
    !stats.records.some((r) => r.account === h.account && r.arrival > h.end && r.arrival <= h.end + 5000)
).length;
let logLines = null;
if (appLog && fs.existsSync(appLog)) {
  const log = fs.readFileSync(appLog, "utf8");
  logLines = {
    semaphoreTimeout: (log.match(/Semaphore (timeout|queue full) for/g) || []).length,
    rateLimitedResetAfter: (log.match(/rate limited \(reset after/g) || []).length,
    highLoad: (log.match(/unexpectedly high load/g) || []).length,
  };
}

const summary = {
  requests: client.length,
  sentInMs: sentMs,
  totalMs,
  slotsPerAccount: SLOTS,
  answerMs: stats.answerMs,
  answered: answered.length,
  refused: refused.length,
  refusedByStatus: byStatus,
  refusedByWords: byWords,
  answeredShare: share,
  answeredSharePct: sharePct,
  waitMs: { p50: pct(waits, 50), p95: pct(waits, 95), max: pct(waits, 100) },
  answeredWaitMs: {
    p50: pct(answered.map((r) => r.done - r.sent), 50),
    p95: pct(answered.map((r) => r.done - r.sent), 95),
  },
  refusedWhileSlotFree: refusedWhileSlotFree.length,
  usageLimit429: usageLimit429.length,
  r429WithoutRetryAfterSeconds: no429RetryAfter.length,
  answeredByOtherModel: wrongModel.length,
  upstreamOutcomes: upstream,
  highLoad500: highLoad.length,
  highLoad500ThenCoolDown: highLoadThenQuiet,
  appLog: logLines,
  sampleRefusals: Object.keys(byStatus).flatMap((st) =>
    [...new Set(refused.filter((r) => String(r.status) === st).map((r) => `${st} ${(r.error || "").slice(0, 160)}`))].slice(0, 3)
  ),
  sampleRetryAfter: [...new Set(r429.map((r) => r.retryAfter))].slice(0, 5),
  conversations: {
    count: convs.length,
    turns: convTurns.length,
    firstTurnAccount: convFirst,
    turnShare: convTurnShare,
    jumpedAccount: convJumped.length,
    failedTurns: convFailed.length,
    turnWaitMs: { p50: pct(convWaits, 50), p95: pct(convWaits, 95), max: pct(convWaits, 100) },
  },
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));

console.log("");
console.log(`requests ${client.length} sent in ${sentMs} ms, all back after ${totalMs} ms`);
console.log(`answered ${answered.length}   refused ${refused.length}  ${JSON.stringify(byStatus)} ${JSON.stringify(byWords)}`);
console.log(`share of answered  ${JSON.stringify(sharePct)}`);
console.log(`client wait ms     p50 ${summary.waitMs.p50}  p95 ${summary.waitMs.p95}  max ${summary.waitMs.max}`);
console.log(`high-load 500s     ${highLoad.length} (then cool-down: ${highLoadThenQuiet})`);
console.log(`new conversations  first turn on ${JSON.stringify(convFirst)}  all turns ${JSON.stringify(convTurnShare)}`);
console.log(`conversation turns wait ms p50 ${summary.conversations.turnWaitMs.p50}  p95 ${summary.conversations.turnWaitMs.p95}`);
console.log("");

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
check(
  "no refusal while an account with quota had a free slot (within a 120 s wait)",
  refusedWhileSlotFree.length === 0,
  `${refusedWhileSlotFree.length} of ${refused.length}`
);
check(
  'no 429 that says "usage limit" while an account with quota exists',
  usageLimit429.length === 0,
  `${usageLimit429.length} of ${r429.length}`
);
check(
  "every 429 has a Retry-After in seconds",
  no429RetryAfter.length === 0,
  `${no429RetryAfter.length} of ${r429.length} without`
);
const maxShare = Math.max(0, ...QUOTA.map((a) => share[a] || 0)) / Math.max(1, answered.length);
check(
  "no account with quota carries more than 65 % of the answered",
  answered.length > 0 && maxShare <= 0.65,
  JSON.stringify(sharePct)
);
check(
  "every answer names the combo as its model",
  answered.length > 0 && wrongModel.length === 0,
  `${wrongModel.length} of ${answered.length} other: ${[...new Set(wrongModel.map((r) => r.model))].slice(0, 3)}`
);
check(
  "every conversation turn answered and every conversation kept one account",
  convFailed.length === 0 && convJumped.length === 0,
  `${convFailed.length} failed, ${convJumped.length} of ${convs.length} moved`
);
const convMax = Math.max(0, ...QUOTA.map((a) => convFirst[a] || 0));
check(
  "new conversations spread over the accounts with quota (none takes more than 6 of 10)",
  convs.length > 0 && convMax <= Math.ceil(convs.length * 0.6) && !convFirst.charlie,
  JSON.stringify(convFirst)
);
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} load checks passed`);
process.exit(failed ? 1 : 0);
