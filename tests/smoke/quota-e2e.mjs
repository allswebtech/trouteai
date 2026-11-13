// Usage-limit routing checks against a running TRouteAI and mock-anthropic.mjs.
//
// An account (connection) whose usage limit is used up must be skipped WITHOUT sending it a
// request, until its reset time; then it is used again by itself. This runs for every combo
// strategy, for direct provider/model calls, for streaming, across a restart (phase "after"),
// and measures the request time.
//
// Usage: node quota-e2e.mjs <base-url> <admin-password> <mock-url> <phase> <state-file>
//   phase: main      setup + all checks; leaves account A limited for 150 s for the restart check
//          after     run after a restart: account A must still be skipped (no request to it)
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [
  base,
  password,
  mockUrl,
  phase = "main",
  stateFile = join(tmpdir(), "quota-e2e-state.json"),
] = process.argv.slice(2);

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
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
async function mock(path, body) {
  const res = await fetch(mockUrl + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
const hits = async () => (await mock("/__stats")).hits;

async function login() {
  const r = await api("/api/auth/login", {
    method: "POST",
    body: { password },
  });
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return r.status;
}

let auth = {};
let chatSeq = 0;
async function chat(model, { stream = false, format = "openai" } = {}) {
  const t0 = performance.now();
  const path = format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const headers =
    format === "anthropic"
      ? { "x-api-key": auth.key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${auth.key}` };
  const res = await fetch(base + path, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 50,
      // a new conversation every time: the same first message would pin the session to one
      // account (session affinity), which is right for real chats but hides routing here
      messages: [{ role: "user", content: `hi ${++chatSeq}` }],
    }),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    ms: performance.now() - t0,
    retryAfter: res.headers.get("retry-after"),
  };
}
const from = (r) => (r.text.match(/Hello from account ([a-z0-9-]+)/) || [])[1] || null;
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

// ── setup ───────────────────────────────────────────────────────────────────
check("login", (await login()) === 200);
let state = {};
if (phase === "main") {
  await mock("/__reset", {});
  const node1 = await api("/api/provider-nodes", {
    method: "POST",
    body: {
      name: "Claude Mock",
      prefix: "cm",
      type: "anthropic-compatible",
      baseUrl: mockUrl + "/v1",
    },
  });
  const node2 = await api("/api/provider-nodes", {
    method: "POST",
    body: {
      name: "Claude Mock 2",
      prefix: "cm2",
      type: "anthropic-compatible",
      baseUrl: mockUrl + "/v1",
    },
  });
  const n1 = node1.json?.node?.id;
  const n2 = node2.json?.node?.id;
  check("create two anthropic-compatible nodes", !!n1 && !!n2, `${node1.status} ${node2.status}`);
  const conn = async (provider, name, apiKey) =>
    (
      await api("/api/providers", {
        method: "POST",
        body: { provider, name, apiKey },
      })
    ).json?.connection?.id;
  const A = await conn(n1, "acc-a", "acc-a");
  const B = await conn(n1, "acc-b", "acc-b");
  const C = await conn(n2, "acc-c", "acc-c");
  check("create connections A, B (cm) and C (cm2)", !!A && !!B && !!C);
  // Many requests per minute go to one account here; lift the local 60 RPM queue so the
  // test measures routing, not the request queue.
  const rq = await api("/api/resilience", {
    method: "PATCH",
    body: {
      requestQueue: { requestsPerMinute: 1000, minTimeBetweenRequestsMs: 0 },
    },
  });
  check("raise the local request queue limit", rq.status === 200, `status ${rq.status}`);
  const key = await api("/api/keys", {
    method: "POST",
    body: { name: "quota-key" },
  });
  state = { n1, n2, A, B, C, key: key.json?.key };
  check("create api key", !!state.key);
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
}
auth = { key: state.key };
const OPUS = "claude-opus-mock";

async function makeCombo(name, strategy, steps) {
  const r = await api("/api/combos", {
    method: "POST",
    body: { name, strategy, models: steps },
  });
  return r.json?.id || r.json?.combo?.id || null;
}
const stepA = {
  kind: "model",
  model: `cm/${OPUS}`,
  connectionId: state.A,
  weight: 50,
};
const stepB = {
  kind: "model",
  model: `cm/${OPUS}`,
  connectionId: state.B,
  weight: 50,
};
const stepC = {
  kind: "model",
  model: `cm2/${OPUS}`,
  connectionId: state.C,
  weight: 50,
};

if (phase === "after") {
  // A was limited for 150 s before the restart: it must still be skipped, with no request to it
  const before = (await hits())["acc-a"] || 0;
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await chat("q-priority"));
  const after = (await hits())["acc-a"] || 0;
  check(
    "after a restart the limited account is still skipped (no request to it)",
    rs.every((r) => r.status === 200 && from(r) !== "acc-a") && after === before,
    `statuses ${rs.map((r) => r.status)} A hits ${before}->${after}`
  );
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} passed`);
  process.exit(ok === results.length ? 0 : 1);
}

// ── baseline latency: healthy accounts ──────────────────────────────────────
await makeCombo("q-priority", "priority", [stepA, stepB]);
for (let i = 0; i < 3; i++) await chat("q-priority"); // warm up
const healthy = [];
for (let i = 0; i < 30; i++) healthy.push((await chat("q-priority")).ms);
console.log(
  `TIME healthy combo: p50 ${pct(healthy, 50).toFixed(1)} ms, p95 ${pct(healthy, 95).toFixed(1)} ms`
);

// ── every strategy: A limited, B healthy ────────────────────────────────────
const STRATEGIES = [
  "priority",
  "round-robin",
  "weighted",
  "fill-first",
  "random",
  "strict-random",
  "least-used",
  "p2c",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "headroom",
  "context-relay",
  "context-optimized",
  "lkgp",
  "auto",
];
// QUOTA_ONLY=priority,p2c runs only those strategies (debugging)
const ONLY = (process.env.QUOTA_ONLY || "").split(",").filter(Boolean);
if (ONLY.length) STRATEGIES.splice(0, STRATEGIES.length, ...ONLY);
const firstHitTimes = [];
const knownTimes = [];
for (const strategy of STRATEGIES) {
  await mock("/__reset", {});
  // a limit with a reset 25 s away (a short "5 hours")
  await mock("/__control", {
    key: "acc-a",
    mode: "limit",
    claim: "five_hour",
    resetInSec: 25,
  });
  const name = `q-${strategy}`;
  if (strategy !== "priority") await makeCombo(name, strategy, [stepA, stepB]);
  const rs = [];
  for (let i = 0; i < 8; i++) rs.push(await chat(name));
  const h = await hits();
  const okAll = rs.every((r) => r.status === 200 && from(r) === "acc-b");
  // At most ONE request may reach A: the one that discovers the limit.
  check(
    `[${strategy}] limited account skipped, every request answered by the other`,
    okAll && (h["acc-a"] || 0) <= 1,
    `statuses ${rs.map((r) => r.status).join(",")} A hits ${h["acc-a"] || 0} B hits ${h["acc-b"] || 0}`
  );
  if ((h["acc-a"] || 0) === 1) firstHitTimes.push(rs[0].ms);
  knownTimes.push(...rs.slice(1).map((r) => r.ms));
  // un-limit A for the next strategy (and clear the router's memory of it via the reset)
  await mock("/__control", { key: "acc-a", mode: "ok" });
  await api(`/api/providers/${state.A}`, {
    method: "PUT",
    body: { rateLimitedUntil: null, testStatus: "active" },
  });
}
console.log(
  `TIME limited account known: p50 ${pct(knownTimes, 50).toFixed(1)} ms, p95 ${pct(knownTimes, 95).toFixed(1)} ms; first discovery p50 ${pct(firstHitTimes, 50).toFixed(1)} ms`
);

// ── auto-resume at the reset time ───────────────────────────────────────────
await mock("/__reset", {});
await api(`/api/providers/${state.A}`, {
  method: "PUT",
  body: { rateLimitedUntil: null, testStatus: "active" },
});
await mock("/__control", {
  key: "acc-a",
  mode: "limit",
  claim: "five_hour",
  resetInSec: 12,
});
await chat("q-priority"); // discovers the limit
const h0 = (await hits())["acc-a"] || 0;
for (let i = 0; i < 3; i++) await chat("q-priority");
const h1 = (await hits())["acc-a"] || 0;
check("before the reset, A gets no request", h1 === h0, `A hits ${h0}->${h1}`);
await sleep(14_000);
const back = await chat("q-priority");
check(
  "after the reset time, A is used again by itself (priority: first step)",
  back.status === 200 && from(back) === "acc-a",
  `status ${back.status} from ${from(back)}`
);

// ── round-robin uses both again after the reset ─────────────────────────────
const rr = [];
for (let i = 0; i < 4; i++) rr.push(from(await chat("q-round-robin")));
check(
  "round-robin takes turns again after the reset",
  rr.includes("acc-a") && rr.includes("acc-b"),
  rr.join(",")
);

// ── all accounts limited: fast 429 with Retry-After ─────────────────────────
await mock("/__reset", {});
await mock("/__control", {
  key: "acc-a",
  mode: "limit",
  claim: "five_hour",
  resetInSec: 600,
});
await mock("/__control", {
  key: "acc-b",
  mode: "limit",
  claim: "seven_day",
  resetInSec: 900,
});
await chat("q-priority"); // discovers both
const hb = await hits();
const allLimited = await chat("q-priority");
const ha = await hits();
const ra = Number(allLimited.retryAfter);
check(
  "all accounts limited: 429 with Retry-After near the earliest reset, no request sent",
  allLimited.status === 429 &&
    ra >= 500 &&
    ra <= 620 &&
    (ha["acc-a"] || 0) === (hb["acc-a"] || 0) &&
    (ha["acc-b"] || 0) === (hb["acc-b"] || 0),
  `status ${allLimited.status} retry-after ${allLimited.retryAfter} ${allLimited.ms.toFixed(0)} ms ${allLimited.text.slice(0, 160)}`
);
for (const id of [state.A, state.B])
  await api(`/api/providers/${id}`, {
    method: "PUT",
    body: { rateLimitedUntil: null, testStatus: "active" },
  });
await mock("/__reset", {});

// ── a plain 429 (short rate limit, not a usage limit) must not block for long ─
await mock("/__control", { key: "acc-a", mode: "plain429" });
const p1 = await chat("q-priority");
await mock("/__control", { key: "acc-a", mode: "ok" });
await sleep(16_000);
const p2 = await chat("q-priority");
check(
  "a plain 429 is a short cooldown only (A is used again within ~15 s)",
  p1.status === 200 && from(p2) === "acc-a",
  `first from ${from(p1)}, later from ${from(p2)}`
);
await api(`/api/providers/${state.A}`, {
  method: "PUT",
  body: { rateLimitedUntil: null, testStatus: "active" },
});

// ── direct provider/model call (no combo) skips the limited account ─────────
await mock("/__reset", {});
await mock("/__control", {
  key: "acc-a",
  mode: "limit",
  claim: "five_hour",
  resetInSec: 600,
});
const d = [];
for (let i = 0; i < 5; i++) d.push(await chat(`cm/${OPUS}`));
const hd = await hits();
check(
  "direct cm/model: every request answered, the limited account gets at most one request",
  d.every((r) => r.status === 200 && from(r) === "acc-b") && (hd["acc-a"] || 0) <= 1,
  `statuses ${d.map((r) => r.status)} A hits ${hd["acc-a"] || 0}`
);

// ── streaming and the Anthropic format (Claude Code) through a combo ────────
const s = await chat("q-priority", { stream: true });
check(
  "stream through the combo skips the limited account",
  s.status === 200 && s.text.includes("acc-b"),
  `status ${s.status}`
);
const m = await chat("q-round-robin", { format: "anthropic" });
check(
  "/v1/messages (Claude Code) through round-robin skips it",
  m.status === 200 && from(m) === "acc-b",
  `status ${m.status} from ${from(m)}`
);

// ── per-model weekly limit (Opus only): Sonnet on the same account still works ─
await mock("/__reset", {});
await api(`/api/providers/${state.A}`, {
  method: "PUT",
  body: { rateLimitedUntil: null, testStatus: "active" },
});
await mock("/__control", {
  key: "acc-a",
  mode: "limit",
  claim: "seven_day_opus",
  resetInSec: 600,
});
await makeCombo("q-opus-only", "priority", [stepA, stepB]);
await makeCombo("q-sonnet-a", "priority", [
  { kind: "model", model: "cm/claude-sonnet-mock", connectionId: state.A },
]);
await chat("q-opus-only"); // discovers the Opus limit on A
const o1 = (await hits())["acc-a"] || 0;
const opus = await chat("q-opus-only");
const sonnet = await chat("q-sonnet-a");
const o2 = await mock("/__stats");
check(
  "Opus-only weekly limit: Opus skips A, Sonnet on A still works",
  from(opus) === "acc-b" &&
    sonnet.status === 200 &&
    from(sonnet) === "acc-a" &&
    (o2.models["acc-a"] || []).slice(o1).every((x) => /sonnet/.test(x)),
  `opus from ${from(opus)}, sonnet ${sonnet.status} from ${from(sonnet)}`
);

// ── model OFF: a combo skips that model without sending a request ───────────
await mock("/__reset", {});
await api(`/api/providers/${state.A}`, {
  method: "PUT",
  body: { rateLimitedUntil: null, testStatus: "active" },
});
await makeCombo("q-off", "round-robin", [stepA, stepC]);
const offRes = await api(
  `/api/provider-models?provider=${encodeURIComponent(state.n1)}&modelId=${OPUS}`,
  { method: "PATCH", body: { isHidden: true } }
);
const off = [];
for (let i = 0; i < 4; i++) off.push(await chat("q-off"));
const hoff = await hits();
check(
  "model OFF: round-robin skips it, every request answered by the other provider",
  offRes.status === 200 &&
    off.every((r) => r.status === 200 && from(r) === "acc-c") &&
    !hoff["acc-a"],
  `statuses ${off.map((r) => r.status)} A hits ${hoff["acc-a"] || 0}`
);
await api(`/api/provider-models?provider=${encodeURIComponent(state.n1)}&modelId=${OPUS}`, {
  method: "PATCH",
  body: { isHidden: false },
});

// ── leave A limited for 150 s for the restart check ─────────────────────────
await mock("/__reset", {});
await mock("/__control", {
  key: "acc-a",
  mode: "limit",
  claim: "five_hour",
  resetInSec: 150,
});
await chat("q-priority");

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
