// Check the Kiro request and answer rules that keep Kiro from refusing a request or misreading an
// answer: tool-result batches, tool schemas, tool calls without input, token and cache counts,
// model capacity, regions in host names, the social sign-in poll and the live model list. Fake
// data only; no network. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-kiro-wire.mts
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { resolveKiroModelAlias } from "../../open-sse/translator/request/openai-to-kiro/adaptiveThinking.ts";
import { sanitizeKiroTools } from "../../open-sse/utils/kiroSanitizer.ts";
import {
  KiroExecutor,
  kiroCapacityErrorAsOverload,
  kiroStreamErrorOf,
} from "../../open-sse/executors/kiro.ts";
import { crc32, parseEventFrame } from "../../open-sse/executors/kiro/eventstream.ts";
import { safeAwsRegion } from "../../open-sse/services/kiroRegion.ts";
import { refreshKiroToken } from "../../open-sse/services/tokenRefresh/providers/kiro.ts";
import { classifyKiroSocialPoll } from "../../src/lib/oauth/kiroSocialPoll.ts";
import { fetchKiroAvailableModels } from "../../open-sse/services/kiroModels.ts";
import { KiroService } from "../../src/lib/oauth/services/kiro.ts";
import { getModelContextLimit } from "../../src/lib/modelCapabilities.ts";
import { claudeCharsPerToken } from "../../open-sse/config/claudeTokens.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const enc = new TextEncoder();
// One AWS event-stream frame: prelude (total, headers length, CRC), string headers, payload, CRC.
function frame(eventType: string, payload: unknown, messageType = "event"): Uint8Array {
  const headerBytes: number[] = [];
  const headers: Array<[string, string]> = [
    [":message-type", messageType],
    [":content-type", "application/json"],
  ];
  headers.push(
    messageType === "exception" ? [":exception-type", eventType] : [":event-type", eventType]
  );
  for (const [name, value] of headers) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xff, ...v);
  }
  const body =
    typeof payload === "string" ? enc.encode(payload) : enc.encode(JSON.stringify(payload));
  const total = 12 + headerBytes.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.slice(0, 8)));
  out.set(headerBytes, 12);
  out.set(body, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(out.slice(0, total - 4)));
  return out;
}

function eventStream(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(f);
        c.close();
      },
    })
  );
}

async function sseChunks(frames: Uint8Array[], model = "claude-sonnet-5") {
  const sse = await new KiroExecutor().transformEventStreamToSSE(eventStream(frames), model).text();
  return sse
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
}

const payload = (messages: unknown[], tools: unknown[] = []) =>
  buildKiroPayload("claude-sonnet-5", { messages, tools }, true, {
    providerSpecificData: {},
  }) as any;

const bashTool = {
  type: "function",
  function: { name: "Bash", description: "Run a command", parameters: { type: "object" } },
};
const call = (id: string) => ({
  id,
  type: "function",
  function: { name: "Bash", arguments: '{"command":"ls"}' },
});

// 1. Assistant text between two results of one tool turn keeps the results together.
{
  const p = payload(
    [
      { role: "user", content: "list two folders" },
      { role: "assistant", content: "", tool_calls: [call("t1"), call("t2")] },
      { role: "tool", tool_call_id: "t1", content: "a" },
      { role: "assistant", content: "first one done" },
      { role: "tool", tool_call_id: "t2", content: "b" },
      { role: "user", content: "thanks" },
    ],
    [bashTool]
  );
  const history = p.conversationState.history;
  const resultTurns = history.filter(
    (h: any) => h.userInputMessage?.userInputMessageContext?.toolResults
  );
  const ids = resultTurns.flatMap((h: any) =>
    h.userInputMessage.userInputMessageContext.toolResults.map((r: any) => r.toolUseId)
  );
  check(
    "both results of one tool turn are in one user turn",
    resultTurns.length === 1 && ids.join(",") === "t1,t2",
    `result turns ${resultTurns.length}, ids ${ids.join(",")}`
  );
  const at = history.indexOf(resultTurns[0]);
  check(
    "the text between them follows as its own assistant turn",
    history[at + 1]?.assistantResponseMessage?.content === "first one done",
    JSON.stringify(history[at + 1] || null).slice(0, 80)
  );
  check(
    "the next user text is the current message",
    String(p.conversationState.currentMessage.userInputMessage.content).endsWith("thanks")
  );
  const toolUse = history.find((h: any) => h.assistantResponseMessage?.toolUses);
  check(
    "the tool turn keeps both tool uses",
    toolUse?.assistantResponseMessage.toolUses.length === 2
  );
}

// 1b. A final assistant reply after the results is not held back.
{
  const p = payload(
    [
      { role: "user", content: "list" },
      { role: "assistant", content: "", tool_calls: [call("t1")] },
      { role: "tool", tool_call_id: "t1", content: "a" },
      { role: "assistant", content: "here it is" },
      { role: "user", content: "ok" },
    ],
    [bashTool]
  );
  const texts = p.conversationState.history
    .map((h: any) => h.assistantResponseMessage?.content)
    .filter(Boolean);
  check("a reply after the last result stays in place", texts.includes("here it is"));
}

// 2. A tool use without any result is dropped (Kiro: 400 "Expected toolResult blocks").
{
  const p = payload(
    [
      { role: "user", content: "list" },
      { role: "assistant", content: "two calls", tool_calls: [call("t1"), call("t2")] },
      { role: "tool", tool_call_id: "t1", content: "a" },
      { role: "user", content: "go on" },
    ],
    [bashTool]
  );
  const uses = p.conversationState.history
    .flatMap((h: any) => h.assistantResponseMessage?.toolUses || [])
    .map((u: any) => u.toolUseId);
  check("an unanswered tool use is dropped", uses.join(",") === "t1", uses.join(","));
}

// 3. A long tool description never reaches Kiro, also when no user turn carries the tools.
{
  const long = "x".repeat(12000);
  const p = payload(
    [{ role: "assistant", content: "hello" }],
    [{ type: "function", function: { name: "Big", description: long, parameters: {} } }]
  );
  const json = JSON.stringify(p);
  const spec = p.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0];
  check(
    "a long description is moved out of the tool spec (no user turn)",
    spec.toolSpecification.description.length < 10000,
    `${spec.toolSpecification.description.length} characters`
  );
  check(
    "its text is in the current message",
    p.conversationState.currentMessage.userInputMessage.content.includes(long)
  );
  check("no private field goes upstream", !json.includes("_toolDocs"));
}

// 4. Tool schemas.
{
  const { tools } = sanitizeKiroTools([
    {
      toolSpecification: {
        name: "Edit",
        inputSchema: {
          json: {
            type: "object",
            anyOf: [
              {
                properties: { path: { type: "string" }, text: { type: "string" } },
                required: ["path", "text"],
              },
              {
                properties: { path: { type: "string" }, url: { type: "string" } },
                required: ["path"],
              },
            ],
          },
        },
      },
    },
    {
      toolSpecification: {
        name: "Rule",
        inputSchema: {
          json: {
            type: "object",
            properties: { if: { type: "string" }, then: { type: "string", anyOf: [] } },
            required: ["if", "missing"],
          },
        },
      },
    },
  ]) as any;
  const edit = tools[0].toolSpecification.inputSchema.json;
  check(
    "a root anyOf becomes one object with the branches' properties",
    edit.type === "object" &&
      !("anyOf" in edit) &&
      Object.keys(edit?.properties || {})
        .sort()
        .join(",") === "path,text,url",
    JSON.stringify(edit).slice(0, 120)
  );
  check(
    "anyOf requires only what every branch requires",
    JSON.stringify(edit?.required) === '["path"]',
    JSON.stringify(edit?.required)
  );
  const rule = tools[1].toolSpecification.inputSchema.json;
  check(
    "properties named like keywords are kept",
    Object.keys(rule?.properties || {})
      .sort()
      .join(",") === "if,then",
    Object.keys(rule?.properties || {}).join(",")
  );
  check(
    "keywords inside a property are still stripped",
    !!rule?.properties?.then && !("anyOf" in rule.properties.then)
  );
  check(
    "required names only declared properties",
    JSON.stringify(rule?.required) === '["if"]',
    JSON.stringify(rule?.required)
  );
}

// 5. A tool call without input gets "{}" as its arguments.
{
  const chunks = await sseChunks([
    frame("toolUseEvent", { toolUseId: "c1", name: "ListFiles" }),
    frame("toolUseEvent", { toolUseId: "c1", name: "ListFiles", stop: true }),
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ]);
  const args = chunks
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
    .map((t: any) => t.function?.arguments ?? "")
    .join("");
  check("a call without input has arguments {}", args === "{}", JSON.stringify(args));
  const withInput = await sseChunks([
    frame("toolUseEvent", { toolUseId: "c2", name: "Bash", input: '{"command":"ls"}' }),
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ]);
  const args2 = withInput
    .flatMap((c) => c.choices?.[0]?.delta?.tool_calls || [])
    .map((t: any) => t.function?.arguments ?? "")
    .join("");
  check("a call with input is unchanged", args2 === '{"command":"ls"}', args2);
}

// 5b. A client tool named `tool_call` (the name Kiro gives its own wrapper) passes through as an
// ordinary tool call with its arguments unchanged.
{
  const chunks = await sseChunks([
    frame("toolUseEvent", { toolUseId: "w1", name: "tool_call", input: '{"query":"x"}' }),
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ]);
  const calls = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls || []);
  const args = calls.map((t: any) => t.function?.arguments ?? "").join("");
  check(
    "a tool named tool_call is passed on unchanged",
    calls[0]?.function?.name === "tool_call" &&
      args === '{"query":"x"}' &&
      !chunks.some((c) => c.error),
    args
  );
}

// 6. Token counts. metricsEvent counts come first and the context-usage estimate second, as before;
// the counts in metadataEvent.usage (meaning not yet seen on the real service) are only a fallback
// when neither gave a prompt count, and only then do its cache counts appear.
{
  const metaUsage = {
    inputTokens: 12,
    outputTokens: 3,
    cacheReadInputTokens: 2048,
    cacheWriteInputTokens: 512,
  };
  const finishUsage = (chunks: any[]) => chunks.find((c) => c.choices?.[0]?.finish_reason)?.usage;

  // Both metadataEvent.usage and a context percentage: exactly the estimate.
  const both = finishUsage(
    await sseChunks([
      frame("assistantResponseEvent", { content: "cached reply" }),
      frame("contextUsageEvent", { contextUsagePercentage: 10 }),
      frame("metadataEvent", { stopReason: "END_TURN", usage: metaUsage }),
    ])
  );
  const windowTokens = Number(getModelContextLimit("kiro", "claude-sonnet-5"));
  const wantTotal = Math.floor((10 * windowTokens) / 100);
  const wantOutput = Math.ceil(
    "cached reply".length / Number(claudeCharsPerToken("claude-sonnet-5"))
  );
  check(
    "with a context percentage the estimate is used, not metadataEvent.usage",
    both?.total_tokens === wantTotal &&
      both?.completion_tokens === wantOutput &&
      both?.prompt_tokens === wantTotal - wantOutput &&
      !("cache_read_input_tokens" in (both || {})) &&
      !("cache_creation_input_tokens" in (both || {})),
    `${JSON.stringify(both)} want total ${wantTotal}, output ${wantOutput}`
  );

  // Only metadataEvent.usage: its numbers, with the cache counts.
  const only = finishUsage(
    await sseChunks([
      frame("assistantResponseEvent", { content: "cached reply" }),
      frame("metadataEvent", { stopReason: "END_TURN", usage: metaUsage }),
    ])
  );
  check(
    "without metrics or a context percentage metadataEvent.usage is used",
    only?.prompt_tokens === 12 &&
      only?.completion_tokens === 3 &&
      only?.total_tokens === 15 &&
      only?.cache_read_input_tokens === 2048 &&
      only?.cache_creation_input_tokens === 512,
    JSON.stringify(only)
  );

  // A metricsEvent and metadataEvent.usage: the metricsEvent numbers.
  const metrics = finishUsage(
    await sseChunks([
      frame("assistantResponseEvent", { content: "hi" }),
      frame("metricsEvent", { inputTokens: 7, outputTokens: 2, cacheReadTokens: 5 }),
      frame("metadataEvent", { stopReason: "END_TURN", usage: metaUsage }),
    ])
  );
  check(
    "metricsEvent counts win over metadataEvent.usage",
    metrics?.prompt_tokens === 7 &&
      metrics?.completion_tokens === 2 &&
      metrics?.total_tokens === 9 &&
      metrics?.cache_read_input_tokens === 5 &&
      !("cache_creation_input_tokens" in (metrics || {})),
    JSON.stringify(metrics)
  );
}

// 7. Reasoning text in both case forms; a signature-only frame shows nothing.
{
  const chunks = await sseChunks([
    frame("reasoningContentEvent", { reasoningText: { Text: "upper" } }),
    frame("reasoningContentEvent", { text: " lower" }),
    frame("reasoningContentEvent", { signature: "sig" }),
    frame("assistantResponseEvent", { content: "answer" }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
  ]);
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content || "").join("");
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
  check("both reasoning text forms are read", reasoning === "upper lower", reasoning);
  check("a signature never becomes text", text === "answer", text);
  const sigOnly = await sseChunks([
    frame("reasoningContentEvent", { signature: "sig" }),
    frame("assistantResponseEvent", { content: "answer" }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
  ]);
  check(
    "a signature-only frame before any reasoning is swallowed",
    sigOnly.every((c) => !c.choices?.[0]?.delta?.reasoning_signature) &&
      sigOnly.map((c) => c.choices?.[0]?.delta?.content || "").join("") === "answer"
  );
}

// 8. Model capacity is an overload (529), not a rate limit (429).
{
  const e = kiroStreamErrorOf("ThrottlingException", "busy", "INSUFFICIENT_MODEL_CAPACITY");
  check(
    "in-stream capacity exception becomes 529",
    e.status === 529 && e.type === "overloaded_error"
  );
  check(
    "a plain throttling exception stays 429",
    kiroStreamErrorOf("ThrottlingException", "slow down").status === 429
  );
  const http = await kiroCapacityErrorAsOverload(
    new Response(
      JSON.stringify({ message: "high traffic", reason: "INSUFFICIENT_MODEL_CAPACITY" }),
      { status: 429 }
    )
  );
  check("HTTP capacity 429 becomes 529", http.status === 529, String(http.status));
  const plain = await kiroCapacityErrorAsOverload(
    new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 })
  );
  check("a plain HTTP 429 stays 429", plain.status === 429);
  const before = await sseChunks([
    frame(
      "ThrottlingException",
      { message: "busy", reason: "INSUFFICIENT_MODEL_CAPACITY" },
      "exception"
    ),
  ]);
  const err = before.find((c) => c.error)?.error;
  check("capacity mid-stream is an error with 529", err?.status === 529, JSON.stringify(err));
}

// 9. A failed frame parse logs no part of the payload.
{
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    parseEventFrame(frame("assistantResponseEvent", "{secret-answer-text"));
  } finally {
    console.warn = realWarn;
  }
  check(
    "a parse failure is logged without the payload",
    warnings.length === 1 && !warnings[0].includes("secret"),
    warnings.join(" | ")
  );
}

// 10. Regions in host names.
{
  check("a real region passes", safeAwsRegion(" EU-Central-1 ") === "eu-central-1");
  check("a host trick falls back", safeAwsRegion("evil.example.com#") === "us-east-1");
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ accessToken: "fake-at", expiresIn: 3600 }), {
      status: 200,
    });
  }) as never;
  try {
    await refreshKiroToken(
      "fake-refresh",
      { clientId: "fake-client", clientSecret: "fake-secret", region: "attacker.example/x?" },
      { warn() {}, info() {}, error() {}, debug() {} }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    "the refresh never builds a host from a bad region",
    urls.length > 0 && urls.every((u) => new URL(u).hostname === "oidc.us-east-1.amazonaws.com"),
    urls.join(" ")
  );
}

// 11. The social sign-in poll reads the progress from `status` too.
{
  const pending = classifyKiroSocialPoll(true, 200, { status: "authorization_pending" });
  check(
    "status authorization_pending is pending",
    pending.kind === "pending",
    JSON.stringify(pending)
  );
  const slow = classifyKiroSocialPoll(false, 400, { status: "slow_down" });
  check("status slow_down is pending", slow.kind === "pending" && slow.error === "slow_down");
  check(
    "a token answer is still success",
    classifyKiroSocialPoll(true, 200, { accessToken: "fake-at" }).kind === "success"
  );
}

// 12. The live model list: only Kiro's own sizes, prompt caching and output limit kept.
{
  const result = await fetchKiroAvailableModels({
    accessToken: "fake-token-models",
    providerSpecificData: { authMethod: "builder-id" },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          models: [
            { modelId: "claude-sonnet-5", modelName: "Sonnet 5" },
            {
              modelId: "claude-opus-5.5",
              tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 },
              promptCaching: {
                supportsPromptCaching: true,
                minimumTokensPerCacheCheckpoint: 1024,
                maximumCacheCheckpointsPerRequest: 4,
              },
            },
          ],
        }),
        { status: 200 }
      )) as never,
  } as never);
  const sonnet = result.models.find((m) => m.id === "claude-sonnet-5");
  const opus = result.models.find((m) => m.id === "claude-opus-5.5");
  check(
    "no 200k is stamped on a model without sizes",
    sonnet && sonnet.contextLength === undefined,
    JSON.stringify(sonnet)
  );
  check(
    "Kiro's own sizes and caching facts are kept",
    opus?.contextLength === 1000000 &&
      opus?.outputTokenLimit === 128000 &&
      opus?.promptCaching?.maximumCacheCheckpointsPerRequest === 4,
    JSON.stringify(opus)
  );
  check(
    "GPT-5.6 has Kiro's 1M window",
    getModelContextLimit("kiro", "gpt-5.6-sol") === 1000000,
    String(getModelContextLimit("kiro", "gpt-5.6-sol"))
  );
}

// 12b. A dated Claude id goes to Kiro as its base id.
{
  check(
    "a dated Claude id loses the date",
    resolveKiroModelAlias("claude-haiku-4-5-20251001").upstream === "claude-haiku-4.5",
    resolveKiroModelAlias("claude-haiku-4-5-20251001").upstream
  );
  check(
    "a non-Claude id keeps its digits",
    resolveKiroModelAlias("model-12345678").upstream === "model-12345678"
  );
}

// 13. API-key import with region "auto" finds the region whose model list takes the key.
{
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = new URL(String(url));
    asked.push(`${u.hostname}${u.pathname}`);
    if (u.pathname.endsWith("/ListAvailableModels")) {
      return new Response("{}", { status: u.hostname.includes("eu-central-1") ? 200 : 403 });
    }
    return new Response(
      JSON.stringify({
        __type: "AccessDeniedException",
        message: "API key authentication is not supported for this operation",
      }),
      { status: 400 }
    );
  }) as never;
  let region = "";
  let named = "";
  let rejected = "";
  try {
    region = (await new KiroService().validateApiKey("fake-kiro-api-key", "auto")).region;
    named = (await new KiroService().validateApiKey("fake-kiro-api-key", "us-east-1")).region;
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as never;
    await new KiroService().validateApiKey("fake-kiro-api-key", "auto").catch((e) => {
      rejected = String(e?.message || e);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  check(
    "auto finds the region that takes the key",
    region === "eu-central-1",
    `${region}; ${asked.join(" ")}`
  );
  check("a named region is used as given", named === "us-east-1", named);
  check("a key no region takes is refused", rejected.startsWith("Invalid Kiro API key"), rejected);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
