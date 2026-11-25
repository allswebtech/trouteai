// "Listed means routable" checks for GET /v1/models against a running TRouteAI and
// mock-anthropic.mjs (fake Claude-style accounts).
//
// A client builds its model picker from the list, so every name in it must answer a request
// now: this calls every listed name and fails when one cannot be served. It also checks that
// a combo whose steps are all off, a provider whose only account is disabled or expired, and
// accounts outside an API key's allowlist are left out, that an account only at its usage
// limit keeps its names, that the dashboard still sees everything, that the old behaviour is
// one feature flag away, and that both list shapes and the "only combos" mode still work.
//
// Usage: node models-e2e.mjs <base-url> <admin-password> <mock-url>
import fs from "node:fs";

const [base, password, mockUrl] = process.argv.slice(2);
if (!base || !password || !mockUrl) {
  console.error("Usage: node models-e2e.mjs <base-url> <admin-password> <mock-url>");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

let cookie = "";
async function api(path, { method = "GET", body, headers = {}, session = true } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      origin: base,
      ...(session && cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
}

// The client list: an API key and no dashboard login.
async function listModels(key, { query = "", headers = {} } = {}) {
  const r = await api(`/v1/models${query}`, {
    session: false,
    headers: { authorization: `Bearer ${key}`, ...headers },
  });
  return { status: r.status, rows: Array.isArray(r.json?.data) ? r.json.data : [] };
}
const ids = (rows) => new Set(rows.map((m) => m.id));

let chatSeq = 0;
async function chat(key, model) {
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 50,
      // a new conversation each time, so session affinity does not pin one account
      messages: [{ role: "user", content: `hi ${++chatSeq}` }],
    }),
  });
  return { status: res.status, text: await res.text() };
}

const login = await api("/api/auth/login", { method: "POST", body: { password } });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("login", login.status === 200 && cookie.includes("auth_token"), `status ${login.status}`);

// Many calls go to one fake account; lift the local request queue so it is not the limit.
const rq = await api("/api/resilience", {
  method: "PATCH",
  body: { requestQueue: { requestsPerMinute: 1000, minTimeBetweenRequestsMs: 0 } },
});
check("raise the local request queue limit", rq.status === 200, `status ${rq.status}`);

// ── setup: four fake providers, each with one account in a different state ──────────────
const MODEL = "claude-opus-mock";
async function node(prefix) {
  const r = await api("/api/provider-nodes", {
    method: "POST",
    body: {
      name: `Fake ${prefix}`,
      prefix,
      type: "anthropic-compatible",
      baseUrl: mockUrl + "/v1",
    },
  });
  const id = r.json?.node?.id;
  await api("/api/provider-models", {
    method: "POST",
    body: {
      provider: id,
      modelId: MODEL,
      modelName: "Opus mock",
      max_input_tokens: 200000,
      max_output_tokens: 32000,
    },
  });
  return id;
}
async function account(provider, name) {
  const r = await api("/api/providers", {
    method: "POST",
    body: { provider, name, apiKey: name },
  });
  return r.json?.connection?.id;
}
const nodes = { fa: await node("fa"), fb: await node("fb"), fc: await node("fc") };
nodes.fd = await node("fd");
check("create four fake providers", Object.values(nodes).every(Boolean));
const accA = await account(nodes.fa, "acc-a"); // usable
const accB = await account(nodes.fb, "acc-b"); // switched off
const accC = await account(nodes.fc, "acc-c"); // expired
const accD = await account(nodes.fd, "acc-d"); // at its usage limit for a while
check("create four accounts", !!accA && !!accB && !!accC && !!accD);
const offB = await api(`/api/providers/${accB}`, { method: "PUT", body: { isActive: false } });
const expC = await api(`/api/providers/${accC}`, {
  method: "PUT",
  body: { testStatus: "expired" },
});
const limD = await api(`/api/providers/${accD}`, {
  method: "PUT",
  body: { rateLimitedUntil: new Date(Date.now() + 3600_000).toISOString() },
});
check(
  "switch B off, mark C expired, put D at its usage limit",
  offB.status === 200 && expC.status === 200 && limD.status === 200,
  `${offB.status} ${expC.status} ${limD.status}`
);

// A second model on the usable provider, switched off.
await api("/api/provider-models", {
  method: "POST",
  body: { provider: nodes.fa, modelId: "claude-hidden-mock", modelName: "Hidden mock" },
});
const hide = await api(
  `/api/provider-models?provider=${encodeURIComponent(nodes.fa)}&modelId=claude-hidden-mock`,
  { method: "PATCH", body: { isHidden: true } }
);
check("switch one model off", hide.status === 200, `status ${hide.status}`);

async function combo(name, models) {
  const r = await api("/api/combos", {
    method: "POST",
    body: { name, strategy: "priority", models },
  });
  return r.status;
}
const step = (prefix, extra = {}) => ({ kind: "model", model: `${prefix}/${MODEL}`, ...extra });
const comboStatuses = [
  await combo("ok-combo", [step("fa")]),
  await combo("off-combo", [step("fa", { enabled: false })]),
  await combo("dead-combo", [step("fb"), step("fc")]),
  await combo("mixed-combo", [step("fb"), step("fa")]),
  await combo("hidden-combo", [{ kind: "model", model: "fa/claude-hidden-mock" }]),
  await combo("pinned-combo", [step("fa", { connectionId: accB })]),
  await combo("limited-combo", [step("fd")]),
];
check(
  "create combos",
  comboStatuses.every((s) => s < 300),
  comboStatuses.join(" ")
);

const keyRes = await api("/api/keys", { method: "POST", body: { name: "models-key" } });
const key = keyRes.json?.key;
check("create an API key", !!key, `status ${keyRes.status}`);

// Providers that need no account answer from the internet; block every one of them (the ids
// from the provider catalog, and every other owner the list shows) so each listed name is
// served by the fake provider and the test stays offline.
const noAuthSource = fs.readFileSync(
  new URL("../../src/shared/constants/providers/noauth.ts", import.meta.url),
  "utf8"
);
const noAuthIds = [...noAuthSource.matchAll(/^ {4}id: "([^"]+)"/gm)].map((m) => m[1]);
const first = await listModels(key);
const ours = new Set(["combo", "fa", "fb", "fc", "fd"]);
const foreign = [
  ...new Set([...noAuthIds, ...first.rows.map((m) => m.owned_by).filter((o) => !ours.has(o))]),
];
const block = await api("/api/settings", { method: "PATCH", body: { blockedProviders: foreign } });
check("block the providers that need no account", block.status === 200, foreign.join(","));

// ── the client list ─────────────────────────────────────────────────────────────────────
const list = await listModels(key);
const listed = ids(list.rows);
check(
  "the client list answers",
  list.status === 200 && list.rows.length > 0,
  `${list.rows.length} rows`
);
check(
  "only the fake providers are listed",
  list.rows.every((m) => ours.has(m.owned_by)),
  [...new Set(list.rows.map((m) => m.owned_by))].join(",")
);
const present = ["ok-combo", "mixed-combo", "limited-combo", `fa/${MODEL}`, `fd/${MODEL}`];
const absent = [
  "off-combo",
  "dead-combo",
  "hidden-combo",
  "pinned-combo",
  `fb/${MODEL}`,
  `fc/${MODEL}`,
  "fa/claude-hidden-mock",
];
check(
  "names that can be served are listed",
  present.every((id) => listed.has(id)),
  present.filter((id) => !listed.has(id)).join(" ")
);
check(
  "names that cannot be served are not listed",
  absent.every((id) => !listed.has(id)),
  absent.filter((id) => listed.has(id)).join(" ")
);
check(
  "no variant or mirror of a left-out name is listed",
  list.rows.every((m) => !/(^|\/)(off|dead|hidden|pinned)-combo$|^f[bc]\//.test(m.id)),
  list.rows
    .map((m) => m.id)
    .filter((id) => /(^|\/)(off|dead|hidden|pinned)-combo$|^f[bc]\//.test(id))
    .join(" ")
);

// Every row carries what a client needs to pick and size a model.
const rowGaps = [];
for (const m of list.rows) {
  const p = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
  const missing = [];
  if (typeof m.id !== "string") missing.push("id");
  if (typeof m.created !== "number") missing.push("created");
  if (!(m.context_length > 0)) missing.push("context_length");
  if (!(m.max_input_tokens > 0)) missing.push("max_input_tokens");
  if (!(m.max_output_tokens > 0)) missing.push("max_output_tokens");
  if (!m.capabilities || typeof m.capabilities !== "object") missing.push("capabilities");
  if (!p) missing.push("supported_parameters");
  else if (m.capabilities?.tool_calling === true && !p.includes("tools")) missing.push("tools");
  if (missing.length) rowGaps.push(`${m.id}: ${missing.join(",")}`);
}
check("every row has its limits and capabilities", rowGaps.length === 0, rowGaps.join("; "));
const fa = list.rows.find((m) => m.id === `fa/${MODEL}`);
check(
  "a model row carries the limits set for it",
  fa?.context_length === 200000 &&
    fa?.max_input_tokens === 200000 &&
    fa?.max_output_tokens === 32000,
  JSON.stringify(fa)
);

// Every listed chat name is called. A name whose only account is at its usage limit stays
// listed and answers a limit, never "not found".
const limitedOnly = (id) => id === "limited-combo" || id.startsWith("fd/");
const chatRows = list.rows.filter((m) => !m.type || m.type === "chat");
const failures = [];
for (const m of chatRows) {
  const r = await chat(key, m.id);
  const ok = limitedOnly(m.id) ? r.status !== 404 && r.status !== 400 : r.status === 200;
  if (!ok) failures.push(`${m.id}=${r.status}`);
}
check(
  `every listed name is served (${chatRows.length} called)`,
  chatRows.length > 0 && failures.length === 0,
  failures.slice(0, 8).join(" ")
);
check(
  "every listed row is a chat model",
  chatRows.length === list.rows.length,
  `${list.rows.length - chatRows.length} other rows`
);

// An API key limited to account A does not see the names only D can serve.
const keyA = await api("/api/keys", { method: "POST", body: { name: "models-key-a" } });
const scopeA = await api(`/api/keys/${keyA.json?.id}`, {
  method: "PATCH",
  body: { allowedConnections: [accA] },
});
const listA = ids((await listModels(keyA.json?.key)).rows);
check(
  "an API key sees only names its own accounts can serve",
  scopeA.status === 200 &&
    listA.has("ok-combo") &&
    listA.has(`fa/${MODEL}`) &&
    !listA.has("limited-combo") &&
    !listA.has(`fd/${MODEL}`),
  `status ${scopeA.status}; ${[...listA].join(" ")}`
);

// ── the other shapes and modes ──────────────────────────────────────────────────────────
const anth = await api("/v1/models?limit=1000", {
  session: false,
  headers: {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.0 (external, cli)",
  },
});
const anthIds = new Set((anth.json?.data || []).map((m) => m.id));
check(
  "the list for coding clients (?limit=, x-api-key) follows the same rule",
  anth.status === 200 && anthIds.has("ok-combo") && !anthIds.has("off-combo"),
  `status ${anth.status}`
);

const dash = await api("/v1/models");
const dashIds = new Set((dash.json?.data || []).map((m) => m.id));
check(
  "the dashboard still sees every combo",
  dash.status === 200 &&
    ["ok-combo", "off-combo", "dead-combo", "pinned-combo"].every((id) => dashIds.has(id)),
  `status ${dash.status}`
);

const combosOn = await api("/api/settings", { method: "PATCH", body: { modelsCombosOnly: true } });
const onlyCombos = (await listModels(key)).rows;
check(
  "the only-combos mode lists only combos that can be served",
  combosOn.status === 200 &&
    onlyCombos.length > 0 &&
    onlyCombos.every((m) => m.owned_by === "combo") &&
    ids(onlyCombos).has("ok-combo") &&
    !ids(onlyCombos).has("off-combo"),
  `${onlyCombos.length} rows`
);
await api("/api/settings", { method: "PATCH", body: { modelsCombosOnly: false } });

const flagOff = await api("/api/settings/feature-flags", {
  method: "PUT",
  body: { key: "MODELS_CATALOG_ROUTABLE_ONLY", value: "false" },
});
const oldList = ids((await listModels(key)).rows);
check(
  "with the rule switched off every configured combo is listed again",
  flagOff.status === 200 && oldList.has("off-combo") && oldList.has("dead-combo"),
  `status ${flagOff.status}`
);
await api("/api/settings/feature-flags", {
  method: "PUT",
  body: { key: "MODELS_CATALOG_ROUTABLE_ONLY", value: "true" },
});
const back = ids((await listModels(key)).rows);
check("switched on again, the rule holds", !back.has("off-combo") && back.has("ok-combo"));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
