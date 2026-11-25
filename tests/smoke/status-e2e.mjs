// Status-code contract checks against a running TRouteAI and mock-anthropic.mjs.
//
// Programs in front of the gateway act on its status codes: a 429 means "this account is at
// its limit" (and may be remembered until the reset time), while an outage must never look
// like a limit. Every row is checked on /v1/messages and /v1/chat/completions, streamed and
// not, for a direct provider/model call and for combos:
//
//   usage limit with a reset     429, rate_limit_error, retry-after to the reset, unified headers
//   short burst 429              429 without a long retry-after
//   out of credit                402 billing_error
//   the client's key is bad      401
//   overloaded                   529 overloaded_error (Anthropic), 503 (OpenAI); never 429
//   down / bad gateway / closed  502 or 503; never 429, no retry-after over a minute
//   time-out                     504; never 429
//   the request is wrong         400 invalid_request_error
//   the second request while the gateway's own cooldown after an outage holds: still no 429
//   a combo: all limited -> 429 with the earliest reset; any outage and none answering -> 5xx
//   a late 429 (after the short keep-alive delay) with stream: true: a client whose Accept
//   header does not name text/event-stream still gets the 429 and its retry-after; with that
//   Accept the answer may already be a 200 stream that carries the error in-band
//
// Each case gets fresh accounts, so one case's cooldown cannot leak into the next.
//
// Usage: node status-e2e.mjs <base-url> <admin-password> <mock-url>
const [base, password, mockUrl] = process.argv.slice(2);

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

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

const login = await api("/api/auth/login", { method: "POST", body: { password } });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("login", login.status === 200, `status ${login.status}`);
await mock("/__reset", {});
const rq = await api("/api/resilience", {
  method: "PATCH",
  body: {
    requestQueue: { requestsPerMinute: 1000, minTimeBetweenRequestsMs: 0 },
    // The gateway's own wait-and-retry inside one request is not what is tested here; with it
    // off, the second request of a case meets the cooldown the first one left behind.
    waitForCooldown: { enabled: false },
    comboCooldownWait: { enabled: false },
  },
});
check("raise the queue limit, turn off cooldown waits", rq.status === 200, `status ${rq.status}`);
const keyRes = await api("/api/keys", { method: "POST", body: { name: "status-key" } });
const apiKey = keyRes.json?.key;
check("create api key", !!apiKey);

const MODEL = "claude-opus-mock";
let seq = 0;

// A fresh provider node with one account (connection) whose fake key is `st-<n>`; the mock
// answers for that key in `mode`.
async function account(mode, { resetInSec } = {}) {
  const n = ++seq;
  const prefix = `st${n}`;
  const node = await api("/api/provider-nodes", {
    method: "POST",
    body: { name: `Status ${n}`, prefix, type: "anthropic-compatible", baseUrl: mockUrl + "/v1" },
  });
  const nodeId = node.json?.node?.id;
  const conn = await api("/api/providers", {
    method: "POST",
    body: { provider: nodeId, name: `st-${n}`, apiKey: `st-${n}` },
  });
  const connectionId = conn.json?.connection?.id;
  if (!nodeId || !connectionId) throw new Error(`could not create account ${n}: ${node.text}`);
  await mock("/__control", { key: `st-${n}`, mode, claim: "five_hour", resetInSec });
  return { model: `${prefix}/${MODEL}`, connectionId, key: `st-${n}` };
}

async function combo(accounts) {
  const name = `st-combo-${++seq}`;
  const r = await api("/api/combos", {
    method: "POST",
    body: {
      name,
      strategy: "priority",
      models: accounts.map((a) => ({
        kind: "model",
        model: a.model,
        connectionId: a.connectionId,
        weight: 50,
      })),
    },
  });
  if (r.status >= 300) throw new Error(`could not create combo: ${r.status} ${r.text}`);
  return name;
}

async function call(model, { dialect, stream, key = apiKey, accept }) {
  const anthropic = dialect === "anthropic";
  const t0 = Date.now();
  const res = await fetch(base + (anthropic ? "/v1/messages" : "/v1/chat/completions"), {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: {
      "content-type": "application/json",
      ...(accept ? { accept } : {}),
      ...(anthropic
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 50,
      messages: [{ role: "user", content: `status check ${++seq}` }],
    }),
  });
  const text = await res.text();
  // The error type from a JSON body or from the first error event of a stream.
  let type = null;
  let bodyType = null;
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const candidates = [text, ...text.split("\n").map((l) => l.replace(/^data:\s*/, ""))];
  for (const c of candidates) {
    const j = parse(c.trim());
    if (j && typeof j === "object" && j.error) {
      type = typeof j.error === "object" ? j.error.type || null : null;
      bodyType = j.type || null;
      break;
    }
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    type,
    bodyType,
    text,
    ms: Date.now() - t0,
    retryAfter: res.headers.get("retry-after"),
    unifiedStatus: res.headers.get("anthropic-ratelimit-unified-status"),
    unifiedReset: res.headers.get("anthropic-ratelimit-unified-reset"),
    unified5h: res.headers.get("anthropic-ratelimit-unified-5h-utilization"),
  };
}

const label = (v) => `${v.dialect}${v.stream ? " stream" : ""}`;
// STATUS_VARIANTS=anthropic and STATUS_SECTIONS=headers,single,combo narrow a run (debugging)
const VARIANTS = [
  { dialect: "anthropic", stream: false },
  { dialect: "anthropic", stream: true },
  { dialect: "openai", stream: false },
  { dialect: "openai", stream: true },
].filter(
  (v) => !process.env.STATUS_VARIANTS || process.env.STATUS_VARIANTS.split(",").includes(label(v))
);
const SECTIONS = (process.env.STATUS_SECTIONS || "headers,single,combo,late").split(",");
const show = (r) =>
  `status ${r.status} type ${r.type} retry-after ${r.retryAfter} unified ${r.unifiedStatus}/${r.unifiedReset} ${r.ms} ms ${r.status >= 400 ? r.text.slice(0, 140).replace(/\s+/g, " ") : ""}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const retryAfterAtMost = (r, sec) => r.retryAfter === null || Number(r.retryAfter) <= sec;
const typeOk = (r, v, anthropicType, openaiType) =>
  v.dialect === "anthropic"
    ? r.type === anthropicType && r.bodyType === "error"
    : r.type === (openaiType ?? anthropicType);

// What every outage answer must satisfy: one of the given statuses, never 429, no long wait.
function outage(name, r, statuses) {
  check(
    name,
    statuses.includes(r.status) && r.type !== "rate_limit_error" && retryAfterAtMost(r, 60),
    show(r)
  );
}

// ── a successful answer passes the account's plan-usage headers through ───────────────────
for (const v of SECTIONS.includes("headers") ? VARIANTS : []) {
  const a = await account("ok");
  const r = await call(a.model, v);
  check(
    `[${label(v)}] a Claude account's answer carries its plan-usage headers`,
    r.status === 200 && r.unified5h === "0.42" && r.unifiedStatus === "allowed",
    show(r)
  );
}

// ── single account ──────────────────────────────────────────────────────────────────────
for (const v of SECTIONS.includes("single") ? VARIANTS : []) {
  const L = label(v);

  {
    const a = await account("limit", { resetInSec: 3600 });
    const r = await call(a.model, v);
    const ra = Number(r.retryAfter);
    check(
      `[${L}] usage limit: 429 rate_limit_error, retry-after to the reset, unified headers`,
      r.status === 429 &&
        typeOk(r, v, "rate_limit_error") &&
        ra >= 3500 &&
        ra <= 3600 &&
        r.unifiedStatus === "rejected" &&
        Math.abs(Number(r.unifiedReset) - (nowSec() + 3600)) <= 120,
      show(r)
    );
    const again = await call(a.model, v);
    const ra2 = Number(again.retryAfter);
    check(
      `[${L}] usage limit, next request (account skipped): still 429 to the same reset`,
      again.status === 429 &&
        typeOk(again, v, "rate_limit_error") &&
        ra2 >= 3400 &&
        ra2 <= 3600 &&
        again.unifiedStatus === "rejected" &&
        Math.abs(Number(again.unifiedReset) - (nowSec() + 3600)) <= 120,
      show(again)
    );
  }

  {
    const a = await account("plain429");
    const r = await call(a.model, v);
    check(
      `[${L}] short burst 429: 429 without a long retry-after`,
      r.status === 429 &&
        typeOk(r, v, "rate_limit_error") &&
        retryAfterAtMost(r, 60),
      show(r)
    );
  }

  {
    const a = await account("billing");
    const r = await call(a.model, v);
    check(
      `[${L}] out of credit: 402 billing_error`,
      r.status === 402 && typeOk(r, v, "billing_error"),
      show(r)
    );
  }

  {
    const a = await account("ok");
    const r = await call(a.model, { ...v, key: "sk-not-a-real-key-000000" });
    check(
      `[${L}] the client's own key is bad: 401`,
      r.status === 401 && r.type !== "rate_limit_error",
      show(r)
    );
  }

  {
    const a = await account("badrequest");
    const r = await call(a.model, v);
    check(
      `[${L}] a wrong request: 400 invalid_request_error`,
      r.status === 400 && typeOk(r, v, "invalid_request_error"),
      show(r)
    );
  }

  {
    const a = await account("overloaded");
    const r = await call(a.model, v);
    const want = v.dialect === "anthropic" ? [529] : [503];
    check(
      `[${L}] overloaded: ${want[0]}${v.dialect === "anthropic" ? " overloaded_error" : ""}, no retry-after over a minute`,
      want.includes(r.status) &&
        (v.dialect !== "anthropic" || typeOk(r, v, "overloaded_error")) &&
        retryAfterAtMost(r, 60),
      show(r)
    );
    outage(
      `[${L}] overloaded, next request in the gateway's cooldown: no 429`,
      await call(a.model, v),
      [...want, 502, 503]
    );
  }

  for (const [mode, what, statuses] of [
    ["unavailable", "provider down (503)", [503]],
    ["badgateway", "bad gateway answer (502 page)", [502]],
    ["close", "socket closed", [502, 503]],
    ["hang", "time-out", [504]],
  ]) {
    const a = await account(mode);
    outage(
      `[${L}] ${what}: ${statuses.join(" or ")}, never 429`,
      await call(a.model, v),
      statuses
    );
    outage(
      `[${L}] ${what}, next request in the gateway's cooldown: no 429`,
      await call(a.model, v),
      [...statuses, 502, 503, 504]
    );
  }
}

// ── combos ──────────────────────────────────────────────────────────────────────────────
for (const v of SECTIONS.includes("combo") ? VARIANTS : []) {
  const L = label(v);
  {
    const name = await combo([
      await account("limit", { resetInSec: 1800 }),
      await account("limit", { resetInSec: 900 }),
    ]);
    const r = await call(name, v);
    const ra = Number(r.retryAfter);
    check(
      `[${L}] combo, every account at its limit: 429 with the earliest reset`,
      r.status === 429 &&
        typeOk(r, v, "rate_limit_error") &&
        ra >= 800 &&
        ra <= 900 &&
        r.unifiedStatus === "rejected" &&
        Math.abs(Number(r.unifiedReset) - (nowSec() + 900)) <= 120,
      show(r)
    );
    const again = await call(name, v);
    const ra2 = Number(again.retryAfter);
    check(
      `[${L}] combo, every account at its limit, next request: 429 with the earliest reset`,
      again.status === 429 && typeOk(again, v, "rate_limit_error") && ra2 >= 700 && ra2 <= 900,
      show(again)
    );
  }
  for (const [modes, what] of [
    [["limit", "overloaded"], "one limited, one overloaded"],
    [["overloaded", "limit"], "one overloaded, one limited"],
    [["limit", "close"], "one limited, one closing the socket"],
    [["unavailable", "badgateway"], "one down, one bad gateway"],
    [["limit", "hang"], "one limited, one timing out"],
  ]) {
    const accts = [];
    for (const m of modes)
      accts.push(await account(m, { resetInSec: m === "limit" ? 1800 : undefined }));
    const name = await combo(accts);
    outage(`[${L}] combo, ${what}: 5xx, never 429`, await call(name, v), [502, 503, 504, 529]);
    outage(
      `[${L}] combo, ${what}, next request: 5xx, never 429`,
      await call(name, v),
      [502, 503, 504, 529]
    );
  }
}

// ── a late 429: the account answers its limit after 3 s, past the 2 s keep-alive delay ──────
for (const v of SECTIONS.includes("late") ? VARIANTS.filter((x) => x.stream) : []) {
  const L = label(v);
  for (const accept of ["application/json", undefined]) {
    const a = await account("limit-slow", { resetInSec: 3600 });
    const r = await call(a.model, { ...v, accept });
    const ra = Number(r.retryAfter);
    check(
      `[${L}] late usage limit, Accept ${accept ?? "not sent"}: HTTP 429 with its retry-after, not a 200 stream`,
      r.status === 429 &&
        r.contentType.includes("application/json") &&
        typeOk(r, v, "rate_limit_error") &&
        ra >= 3400 &&
        ra <= 3600 &&
        r.unifiedStatus === "rejected",
      show(r)
    );
  }
  {
    const a = await account("limit-slow", { resetInSec: 3600 });
    const r = await call(a.model, { ...v, accept: "text/event-stream" });
    check(
      `[${L}] late usage limit, Accept text/event-stream: a 429, or a 200 stream with the error in-band`,
      (r.status === 429 && typeOk(r, v, "rate_limit_error")) ||
        (r.status === 200 && r.contentType.includes("text/event-stream") && r.type !== null),
      show(r)
    );
  }
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
