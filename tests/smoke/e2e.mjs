// End-to-end smoke checks against a running TRouteAI with a fresh data folder:
// login, dashboard pages, provider + connection + combo + API key setup through the
// management API, then chat through the OpenAI, Anthropic and Responses formats.
//
// Usage: node e2e.mjs <base-url> <admin-password> [mock-upstream-url]
//   PAGES=/dashboard,/dashboard/providers,...  pages to open (default: a short list)
const [base, password, mockUrl = "http://127.0.0.1:20997/v1"] = process.argv.slice(2);
if (!base || !password) {
  console.error("Usage: node e2e.mjs <base-url> <admin-password> [mock-upstream-url]");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

let cookie = "";
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      origin: base,
      ...(cookie ? { cookie } : {}),
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

async function v1(path, body, headers) {
  const res = await fetch(base + path, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const login = await api("/api/auth/login", {
  method: "POST",
  body: { password },
});
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("login", login.status === 200 && cookie.includes("auth_token"), `status ${login.status}`);

const loginPage = await fetch(base + "/login", {
  signal: AbortSignal.timeout(60_000),
});
const loginHtml = await loginPage.text();
check("login page", loginPage.status === 200, `status ${loginPage.status}`);
const asset = loginHtml.match(/\/_next\/static\/[^"']+\.(?:css|js)/)?.[0];
if (asset) {
  const res = await fetch(base + asset, {
    signal: AbortSignal.timeout(60_000),
  });
  check("static asset", res.status === 200, asset);
}

const pages = (
  process.env.PAGES ||
  "/dashboard,/dashboard/providers,/dashboard/combos,/dashboard/api-manager,/dashboard/endpoint,/dashboard/quota,/dashboard/settings"
)
  .split(",")
  .filter(Boolean);
const pageFails = [];
for (const page of pages) {
  const res = await api(page);
  if (res.status !== 200) pageFails.push(`${page}=${res.status}`);
}
check(`dashboard pages (${pages.length})`, pageFails.length === 0, pageFails.join(" "));

const node = await api("/api/provider-nodes", {
  method: "POST",
  body: {
    name: "Mock",
    prefix: "mock",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: mockUrl,
  },
});
const nodeId = node.json?.node?.id || node.json?.id;
check("create provider node", node.status < 300 && !!nodeId, `status ${node.status}`);

const conn = await api("/api/providers", {
  method: "POST",
  body: { provider: nodeId, name: "mock-conn", apiKey: "sk-upstream-test" },
});
check("create connection", conn.status < 300, `status ${conn.status}`);

const combo = await api("/api/combos", {
  method: "POST",
  body: {
    name: "smoke-combo",
    strategy: "priority",
    models: ["mock/gpt-mock"],
  },
});
check("create combo", combo.status < 300, `status ${combo.status}`);

const key = await api("/api/keys", {
  method: "POST",
  body: { name: "smoke-key" },
});
const apiKey = key.json?.key;
check("create api key", !!apiKey, `status ${key.status}`);

const auth = { authorization: `Bearer ${apiKey}` };
const hello = [{ role: "user", content: "hi" }];

const noKey = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  {}
);
check("/v1 rejects a request without API key", noKey.status === 401, `status ${noKey.status}`);

const chat = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  auth
);
check(
  "chat via combo (JSON)",
  chat.status === 200 && chat.text.includes("mock upstream"),
  `status ${chat.status}`
);

const stream = await v1(
  "/v1/chat/completions",
  { model: "mock/gpt-mock", stream: true, messages: hello },
  auth
);
check(
  "chat via provider/model (stream)",
  stream.status === 200 && stream.text.includes("[DONE]") && stream.text.includes("mock upstream"),
  `status ${stream.status}`
);

const messages = await v1(
  "/v1/messages",
  { model: "smoke-combo", max_tokens: 50, stream: false, messages: hello },
  { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
);
check(
  "Anthropic format /v1/messages",
  messages.status === 200 && messages.text.includes("mock upstream"),
  `status ${messages.status}`
);

const responses = await v1(
  "/v1/responses",
  { model: "smoke-combo", stream: false, input: "hi" },
  auth
);
check(
  "Responses format /v1/responses",
  responses.status === 200 && responses.text.includes("mock upstream"),
  `status ${responses.status}`
);

const models = await fetch(base + "/v1/models", {
  headers: auth,
  signal: AbortSignal.timeout(60_000),
});
const modelsText = await models.text();
check(
  "/v1/models lists the combo",
  models.status === 200 && modelsText.includes("smoke-combo"),
  `status ${models.status}`
);

const setModelOff = (off) =>
  api(`/api/provider-models?provider=${encodeURIComponent(nodeId)}&modelId=gpt-mock`, {
    method: "PATCH",
    body: { isHidden: off },
  });

const off = await setModelOff(true);
check("turn model OFF", off.status === 200, `status ${off.status}`);

const offDirect = await v1(
  "/v1/chat/completions",
  { model: "mock/gpt-mock", stream: false, messages: hello },
  auth
);
check(
  "OFF model is refused (direct)",
  offDirect.status === 404 && offDirect.text.includes("turned off"),
  `status ${offDirect.status}`
);

const offCombo = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  auth
);
check(
  "OFF model is not served through a combo",
  offCombo.status >= 400 && !offCombo.text.includes("mock upstream"),
  `status ${offCombo.status}`
);

const on = await setModelOff(false);
check("turn model ON", on.status === 200, `status ${on.status}`);

const onDirect = await v1(
  "/v1/chat/completions",
  { model: "mock/gpt-mock", stream: false, messages: hello },
  auth
);
check(
  "ON model works again",
  onDirect.status === 200 && onDirect.text.includes("mock upstream"),
  `status ${onDirect.status}`
);

const comboId = combo.json?.id || combo.json?.combo?.id;
const setStepOff = (off) =>
  api(`/api/combos/${comboId}`, {
    method: "PUT",
    body: {
      models: [{ kind: "model", model: "mock/gpt-mock", ...(off ? { enabled: false } : {}) }],
    },
  });

const stepOff = await setStepOff(true);
check("turn combo step OFF", stepOff.status === 200, `status ${stepOff.status}`);

const stepOffChat = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  auth
);
check(
  "OFF combo step is skipped",
  stepOffChat.status === 503 && stepOffChat.text.includes("turned off"),
  `status ${stepOffChat.status}`
);

const stepOn = await setStepOff(false);
check("turn combo step ON", stepOn.status === 200, `status ${stepOn.status}`);

const stepOnChat = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  auth
);
check(
  "ON combo step works again",
  stepOnChat.status === 200 && stepOnChat.text.includes("mock upstream"),
  `status ${stepOnChat.status}`
);

const dupNode = await api("/api/provider-nodes", {
  method: "POST",
  body: {
    name: "Mock again",
    prefix: "mock",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: mockUrl,
  },
});
check("duplicate provider prefix is refused", dupNode.status === 409, `status ${dupNode.status}`);

const nodesAnonymous = await fetch(base + "/api/provider-nodes", {
  headers: { origin: base },
  redirect: "manual",
  signal: AbortSignal.timeout(60_000),
});
check(
  "provider-nodes API needs a login",
  nodesAnonymous.status === 401 || nodesAnonymous.status === 403,
  `status ${nodesAnonymous.status}`
);

const badKey = await v1(
  "/v1/chat/completions",
  { model: "smoke-combo", stream: false, messages: hello },
  { authorization: "Bearer sk-not-a-real-key" }
);
check(
  "invalid API key gives a helpful 401",
  badKey.status === 401 && badKey.text.includes("Dashboard > API Keys"),
  `status ${badKey.status}`
);

const favicon = await api("/api/settings/favicon");
check(
  "default favicon fallback works (logged in)",
  favicon.status === 307 && favicon.headers.get("location") === "/favicon.svg",
  `status ${favicon.status}`
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
