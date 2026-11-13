// Context-size checks against a running TRouteAI and mock-anthropic.mjs.
//
// 1. A conversation is never shortened silently (prompt compression is off by default): the
//    provider receives the body as the client built it, even near the model's window.
// 2. Only a request clearly over a KNOWN window is refused locally (estimate > limit x 1.1);
//    one close to the limit goes to the provider, and a limit that is only a guess is never
//    enforced.
// 3. Every context-overflow error reaches the client in the wording its agent recovers
//    from: Anthropic's "prompt is too long: N tokens > M maximum" (Claude Code compacts) on
//    /v1/messages, code "context_length_exceeded" on OpenAI-format routes. Checked with the
//    regexes Claude Code 2.1.319 itself uses.
//
// Usage: node context-e2e.mjs <base-url> <admin-password> <mock-url>
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
const stats = () => mock("/__stats");
const hitsOf = async (key) => (await stats()).hits[key] || 0;

// Claude Code 2.1.319: i$() / pje() / sW() (read from its binary)
const ccPromptTooLong = (t) =>
  t.toLowerCase().includes("prompt is too long") ||
  t.toLowerCase().includes("input is too long for requested model");
const ccNumbers = (t) => {
  const m = t.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  return m ? { actual: Number(m[1]), limit: Number(m[2]) } : null;
};
const ccMaxTokens = (t) =>
  t.match(/input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/);

let apiKey = "";
let seq = 0;
// A conversation of about `tokens` estimated tokens (characters / 4): one long tool result
// that ends with TAIL-MARKER, so the mock can tell whether it arrived uncut.
function conversation(tokens, format) {
  const filler = "lorem ipsum ".repeat(Math.max(1, Math.floor((tokens * 4) / 12)));
  const result = `${filler}TAIL-MARKER`;
  if (format === "anthropic") {
    return [
      { role: "user", content: `read the file ${++seq}` },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: `toolu_${seq}`, name: "Read", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `toolu_${seq}`, content: result },
          { type: "text", text: "summarize it" },
        ],
      },
    ];
  }
  return [
    { role: "user", content: `read the file ${++seq}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `call_${seq}`, type: "function", function: { name: "Read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: `call_${seq}`, content: result },
    { role: "user", content: "summarize it" },
  ];
}
const TOOLS_ANTHROPIC = [
  { name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } },
];
const TOOLS_OPENAI = [
  {
    type: "function",
    function: { name: "Read", description: "read a file", parameters: { type: "object" } },
  },
];

async function send(model, tokens, { format = "anthropic", stream = false } = {}) {
  const path = format === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const headers =
    format === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
  if (stream) headers.accept = "text/event-stream";
  const res = await fetch(base + path, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      stream,
      max_tokens: 1000,
      tools: format === "anthropic" ? TOOLS_ANTHROPIC : TOOLS_OPENAI,
      messages: conversation(tokens, format),
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

// ── setup ───────────────────────────────────────────────────────────────────
const login = await api("/api/auth/login", { method: "POST", body: { password } });
cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
check("login", login.status === 200);
await mock("/__reset", {});
const node = await api("/api/provider-nodes", {
  method: "POST",
  body: {
    name: "Ctx Mock",
    prefix: "ctxm",
    type: "anthropic-compatible",
    baseUrl: mockUrl + "/v1",
  },
});
const nodeId = node.json?.node?.id;
const conn = await api("/api/providers", {
  method: "POST",
  body: { provider: nodeId, name: "ctx-a", apiKey: "ctx-a" },
});
const connId = conn.json?.connection?.id;
const key = await api("/api/keys", { method: "POST", body: { name: "ctx-key" } });
apiKey = key.json?.key;
await api("/api/resilience", {
  method: "PATCH",
  body: { requestQueue: { requestsPerMinute: 1000, minTimeBetweenRequestsMs: 0 } },
});
check("setup: node, connection, api key", !!nodeId && !!connId && !!apiKey);

const MODEL = "claude-opus-mock";
const DIRECT = `ctxm/${MODEL}`;
const LIMIT = 20000;
const setLimit = (value) =>
  api("/api/provider-models", {
    method: "PUT",
    body: { provider: nodeId, modelId: MODEL, contextWindowOverride: value },
  });
const lim = await setLimit(LIMIT);
check(
  "set a known context window (20,000 tokens) for the model",
  lim.status === 200,
  `status ${lim.status} ${lim.text.slice(0, 120)}`
);
const step = { kind: "model", model: DIRECT, connectionId: connId, weight: 100 };
for (const [name, strategy] of [
  ["ctxm-priority", "priority"],
  ["ctxm-rr", "round-robin"],
]) {
  await api("/api/combos", { method: "POST", body: { name, strategy, models: [step] } });
}

// ── 1. no silent trimming ───────────────────────────────────────────────────
for (const [label, model] of [
  ["direct model", DIRECT],
  ["combo", "ctxm-priority"],
]) {
  const r = await send(model, Math.round(LIMIT * 0.8));
  const last = (await stats()).last["ctx-a"];
  check(
    `80% of the window (${label}): sent to the provider uncut`,
    r.status === 200 && last?.tail === true,
    `status ${r.status} tail ${last?.tail} bytes ${last?.bytes}`
  );
}

// ── 2. close to the limit goes to the provider ──────────────────────────────
{
  const r = await send(DIRECT, Math.round(LIMIT * 1.04));
  const last = (await stats()).last["ctx-a"];
  check(
    "104% of the window (inside the estimate tolerance): the provider decides",
    r.status === 200 && last?.tail === true,
    `status ${r.status} tail ${last?.tail}`
  );
}

// ── 3. clearly over a known window: refused locally, in Claude Code's wording ─
for (const [label, model, format] of [
  ["direct model, /v1/messages", DIRECT, "anthropic"],
  ["priority combo, /v1/messages", "ctxm-priority", "anthropic"],
  ["round-robin combo, /v1/messages", "ctxm-rr", "anthropic"],
  ["direct model, /v1/chat/completions", DIRECT, "openai"],
  ["priority combo, /v1/chat/completions", "ctxm-priority", "openai"],
]) {
  const before = await hitsOf("ctx-a");
  const r = await send(model, Math.round(LIMIT * 1.5), { format });
  const after = await hitsOf("ctx-a");
  const nums = ccNumbers(r.text);
  const ok =
    r.status === 400 &&
    after === before &&
    (format === "anthropic"
      ? r.json?.type === "error" &&
        /^prompt is too long: \d+ tokens > \d+ maximum$/.test(r.json?.error?.message || "") &&
        nums?.limit === LIMIT &&
        nums.actual > LIMIT
      : r.json?.error?.code === "context_length_exceeded" && ccPromptTooLong(r.text));
  check(
    `150% of the window (${label}): 400, no request sent, recoverable wording`,
    ok,
    `status ${r.status} hits ${before}->${after} ${nums ? `${nums.actual} > ${nums.limit}` : r.text.slice(0, 140)}`
  );
}

// ── 4. a provider's own overflow error, reworded for the client ─────────────
async function withMode(mode, fn) {
  await mock("/__control", { key: "ctx-a", mode });
  try {
    return await fn();
  } finally {
    await mock("/__control", { key: "ctx-a", mode: "ok" });
  }
}
await withMode("overflow-kiro", async () => {
  for (const [label, model] of [
    ["direct", DIRECT],
    ["combo", "ctxm-priority"],
  ]) {
    const r = await send(model, 200);
    check(
      `provider "Input is too long." (${label}, /v1/messages): Anthropic error claude code compacts on`,
      r.status === 400 && r.json?.type === "error" && ccPromptTooLong(r.json?.error?.message || ""),
      `status ${r.status} ${r.text.slice(0, 160)}`
    );
  }
  const o = await send(DIRECT, 200, { format: "openai" });
  check(
    'provider "Input is too long." (/v1/chat/completions): code context_length_exceeded',
    o.status === 400 && o.json?.error?.code === "context_length_exceeded",
    `status ${o.status} ${o.text.slice(0, 160)}`
  );
  const s = await send(DIRECT, 200, { stream: true });
  check(
    "streaming /v1/messages: the overflow error is still recoverable",
    (s.status === 400 && ccPromptTooLong(s.text)) ||
      (s.status === 200 && /event: error/.test(s.text) && ccPromptTooLong(s.text)),
    `status ${s.status} ${s.text.slice(0, 160)}`
  );
});
await withMode("overflow-openai", async () => {
  const r = await send(DIRECT, 200);
  const nums = ccNumbers(r.text);
  check(
    "provider OpenAI-style overflow: numbers kept for Claude Code",
    r.status === 400 && nums?.actual === 130500 && nums?.limit === 128000,
    r.text.slice(0, 160)
  );
});
await withMode("overflow-openai-completion", async () => {
  const r = await send(DIRECT, 200);
  const m = ccMaxTokens(r.text);
  check(
    "provider input+completion overflow: Claude Code's max_tokens retry wording",
    r.status === 400 && m && m[1] === "100000" && m[2] === "40000" && m[3] === "128000",
    r.text.slice(0, 200)
  );
});
await withMode("overflow-anthropic", async () => {
  const r = await send(DIRECT, 200);
  check(
    "Anthropic's own overflow error keeps its wording and numbers",
    r.status === 400 &&
      r.json?.type === "error" &&
      r.json?.error?.message === "prompt is too long: 1022310 tokens > 1000000 maximum",
    r.text.slice(0, 160)
  );
});

// ── 4b. earlier-turn thinking is not counted (providers drop it) ───────────
async function post(path, body, { stream = false, format = "anthropic", key = apiKey } = {}) {
  const headers =
    format === "anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${key}` };
  if (stream) headers.accept = "text/event-stream";
  const res = await fetch(base + path, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ stream, ...body }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}
{
  // 40 earlier turns, each with ~2,000 tokens of thinking + signature (~80k tokens of text,
  // 4x the 20k window) and a short answer; the real prompt is ~8k tokens.
  const history = [];
  for (let i = 0; i < 40; i++) {
    history.push({ role: "user", content: `question ${i} ${++seq}` });
    history.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "deep thought ".repeat(500), signature: "sig".repeat(700) },
        { type: "text", text: `answer ${i}` },
      ],
    });
  }
  for (const [label, model] of [
    ["direct", DIRECT],
    ["priority combo", "ctxm-priority"],
  ]) {
    const before = await hitsOf("ctx-a");
    const r = await post("/v1/messages", {
      model,
      max_tokens: 1000,
      messages: [...history, ...conversation(Math.round(LIMIT * 0.4), "anthropic")],
    });
    check(
      `long Claude Code session (thinking 4x the window, ${label}): sent, not refused`,
      r.status === 200 && (await hitsOf("ctx-a")) === before + 1,
      `status ${r.status} ${r.text.slice(0, 120)}`
    );
  }
}

// ── 4b2. a client that sent no max_tokens is not refused near the window ────
{
  const r = await post(
    "/v1/chat/completions",
    { model: DIRECT, stream: false, messages: conversation(Math.round(LIMIT * 0.9), "openai") },
    { format: "openai" }
  );
  check(
    "OpenAI client without max_tokens at 90% of a Claude model's window: answered (max_tokens fitted)",
    r.status === 200,
    `status ${r.status} ${r.text.slice(0, 160)}`
  );
}

// ── 4c. auto strategy: same rule and wording ───────────────────────────────
await api("/api/combos", {
  method: "POST",
  body: { name: "ctxm-auto", strategy: "auto", models: [step] },
});
{
  const ok80 = await send("ctxm-auto", Math.round(LIMIT * 0.8));
  check("auto combo, 80% of the window: answered", ok80.status === 200, `status ${ok80.status}`);
  const before = await hitsOf("ctx-a");
  const r = await send("ctxm-auto", Math.round(LIMIT * 1.5));
  const nums = ccNumbers(r.text);
  check(
    "auto combo, 150%: 400 in Claude Code's wording, no request sent",
    r.status === 400 && nums?.limit === LIMIT && (await hitsOf("ctx-a")) === before,
    `status ${r.status} ${r.text.slice(0, 140)}`
  );
}

// ── 4d. overflow after the keepalive stream already started (slow provider) ─
await withMode("overflow-kiro-slow", async () => {
  const m = await post(
    "/v1/messages",
    { model: DIRECT, max_tokens: 100, messages: conversation(200, "anthropic") },
    { stream: true }
  );
  check(
    "slow provider overflow, streaming /v1/messages: in-band error Claude Code compacts on",
    m.status === 200 && /event: error/.test(m.text) && ccPromptTooLong(m.text),
    `status ${m.status} ${m.text.replace(/event: ping\ndata: [^\n]*\n\n/g, "").slice(0, 160)}`
  );
  const rs = await post(
    "/v1/responses",
    { model: DIRECT, input: [{ role: "user", content: "hi" }] },
    { stream: true, format: "openai" }
  );
  const failed = rs.text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6));
      } catch {
        return null;
      }
    })
    .find((d) => d?.type === "response.failed");
  check(
    "slow provider overflow, streaming /v1/responses: response.failed with context_length_exceeded (Codex compacts)",
    rs.status === 200 && failed?.response?.error?.code === "context_length_exceeded",
    `status ${rs.status} ${rs.text.slice(-200)}`
  );
});

// ── 4e. overflow inside a provider's stream (Responses API response.failed) ─
{
  const rnode = await api("/api/provider-nodes", {
    method: "POST",
    body: {
      name: "Ctx Responses",
      prefix: "ctxr",
      type: "openai-compatible",
      apiType: "responses",
      baseUrl: mockUrl + "/v1",
    },
  });
  const rconn = await api("/api/providers", {
    method: "POST",
    body: { provider: rnode.json?.node?.id, name: "ctx-r", apiKey: "ctx-r" },
  });
  check(
    "setup: Responses API provider",
    !!rnode.json?.node?.id && !!rconn.json?.connection?.id,
    `${rnode.status} ${rconn.status}`
  );
  await mock("/__control", { key: "ctx-r", mode: "responses-overflow" });
  const m = await post(
    "/v1/messages",
    { model: "ctxr/gpt-mock", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    { stream: true }
  );
  const errLine = (m.text.match(/event: error\ndata: (.*)/) || [])[1] || "";
  check(
    "provider stream fails with context_length_exceeded, /v1/messages: Anthropic error event, stream ends cleanly",
    m.status === 200 &&
      ccPromptTooLong(errLine) &&
      !/message_stop/.test(m.text.split("event: error")[1] || ""),
    `status ${m.status} ${m.text.slice(-220)}`
  );
  const o = await post(
    "/v1/chat/completions",
    { model: "ctxr/gpt-mock", messages: [{ role: "user", content: "hi" }] },
    { stream: true, format: "openai" }
  );
  check(
    "provider stream fails with context_length_exceeded, /v1/chat/completions: error chunk with the code",
    o.status === 200 && /"code":"context_length_exceeded"/.test(o.text),
    `status ${o.status} ${o.text.slice(-200)}`
  );
  await mock("/__control", { key: "ctx-r", mode: "ok" });
}

// ── 5. a limit that is only a guess is never enforced ───────────────────────
{
  const cleared = await setLimit(null);
  // without the override the model has no catalog entry: the "claude" name guess (200k) is
  // the only limit, and it must not refuse or cut a request
  const before = await hitsOf("ctx-a");
  const r = await send("ctxm-priority", 240000);
  const last = (await stats()).last["ctx-a"];
  check(
    "unknown window (name guess 200k), 240k request: sent uncut, provider decides",
    cleared.status === 200 &&
      r.status === 200 &&
      last?.tail === true &&
      (await hitsOf("ctx-a")) === before + 1,
    `clear ${cleared.status} status ${r.status} tail ${last?.tail} bytes ${last?.bytes}`
  );
}

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
