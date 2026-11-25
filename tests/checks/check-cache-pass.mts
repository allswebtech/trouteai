// The prompt cache, passed on honestly. One conversation is sent ten times, one new turn each,
// in each dialect a client speaks (Claude Messages, OpenAI chat, Responses; streamed and not) to
// each upstream kind: the Claude service with an API key, an OpenAI-compatible service and Kiro.
// The fake upstreams count what they would have cached: the Claude one keeps, per account, the
// prompt up to every cache mark (tools, then system, then messages, with the marks themselves
// left out, as the service compares them), the OpenAI-compatible one keeps the prompt up to
// every message (automatic prefix caching). Each later turn must find the whole earlier prompt
// again, byte for byte, on the same account, and the client must get back exactly the cache
// figures the upstream reported. For Kiro, which reports no cache figures, the conversation id
// and the history must stay the same.
// In-process, fetch is replaced: no server, no network. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-cache-pass.mts
import { POST as messagesPost } from "../../src/app/api/v1/messages/route.ts";
import { POST as chatPost } from "../../src/app/api/v1/chat/completions/route.ts";
import { POST as responsesPost } from "../../src/app/api/v1/responses/route.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createProviderNode } from "../../src/lib/db/providers/nodes.ts";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.ts";
import { appendFileSync } from "node:fs";

const write = (line: string) => process.stdout.write(line + "\n");
for (const k of ["log", "info", "warn", "debug", "error"] as const) console[k] = () => {};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const tok = (chars: number) => Math.ceil(chars / 4);
const withoutMark = (block: Record<string, unknown>) => {
  const { cache_control, ...rest } = block;
  return JSON.stringify(rest);
};

// ---- the fake Claude service: what it would have cached, per account --------------------------
type CacheFigures = { read: number; write: number; uncached: number; lastMark: number; total: number };
const claudeStore = new Map<string, Set<string>>();
function claudeCache(account: string, body: any): CacheFigures {
  const segments: Array<{ text: string; mark: boolean }> = [];
  for (const t of body.tools || []) segments.push({ text: withoutMark(t), mark: !!t.cache_control });
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system;
  for (const b of system || []) {
    // The billing line changes with every request by design; the service does not cache it.
    if (/^x-anthropic-billing-header:/.test(String(b.text || ""))) continue;
    segments.push({ text: withoutMark(b), mark: !!b.cache_control });
  }
  for (const m of body.messages || []) {
    segments.push({ text: `<${m.role}>`, mark: false });
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of content || []) segments.push({ text: withoutMark(b), mark: !!b.cache_control });
  }
  const store = claudeStore.get(account) ?? new Set<string>();
  claudeStore.set(account, store);
  let prompt = "";
  let read = 0;
  let lastMark = 0;
  const marked: string[] = [];
  for (const s of segments) {
    prompt += s.text + "\n";
    if (store.has(prompt)) read = prompt.length;
    if (s.mark) {
      lastMark = prompt.length;
      marked.push(prompt);
    }
  }
  for (const p of marked) store.add(p);
  const r = tok(read);
  const w = Math.max(0, tok(lastMark) - r);
  return { read: r, write: w, uncached: tok(prompt.length) - r - w, lastMark: tok(lastMark), total: tok(prompt.length) };
}

// ---- the fake OpenAI-compatible service: automatic prefix caching, per account -----------------
const openaiStore = new Map<string, Set<string>>();
function openaiCache(account: string, body: any): CacheFigures {
  const store = openaiStore.get(account) ?? new Set<string>();
  openaiStore.set(account, store);
  let prompt = (body.tools || []).map((t: unknown) => JSON.stringify(t)).join("\n") + "\n";
  let read = 0;
  for (const m of body.messages || []) {
    prompt += JSON.stringify(m) + "\n";
    if (store.has(prompt)) read = prompt.length;
    store.add(prompt);
  }
  const r = tok(read);
  return { read: r, write: 0, uncached: tok(prompt.length) - r, lastMark: tok(prompt.length), total: tok(prompt.length) };
}

type Seen = { kind: "claude" | "openai"; account: string; body: any; figures: CacheFigures };
let seen: Seen[] = [];
// CACHE_PASS_DUMP=<file> writes every upstream body, to see what a failing case sent.
const dumpTo = process.env.CACHE_PASS_DUMP || "";
const record = (s: Seen) => {
  if (dumpTo) appendFileSync(dumpTo, JSON.stringify(s) + "\n");
  seen.push(s);
};
const offHost: string[] = [];
const OPENAI_BASE = "https://llm.shop.example/v1";

globalThis.fetch = (async (input: unknown, init: { headers?: any; body?: string } = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init.headers || {});
  const body = JSON.parse(String(init.body || "{}"));
  if (url.startsWith("https://api.anthropic.com/") && /\/v1\/messages(\?|$)/.test(url)) {
    const account = headers.get("x-api-key") || "none";
    const figures = claudeCache(account, body);
    record({ kind: "claude", account, body, figures });
    const usage = {
      input_tokens: figures.uncached,
      cache_creation_input_tokens: figures.write,
      cache_read_input_tokens: figures.read,
      output_tokens: 2,
    };
    const message = {
      id: "msg_fake_1",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    };
    if (!body.stream) {
      return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
    }
    const ev = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const sse =
      ev("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } }) +
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }) +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
      ev("message_stop", {});
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  if (url.startsWith(OPENAI_BASE) && url.includes("/chat/completions")) {
    const account = (headers.get("authorization") || "none").replace(/^Bearer /, "");
    const figures = openaiCache(account, body);
    record({ kind: "openai", account, body, figures });
    const usage = {
      prompt_tokens: figures.total,
      completion_tokens: 2,
      total_tokens: figures.total + 2,
      prompt_tokens_details: { cached_tokens: figures.read },
    };
    if (!body.stream) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-fake1",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage,
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
    const chunk = (o: object) => `data: ${JSON.stringify({ id: "chatcmpl-fake1", object: "chat.completion.chunk", created: 1, model: body.model, ...o })}\n\n`;
    const sse =
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      chunk({ choices: [], usage }) +
      "data: [DONE]\n\n";
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  offHost.push(url);
  return new Response("{}", { status: 404 });
}) as never;

// ---- accounts ---------------------------------------------------------------------------------
const KEY_A = "sk-ant-api03-fake-alpha-0000";
const SHOP_KEY = "sk-shop-fake-0000";
await createProviderConnection({
  provider: "anthropic",
  authType: "apikey",
  name: "alpha",
  apiKey: KEY_A,
  isActive: true,
});
const node: any = await createProviderNode({
  id: "openai-compatible-chat-shop",
  type: "openai-compatible",
  name: "Shop",
  prefix: "shop",
  apiType: "chat",
  baseUrl: OPENAI_BASE,
});
await createProviderConnection({
  provider: node.id,
  authType: "apikey",
  name: "shop",
  apiKey: SHOP_KEY,
  isActive: true,
  providerSpecificData: { prefix: "shop", apiType: "chat", baseUrl: OPENAI_BASE, nodeName: "Shop" },
});

// ---- one conversation in each dialect ---------------------------------------------------------
type Dialect = "messages" | "chat" | "responses";
const SYSTEM = "You are a coding agent. Work in the repository the user names.";
const userText = (c: string, n: number) => `${c}: step ${n}, change the file src/part${n}.ts`;
const answerText = (n: number) => `Done with step ${n}.`;
const anthropicTools = [
  { name: "Bash", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
];
const chatTools = anthropicTools.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));
const responsesTools = anthropicTools.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

function build(dialect: Dialect, model: string, conv: string, turns: number, stream: boolean) {
  if (dialect === "messages") {
    const messages: any[] = [];
    for (let n = 1; n <= turns; n++) {
      // Like Claude Code: the cache mark sits on the newest user turn only.
      const mark = n === turns ? { cache_control: { type: "ephemeral" } } : {};
      messages.push({ role: "user", content: [{ type: "text", text: userText(conv, n), ...mark }] });
      if (n < turns) messages.push({ role: "assistant", content: [{ type: "text", text: answerText(n) }] });
    }
    return {
      model,
      max_tokens: 1024,
      stream,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.330.f86; cc_entrypoint=cli;" },
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
      ],
      tools: anthropicTools,
      messages,
      metadata: { user_id: JSON.stringify({ device_id: "c".repeat(64), account_uuid: "", session_id: conv }) },
    };
  }
  if (dialect === "chat") {
    const messages: any[] = [{ role: "system", content: SYSTEM }];
    for (let n = 1; n <= turns; n++) {
      messages.push({ role: "user", content: userText(conv, n) });
      if (n < turns) messages.push({ role: "assistant", content: answerText(n) });
    }
    return { model, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), tools: chatTools, messages };
  }
  const input: any[] = [];
  for (let n = 1; n <= turns; n++) {
    input.push({ role: "user", content: [{ type: "input_text", text: userText(conv, n) }] });
    if (n < turns) input.push({ role: "assistant", content: [{ type: "output_text", text: answerText(n) }] });
  }
  return { model, stream, instructions: SYSTEM, tools: responsesTools, input };
}

const CLAUDE_CODE_UA = "claude-cli/2.1.330 (external, cli)";
async function send(dialect: Dialect, body: any) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: body.stream ? "text/event-stream" : "application/json",
    authorization: "Bearer gateway-client-key",
    "user-agent": dialect === "messages" ? CLAUDE_CODE_UA : "example-client/1.0",
  };
  if (dialect === "messages") headers["anthropic-version"] = "2023-06-01";
  const url = `http://localhost/v1/${dialect === "messages" ? "messages" : dialect === "chat" ? "chat/completions" : "responses"}`;
  const request = new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  const res =
    dialect === "messages"
      ? await messagesPost(request, {})
      : dialect === "chat"
        ? await (chatPost as any)(request)
        : await (responsesPost as any)(request);
  return { status: res.status, text: await res.text() };
}

// The cache figures the client got back, in its own dialect.
function clientFigures(dialect: Dialect, stream: boolean, text: string) {
  const events = stream
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data: {"))
        .map((l) => {
          try {
            return JSON.parse(l.slice(6));
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [JSON.parse(text)];
  let usage: any = {};
  for (const e of events) {
    const u =
      dialect === "messages"
        ? (e.type === "message_start" ? e.message?.usage : e.usage)
        : dialect === "chat"
          ? e.usage
          : (e.type === "response.completed" ? e.response?.usage : e.usage);
    if (u && typeof u === "object") usage = { ...usage, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined && v !== null)) };
  }
  if (dialect === "messages") {
    return { read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens, input: usage.input_tokens };
  }
  if (dialect === "chat") {
    return { read: usage.prompt_tokens_details?.cached_tokens, write: usage.prompt_tokens_details?.cache_creation_tokens, input: undefined };
  }
  return { read: usage.input_tokens_details?.cached_tokens, write: usage.input_tokens_details?.cache_creation_tokens, input: undefined };
}

const UPSTREAMS = [
  { kind: "Claude (API key)", model: "anthropic/claude-opus-5-5" },
  { kind: "OpenAI-compatible", model: "shop/shop-model" },
] as const;
const DIALECTS: Dialect[] = ["messages", "chat", "responses"];

for (const up of UPSTREAMS) {
  for (const dialect of DIALECTS) {
    for (const stream of [false, true]) {
      const label = `${up.kind} / ${dialect}${stream ? " stream" : ""}`;
      const conv = `conv-${up.kind.length}-${dialect}-${stream ? "s" : "n"}`;
      const runs: Array<{ seen: Seen | null; got: any; status: number; detail: string }> = [];
      for (let n = 1; n <= 10; n++) {
        seen = [];
        const { status, text } = await send(dialect, build(dialect, up.model, conv, n, stream));
        let got: any = null;
        try {
          got = status === 200 ? clientFigures(dialect, stream, text) : null;
        } catch {
          got = null;
        }
        runs.push({ seen: seen.length === 1 ? seen[0] : null, got, status, detail: text.slice(0, 160) });
      }
      const bad = runs.findIndex((r) => r.status !== 200 || !r.seen || !r.got);
      if (bad >= 0) {
        check(`${label}: ten turns answered, one upstream request each`, false, `turn ${bad + 1}: ${runs[bad].status} ${runs[bad].detail}`);
        continue;
      }
      const accounts = new Set(runs.map((r) => r.seen!.account));
      check(`${label}: every turn on the same account`, accounts.size === 1, [...accounts].join(","));
      const misses: string[] = [];
      for (let i = 1; i < runs.length; i++) {
        const want = runs[i - 1].seen!.figures.lastMark;
        const got = runs[i].seen!.figures.read;
        if (want === 0 || got !== want) misses.push(`turn ${i + 1}: read ${got} of ${want}`);
      }
      check(`${label}: each turn finds the whole earlier prompt again, byte for byte`, misses.length === 0, misses.slice(0, 3).join("; "));
      const wrong: string[] = [];
      runs.forEach((r, i) => {
        const f = r.seen!.figures;
        const g = r.got;
        if (g.read !== f.read && !(f.read === 0 && g.read === undefined)) wrong.push(`turn ${i + 1} read ${g.read} != ${f.read}`);
        // A dialect without a cache-write field may leave it out; when it is there it is exact.
        if (dialect === "messages" || g.write !== undefined) {
          if (g.write !== f.write && !(f.write === 0 && g.write === undefined)) wrong.push(`turn ${i + 1} write ${g.write} != ${f.write}`);
        }
        if (dialect === "messages" && g.input !== f.uncached) wrong.push(`turn ${i + 1} input ${g.input} != ${f.uncached}`);
      });
      check(`${label}: the client gets back exactly the upstream's cache figures`, wrong.length === 0, wrong.slice(0, 3).join("; "));
      if (up.kind.startsWith("Claude") && dialect === "messages") {
        // Every mark the client sent arrives where it put it.
        const last = runs[runs.length - 1].seen!.body;
        const lastMsg = last.messages[last.messages.length - 1];
        const ok =
          !!last.system?.some((b: any) => b.text === SYSTEM && b.cache_control) &&
          Array.isArray(lastMsg?.content) &&
          !!lastMsg.content[lastMsg.content.length - 1]?.cache_control;
        check(`${label}: the client's cache marks reach the service`, ok, JSON.stringify(last.system).slice(0, 160));
      }
    }
  }
}

// ---- Kiro: no cache figures, but one conversation id for one conversation ---------------------
{
  initTranslators();
  for (const dialect of DIALECTS) {
    const source = dialect === "messages" ? "claude" : dialect === "chat" ? "openai" : "openai-responses";
    const ids = new Set<string>();
    const historyMisses: string[] = [];
    let previous: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const body = build(dialect, "claude-sonnet-5", "kiro-conv", n, true);
      const p: any = await translateRequest(source, "kiro", "claude-sonnet-5", body, true, { providerSpecificData: {} }, "kiro");
      ids.add(String(p?.conversationState?.conversationId));
      const history = (p?.conversationState?.history || []).map((h: unknown) => JSON.stringify(h));
      for (let i = 0; i < previous.length; i++) {
        if (history[i] !== previous[i]) {
          historyMisses.push(`turn ${n}: history[${i}] changed`);
          break;
        }
      }
      previous = history;
    }
    check(`Kiro / ${dialect}: one conversation id for all ten turns`, ids.size === 1, [...ids].join(","));
    check(`Kiro / ${dialect}: the earlier history arrives unchanged every turn`, historyMisses.length === 0, historyMisses.slice(0, 3).join("; "));
  }
  const other = await translateRequest("claude", "kiro", "claude-sonnet-5", build("messages", "claude-sonnet-5", "kiro-other", 3, true), true, { providerSpecificData: {} }, "kiro");
  const first = await translateRequest("claude", "kiro", "claude-sonnet-5", build("messages", "claude-sonnet-5", "kiro-conv", 3, true), true, { providerSpecificData: {} }, "kiro");
  check(
    "Kiro: another conversation gets another conversation id",
    (other as any).conversationState.conversationId !== (first as any).conversationState.conversationId
  );
}

check("nothing was sent anywhere but the fake services", offHost.length === 0, offHost.join(","));
write(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
