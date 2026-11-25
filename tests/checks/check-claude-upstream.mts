// What reaches the Claude service, compared with what the coding client sent.
// Requests shaped like Claude Code's (main turn with tools, thinking, cache markers and betas; a
// tool-result turn; a helper call; a count) go through the gateway in-process to a fake Anthropic
// upstream (fetch is replaced: the `anthropic` and `claude` providers have the service's host
// built in). Once for an API-key account, once for a subscription account. Every difference in
// the headers and in the body (parsed JSON, field by field) is listed and compared with the
// expected list below, so a change to what goes upstream fails here until the list is updated on
// purpose. The fixtures are synthetic: the header set and beta list are the ones Claude Code
// 2.1.330 sends; every id, key, signature and text is made up.
// It also checks that no request carries a thinking signature the service did not issue.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-claude-upstream.mts
import { POST as messagesPost } from "../../src/app/api/v1/messages/route.ts";
import { POST as countPost } from "../../src/app/api/v1/messages/count_tokens/route.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { appendFileSync } from "node:fs";
import { stainlessArch, stainlessOS } from "../../open-sse/executors/claudeIdentity.ts";
import { EXPECTED } from "./claude-upstream-expected.mts";

const write = (line: string) => process.stdout.write(line + "\n");
for (const k of ["log", "info", "warn", "debug", "error"] as const) console[k] = () => {};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---- the fake service -------------------------------------------------------------------------
// Signatures the fake service "issued" on earlier turns; nothing else may travel upstream.
const ISSUED = new Set(["ZmFrZS1zaWctdHVybi0x", "ZmFrZS1zaWctdHVybi0y", "ZmFrZS1yZWRhY3RlZC0x"]);
type Sent = { url: string; headers: Record<string, string>; body: any };
let sent: Sent[] = [];
const offHost: string[] = [];
globalThis.fetch = (async (input: unknown, init: { headers?: any; body?: string } = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://api.anthropic.com/")) offHost.push(url);
  if (!/\/v1\/messages/.test(url)) return new Response("{}", { status: 404 });
  const headers: Record<string, string> = {};
  new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
  const body = JSON.parse(String(init.body || "{}"));
  sent.push({ url, headers, body });
  if (url.includes("/count_tokens")) {
    return new Response('{"input_tokens":42}', { headers: { "content-type": "application/json" } });
  }
  const message = {
    id: "msg_fake_1",
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  if (!body.stream) {
    return new Response(JSON.stringify(message), {
      headers: { "content-type": "application/json" },
    });
  }
  const ev = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const sse =
    ev("message_start", { message: { ...message, content: [], stop_reason: null } }) +
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
    ev("message_stop", {});
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}) as never;

// ---- accounts ---------------------------------------------------------------------------------
const API_KEY = "sk-ant-api03-fake-key-0000";
const OAUTH_TOKEN = "sk-ant-oat01-fake-token-0000";
const DEVICE = "d".repeat(64);
const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
await createProviderConnection({
  provider: "anthropic",
  authType: "apikey",
  name: "api-key",
  apiKey: API_KEY,
  isActive: true,
});
await createProviderConnection({
  provider: "claude",
  authType: "oauth",
  name: "subscription",
  email: "subscriber@example.invalid",
  accessToken: OAUTH_TOKEN,
  refreshToken: "sk-ant-ort01-fake-refresh-0000",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  providerSpecificData: { cliUserID: DEVICE, accountUUID: ACCOUNT },
  isActive: true,
});

// ---- the client's requests --------------------------------------------------------------------
const CLIENT_SESSION = "11111111-1111-4111-8111-111111111111";
const CLIENT_BETAS = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "thinking-token-count-2026-05-13",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
].join(",");
const clientHeaders = (betas = CLIENT_BETAS): Record<string, string> => ({
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "claude-cli/2.1.330 (external, cli)",
  "x-app": "cli",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": betas,
  "anthropic-dangerous-direct-browser-access": "true",
  "x-claude-code-session-id": CLIENT_SESSION,
  // The made-up client runs on this computer, so its architecture and system are the ones the
  // gateway reports for itself: the listed differences then hold on every machine.
  "x-stainless-arch": stainlessArch(),
  "x-stainless-lang": "js",
  "x-stainless-os": stainlessOS(),
  "x-stainless-package-version": "0.128.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.12.1",
  "x-stainless-timeout": "600",
  authorization: "Bearer gateway-client-key",
});
const billing = {
  type: "text",
  text: "x-anthropic-billing-header: cc_version=2.1.330.f86; cc_entrypoint=cli;",
};
const system = [
  billing,
  {
    type: "text",
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: "ephemeral" },
  },
  {
    type: "text",
    text: "You are an interactive agent that helps users with software engineering tasks.",
    cache_control: { type: "ephemeral" },
  },
];
const tools = [
  {
    name: "Bash",
    description: "Executes a given bash command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" }, description: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Reads a file from the local filesystem.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "WebFetch",
    description: "Fetches a URL.",
    input_schema: { type: "object", properties: { url: { type: "string" } } },
    defer_loading: true,
  },
];
const userTurn = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>The project uses TypeScript.</system-reminder>" },
    {
      type: "text",
      text: "Fix the failing test in src/sum.ts",
      cache_control: { type: "ephemeral" },
    },
  ],
};
const metadata = {
  user_id: JSON.stringify({
    device_id: "c".repeat(64),
    account_uuid: "",
    session_id: CLIENT_SESSION,
  }),
};
// Claude Code 2.1.330 sends its context reminders as a system turn inside `messages`.
const systemTurn = {
  role: "system",
  content: [
    {
      type: "text",
      text: "Today's date is in the future. The working folder is a git repository.",
      cache_control: { type: "ephemeral" },
    },
  ],
};
const mainTurn = (model: string) => ({
  model,
  messages: [userTurn, systemTurn],
  system,
  tools,
  metadata,
  max_tokens: 128000,
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  output_config: { effort: "medium" },
  stream: true,
});
const toolCycle = (n: number, sig: string, cache = false) => [
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: `Step ${n}: read the file.`, signature: sig },
      { type: "tool_use", id: `toolu_fake_${n}`, name: "Read", input: { file_path: "src/sum.ts" } },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: `toolu_fake_${n}`,
        content: "export const sum = (a, b) => a - b;",
        is_error: false,
        ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
      },
    ],
  },
];
const toolResultTurn = (model: string) => {
  const t = mainTurn(model);
  const first = { ...userTurn, content: userTurn.content.map(({ cache_control, ...b }) => b) };
  return {
    ...t,
    messages: [
      first,
      systemTurn,
      ...toolCycle(1, "ZmFrZS1zaWctdHVybi0x"),
      ...toolCycle(2, "ZmFrZS1zaWctdHVybi0y", true),
    ],
  };
};
const helperCall = (model: string) => ({
  model,
  max_tokens: 512,
  system: [billing, { type: "text", text: "Summarize this coding conversation in a short title." }],
  messages: [{ role: "user", content: "Fix the failing test in src/sum.ts" }],
  metadata,
  stream: false,
});
const countBody = (model: string) => ({ model, system, tools, messages: [userTurn] });

// ---- the diff ---------------------------------------------------------------------------------
const mask = (s: string) =>
  s
    .replaceAll(API_KEY, "<account key>")
    .replaceAll(OAUTH_TOKEN, "<account token>")
    .replace(/cch=[0-9a-f]{5}/g, "cch=<hash>")
    .replace(/[0-9a-f]{64}/gi, "<hex64>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
const show = (v: unknown) => {
  const s = mask(typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? "undefined"));
  return s.length > 110 ? s.slice(0, 107) + "..." : s;
};
const tokens = (v: string | undefined) =>
  (v || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

function headerDiff(client: Record<string, string>, upstream: Record<string, string>): string[] {
  const out: string[] = [];
  const names = [...new Set([...Object.keys(client), ...Object.keys(upstream)])].sort();
  for (const name of names) {
    const a = client[name];
    const b = upstream[name];
    if (a === b) continue;
    if (name === "anthropic-beta" && a !== undefined && b !== undefined) {
      const added = tokens(b).filter((t) => !tokens(a).includes(t));
      const removed = tokens(a).filter((t) => !tokens(b).includes(t));
      for (const t of added) out.push(`header anthropic-beta +${t}`);
      for (const t of removed) out.push(`header anthropic-beta -${t}`);
      if (!added.length && !removed.length) out.push("header anthropic-beta reordered");
    } else if (a === undefined) out.push(`header + ${name}: ${mask(b)}`);
    else if (b === undefined) out.push(`header - ${name}`);
    else out.push(`header ~ ${name}: ${mask(a)} -> ${mask(b)}`);
  }
  return out;
}

function bodyDiff(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      bodyDiff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])];
    for (const k of keys) {
      bodyDiff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, out);
    }
  } else if (a === undefined) out.push(`body + ${path}: ${show(b)}`);
  else if (b === undefined) out.push(`body - ${path}`);
  else out.push(`body ~ ${path}: ${show(a)} -> ${show(b)}`);
  return out;
}

function signaturesIn(v: unknown, found: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => signaturesIn(x, found));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "thinking" && "signature" in o) found.push(String(o.signature));
    if (o.type === "redacted_thinking") found.push(String(o.data));
    Object.values(o).forEach((x) => signaturesIn(x, found));
  }
  return found;
}

// ---- run ----------------------------------------------------------------------------------------
async function send(kind: "messages" | "count", headers: Record<string, string>, body: object) {
  sent = [];
  const request = new Request(
    `http://localhost/v1/messages${kind === "count" ? "/count_tokens" : ""}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
  );
  const res = kind === "count" ? await countPost(request) : await messagesPost(request, {});
  const text = await res.text();
  return { status: res.status, text, upstream: sent };
}

const ACCOUNTS = [
  { kind: "api-key", prefix: "anthropic/" },
  { kind: "subscription", prefix: "claude/" },
] as const;
const REQUESTS = [
  { name: "main turn", kind: "messages", model: "claude-opus-5-5", build: mainTurn },
  { name: "tool-result turn", kind: "messages", model: "claude-opus-5-5", build: toolResultTurn },
  { name: "helper call", kind: "messages", model: "claude-haiku-5-5", build: helperCall },
  { name: "count", kind: "count", model: "claude-opus-5-5", build: countBody },
] as const;

// CLAUDE_UPSTREAM_PRINT=<file> writes the lists as found, to update the expected file on purpose.
const printTo = process.env.CLAUDE_UPSTREAM_PRINT || "";
for (const account of ACCOUNTS) {
  for (const r of REQUESTS) {
    const label = `${account.kind} / ${r.name}`;
    const headers = clientHeaders();
    const body = r.build(r.model);
    const { status, text, upstream } = await send(r.kind, headers, {
      ...body,
      model: account.prefix + r.model,
    });
    if (status !== 200 || upstream.length !== 1) {
      check(
        `${label}: answered through one upstream request`,
        false,
        `${status} ${upstream.length} ${text.slice(0, 200)}`
      );
      continue;
    }
    const up = upstream[0];
    const { authorization, ...clientRest } = headers;
    const expectedAuth =
      account.kind === "api-key"
        ? { "x-api-key": API_KEY }
        : { authorization: `Bearer ${OAUTH_TOKEN}` };
    const diff = [
      `url ${up.url.replace("https://api.anthropic.com", "")}`,
      ...headerDiff({ ...clientRest, ...expectedAuth }, up.headers),
      ...bodyDiff(body, up.body),
    ];
    const expected = EXPECTED[label] ?? [];
    const unexpected = diff.filter((d) => !expected.includes(d));
    const missing = expected.filter((d) => !diff.includes(d));
    if (printTo) {
      appendFileSync(
        printTo,
        `  "${label}": [\n${diff.map((d) => `    ${JSON.stringify(d)},`).join("\n")}\n  ],\n`
      );
    }
    check(
      `${label}: what reaches the service differs from the client's request exactly as listed`,
      unexpected.length === 0 && missing.length === 0,
      [...unexpected.map((d) => `new: ${d}`), ...missing.map((d) => `gone: ${d}`)].join(" | ")
    );
    const foreign = signaturesIn(up.body).filter((s) => !ISSUED.has(s));
    check(
      `${label}: no thinking signature the service did not issue`,
      foreign.length === 0,
      foreign.map((s) => s.slice(0, 16)).join(",")
    );
  }
}
check("nothing was sent anywhere but the fake service", offHost.length === 0, offHost.join(","));

write(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
