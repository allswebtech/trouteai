// Who answered, and under which name, against a running TRouteAI and mock-anthropic.mjs.
//
// The `model` of every answer is the string the client sent, in every dialect, streamed and
// not, even when the stored id of the step differs (dashed name asked, dotted id stored).
// Every answer and every error carries X-TRouteAI-Requested-Model; an answer from a later combo
// step carries X-TRouteAI-Fallback and X-TRouteAI-Fallback-Attempts.
//
// Built-in swaps are off by default: a missing model, a retired name and a credit error get the
// real answer; each switched on answers with its reason token, also in the request log row.
//
// Usage: node answers-e2e.mjs <base-url> <admin-password> <mock-url>
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

const login = await api("/api/auth/login", { method: "POST", body: { password } });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("login", login.status === 200, `status ${login.status}`);
await mock("/__reset", {});

const node = await api("/api/provider-nodes", {
  method: "POST",
  body: {
    name: "Answers Mock",
    prefix: "am",
    type: "anthropic-compatible",
    baseUrl: mockUrl + "/v1",
  },
});
const nodeId = node.json?.node?.id;
const conn = async (name, apiKey) =>
  (await api("/api/providers", { method: "POST", body: { provider: nodeId, name, apiKey } })).json
    ?.connection?.id;
const OK = await conn("ans-ok", "ans-ok");
const FAIL = await conn("ans-fail", "ans-fail");
const ERR = await conn("ans-err", "ans-err");
check("setup: node and three fake accounts", !!nodeId && !!OK && !!FAIL && !!ERR);
await api("/api/resilience", {
  method: "PATCH",
  body: { requestQueue: { requestsPerMinute: 1000, minTimeBetweenRequestsMs: 0 } },
});
// ans-fail is at its usage limit, ans-err answers every request with a 400
await mock("/__control", { key: "ans-fail", mode: "limit", resetInSec: 900 });
await mock("/__control", { key: "ans-err", mode: "overflow-anthropic" });
const key = (await api("/api/keys", { method: "POST", body: { name: "answers-key" } })).json?.key;

// The client asks for the dashed name; the only step's stored id is the dotted one.
const ASKED = "claude-opus-5-5";
const STORED = "claude-opus-5.5";
const step = (connectionId) => ({ kind: "model", model: `am/${STORED}`, connectionId });
const combo = async (name, steps) =>
  (
    await api("/api/combos", {
      method: "POST",
      body: { name, strategy: "priority", models: steps },
    })
  ).json;
const c1 = await combo(ASKED, [step(OK)]);
const c2 = await combo("ans-fallback", [step(FAIL), step(OK)]);
const c3 = await combo("ans-broken", [step(ERR)]);
check("setup: api key and three combos", !!key && !!c1 && !!c2 && !!c3);

let seq = 0;
async function ask(format, model, stream) {
  const path =
    format === "messages"
      ? "/v1/messages"
      : format === "responses"
        ? "/v1/responses"
        : "/v1/chat/completions";
  const text = `hi ${++seq}`;
  const body =
    format === "responses"
      ? { model, stream, input: text }
      : { model, stream, max_tokens: 50, messages: [{ role: "user", content: text }] };
  const res = await fetch(base + path, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      ...(format === "messages"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

// Every `model` the client can read in the answer, by dialect.
function modelsIn(format, stream, text) {
  if (!stream) {
    try {
      const j = JSON.parse(text);
      return [j.model, j.response?.model].filter((m) => typeof m === "string");
    } catch {
      return [];
    }
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    let j;
    try {
      j = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (typeof j.model === "string") out.push(j.model);
    if (typeof j.message?.model === "string") out.push(j.message.model);
    if (typeof j.response?.model === "string") out.push(j.response.model);
  }
  return out;
}
// An Anthropic stream must name it in message_start (a JSON answer has no events)
const hasStartModel = (format, stream, text) =>
  !stream || format !== "messages" || /"type":"message_start"[^\n]*"model":/.test(text);

const FORMATS = ["messages", "chat", "responses"];
for (const format of FORMATS) {
  for (const stream of [false, true]) {
    const tag = `${format} ${stream ? "stream" : "json"}`;
    const r = await ask(format, ASKED, stream);
    const models = modelsIn(format, stream, r.text);
    check(
      `${tag}: every model in the answer is the name sent`,
      r.status === 200 &&
        models.length > 0 &&
        models.every((m) => m === ASKED) &&
        hasStartModel(format, stream, r.text),
      `${r.status} ${[...new Set(models)].join(",")} ${r.text.slice(0, 160)}`
    );
    check(
      `${tag}: headers name the model asked for and the one that answered`,
      r.headers.get("x-trouteai-requested-model") === ASKED &&
        r.headers.get("x-trouteai-model") === STORED &&
        !r.headers.get("x-trouteai-fallback"),
      `requested ${r.headers.get("x-trouteai-requested-model")} model ${r.headers.get("x-trouteai-model")} fallback ${r.headers.get("x-trouteai-fallback")}`
    );
    const f = await ask(format, "ans-fallback", stream);
    check(
      `${tag}: combo whose first step fails says a later step answered`,
      f.status === 200 &&
        f.text.includes("Hello from account ans-ok") &&
        f.headers.get("x-trouteai-fallback") === "combo-step" &&
        f.headers.get("x-trouteai-fallback-attempts") === "1" &&
        f.headers.get("x-trouteai-requested-model") === "ans-fallback" &&
        modelsIn(format, stream, f.text).every((m) => m === "ans-fallback"),
      `${f.status} fallback ${f.headers.get("x-trouteai-fallback")} attempts ${f.headers.get("x-trouteai-fallback-attempts")}`
    );
    const e = await ask(format, "ans-broken", stream);
    check(
      `${tag}: an error answer carries the requested-model header`,
      e.status >= 400 && e.headers.get("x-trouteai-requested-model") === "ans-broken",
      `${e.status} requested ${e.headers.get("x-trouteai-requested-model")}`
    );
  }
}

// A direct provider/model call echoes that string too (any working account answers it)
{
  const direct = `am/${STORED}`;
  const r = await ask("chat", direct, false);
  check(
    "direct call: the body and the requested header are the provider/model string sent",
    r.status === 200 &&
      modelsIn("chat", false, r.text).every((m) => m === direct) &&
      r.headers.get("x-trouteai-requested-model") === direct &&
      r.headers.get("x-trouteai-model") === STORED,
    `${r.status} ${modelsIn("chat", false, r.text)} ${r.headers.get("x-trouteai-requested-model")} ${r.headers.get("x-trouteai-model")}`
  );
}

// The setting switched off: the body names the answering model's id again
{
  const off = await api("/api/settings", {
    method: "PATCH",
    body: { echoRequestedModelName: false },
  });
  const a = await ask("messages", ASKED, false);
  const b = await ask("messages", ASKED, true);
  check(
    "echo off: the body names the stored id of the step that answered",
    off.status === 200 &&
      modelsIn("messages", false, a.text).every((m) => m === STORED) &&
      modelsIn("messages", true, b.text).every((m) => m === STORED) &&
      a.headers.get("x-trouteai-requested-model") === ASKED,
    `${off.status} ${modelsIn("messages", false, a.text)} / ${[...new Set(modelsIn("messages", true, b.text))]}`
  );
  await api("/api/settings", { method: "PATCH", body: { echoRequestedModelName: true } });
}

// ── Reason tokens, end to end, on a node with one fake account so every result is fixed ──
const soloNode = await api("/api/provider-nodes", {
  method: "POST",
  body: {
    name: "Answers Solo",
    prefix: "as",
    type: "anthropic-compatible",
    baseUrl: mockUrl + "/v1",
  },
});
const soloId = soloNode.json?.node?.id;
const SOLO = (
  await api("/api/providers", {
    method: "POST",
    body: { provider: soloId, name: "ans-solo", apiKey: "ans-solo" },
  })
).json?.connection?.id;
check("setup: a second node with one fake account", !!soloId && !!SOLO);
const perModel = (model, mode) => mock("/__control", { key: "ans-solo", model, mode });
const settings = (body) => api("/api/settings", { method: "PATCH", body });
const header = (r, name) => r.headers.get(`x-trouteai-${name}`);
const sentTo = async () =>
  (await (await fetch(mockUrl + "/__stats")).json()).models["ans-solo"] || [];

// The log row of the request that answered (written just after the answer, so poll briefly).
async function logRow(asked) {
  for (let i = 0; i < 20; i++) {
    const rows = (await api(`/api/usage/call-logs?limit=50&model=${encodeURIComponent(asked)}`))
      .json;
    const row = Array.isArray(rows)
      ? rows.find((r) => r.requestedModel === asked && r.status === 200 && "fallback" in r)
      : null;
    if (row) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Family fallback, off by default: the missing model's real error, naming it
{
  await perModel("claude-opus-4-6", "missing");
  const r = await ask("chat", "as/claude-opus-4-6", false);
  check(
    "family off: a missing model gets its own not-found error, no other model answers",
    r.status === 404 && r.text.includes("claude-opus-4-6") && !header(r, "fallback"),
    `${r.status} ${header(r, "fallback")} ${r.text.slice(0, 160)}`
  );
}
// Family fallback switched on: a sibling answers, marked family
{
  const on = await settings({ modelFamilyFallback: true });
  await perModel("claude-opus-4-8", "missing");
  const asked = "as/claude-opus-4-8";
  const r = await ask("chat", asked, false);
  check(
    "family on: a sibling answers, marked family, attempts 1, the body keeps the name sent",
    on.status === 200 &&
      r.status === 200 &&
      header(r, "fallback") === "family" &&
      header(r, "fallback-attempts") === "1" &&
      header(r, "model") === "claude-opus-4-7" &&
      header(r, "requested-model") === asked &&
      modelsIn("chat", false, r.text).every((m) => m === asked),
    `${r.status} ${header(r, "fallback")} ${header(r, "fallback-attempts")} ${header(r, "model")}`
  );
  const row = await logRow(asked);
  check(
    "family on: the log row names the reason and the attempts",
    row?.fallback === "family" && row?.fallbackAttempts === 1,
    JSON.stringify(row && { fallback: row.fallback, attempts: row.fallbackAttempts })
  );
  const s = await ask("chat", asked, true);
  check(
    "family on, streamed: the end-of-stream comment names the reason and the requested model",
    s.status === 200 &&
      s.text.includes(": x-trouteai-fallback=family") &&
      s.text.includes(`: x-trouteai-requested-model=${asked}`),
    `${s.status} ${s.text
      .split("\n")
      .filter((l) => l.startsWith(": x-trouteai"))
      .join(" | ")}`
  );
  // context overflow: a sibling with room answers, marked context-overflow. The wording is one
  // the overflow classifier knows ("maximum context length"); Anthropic's own "prompt is too
  // long" is not one of its signals, so it is passed to the client even with the switch on.
  await perModel("claude-sonnet-4-6", "overflow-openai");
  const o = await ask("chat", "as/claude-sonnet-4-6", false);
  check(
    "family on: a context overflow is answered by a sibling, marked context-overflow",
    o.status === 200 &&
      header(o, "fallback") === "context-overflow" &&
      header(o, "fallback-attempts") === "1" &&
      header(o, "model") !== "claude-sonnet-4-6",
    `${o.status} ${header(o, "fallback")} ${header(o, "model")}`
  );
  await settings({ modelFamilyFallback: false });
}

// Built-in aliases: a spelling is not marked; a retired name goes as sent unless switched on
{
  const spelling = await ask("chat", "as/kimi-k2", false);
  const afterSpelling = await sentTo();
  check(
    "alias: another spelling of the same model is sent as the provider's id, not marked",
    spelling.status === 200 &&
      afterSpelling.at(-1) === "moonshotai/Kimi-K2" &&
      !header(spelling, "fallback"),
    `${spelling.status} ${afterSpelling.at(-1)} ${header(spelling, "fallback")}`
  );
  const off = await ask("chat", "as/claude-3-opus-20240229", false);
  const afterOff = await sentTo();
  check(
    "alias off: a retired name reaches the provider as sent",
    off.status === 200 && afterOff.at(-1) === "claude-3-opus-20240229" && !header(off, "fallback"),
    `${off.status} ${afterOff.at(-1)} ${header(off, "fallback")}`
  );
  await settings({ answerRetiredModelsWithSuccessor: true });
  const asked = "as/claude-3-opus-20240229";
  const on = await ask("chat", asked, false);
  const afterOn = await sentTo();
  check(
    "alias on: the successor answers, marked alias, the body keeps the name sent",
    on.status === 200 &&
      afterOn.at(-1) === "claude-opus-4-20250514" &&
      header(on, "fallback") === "alias" &&
      header(on, "model") === "claude-opus-4-20250514" &&
      modelsIn("chat", false, on.text).every((m) => m === asked),
    `${on.status} ${afterOn.at(-1)} ${header(on, "fallback")} ${header(on, "model")}`
  );
  const row = await logRow(asked);
  check(
    "alias on: the log row names the reason",
    row?.fallback === "alias" && row?.fallbackAttempts === 0,
    JSON.stringify(row && { fallback: row.fallback, attempts: row.fallbackAttempts })
  );
  await settings({ answerRetiredModelsWithSuccessor: false });
}

// Emergency fallback, off by default: a credit error stays the client's error
{
  await perModel("claude-billing-mock", "billing");
  const r = await ask("chat", "as/claude-billing-mock", false);
  check(
    "emergency off: a credit error is answered as an error, no free model answers",
    r.status === 402 && !header(r, "fallback"),
    `${r.status} ${header(r, "fallback")} ${r.text.slice(0, 120)}`
  );
}

// The user's global fallback model: marked global, attempts = the combo's steps
{
  await perModel("claude-down-mock", "unavailable");
  const down = await combo("ans-down", [
    { kind: "model", model: "as/claude-down-mock", connectionId: SOLO },
  ]);
  const set = await settings({ globalFallbackModel: "am/claude-opus-mock" });
  const r = await ask("chat", "ans-down", false);
  check(
    "global fallback: the user's last resort answers, marked global, attempts 1",
    !!down &&
      set.status === 200 &&
      r.status === 200 &&
      header(r, "fallback") === "global" &&
      header(r, "fallback-attempts") === "1" &&
      header(r, "model") === "claude-opus-mock" &&
      modelsIn("chat", false, r.text).every((m) => m === "ans-down"),
    `${r.status} ${header(r, "fallback")} ${header(r, "fallback-attempts")} ${header(r, "model")} ${r.text.slice(0, 120)}`
  );
  const row = await logRow("ans-down");
  check(
    "global fallback: the log row names the reason and the attempts",
    row?.fallback === "global" && row?.fallbackAttempts === 1,
    JSON.stringify(row && { fallback: row.fallback, attempts: row.fallbackAttempts })
  );
  await settings({ globalFallbackModel: "" });
}

// The shared combo loop's mark reaches the log row too
{
  const r = await ask("chat", "ans-fallback", false);
  const row = await logRow("ans-fallback");
  check(
    "combo step: the log row of the later step names combo-step and its attempts",
    r.status === 200 && row?.fallback === "combo-step" && row?.fallbackAttempts === 1,
    JSON.stringify(row && { fallback: row.fallback, attempts: row.fallbackAttempts })
  );
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
