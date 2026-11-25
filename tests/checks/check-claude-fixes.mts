// The Claude path's request, thinking, stream, version, model, limit and sign-in fixes, one
// case each. No network: functions are called directly, and where a request is sent, fetch is
// replaced and the request TRouteAI would send is read back. Every id, key and text is made up.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-claude-fixes.mts
import {
  FORWARDABLE_CLIENT_BETAS,
  mergeClientAnthropicBeta,
} from "../../open-sse/config/anthropicHeaders.ts";
import { modelSupportsContext1mBeta } from "../../open-sse/services/claudeCodeCompatible.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import {
  createConnectionFromAuthFile,
  enrichWithBootstrap,
  parseAndValidateClaudeAuth,
} from "../../src/lib/oauth/utils/claudeAuthImport.ts";
import * as usageCooldown from "../../open-sse/services/claudeUsageCooldown.ts";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { modelHasNativeContext1m } from "../../open-sse/config/claudeCodeCompatibleIdentity.ts";
import * as clientVersion from "../../src/shared/constants/claudeCodeClient.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { initTranslators } from "../../open-sse/translator/index.ts";
import { normalizeClaudeHaikuConstraints } from "../../open-sse/services/claudeHaikuConstraints.ts";
import { normalizeThinkingForModel } from "../../src/shared/constants/modelSpecs.ts";
import { POST as countPost } from "../../src/app/api/v1/messages/count_tokens/route.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createApiKey, updateApiKeyPermissions } from "../../src/lib/db/apiKeys.ts";
import { signRequestBody } from "../../open-sse/services/claudeCodeCCH.ts";
import { obfuscateInBody } from "../../open-sse/services/claudeCodeObfuscation.ts";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.ts";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.ts";

const write = (line: string) => process.stdout.write(line + "\n");
for (const k of ["log", "info", "warn", "debug"] as const) console[k] = () => {};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const tokens = (v: string) => v.split(",").filter(Boolean);

// A Claude subscription request through the executor, fetch replaced; returns what was sent.
type Sent = { headers: Record<string, string>; body: any };
async function sendSubscription(
  body: Record<string, unknown>,
  clientHeaders: Record<string, string> = {},
  model = String(body.model)
): Promise<Sent> {
  let sent: Sent | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { headers?: any; body?: string }) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
    sent = { headers, body: JSON.parse(String(init.body || "{}")) };
    return new Response(
      JSON.stringify({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } }
    );
  }) as never;
  try {
    const executor = await getExecutor("claude");
    await executor.execute({
      model,
      body,
      stream: false,
      credentials: { accessToken: "sk-ant-oat01-fake-0000", providerSpecificData: {} },
      clientHeaders: {
        "x-app": "cli",
        "user-agent": "claude-cli/2.1.330 (external, cli)",
        ...clientHeaders,
      },
      log: null,
    } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent as unknown as Sent;
}

// ---- 1. client betas ---------------------------------------------------------------------------
{
  const client = [
    "claude-code-20250219",
    "per-turn-control-2026-07-01",
    "mid-conversation-tool-changes-2026-07-01",
    "thinking-token-count-2026-05-13",
    "thinking-display-updates-2026-08-18",
    "server-side-fallback-2026-07-01",
    "context-1m-2025-08-07",
    "skills-2025-10-02",
    "made-up-beta-2030-01-01",
  ].join(",");
  const merged = tokens(mergeClientAnthropicBeta("oauth-2025-04-20", client));
  check(
    "betas: the client's per-turn, tool-change, thinking and fallback betas are forwarded",
    [
      "per-turn-control-2026-07-01",
      "mid-conversation-tool-changes-2026-07-01",
      "thinking-token-count-2026-05-13",
      "thinking-display-updates-2026-08-18",
      "server-side-fallback-2026-07-01",
    ].every((b) => merged.includes(b)),
    merged.join(",")
  );
  check(
    "betas: a beta that is not on the list is not forwarded",
    !merged.includes("made-up-beta-2030-01-01")
  );
  check(
    "betas: nothing is added that the client did not send",
    tokens(mergeClientAnthropicBeta("oauth-2025-04-20", "")).length === 1
  );
  const forHaiku = tokens(
    mergeClientAnthropicBeta("", client, undefined, { model: "claude-haiku-5-5" })
  );
  const forSonnet = tokens(
    mergeClientAnthropicBeta("", client, undefined, { model: "claude-sonnet-4-6" })
  );
  check(
    "betas: context-1m follows the model that answers (kept for Sonnet 4.6, dropped for Haiku 5.5)",
    forSonnet.includes("context-1m-2025-08-07") && !forHaiku.includes("context-1m-2025-08-07")
  );
  check(
    "betas: context-1m is not sent to models whose 1M window is native, nor read as an older model",
    !modelSupportsContext1mBeta("claude-opus-5-5") &&
      !modelSupportsContext1mBeta("claude-fable-5-2") &&
      modelSupportsContext1mBeta("claude-fable-5") &&
      modelSupportsContext1mBeta("claude-sonnet-4-6-20260101") &&
      modelSupportsContext1mBeta("claude/claude-sonnet-5-5")
  );
  const noExec = tokens(mergeClientAnthropicBeta("", client, undefined, { body: { tools: [] } }));
  const withExec = tokens(
    mergeClientAnthropicBeta("", client, undefined, {
      body: { tools: [{ type: "code_execution_20260521", name: "code_execution" }] },
    })
  );
  check(
    "betas: skills only with a code-execution tool",
    !noExec.includes("skills-2025-10-02") && withExec.includes("skills-2025-10-02")
  );
  check(
    "betas: the allowlist has no duplicates",
    new Set(FORWARDABLE_CLIENT_BETAS).size === FORWARDABLE_CLIENT_BETAS.length
  );

  const sent = await sendSubscription(
    {
      model: "claude-haiku-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    },
    { "anthropic-beta": "context-1m-2025-08-07,per-turn-control-2026-07-01" }
  );
  const up = tokens(sent.headers["anthropic-beta"] || "");
  check(
    "betas: subscription request to Haiku 5.5 forwards per-turn-control and drops context-1m",
    up.includes("per-turn-control-2026-07-01") && !up.includes("context-1m-2025-08-07"),
    up.join(",")
  );
}

// ---- 1. thinking.display "updates" --------------------------------------------------------------
{
  const body = (display: string) => ({
    model: "claude-opus-5-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive", display },
  });
  const withBeta = await sendSubscription(body("updates"), {
    "anthropic-beta": "thinking-display-updates-2026-08-18",
  });
  const withoutBeta = await sendSubscription(body("updates"));
  check(
    'display "updates" stays when the client sent its beta, and the beta travels',
    withBeta.body.thinking?.display === "updates" &&
      tokens(withBeta.headers["anthropic-beta"] || "").includes(
        "thinking-display-updates-2026-08-18"
      ),
    JSON.stringify(withBeta.body.thinking)
  );
  check(
    'display "updates" without its beta still becomes "summarized"',
    withoutBeta.body.thinking?.display === "summarized"
  );
}

// ---- 1. OpenAI client -> Claude: stop and tool_result markers ----------------------------------
{
  const base = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
  const nullStop = openaiToClaudeRequest(
    "claude-sonnet-5-5",
    { ...base, stop: null },
    false
  ) as any;
  const listStop = openaiToClaudeRequest(
    "claude-sonnet-5-5",
    { ...base, stop: ["END", null, ""] },
    false
  ) as any;
  check(
    "stop: null sends no stop_sequences; null and empty entries are dropped from a list",
    nullStop.stop_sequences === undefined && JSON.stringify(listStop.stop_sequences) === '["END"]',
    JSON.stringify([nullStop.stop_sequences, listStop.stop_sequences])
  );
  const translated = openaiToClaudeRequest(
    "claude-sonnet-5-5",
    {
      max_tokens: 100,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_fake_1", type: "function", function: { name: "Read", arguments: "{}" } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_fake_1",
          content: [{ type: "text", text: "file text", cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    },
    false
  ) as any;
  const results = translated.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((b: any) => b.type === "tool_result");
  const nested = JSON.stringify(results.map((r: any) => r.content)).includes("cache_control");
  check(
    "a cache marker inside tool_result.content moves onto the tool_result block",
    results.length === 1 && !nested && results[0].cache_control?.type === "ephemeral",
    JSON.stringify(results)
  );
}

// ---- 2. thinking is the model's ----------------------------------------------------------------
{
  const signatures = (body: any) =>
    (body.messages || []).flatMap((m: any) =>
      Array.isArray(m.content)
        ? m.content
            .filter((b: any) => b.type === "thinking" || b.type === "redacted_thinking")
            .map((b: any) => (b.type === "thinking" ? b.signature : b.data))
        : []
    );
  const turn = (n: number, thinking: Record<string, unknown> | null) => [
    {
      role: "assistant",
      content: [
        ...(thinking ? [thinking] : []),
        { type: "tool_use", id: `toolu_fake_${n}`, name: "Read", input: {} },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `toolu_fake_${n}`, content: "x" }],
    },
  ];
  const signed = (n: number) => ({
    type: "thinking",
    thinking: `step ${n}`,
    signature: `ZmFrZS1zaWctdHVybi0${n}`,
  });
  const history = () => ({
    model: "claude-opus-5-5",
    max_tokens: 100,
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: "fix it" },
      ...turn(1, signed(1)),
      ...turn(2, { type: "thinking", thinking: "from another provider", signature: "" }),
      ...turn(3, { type: "redacted_thinking", data: DEFAULT_THINKING_CLAUDE_SIGNATURE }),
      ...turn(4, signed(4)),
    ],
  });
  for (const provider of ["claude", "anthropic-compatible-fake"]) {
    const out = prepareClaudeRequest(history() as any, provider, true, "claude-opus-5-5") as any;
    const sigs = signatures(out);
    check(
      `thinking (${provider}): older signed thinking travels unchanged, never replaced by a fixed blob`,
      JSON.stringify(out.messages[1].content[0]) === JSON.stringify(signed(1)) &&
        !sigs.includes(DEFAULT_THINKING_CLAUDE_SIGNATURE),
      JSON.stringify(sigs.map((x: string) => String(x).slice(0, 20)))
    );
    check(
      `thinking (${provider}): blocks the service never issued are dropped, their tool calls kept`,
      JSON.stringify(sigs) === JSON.stringify([signed(1).signature, signed(4).signature]) &&
        out.messages.filter((m: any) => m.role === "assistant").length === 4
    );
  }
  const manual = {
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    thinking: { type: "enabled", budget_tokens: 1024 },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    messages: [{ role: "user", content: "fix it" }, ...turn(1, null)],
  };
  const manualOut = prepareClaudeRequest(manual as any, "claude", true, "claude-sonnet-4-6") as any;
  check(
    "thinking: manual thinking without the block its last tool call needs is switched off, none invented",
    manualOut.thinking === undefined &&
      manualOut.context_management === undefined &&
      signatures(manualOut).length === 0,
    JSON.stringify({ t: manualOut.thinking, s: signatures(manualOut) })
  );
  const fromOpenAI = openaiToClaudeRequest(
    "claude-opus-5-5",
    {
      max_tokens: 100,
      reasoning_effort: "high",
      messages: [
        { role: "user", content: "fix it" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "no signature here" }],
          reasoning_content: "earlier reasoning",
          tool_calls: [
            { id: "call_fake_1", type: "function", function: { name: "Read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_fake_1", content: "x" },
      ],
      tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }],
    },
    false
  ) as any;
  const prepared = prepareClaudeRequest(fromOpenAI, "claude", false, "claude-opus-5-5") as any;
  check(
    "thinking: an OpenAI client's unsigned thinking never reaches the service with a made-up signature",
    !JSON.stringify(prepared).includes(DEFAULT_THINKING_CLAUDE_SIGNATURE) &&
      signatures(prepared).length === 0,
    JSON.stringify(signatures(prepared)).slice(0, 80)
  );
}

// ---- 1. cch= only in the top-level system; signed-thinking turns not altered -------------------
{
  const billing =
    "x-anthropic-billing-header: cc_version=2.1.330.abc; cc_entrypoint=cli; cch=00000;";
  const body = JSON.stringify({
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: [{ type: "text", text: billing }] }],
    system: [{ type: "text", text: billing }],
  });
  const signed = JSON.parse(await signRequestBody(body));
  check(
    "cch: the billing line in system is signed, the same words in user text are left alone",
    signed.messages[0].content[0].text === billing &&
      /cch=[0-9a-f]{5};$/.test(signed.system[0].text) &&
      signed.system[0].text !== billing,
    signed.system[0].text
  );
  const noSystem = JSON.stringify({ messages: [{ role: "user", content: billing }] });
  check(
    "cch: a body with no billing line in system is sent as it is",
    (await signRequestBody(noSystem)) === noSystem
  );
  const relay = JSON.stringify({
    system: [{ type: "text", text: billing.replace("00000", "1a2b3") }],
    messages: [],
  });
  check(
    "cch: a billing line that already holds a value is signed again",
    !(await signRequestBody(relay)).includes("cch=1a2b3;")
  );

  const turn = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", signature: "ZmFrZS1zaWctdHVybi0x" },
      { type: "text", text: "I will ask opencode about it." },
    ],
  };
  const plain = { role: "user", content: [{ type: "text", text: "use opencode" }] };
  const ob: any = { messages: [structuredClone(plain), structuredClone(turn)] };
  obfuscateInBody(ob);
  check(
    "obfuscation: a turn with signed thinking is sent unchanged, other turns still change",
    JSON.stringify(ob.messages[1]) === JSON.stringify(turn) &&
      ob.messages[0].content[0].text !== plain.content[0].text,
    JSON.stringify(ob.messages[1].content[1])
  );
}

// ---- 5. the count asks the service only through accounts the caller's key may use -------------
{
  // The server's startup sets this secret; a check makes its own throwaway one.
  process.env.API_KEY_SECRET ||= "fake-check-secret-0000000000000000";
  const a = (await createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    name: "count-a",
    apiKey: "sk-ant-api03-fake-count-a",
    isActive: true,
  })) as { id: string };
  const b = (await createProviderConnection({
    provider: "anthropic",
    authType: "apikey",
    name: "count-b",
    apiKey: "sk-ant-api03-fake-count-b",
    isActive: true,
  })) as { id: string };
  const onlyB = (await createApiKey("count-only-b", "fake-machine-0001")) as {
    id: string;
    key: string;
  };
  await updateApiKeyPermissions(onlyB.id, { allowedConnections: [b.id] });
  const used: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { headers?: any }) => {
    used.push(new Headers(init.headers || {}).get("x-api-key") || "");
    return new Response('{"input_tokens":7}', { headers: { "content-type": "application/json" } });
  }) as never;
  const count = async (key: string) => {
    const res = await countPost(
      new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-6",
          messages: [{ role: "user", content: "Say OK" }],
        }),
      })
    );
    return res.status;
  };
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push(await count(onlyB.key));
    check(
      "count: a key limited to one account counts only through that account",
      statuses.every((st) => st === 200) &&
        used.length === 4 &&
        used.every((k) => k === "sk-ant-api03-fake-count-b"),
      `${statuses.join(",")} ${used.join(",")}`
    );
    void a;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- 1. Haiku 5.5 is adaptive-only; the 5.5 models refuse thinking "disabled" -------------------
{
  const adaptive = {
    model: "claude-haiku-5-5",
    max_tokens: 100,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "hi" }],
  };
  const h55 = normalizeClaudeHaikuConstraints(structuredClone(adaptive), "claude-haiku-5-5") as any;
  const h45 = normalizeClaudeHaikuConstraints(
    { ...structuredClone(adaptive), model: "claude-haiku-4-5-20251001" },
    "claude-haiku-4-5-20251001"
  ) as any;
  check(
    "haiku: 5.5 keeps adaptive thinking and its effort; 4.5 still gets a budget",
    h55.thinking?.type === "adaptive" &&
      h55.output_config?.effort === "low" &&
      h45.thinking?.type === "enabled" &&
      h45.output_config === undefined,
    JSON.stringify([h55.thinking, h55.output_config, h45.thinking])
  );
  const sent = await sendSubscription(structuredClone(adaptive));
  check(
    "haiku: a subscription request to Haiku 5.5 keeps its effort",
    sent.body.output_config?.effort === "low" && sent.body.thinking?.budget_tokens === undefined,
    JSON.stringify([sent.body.thinking, sent.body.output_config])
  );
  const disabled = (model: string) =>
    normalizeThinkingForModel({ model, thinking: { type: "disabled" } }, model) as any;
  check(
    'models: thinking "disabled" is removed for Opus 5.5, Sonnet 5.5 and Fable 5.2, kept for Haiku 5.5',
    disabled("claude-opus-5-5").thinking === undefined &&
      disabled("claude-sonnet-5-5").thinking === undefined &&
      disabled("claude-fable-5-2").thinking === undefined &&
      disabled("claude-haiku-5-5").thinking?.type === "disabled"
  );
}

// ---- 3. streams: a cut-off answer ends as an error; held text is released ---------------------
{
  await initTranslators();
  // An OpenAI-format upstream answer turned into Anthropic events for an Anthropic client.
  async function relay(chunks: unknown[]): Promise<string> {
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
    const upstream = new Response(sse).body as ReadableStream<Uint8Array>;
    const out = upstream.pipeThrough(
      createSSEStream({
        targetFormat: "openai",
        sourceFormat: "claude",
        provider: "openai-compatible-fake",
        model: "fake-model",
        body: { messages: [{ role: "user", content: "hi" }] },
      }) as never
    );
    let text = "";
    try {
      text = await new Response(out).text();
    } catch {
      // a stream that errors after its last event still delivered the events before it
    }
    return text;
  }
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "chatcmpl-fake12345",
    object: "chat.completion.chunk",
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const cut = await relay([
    chunk({ role: "assistant", content: "Hello" }),
    chunk({ content: " wor" }),
  ]);
  check(
    "stream: an answer cut off without a finish reason ends with an error event, not end_turn",
    /event: error/.test(cut) && !/"stop_reason":"end_turn"/.test(cut) && /Hello/.test(cut),
    cut.replace(/\n+/g, " ").slice(-240)
  );
  const done = await relay([
    chunk({ role: "assistant", content: "Hello" }),
    chunk({}, "stop"),
    { id: "chatcmpl-fake12345", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
  check(
    "stream: a finished answer still ends with end_turn and no error",
    /"stop_reason":"end_turn"/.test(done) && !/event: error/.test(done),
    done.replace(/\n+/g, " ").slice(-160)
  );
  const held = await relay([
    chunk({ role: "assistant", content: "Before " }),
    chunk({ content: '<invoke name="Read"><parameter name="x">1' }),
    chunk({}, "stop"),
    { id: "chatcmpl-fake12345", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
  check(
    "stream: text held for an unclosed <invoke> block is released at the end",
    held.includes('<invoke name=\\"Read\\"><parameter name=\\"x\\">1'),
    held.replace(/\n+/g, " ").slice(-200)
  );
}

// ---- 1. cache breakpoints (at most four, TTL order) and the trailing assistant prefill ---------
{
  const mark = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
  const body = {
    model: "claude-opus-5-5",
    max_tokens: 100,
    system: [
      { type: "text", text: "a", cache_control: mark() },
      { type: "text", text: "b", cache_control: mark("1h") },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "c", cache_control: mark() }] },
      { role: "assistant", content: [{ type: "text", text: "d", cache_control: mark() }] },
      { role: "user", content: [{ type: "text", text: "e", cache_control: mark() }] },
      { role: "assistant", content: [{ type: "text", text: "f  ", cache_control: mark() }] },
      { role: "user", content: [{ type: "text", text: "g" }] },
    ],
  };
  const sent = await sendSubscription(structuredClone(body));
  const markers: any[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (v.cache_control) markers.push(v.cache_control);
      Object.values(v).forEach(walk);
    }
  };
  walk([sent.body.tools, sent.body.system, sent.body.messages]);
  check(
    "cache: at most four breakpoints reach the service",
    markers.length <= 4,
    String(markers.length)
  );
  const ttls = markers.map((m) => m.ttl ?? "5m");
  const firstShort = ttls.indexOf("5m");
  check(
    "cache: no 1h breakpoint comes after a 5m one",
    firstShort < 0 || !ttls.slice(firstShort).includes("1h"),
    ttls.join(",")
  );
  const prefill = (model: string, text: string) => ({
    model,
    max_tokens: 100,
    messages: [
      { role: "user", content: "write a list" },
      { role: "assistant", content: [{ type: "text", text }] },
    ],
  });
  const newer = await sendSubscription(prefill("claude-opus-5-5", "Here is the list:"));
  const older = await sendSubscription(
    prefill("claude-haiku-4-5-20251001", "Here is the list:  \n")
  );
  check(
    "prefill: a model that refuses prefill gets the request without the trailing assistant turn",
    newer.body.messages.length === 1 && newer.body.messages[0].role === "user",
    JSON.stringify(newer.body.messages.map((m: any) => m.role))
  );
  check(
    "prefill: a model that takes prefill keeps it, with no trailing whitespace",
    older.body.messages.length === 2 &&
      older.body.messages[1].content[0].text === "Here is the list:",
    JSON.stringify(older.body.messages[1])
  );
}

// ---- 4. the client version: the pinned set by default; an override changes the version only --
{
  const v = clientVersion as any;
  const sendOne = async () => {
    const sent = await sendSubscription({
      model: "claude-opus-5-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    return {
      ua: sent.headers["user-agent"],
      billing: String(sent.body.system?.[0]?.text || ""),
      sdk: sent.headers["x-stainless-package-version"],
      runtime: sent.headers["x-stainless-runtime-version"],
    };
  };
  // The four values are one set: the client identity presented on the subscription path.
  check(
    "version: the default identity is the pinned set (2.1.319, build 250, SDK 0.128.0, runtime v26.12.1)",
    v.CLAUDE_CODE_CLIENT_VERSION === "2.1.319" &&
      v.CLAUDE_CODE_CLIENT_BUILD_REVISION === "250" &&
      v.CLAUDE_CODE_SDK_PACKAGE_VERSION === "0.128.0" &&
      v.CLAUDE_CODE_RUNTIME_VERSION === "v26.12.1"
  );
  const pinned = await sendOne();
  check(
    "version: with no override the subscription request presents exactly that set",
    pinned.ua === "claude-cli/2.1.319 (external, cli)" &&
      pinned.billing.includes("cc_version=2.1.319.250;") &&
      pinned.sdk === "0.128.0" &&
      pinned.runtime === "v26.12.1",
    JSON.stringify(pinned)
  );
  if (typeof v.getClaudeCodeClientVersion === "function") {
    process.env.TROUTEAI_CLAUDE_CODE_VERSION = "2.1.400";
    const env = await sendOne();
    process.env.TROUTEAI_CLAUDE_CODE_VERSION = "not-a-version";
    const bad = await sendOne();
    delete process.env.TROUTEAI_CLAUDE_CODE_VERSION;
    v.noteClaudeCodeClientVersionSetting("2.1.500");
    const setting = v.getClaudeCodeClientVersion();
    v.noteClaudeCodeClientVersionSetting("");
    check(
      "version: TROUTEAI_CLAUDE_CODE_VERSION changes the version only; build, SDK and runtime stay",
      env.ua === "claude-cli/2.1.400 (external, cli)" &&
        env.billing.includes("cc_version=2.1.400.250;") &&
        env.sdk === "0.128.0" &&
        env.runtime === "v26.12.1",
      JSON.stringify(env)
    );
    check(
      "version: an invalid override falls back to the pin; the dashboard setting wins over the environment",
      bad.ua === "claude-cli/2.1.319 (external, cli)" && setting === "2.1.500",
      JSON.stringify([bad.ua, setting])
    );
  } else {
    check(
      "version: a setting and an environment variable can override the version",
      false,
      "no override"
    );
  }
}

// ---- 6. models: the current models with their sizes; the native 1M list ----------------------
{
  const current = [
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ];
  for (const provider of ["claude", "anthropic"]) {
    const listed = new Map(getModelsByProviderId(provider).map((m: any) => [m.id, m]));
    const missing = current.filter((id) => {
      const m: any = listed.get(id);
      return !m || m.contextLength !== 1000000 || m.maxOutputTokens !== 128000;
    });
    check(
      `models (${provider}): the current models are listed with 1M context and 128K output`,
      missing.length === 0,
      missing.join(",")
    );
  }
  check(
    "models: Opus 5.5, Fable 5.1/5.2 and Haiku 5.5 have a native 1M window",
    ["claude-opus-5-5", "claude-fable-5-1", "claude-fable-5-2", "claude-haiku-5-5"].every((m) =>
      modelHasNativeContext1m(m)
    ) && !modelHasNativeContext1m("claude-sonnet-4-6")
  );
}

// ---- 7. limits: the usage-poll cooldown honours retry-after and the reset headers -------------
{
  const c = usageCooldown as any;
  const now = 1_800_000_000_000;
  if (typeof c.computeClaudeUsageRetryMs !== "function") {
    check(
      "cooldown: retry-after and reset headers set the usage-poll cooldown",
      false,
      "no reader"
    );
  } else {
    const after = c.computeClaudeUsageRetryMs(new Headers({ "retry-after": "3600" }), now);
    const reset = c.computeClaudeUsageRetryMs(
      new Headers({ "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 1800) }),
      now
    );
    const none = c.computeClaudeUsageRetryMs(new Headers(), now);
    const huge = c.computeClaudeUsageRetryMs(new Headers({ "retry-after": "9999999" }), now);
    check(
      "cooldown: retry-after (1 h) and a reset header (30 min) set the wait; none gives 3 min; 6 h at most",
      after === 3_600_000 && reset === 1_800_000 && none === 180_000 && huge === 6 * 3_600_000,
      JSON.stringify([after, reset, none, huge])
    );
  }
  c._resetClaudeOauthUsageCooldown();
  c.markClaudeOauthUsage429("sk-ant-oat01-fake-cool", now, 60_000);
  check(
    "cooldown: a marked token cools down until the wait is over",
    c.isClaudeOauthUsageCoolingDown("sk-ant-oat01-fake-cool", now + 30_000) &&
      !c.isClaudeOauthUsageCoolingDown("sk-ant-oat01-fake-cool", now + 61_000)
  );
}

// ---- 8. sign-in: setup tokens, the import's bootstrap shape, seat tier and device id ---------
{
  for (const provider of ["claude", "anthropic"]) {
    let headers: Record<string, string> = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init: { headers?: any }) => {
      new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
      return new Response(
        JSON.stringify({
          id: "msg_f",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as never;
    try {
      const executor = await getExecutor(provider);
      await executor.execute({
        model: "claude-sonnet-4-6",
        body: {
          model: "claude-sonnet-4-6",
          max_tokens: 10,
          messages: [{ role: "user", content: "hi" }],
        },
        stream: false,
        credentials: { apiKey: "sk-ant-oat01-fake-setup-token", providerSpecificData: {} },
        log: null,
      } as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    check(
      `setup token (${provider}): a sk-ant-oat token saved as a key goes up as a bearer token, not x-api-key`,
      headers["authorization"] === "Bearer sk-ant-oat01-fake-setup-token" && !headers["x-api-key"],
      JSON.stringify({
        auth: headers["authorization"]?.slice(0, 20),
        key: headers["x-api-key"]?.slice(0, 12),
      })
    );
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        oauth_account: {
          account_uuid: "00000000-0000-4000-8000-0000000000cc",
          account_email: "imported@example.invalid",
          organization_uuid: "00000000-0000-4000-8000-0000000000dd",
          seat_tier: "team_premium",
          user_rate_limit_tier: "fake_tier_5x",
        },
      }),
      { headers: { "content-type": "application/json" } }
    )) as never;
  try {
    const file = {
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-fake-import-1",
        refreshToken: "sk-ant-ort01-fake-import-1",
        expiresAt: Date.now() + 3_600_000,
      },
    };
    const enriched: any = await enrichWithBootstrap(parseAndValidateClaudeAuth(file));
    check(
      "import: the nested bootstrap answer gives the account, the seat tier and the user tier",
      enriched.accountUUID === "00000000-0000-4000-8000-0000000000cc" &&
        enriched.seatTier === "team_premium" &&
        enriched.rateLimitTier === "fake_tier_5x",
      JSON.stringify([enriched.accountUUID, enriched.seatTier, enriched.rateLimitTier])
    );
    const first: any = await createConnectionFromAuthFile(enriched, {});
    const again: any = await createConnectionFromAuthFile(
      { ...enriched, accessToken: "sk-ant-oat01-fake-import-2" },
      { overwriteExisting: true }
    );
    const id1 = first?.connection?.providerSpecificData?.cliUserID;
    const id2 = again?.connection?.providerSpecificData?.cliUserID;
    check(
      "import: an imported account gets one device id, kept when the import is repeated",
      typeof id1 === "string" &&
        /^[a-f0-9]{64}$/.test(id1) &&
        id1 === id2 &&
        first?.connection?.providerSpecificData?.seatTier === "team_premium",
      JSON.stringify([String(id1).slice(0, 8), String(id2).slice(0, 8)])
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

write(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
