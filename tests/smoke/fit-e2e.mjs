// End to end: what programs that start TRouteAI or sit in front of it rely on. Starts the
// `trouteai` command the way a supervisor does (no terminal, --port, a throwaway data folder)
// against a slow fake provider (mock-slow.mjs) and checks the bind, the health states, both
// key headers, the API paths that must not redirect, the token counts, the stream headers and
// keep-alives, key creation by command, and a SIGTERM with a stream open.
//
// Usage: node fit-e2e.mjs <app-port> <mock-port>
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "../..");
const PORT = Number(process.argv[2] || 21174);
const MOCK_PORT = Number(process.argv[3] || 21175);
const PASSWORD = "Fit-Test-Pass-123";
const base = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-fit-"));
const LOG = path.join(DATA, "app.log");

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The environment a supervisor gives: no HOST, no PORT (the port comes from --port).
const env = { ...process.env };
for (const key of ["HOST", "PORT", "DASHBOARD_PORT", "API_PORT", "TROUTEAI_UPDATE_CHECK"]) {
  delete env[key];
}
Object.assign(env, {
  DATA_DIR: DATA,
  INITIAL_PASSWORD: PASSWORD,
  // Short intervals so the keep-alive checks take seconds, not minutes.
  SSE_HEARTBEAT_INTERVAL_MS: "1000",
  TROUTEAI_STREAM_KEEPALIVE_AFTER_MS: "1000",
});

const mock = spawn(process.execPath, [path.join(HERE, "mock-slow.mjs"), String(MOCK_PORT)], {
  env: { ...process.env, SLOW_FIRST_MS: "4000", PAUSE_MS: "4000" },
  stdio: "ignore",
});
let app = null;
let appExited = null;

// The command starts a child Node with a heap limit; killing only the command would leave that
// child serving, so a server is ended through its whole process group.
const servers = [];
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}
function cleanup() {
  for (const child of servers) killGroup(child);
  try {
    mock.kill("SIGKILL");
  } catch {}
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on("exit", cleanup);

function connects(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: PORT });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function hasIpv6Loopback() {
  return Object.values(os.networkInterfaces()).some((entries) =>
    (entries ?? []).some((e) => e.internal && e.family === "IPv6" && e.address === "::1")
  );
}

async function request(url, { method = "GET", headers = {}, body, redirect = "manual" } = {}) {
  const res = await fetch(url, {
    method,
    redirect,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

/** Read a stream and keep when each piece arrived. */
async function timedStream(url, headers, body, { stopAfterMs = 30_000 } = {}) {
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(stopAfterMs),
  });
  const pieces = [];
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    pieces.push({ at: Date.now() - started, text: decoder.decode(chunk, { stream: true }) });
  }
  const text = pieces.map((p) => p.text).join("");
  let maxGap = pieces.length ? pieces[0].at : Infinity;
  for (let i = 1; i < pieces.length; i++)
    maxGap = Math.max(maxGap, pieces[i].at - pieces[i - 1].at);
  return { status: res.status, headers: res.headers, text, firstAt: pieces[0]?.at ?? null, maxGap };
}

function sseEvents(text) {
  return text
    .split(/\n\n/)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? null;
      const data = block.match(/^data: (.+)$/m)?.[1] ?? null;
      let json = null;
      try {
        json = data && data !== "[DONE]" ? JSON.parse(data) : null;
      } catch {}
      return { event, data, json };
    })
    .filter((e) => e.event || e.data);
}

// ── --version ───────────────────────────────────────────────────────────────
const version = spawnSync(process.execPath, [path.join(APP_DIR, "bin/trouteai.mjs"), "--version"], {
  env,
  encoding: "utf8",
});
const firstLine = String(version.stdout).split("\n")[0];
check("--version prints x.y.z on its first line", /^\d+\.\d+\.\d+$/.test(firstLine), firstLine);

// ── Start like a supervisor ─────────────────────────────────────────────────
const out = fs.openSync(LOG, "a");
const startedAt = Date.now();
app = spawn(process.execPath, [path.join(APP_DIR, "bin/trouteai.mjs"), "--port", String(PORT)], {
  cwd: os.tmpdir(),
  env,
  stdio: ["ignore", out, out],
  detached: true,
});
servers.push(app);
app.once("exit", (code, signal) => {
  appExited = { code, signal, at: Date.now() };
});
let ready = false;
while (Date.now() - startedAt < 90_000 && appExited === null) {
  if (fs.readFileSync(LOG, "utf8").includes("listening on")) {
    ready = true;
    break;
  }
  await sleep(250);
}
const startSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
check(
  "starts with no terminal and --port, listens within 30 s",
  ready && startSeconds <= 30,
  `${startSeconds} s`
);
if (!ready) {
  console.log(fs.readFileSync(LOG, "utf8").split("\n").slice(-30).join("\n"));
  process.exit(1);
}
const banner = fs.readFileSync(LOG, "utf8");
check(
  "start banner says how to allow the network",
  banner.includes("HOST=0.0.0.0"),
  banner
    .split("\n")
    .find((l) => l.includes("HOST=0.0.0.0"))
    ?.trim() ?? "no line"
);

// ── Bind ────────────────────────────────────────────────────────────────────
check("answers on 127.0.0.1", await connects("127.0.0.1"));
check("answers on localhost", (await request(`http://localhost:${PORT}/healthz`)).status === 200);
if (hasIpv6Loopback()) check("answers on ::1", await connects("::1"));
else console.log("SKIP  answers on ::1 (this computer has no IPv6 loopback)");
const otherAddress = os.platform() === "linux" ? "127.0.0.2" : null;
if (otherAddress) {
  check(
    `does not answer on another local address (${otherAddress})`,
    !(await connects(otherAddress))
  );
}
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((e) => e && !e.internal && e.family === "IPv4")?.address;
if (lan) check("does not answer on the network address", !(await connects(lan)));

// ── Health ──────────────────────────────────────────────────────────────────
const health = await request(`${base}/healthz`);
check(
  "/healthz answers 200 ok without a key",
  health.status === 200 && health.text.trim() === "ok"
);

const listFails = [];
for (const route of ["/v1/models", "/api/v1/models", "/api/models", "/models"]) {
  const res = await request(base + route);
  if (res.status !== 401) listFails.push(`${route}=${res.status}`);
}
check("the model lists need a key", listFails.length === 0, listFails.join(", "));
const root = await request(`${base}/`);
const dashboard = await request(`${base}/dashboard`);
check(
  "/ leads a browser to the sign-in page",
  root.status >= 300 &&
    root.status < 400 &&
    String(dashboard.headers.get("location") || "").includes("/login"),
  `${root.status} ${root.headers.get("location")} then ${dashboard.headers.get("location")}`
);

// ── Setup through the dashboard API ─────────────────────────────────────────
const login = await request(`${base}/api/auth/login`, {
  method: "POST",
  headers: { origin: base },
  body: { password: PASSWORD },
});
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const manage = { origin: base, cookie };
const node = await request(`${base}/api/provider-nodes`, {
  method: "POST",
  headers: manage,
  body: {
    name: "Slow",
    prefix: "slow",
    type: "openai-compatible",
    apiType: "chat",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  },
});
const nodeId = node.json?.node?.id || node.json?.id;
const conn = await request(`${base}/api/providers`, {
  method: "POST",
  headers: manage,
  body: { provider: nodeId, name: "slow-conn", apiKey: "sk-fake-upstream" },
});
check(
  "setup: provider and connection",
  !!nodeId && conn.status < 300,
  `${node.status} ${conn.status}`
);

// ── Key creation by command ─────────────────────────────────────────────────
const created = spawnSync(
  process.execPath,
  [path.join(APP_DIR, "bin/trouteai.mjs"), "key", "create", "fit test", "--port", String(PORT)],
  { env, encoding: "utf8", timeout: 60_000 }
);
let key = String(created.stdout).trim();
if (created.status === 0 && /^sk-/.test(key)) {
  check(
    "trouteai key create prints only the key on stdout",
    key.split("\n").length === 1,
    key.slice(0, 6)
  );
  const listed = await request(`${base}/api/keys`, { headers: manage });
  check(
    "the key is in the key list",
    (listed.json?.keys ?? []).some((k) => k.name === "fit test")
  );
} else {
  check(
    "trouteai key create",
    false,
    `exit ${created.status}: ${String(created.stderr).trim().slice(0, 200)}`
  );
  key = "";
}
if (!key) {
  const made = await request(`${base}/api/keys`, {
    method: "POST",
    headers: manage,
    body: { name: "fit" },
  });
  key = made.json?.key ?? "";
}
const tokenFile = path.join(DATA, "cli-token");
const tokenMode = fs.existsSync(tokenFile)
  ? (fs.statSync(tokenFile).mode & 0o777).toString(8)
  : "missing";
check(
  "the server made the command token with mode 0600",
  os.platform() === "win32" ? tokenMode !== "missing" : tokenMode === "600",
  tokenMode
);
let machineIdRaw = os.hostname().toLowerCase();
for (const candidate of ["/var/lib/dbus/machine-id", "/etc/machine-id"]) {
  try {
    const value = fs.readFileSync(candidate, "utf8").split("\n")[0].trim().toLowerCase();
    if (value) {
      machineIdRaw = value;
      break;
    }
  } catch {}
}
const oldToken = createHmac("sha256", machineIdRaw).update("trouteai-cli-auth-v1").digest("hex");
const oldTokenCreate = await request(`${base}/api/keys`, {
  method: "POST",
  headers: { "x-trouteai-cli-token": oldToken },
  body: { name: "machine-id" },
});
check(
  "a token derived from the machine id cannot create a key",
  oldTokenCreate.status === 401 || oldTokenCreate.status === 403,
  `status ${oldTokenCreate.status}`
);
let secretFromFile = "0".repeat(64);
try {
  secretFromFile = fs.readFileSync(tokenFile, "utf8").trim();
} catch {}
const forwardedCreate = await request(`${base}/api/keys`, {
  method: "POST",
  headers: { "x-trouteai-cli-token": secretFromFile, "x-forwarded-for": "203.0.113.9" },
  body: { name: "forwarded" },
});
check(
  "the command token through a proxy cannot create a key",
  forwardedCreate.status === 401 || forwardedCreate.status === 403,
  `status ${forwardedCreate.status}`
);
const noTokenCreate = await request(`${base}/api/keys`, {
  method: "POST",
  headers: { "x-trouteai-cli-token": "0".repeat(64) },
  body: { name: "intruder" },
});
check(
  "a wrong command token cannot create a key",
  noTokenCreate.status === 401 || noTokenCreate.status === 403,
  `status ${noTokenCreate.status}`
);

// ── The provider list and the one-time sign-in link (for a program that manages this server) ──
const cliAuth = { "x-trouteai-cli-token": secretFromFile };
const catalogNone = await request(`${base}/api/providers/catalog`);
check(
  "the provider list needs management rights",
  catalogNone.status === 401 || catalogNone.status === 403,
  `status ${catalogNone.status}`
);
const catalogKey = await request(`${base}/api/providers/catalog`, {
  headers: { authorization: `Bearer ${key}` },
});
check(
  "a key without the manage scope cannot read the provider list",
  catalogKey.status === 403,
  `status ${catalogKey.status}`
);
const catalog = await request(`${base}/api/providers/catalog`, { headers: cliAuth });
const catalogRows = catalog.json?.providers ?? [];
check(
  "the command token reads the provider list",
  catalog.status === 200 && catalogRows.length > 50,
  `status ${catalog.status}, ${catalogRows.length} providers`
);
check(
  "each provider has id, name, category, hints, website and flow",
  catalogRows.every(
    (r) =>
      r.id &&
      r.name &&
      r.category &&
      ["api-key", "device-code", "link-and-paste", "own-page"].includes(r.flow) &&
      "authHint" in r &&
      "apiHint" in r &&
      "website" in r
  )
);
const flowOfProvider = (id) => catalogRows.find((r) => r.id === id)?.flow;
check(
  "github is device-code, claude is link-and-paste, codex is own-page, openai is api-key",
  flowOfProvider("github") === "device-code" &&
    flowOfProvider("claude") === "link-and-paste" &&
    flowOfProvider("codex") === "own-page" &&
    flowOfProvider("openai") === "api-key"
);

const linkNone = await request(`${base}/api/auth/link`, { method: "POST", body: {} });
check(
  "a sign-in link cannot be made without management rights",
  linkNone.status === 401 || linkNone.status === 403,
  `status ${linkNone.status}`
);
const linkKey = await request(`${base}/api/auth/link`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}` },
  body: {},
});
check(
  "a key without the manage scope cannot make a sign-in link",
  linkKey.status === 403,
  `status ${linkKey.status}`
);
const linkMade = await request(`${base}/api/auth/link`, {
  method: "POST",
  headers: cliAuth,
  body: {},
});
const linkUrl = String(linkMade.json?.url ?? "");
check(
  "the command token makes a link: {url, expiresIn: 60}",
  linkMade.status === 200 &&
    linkMade.json?.expiresIn === 60 &&
    new RegExp(
      `^http://(127\\.0\\.0\\.1|localhost):${PORT}/login/link\\?code=[A-Za-z0-9_-]{43}$`
    ).test(linkUrl),
  `status ${linkMade.status}, ${linkUrl.replace(/code=.*/, "code=...")}`
);
const loginRef = await request(`${base}/api/auth/login`, {
  method: "POST",
  headers: { origin: base },
  body: { password: PASSWORD },
});
const loginCookie = String(loginRef.headers.get("set-cookie") ?? "");
const flagsOf = (c) =>
  c
    .split(";")
    .slice(1)
    .map((p) => p.trim().toLowerCase())
    .sort()
    .join(";");
const linkCode = linkUrl.split("code=")[1] ?? "";
const used = await request(linkUrl);
const usedCookie = String(used.headers.get("set-cookie") ?? "");
check(
  "the link signs in and goes to the dashboard",
  [302, 303, 307].includes(used.status) &&
    new URL(used.headers.get("location") ?? "", base).pathname === "/dashboard" &&
    /^auth_token=[^;]+/.test(usedCookie),
  `status ${used.status}, location ${used.headers.get("location")}`
);
check(
  "its cookie has the same flags as the password sign-in",
  usedCookie !== "" && flagsOf(usedCookie) === flagsOf(loginCookie),
  `${flagsOf(usedCookie)} against ${flagsOf(loginCookie)}`
);
check(
  "its answer carries no-referrer and no-store",
  /no-referrer/.test(used.headers.get("referrer-policy") ?? "") &&
    /no-store/.test(used.headers.get("cache-control") ?? ""),
  `${used.headers.get("referrer-policy")} | ${used.headers.get("cache-control")}`
);
const withLinkCookie = await request(`${base}/api/providers`, {
  headers: { cookie: usedCookie.split(";")[0] },
});
check(
  "the session of the link opens the management routes",
  withLinkCookie.status === 200,
  `status ${withLinkCookie.status}`
);
const usedAgain = await request(linkUrl);
check(
  "a second use goes to the sign-in page and sets no cookie",
  [302, 303, 307].includes(usedAgain.status) &&
    new URL(usedAgain.headers.get("location") ?? "", base).pathname === "/login" &&
    !usedAgain.headers.get("set-cookie"),
  `status ${usedAgain.status}, location ${usedAgain.headers.get("location")}`
);
for (const [label, url] of [
  ["a wrong code", `${base}/login/link?code=${"A".repeat(43)}`],
  ["no code", `${base}/login/link`],
]) {
  const r = await request(url);
  check(
    `${label} goes to the sign-in page and sets no cookie`,
    [302, 303, 307].includes(r.status) &&
      new URL(r.headers.get("location") ?? "", base).pathname === "/login" &&
      !r.headers.get("set-cookie") &&
      !/code|invalid|expired/i.test(r.text),
    `status ${r.status}`
  );
}
const logText = fs.readFileSync(LOG, "utf8");
check("the code is not in the server log", linkCode.length === 43 && !logText.includes(linkCode));

const bearer = { authorization: `Bearer ${key}` };
const xApiKey = { "x-api-key": key };
const both = { ...bearer, ...xApiKey };
const hello = [{ role: "user", content: "hi" }];

// ── Both key headers on every /v1 route ─────────────────────────────────────
const routes = [
  ["GET", "/v1/models", null],
  ["POST", "/v1/chat/completions", { model: "slow/fast", stream: false, messages: hello }],
  ["POST", "/v1/messages", { model: "slow/fast", max_tokens: 16, stream: false, messages: hello }],
  ["POST", "/v1/messages/count_tokens", { model: "slow/fast", messages: hello }],
  ["POST", "/v1/responses", { model: "slow/fast", stream: false, input: "hi" }],
  ["POST", "/v1/embeddings", { model: "slow/fast", input: "hi" }],
  ["GET", "/v1/combos", null],
];
const headerFails = [];
for (const [method, route, body] of routes) {
  for (const [label, headers] of [
    ["bearer", bearer],
    ["x-api-key", xApiKey],
    ["both", both],
  ]) {
    const res = await request(base + route, { method, headers, body: body ?? undefined });
    if (res.status === 401 || res.status === 403)
      headerFails.push(`${route} ${label}=${res.status}`);
  }
}
check(
  `the same key in Bearer, x-api-key or both is accepted (${routes.length} routes)`,
  headerFails.length === 0,
  headerFails.join(", ")
);
const wrongKey = await request(`${base}/v1/models`, {
  headers: { "x-api-key": "sk-fake-not-a-key" },
});
check("a wrong key in x-api-key is refused", wrongKey.status === 401, `status ${wrongKey.status}`);

// ── No redirect on an API path ──────────────────────────────────────────────
const redirectFails = [];
for (const [method, route, body] of [
  ["GET", "/v1/models/", null],
  ["GET", "/v1/models", null],
  ["GET", "/models/", null],
  ["GET", "/api/v1/models/", null],
  ["GET", "/healthz/", null],
  ["POST", "/v1/chat/completions/", { model: "slow/fast", stream: false, messages: hello }],
  ["POST", "/v1/messages/", { model: "slow/fast", max_tokens: 16, stream: false, messages: hello }],
]) {
  const res = await request(base + route, { method, headers: bearer, body: body ?? undefined });
  if (res.status >= 300 && res.status < 400) redirectFails.push(`${method} ${route}=${res.status}`);
  else if (res.status !== 200) redirectFails.push(`${method} ${route}=${res.status}`);
}
check(
  "API paths answer 200 with and without a trailing slash, no redirect",
  redirectFails.length === 0,
  redirectFails.join(", ")
);

// ── Token counts and stream headers ─────────────────────────────────────────
const openaiStream = await timedStream(`${base}/v1/chat/completions`, bearer, {
  model: "slow/fast",
  stream: true,
  stream_options: { include_usage: true },
  messages: hello,
});
const openaiChunks = sseEvents(openaiStream.text).filter((e) => e.json);
const lastUsage = [...openaiChunks].reverse().find((e) => e.json.usage)?.json.usage;
check(
  "OpenAI stream: usage with prompt and completion tokens in the last chunks",
  lastUsage?.prompt_tokens > 0 && lastUsage?.completion_tokens > 0,
  JSON.stringify(lastUsage)
);
check(
  "OpenAI stream: X-Accel-Buffering: no",
  openaiStream.headers.get("x-accel-buffering") === "no"
);

const claudeStream = await timedStream(
  `${base}/v1/messages`,
  { ...xApiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
  { model: "slow/fast", max_tokens: 32, stream: true, messages: hello }
);
const claudeEvents = sseEvents(claudeStream.text).filter((e) => e.json);
const start = claudeEvents.find((e) => e.json.type === "message_start")?.json.message?.usage;
const delta = claudeEvents.find((e) => e.json.type === "message_delta")?.json.usage;
check(
  "Anthropic stream: usage in message_start and message_delta",
  typeof start?.input_tokens === "number" &&
    typeof start?.output_tokens === "number" &&
    delta?.output_tokens > 0,
  JSON.stringify({ start, delta })
);
check(
  "Anthropic stream: X-Accel-Buffering: no",
  claudeStream.headers.get("x-accel-buffering") === "no"
);
const plain = await request(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: bearer,
  body: { model: "slow/fast", stream: false, messages: hello },
});
check(
  "OpenAI answer: usage with prompt and completion tokens",
  plain.json?.usage?.prompt_tokens > 0 && plain.json?.usage?.completion_tokens > 0,
  JSON.stringify(plain.json?.usage)
);

const tokenFails = [];
for (const extra of [
  { max_tokens: 16 },
  { max_completion_tokens: 16 },
  { max_completion_tokens: 16, stream: true, stream_options: { include_usage: true } },
]) {
  const res = await request(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: bearer,
    body: { model: "slow/fast", stream: false, messages: hello, ...extra },
  });
  if (res.status !== 200) tokenFails.push(`${Object.keys(extra).join("+")}=${res.status}`);
}
check(
  "max_tokens, max_completion_tokens and stream_options are accepted",
  tokenFails.length === 0,
  tokenFails.join(", ")
);

// ── Keep-alive while the model is silent ────────────────────────────────────
const pausedOpenai = await timedStream(`${base}/v1/chat/completions`, bearer, {
  model: "slow/pause-mid",
  stream: true,
  messages: hello,
});
check(
  "OpenAI stream: bytes keep coming while the model pauses 4 s (heartbeat 1 s)",
  pausedOpenai.status === 200 && pausedOpenai.maxGap < 2500,
  `longest silence ${pausedOpenai.maxGap} ms`
);
const pausedClaude = await timedStream(
  `${base}/v1/messages`,
  { ...xApiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
  { model: "slow/pause-mid", max_tokens: 32, stream: true, messages: hello }
);
check(
  "Anthropic stream: ping events while the model pauses 4 s",
  pausedClaude.status === 200 &&
    pausedClaude.maxGap < 2500 &&
    pausedClaude.text.includes("event: ping"),
  `longest silence ${pausedClaude.maxGap} ms`
);
for (const [label, route, body] of [
  [
    "Anthropic",
    "/v1/messages",
    { model: "slow/slow-first", max_tokens: 32, stream: true, messages: hello },
  ],
  ["Responses", "/v1/responses", { model: "slow/slow-first", stream: true, input: "hi" }],
]) {
  const slow = await timedStream(
    base + route,
    { ...xApiKey, "anthropic-version": "2023-06-01", accept: "application/json" },
    body
  );
  check(
    `${label} stream: "stream": true with an SDK's JSON Accept gets bytes before a 4 s first token`,
    slow.status === 200 && slow.firstAt !== null && slow.firstAt < 3000 && slow.maxGap < 3000,
    `first byte ${slow.firstAt} ms, longest silence ${slow.maxGap} ms`
  );
}

// ── SIGTERM with a stream open ──────────────────────────────────────────────
const openStream = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...bearer },
  body: JSON.stringify({ model: "slow/hang", stream: true, messages: hello }),
});
const reader = openStream.body.getReader();
const firstChunk = await reader.read();
let streamText = new TextDecoder().decode(firstChunk.value ?? new Uint8Array());
const streamEnded = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "closed";
      streamText += new TextDecoder().decode(value);
    }
  } catch {
    return "cut";
  }
})();
check("a stream is open before the stop signal", openStream.status === 200 && !firstChunk.done);

const signalAt = Date.now();
app.kill("SIGTERM");
await sleep(400);
const stoppingHealth = await request(`${base}/healthz`).catch(() => null);
check(
  "/healthz answers 503 stopping while the stream drains",
  stoppingHealth?.status === 503 && stoppingHealth.text.trim() === "stopping",
  stoppingHealth ? `${stoppingHealth.status} ${stoppingHealth.text.trim()}` : "no answer"
);
const newRequest = await request(`${base}/v1/models`, { headers: bearer }).catch(() => null);
check(
  "a new API request while stopping is refused with 503, not served",
  !newRequest || newRequest.status === 503,
  newRequest ? `status ${newRequest.status}` : "connection refused"
);
while (appExited === null && Date.now() - signalAt < 15_000) await sleep(100);
const stopSeconds = appExited ? Math.round((appExited.at - signalAt) / 100) / 10 : null;
check(
  "SIGTERM with a stream open: the process ends within 10 s",
  appExited !== null && stopSeconds <= 10,
  appExited
    ? `${stopSeconds} s, exit ${appExited.code ?? appExited.signal}`
    : "still running after 15 s"
);
const ending = await Promise.race([streamEnded, sleep(3000).then(() => "still open")]);
check(
  "the cut stream does not end like a finished answer",
  ending !== "still open" &&
    !streamText.includes("[DONE]") &&
    !/"finish_reason":"stop"/.test(streamText),
  ending
);

// ── The switch: TROUTEAI_DISABLE_CLI_TOKEN=true refuses the command ────────────
const switchLog = fs.openSync(LOG, "a");
const switched = spawn(
  process.execPath,
  [path.join(APP_DIR, "bin/trouteai.mjs"), "--port", String(PORT)],
  {
    cwd: os.tmpdir(),
    env: { ...env, TROUTEAI_DISABLE_CLI_TOKEN: "true" },
    detached: true,
    stdio: ["ignore", switchLog, switchLog],
  }
);
servers.push(switched);
let switchedExited = false;
switched.once("exit", () => (switchedExited = true));
let switchedReady = false;
for (let waited = 0; waited < 90_000 && !switchedExited; waited += 250) {
  if ((await request(`${base}/healthz`).catch(() => null))?.status === 200) {
    switchedReady = true;
    break;
  }
  await sleep(250);
}
if (switchedReady) {
  const refused = spawnSync(
    process.execPath,
    [
      path.join(APP_DIR, "bin/trouteai.mjs"),
      "key",
      "create",
      "switched off",
      "--port",
      String(PORT),
    ],
    { env, encoding: "utf8", timeout: 60_000 }
  );
  check(
    "with TROUTEAI_DISABLE_CLI_TOKEN=true, trouteai key create is refused",
    refused.status !== 0 &&
      !/^sk-/.test(String(refused.stdout).trim()) &&
      /refused/.test(String(refused.stderr)),
    String(refused.stderr).trim().split("\n")[0]
  );
} else {
  check(
    "with TROUTEAI_DISABLE_CLI_TOKEN=true, trouteai key create is refused",
    false,
    "server did not start"
  );
}
switched.kill("SIGTERM");
for (let waited = 0; waited < 15_000 && !switchedExited; waited += 100) await sleep(100);
if (!switchedExited) killGroup(switched);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) {
  const errors = fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => /Error|FATAL|WARN/.test(l));
  if (errors.length) console.log(`App log:\n${errors.slice(-15).join("\n")}`);
}
process.exit(failed ? 1 : 0);
