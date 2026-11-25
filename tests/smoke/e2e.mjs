// End-to-end smoke checks against a running TRouteAI with a fresh data folder:
// login, dashboard pages, provider + connection + combo + API key setup through the
// management API, then chat through the OpenAI, Anthropic and Responses formats.
//
// Usage: node e2e.mjs <base-url> <admin-password> [mock-upstream-url]
//   PAGES=/dashboard,/dashboard/providers,...  pages to open (default: a short list)
import http from "node:http";

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

// White-label before sign-in: the sign-in page reads the custom name from the public sign-in
// status, and the tab icon route answers a signed-out browser too.
const named = await api("/api/settings", {
  method: "PATCH",
  body: { instanceName: "Smoke Gateway" },
});
const statusAnon = await fetch(base + "/api/settings/require-login", {
  signal: AbortSignal.timeout(60_000),
});
const statusJson = await statusAnon.json().catch(() => ({}));
check(
  "sign-in status carries the custom name",
  named.status === 200 && statusJson.instanceName === "Smoke Gateway",
  `status ${named.status}, name ${statusJson.instanceName}`
);
await api("/api/settings", { method: "PATCH", body: { instanceName: "" } });
const faviconAnon = await fetch(base + "/api/settings/favicon", {
  redirect: "manual",
  signal: AbortSignal.timeout(60_000),
});
check(
  "favicon route answers a signed-out browser",
  faviconAnon.status === 307 && faviconAnon.headers.get("location") === "/favicon.svg",
  `status ${faviconAnon.status}`
);

// Only the body's `stream: true` gets an event stream; absent or false gets one JSON answer,
// whatever the Accept header says (the OpenAI and Anthropic APIs default `stream` to false).
// node:http sends exactly the headers given: fetch would always add `Accept: */*`.
function rawPost(path, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        timeout: 60_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, type: String(res.headers["content-type"] || ""), text })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const dialects = [
  {
    path: "/v1/chat/completions",
    body: { model: "smoke-combo", messages: hello },
    json: (j) => j?.object === "chat.completion" && !!j.choices?.[0]?.message,
    sse: (t) => t.includes("chat.completion.chunk") && t.includes("data: [DONE]"),
  },
  {
    path: "/v1/messages",
    body: { model: "smoke-combo", max_tokens: 50, messages: hello },
    json: (j) => j?.type === "message" && Array.isArray(j.content),
    sse: (t) => t.includes("event: message_start") && t.includes("event: message_stop"),
  },
  {
    path: "/v1/responses",
    body: { model: "smoke-combo", input: "hi" },
    json: (j) => j?.object === "response" && Array.isArray(j.output),
    sse: (t) => t.includes("event: response.created") && t.includes("event: response.completed"),
  },
];
const streamValues = [true, false, undefined];
const acceptValues = [undefined, "*/*", "application/json", "text/event-stream"];
const matrix = [];
for (const d of dialects) {
  for (const streamValue of streamValues) {
    for (const accept of acceptValues) {
      matrix.push({ d, streamValue, accept });
    }
  }
}
const matrixResults = await Promise.all(
  matrix.map(async ({ d, streamValue, accept }) => {
    const body = streamValue === undefined ? d.body : { ...d.body, stream: streamValue };
    const headers = { ...auth, ...(accept ? { accept } : {}) };
    try {
      return await rawPost(d.path, body, headers);
    } catch (error) {
      return { status: 0, type: "", text: String(error) };
    }
  })
);
matrix.forEach(({ d, streamValue, accept }, i) => {
  const res = matrixResults[i];
  const wantSse = streamValue === true;
  const shapeOk = wantSse
    ? res.type.includes("text/event-stream") && d.sse(res.text)
    : res.type.includes("application/json") && d.json(parseJson(res.text));
  check(
    `${d.path} stream ${streamValue === undefined ? "absent" : streamValue}, Accept ${
      accept ?? "none"
    } -> ${wantSse ? "event stream" : "JSON"}`,
    res.status === 200 && shapeOk,
    `status ${res.status}, ${res.type || "no content type"}`
  );
});

// A key set to the old "JSON Compatible" stream setting answers the same way.
const jsonKey = await api("/api/keys", { method: "POST", body: { name: "smoke-json-key" } });
const jsonKeyId = jsonKey.json?.id || jsonKey.json?.key?.id || jsonKey.json?.apiKey?.id;
const jsonKeySet = jsonKeyId
  ? await api(`/api/keys/${jsonKeyId}`, { method: "PATCH", body: { streamDefaultMode: "json" } })
  : { status: 0 };
check(
  "set a key to the JSON stream setting",
  jsonKeySet.status === 200,
  `status ${jsonKeySet.status}`
);
const jsonKeyAuth = { authorization: `Bearer ${jsonKey.json?.key}` };
for (const [streamValue, accept, wantSse] of [
  [undefined, "text/event-stream", false],
  [true, "application/json", true],
]) {
  const body = { model: "smoke-combo", messages: hello };
  if (streamValue !== undefined) body.stream = streamValue;
  const res = await rawPost("/v1/chat/completions", body, { ...jsonKeyAuth, accept });
  check(
    `JSON-setting key, stream ${streamValue ?? "absent"}, Accept ${accept} -> ${
      wantSse ? "event stream" : "JSON"
    }`,
    res.status === 200 && res.type.includes(wantSse ? "text/event-stream" : "application/json"),
    `status ${res.status}, ${res.type}`
  );
}

// The Ollama chat API streams by default, so the Ollama route still does.
const ollama = await rawPost(
  "/v1/api/chat",
  { model: "smoke-combo", messages: hello },
  { ...auth, accept: "*/*" }
);
check(
  "Ollama chat with no stream field still streams",
  ollama.status === 200 && ollama.text.includes('"done":true') && ollama.text.includes("mock"),
  `status ${ollama.status}, ${ollama.type}`
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
