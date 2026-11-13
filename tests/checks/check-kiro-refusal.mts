// Kiro refusals, "thinking off", stop sequences, max_tokens and the Claude-format answer details
// (no network: fetch is replaced by canned Kiro answers).
// Background, seen live 2026-11-10: Claude Opus 5.5 / Sonnet 5.5 on Kiro refuse some ordinary
// requests (Claude Code's auto-mode safety check) with HTTP 200, no content frames and a
// metadataEvent {"stopReason":"CONTENT_FILTERED","stopDetails":{"refusal":{...}}}. TRouteAI used
// to report that as 502 "Provider returned empty content", cool the account down and retry.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-kiro-refusal.mts
import {
  KiroExecutor,
  kiroFinishReason,
  kiroHelperPromptKey,
  kiroRefusalFallbackModel,
  peekKiroRefusal,
  readKiroStopMetadata,
} from "../../open-sse/executors/kiro.ts";
import { crc32 } from "../../open-sse/executors/kiro/eventstream.ts";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.ts";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { convertFinishReason } from "../../open-sse/utils/finishReason.ts";

const enc = new TextEncoder();
function frame(eventType: string, payload: unknown, headers?: string[][]): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of headers || [
    [":event-type", eventType],
    [":message-type", "event"],
    [":content-type", "application/json"],
  ]) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerBytes.push(n.length, ...n, 7, v.length >> 8, v.length & 0xff, ...v);
  }
  const body = enc.encode(JSON.stringify(payload));
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
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
// A body delivered in pieces of `size` bytes, so frames are split across network chunks.
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(o, o + size));
      o += size;
    },
  });
}

const refusal = (category: string) =>
  concat([
    frame("metadataEvent", {
      stopDetails: {
        refusal: {
          category,
          explanation:
            "The selected model cannot continue this conversation. Please select a different model.",
        },
      },
      stopReason: "CONTENT_FILTERED",
    }),
    frame("contextUsageEvent", { contextUsagePercentage: 4.9 }),
  ]);
const answer = (text: string, stopReason = "END_TURN") =>
  concat([
    frame("reasoningContentEvent", { text: "thinking about it" }),
    frame("assistantResponseEvent", { content: text.slice(0, 5) }),
    frame("assistantResponseEvent", { content: text.slice(5) }),
    frame("metadataEvent", { stopReason }),
    frame("contextUsageEvent", { contextUsagePercentage: 1 }),
    frame("meteringEvent", { unit: "credit", usage: 0.1 }),
  ]);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

type Canned = { status?: number; bytes?: Uint8Array; json?: unknown };
const realFetch = globalThis.fetch;
// Runs one request through KiroExecutor with canned upstream answers (one per fetch, in order).
async function run(model: string, kiroBody: Record<string, unknown>, canned: Canned[]) {
  const sentModels: string[] = [];
  const sentKeys: string[] = [];
  const sentReasoning: boolean[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    const sent = JSON.parse(String(init?.body || "{}"));
    sentModels.push(sent?.conversationState?.currentMessage?.userInputMessage?.modelId || "?");
    sentKeys.push(Object.keys(sent).sort().join(","));
    sentReasoning.push(
      (sent?.conversationState?.history || []).some(
        (h: any) => h?.assistantResponseMessage?.reasoningContent
      )
    );
    const c = canned[Math.min(i++, canned.length - 1)];
    if (c.json) return new Response(JSON.stringify(c.json), { status: c.status || 400 });
    return new Response(chunked(c.bytes as Uint8Array, 37), { status: 200 });
  }) as never;
  const warnings: string[] = [];
  try {
    const result = await new KiroExecutor().execute({
      model,
      body: kiroBody,
      stream: true,
      credentials: {
        accessToken: "t",
        providerSpecificData: {
          profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/X",
          authMethod: "builder-id",
        },
      },
      log: { warn: (_tag: string, msg: string) => warnings.push(msg) },
    } as never);
    const sse = await result.response.text();
    let text = "";
    let reasoning = "";
    let signature = "";
    let answerModel = "";
    let finish = "";
    let stopSequence: string | undefined;
    let usage: Record<string, number> | undefined;
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: {")) continue;
      const j = JSON.parse(line.slice(6));
      const c = j.choices?.[0];
      if (j.model) answerModel = j.model;
      if (c?.delta?.content) text += c.delta.content;
      if (c?.delta?.reasoning_content) reasoning += c.delta.reasoning_content;
      if (c?.delta?.reasoning_signature) signature += c.delta.reasoning_signature;
      if (c?.finish_reason) {
        finish = c.finish_reason;
        stopSequence = c.stop_sequence;
        usage = j.usage;
      }
    }
    const doneCount = sse.split("data: [DONE]").length - 1;
    return {
      status: result.response.status,
      answeringHeader: result.response.headers.get("x-trouteai-answering-model"),
      sse,
      answerModel,
      text,
      reasoning,
      signature,
      finish,
      stopSequence,
      usage,
      sentModels,
      sentKeys,
      sentReasoning,
      warnings,
      done: doneCount === 1,
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}
const kiroBody = (modelId: string, content: string, extra: Record<string, unknown> = {}) => ({
  conversationState: {
    chatTriggerType: "MANUAL",
    conversationId: "c",
    currentMessage: { userInputMessage: { content, modelId, origin: "AI_EDITOR", ...extra } },
    history: [],
  },
});
const tools = { userInputMessageContext: { tools: [{ toolSpecification: { name: "Bash" } }] } };

// 1. Stop metadata and finish reasons
{
  const m = readKiroStopMetadata({
    stopReason: "CONTENT_FILTERED",
    stopDetails: { refusal: { category: "CYBER" } },
  });
  check("refusal metadata is read", !!m && m.refused && m.category === "CYBER");
  check(
    "END_TURN is not a refusal",
    readKiroStopMetadata({ stopReason: "END_TURN" })?.refused === false
  );
  check(
    "metadata without a stop reason is ignored",
    readKiroStopMetadata({ conversationId: "x" }) === null
  );
  check(
    "CONTENT_FILTERED -> content_filter",
    kiroFinishReason("CONTENT_FILTERED") === "content_filter"
  );
  check("MAX_TOKENS -> length", kiroFinishReason("MAX_TOKENS") === "length");
  check(
    "END_TURN / unknown / none -> stop",
    ["END_TURN", "WHATEVER", undefined].every((r) => kiroFinishReason(r) === "stop")
  );
  check(
    "content_filter reaches Claude clients as stop_reason refusal",
    convertFinishReason("content_filter") === "refusal"
  );
  check(
    "an empty content_filter answer is not 'empty content' (no 502, no cooldown)",
    isEmptyContentResponse({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    }) === false
  );
  check(
    "an empty plain stop still is (the old safety net stays)",
    isEmptyContentResponse({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    }) === true
  );
}

// 2. Refusal -> fallback model answers
{
  const r = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: refusal("CYBER") },
    { bytes: answer("<block>no</block>") },
  ]);
  check(
    "Opus 5.5 refusal: Opus 4.8 is asked and answers",
    r.sentModels.join(",") === "claude-opus-5.5,claude-opus-4.8" &&
      r.text === "<block>no</block>" &&
      r.finish === "stop" &&
      r.done,
    `sent ${r.sentModels.join(" -> ")}, text "${r.text}", finish ${r.finish}`
  );
  check(
    "the switch is logged once",
    r.warnings.length === 1 && /refused.*CYBER.*claude-opus-4\.8/.test(r.warnings[0]),
    r.warnings[0] || "no warning"
  );
  const s = await run("claude-sonnet-5.5", kiroBody("claude-sonnet-5.5", "short prompt"), [
    { bytes: refusal("REASONING_EXTRACTION") },
    { bytes: answer("ok then") },
  ]);
  check(
    "Sonnet 5.5 refusal: Sonnet 5 answers",
    s.sentModels.join(",") === "claude-sonnet-5.5,claude-sonnet-5" && s.text === "ok then"
  );
  check(
    "the answer names the model that wrote it (Opus 4.8 / Sonnet 5), as the Messages API does",
    r.answerModel === "claude-opus-4.8" && s.answerModel === "claude-sonnet-5",
    `${r.answerModel} / ${s.answerModel}`
  );
  check(
    "fallback table",
    kiroRefusalFallbackModel("claude-opus-5") === "claude-opus-4.8" &&
      kiroRefusalFallbackModel("claude-haiku-5.5") === "" &&
      kiroRefusalFallbackModel("claude-opus-4.8") === ""
  );
}

// 3. Refusal that stays a refusal
{
  const r = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: refusal("CYBER") },
    {
      status: 402,
      json: { message: "You have reached the limit.", reason: "MONTHLY_REQUEST_COUNT" },
    },
  ]);
  check(
    "fallback cannot be asked (402): the client gets the refusal (from the requested model), not an error, and no third request",
    r.status === 200 &&
      r.finish === "content_filter" &&
      r.text === "" &&
      r.sentModels.length === 2 &&
      r.done &&
      r.answerModel === "claude-opus-5.5",
    `status ${r.status}, finish ${r.finish}, requests ${r.sentModels.length}`
  );
  const h = await run("claude-haiku-5.5", kiroBody("claude-haiku-5.5", "short prompt"), [
    { bytes: refusal("CYBER") },
  ]);
  check(
    "model without a fallback: one request, finish content_filter",
    h.sentModels.length === 1 && h.finish === "content_filter" && h.text === "" && h.done
  );
  const both = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: refusal("CYBER") },
    { bytes: refusal("CYBER") },
  ]);
  check(
    "fallback refuses too: finish content_filter after two requests",
    both.sentModels.length === 2 && both.finish === "content_filter" && both.text === ""
  );
  process.env.TROUTEAI_KIRO_REFUSAL_FALLBACK = "0";
  const off = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: refusal("CYBER") },
    { bytes: answer("no") },
  ]);
  delete process.env.TROUTEAI_KIRO_REFUSAL_FALLBACK;
  check(
    "TROUTEAI_KIRO_REFUSAL_FALLBACK=0: refusal passed on, one request",
    off.sentModels.length === 1 && off.finish === "content_filter"
  );
}

// 4. Normal answers are untouched by the look-ahead
{
  const long = "The quick brown fox. ".repeat(400);
  const r = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: answer(long) },
  ]);
  check(
    "normal answer in 37-byte network pieces: every byte arrives, one request, requested model named",
    r.text === long &&
      r.reasoning === "thinking about it" &&
      r.finish === "stop" &&
      r.sentModels.length === 1 &&
      r.warnings.length === 0 &&
      r.answerModel === "claude-opus-5.5",
    `${r.text.length}/${long.length} chars`
  );
  const cut = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    { bytes: answer("partial text", "MAX_TOKENS") },
  ]);
  check("MAX_TOKENS answer: finish length", cut.finish === "length" && cut.text === "partial text");
  const late = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short prompt"), [
    {
      bytes: concat([
        frame("assistantResponseEvent", { content: "I started, " }),
        refusal("CYBER"),
      ]),
    },
  ]);
  check(
    "refusal after some text: text kept, finish content_filter, no second request",
    late.text === "I started, " && late.finish === "content_filter" && late.sentModels.length === 1
  );
  const peeked = await peekKiroRefusal(new Response(chunked(answer("hello world"), 5)));
  const bytes = new Uint8Array(await peeked.response.arrayBuffer());
  check(
    "look-ahead replays the stream byte for byte",
    !peeked.refused &&
      bytes.length === answer("hello world").length &&
      bytes.every((b, i) => b === answer("hello world")[i])
  );
}

// 5. A refused helper prompt goes to the fallback directly next time
{
  const helper = "You are a security monitor for autonomous AI coding agents. ".repeat(100); // > 4 KB, fixed
  const first = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", `${helper}\naction one`), [
    { bytes: refusal("REASONING_EXTRACTION") },
    { bytes: answer("<block>no</block>") },
  ]);
  const second = await run(
    "claude-opus-5.5",
    kiroBody("claude-opus-5.5", `${helper}\naction two`),
    [{ bytes: answer("<block>yes</block>") }]
  );
  check(
    "first refused helper call: two requests",
    first.sentModels.join(",") === "claude-opus-5.5,claude-opus-4.8" &&
      first.text === "<block>no</block>"
  );
  check(
    "next call of the same helper: one request, straight to Opus 4.8, and named so",
    second.sentModels.join(",") === "claude-opus-4.8" &&
      second.text === "<block>yes</block>" &&
      second.answerModel === "claude-opus-4.8",
    `sent ${second.sentModels.join(" -> ")}`
  );
  check(
    "the helper key ignores the per-request time line",
    kiroHelperPromptKey(
      kiroBody(
        "claude-opus-5.5",
        `[Context: Current time is 2026-11-10T06:51:18.692Z]\n\n${helper}`
      )
    ) ===
      kiroHelperPromptKey(
        kiroBody(
          "claude-opus-5.5",
          `[Context: Current time is 2026-11-10T07:00:00.001Z]\n\n${helper}`
        )
      ) &&
      kiroHelperPromptKey(kiroBody("claude-opus-5.5", helper)) ===
        kiroHelperPromptKey(
          kiroBody(
            "claude-opus-5.5",
            `[Context: Current time is 2026-11-10T07:00:00.001Z]\n\n${helper}`
          )
        )
  );
  const chat = await run(
    "claude-opus-5.5",
    kiroBody("claude-opus-5.5", `${helper}\nwith tools`, tools),
    [{ bytes: answer("hi") }]
  );
  check(
    "same text but a request with tools (a normal conversation) still uses Opus 5.5",
    chat.sentModels.join(",") === "claude-opus-5.5"
  );
  check(
    "requests with tools or history, or short ones, have no helper key",
    kiroHelperPromptKey(kiroBody("claude-opus-5.5", helper, tools)) === "" &&
      kiroHelperPromptKey(kiroBody("claude-opus-5.5", "short")) === "" &&
      kiroHelperPromptKey({
        conversationState: {
          currentMessage: { userInputMessage: { content: helper, modelId: "m" } },
          history: [{}],
        },
      }) === "" &&
      kiroHelperPromptKey(kiroBody("claude-opus-5.5", helper)).length === 64
  );
  const other = "Another long fixed helper instruction text for a different job. ".repeat(100);
  await run("claude-opus-5.5", kiroBody("claude-opus-5.5", `${other}\nA`), [
    { bytes: refusal("CYBER") },
    { bytes: answer("x") },
  ]);
  const after = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", `${other}\nB`), [
    { bytes: answer("y") },
  ]);
  check(
    "a CYBER refusal (about the content, not the prompt) is not remembered",
    after.sentModels.join(",") === "claude-opus-5.5"
  );
  const gone = await run(
    "claude-opus-5.5",
    kiroBody("claude-opus-5.5", `${helper}\naction three`),
    [
      { status: 402, json: { message: "You have reached the limit." } },
      { bytes: answer("<block>no</block>") },
    ]
  );
  check(
    "remembered fallback fails: the normal model is asked in the same call",
    gone.sentModels.join(",") === "claude-opus-4.8,claude-opus-5.5" &&
      gone.text === "<block>no</block>",
    `sent ${gone.sentModels.join(" -> ")}`
  );
}

// 6. "Thinking off" from the client
{
  initTranslators();
  const creds = { providerSpecificData: { authMethod: "builder-id" } };
  const claude = (extra: Record<string, unknown>) => ({
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });
  const viaClaude = (model: string, extra: Record<string, unknown>) =>
    translateRequest(
      "claude",
      "kiro",
      model,
      { ...claude(extra), model },
      true,
      creds,
      "kiro"
    ) as Record<string, any>;
  const content = (p: Record<string, any>) =>
    String(p.conversationState.currentMessage.userInputMessage.content);

  const off = viaClaude("claude-opus-5.5", { thinking: { type: "disabled" }, temperature: 0 });
  check(
    "Claude thinking disabled on Opus 5.5: lowest effort, hidden thinking, no thinking directive, no temperature",
    JSON.stringify(off.additionalModelRequestFields) ===
      '{"output_config":{"effort":"low"},"thinking":{"type":"adaptive","display":"omitted"}}' &&
      !content(off).includes("<thinking_mode>") &&
      off.inferenceConfig?.temperature === undefined,
    JSON.stringify(off.additionalModelRequestFields)
  );
  const old = viaClaude("claude-sonnet-4.5", { thinking: { type: "disabled" } });
  check(
    "model without the field (Sonnet 4.5): nothing added",
    old.additionalModelRequestFields === undefined
  );
  const none = viaClaude("claude-opus-5.5", {});
  check(
    "no thinking setting at all: nothing added (as before)",
    none.additionalModelRequestFields === undefined
  );
  const effort = viaClaude("claude-opus-5.5", {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  check(
    "effort high still wins and keeps the directive",
    effort.additionalModelRequestFields?.output_config?.effort === "high" &&
      content(effort).includes("<thinking_mode>enabled")
  );
  const openai = buildKiroPayload(
    "claude-opus-5.5",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" },
    true,
    creds
  ) as Record<string, any>;
  check(
    "OpenAI reasoning_effort none: same low / hidden fields",
    openai.additionalModelRequestFields?.output_config?.effort === "low" &&
      openai.additionalModelRequestFields?.thinking?.display === "omitted"
  );
  const suffix = buildKiroPayload(
    "claude-opus-5.5-high",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" },
    true,
    creds
  ) as Record<string, any>;
  check(
    "a -high model suffix beats 'none'",
    suffix.additionalModelRequestFields?.output_config?.effort === "high"
  );
  const toClaude = translateRequest(
    "claude",
    "claude",
    "claude-opus-5-5",
    { ...claude({ thinking: { type: "disabled" } }), model: "claude-opus-5-5" },
    true,
    null,
    "claude"
  ) as Record<string, any>;
  check(
    "other providers are not sent reasoning_effort none",
    toClaude.reasoning_effort === undefined
  );
}

// 7. stop sequences and max_tokens (Kiro applies neither: the executor does)
{
  const pieces = (parts: string[], tail: Uint8Array[] = []) =>
    concat([
      ...parts.map((p) => frame("assistantResponseEvent", { content: p })),
      frame("metadataEvent", { stopReason: "END_TURN" }),
      frame("contextUsageEvent", { contextUsagePercentage: 2 }),
      ...tail,
    ]);
  const limited = (limits: Record<string, unknown>, content = "short prompt") => ({
    ...kiroBody("claude-sonnet-5", content),
    _clientLimits: limits,
  });

  const a = await run("claude-sonnet-5", limited({ stop: ["</block>"] }), [
    { bytes: pieces(["<block>no", "</block>", " and more text"]) },
  ]);
  check(
    "stop sequence in its own frame: text ends before it, stop_sequence reported",
    a.text === "<block>no" && a.finish === "stop" && a.stopSequence === "</block>" && a.done,
    JSON.stringify({ t: a.text, f: a.finish, q: a.stopSequence })
  );
  check(
    "the limits never leave TRouteAI (only Kiro's own fields are sent)",
    a.sentKeys.every((k) => !k.includes("_clientLimits")),
    a.sentKeys.join(" | ")
  );
  check(
    "usage of a cut answer still has the input tokens",
    (a.usage?.prompt_tokens || 0) > 0,
    JSON.stringify(a.usage)
  );
  const b = await run("claude-sonnet-5", limited({ stop: ["</severity>"] }), [
    { bytes: pieces(["<severity>7</sev", "erity> trailing"]) },
  ]);
  check(
    "stop sequence split across two frames",
    b.text === "<severity>7" && b.stopSequence === "</severity>",
    JSON.stringify(b.text)
  );
  const c = await run("claude-sonnet-5", limited({ stop: ["STOP", "</x>"] }), [
    { bytes: pieces(["one </x> two STOP three"]) },
  ]);
  check(
    "several stop sequences: the earliest wins",
    c.text === "one " && c.stopSequence === "</x>",
    JSON.stringify(c.text)
  );
  const d = await run("claude-sonnet-5", limited({ stop: ["</block>"] }), [
    { bytes: pieces(["a < b and </bl", "ah, nothing"]) },
  ]);
  check(
    "a held-back start that is not a stop sequence is written after all",
    d.text === "a < b and </blah, nothing" && d.finish === "stop" && d.stopSequence === undefined,
    JSON.stringify(d.text)
  );
  const e = await run("claude-sonnet-5", limited({ stop: ["</block>"] }), [
    { bytes: pieces(["ends with </blo"]) },
  ]);
  check(
    "held-back tail at the very end is flushed",
    e.text === "ends with </blo",
    JSON.stringify(e.text)
  );
  const f = await run("claude-sonnet-5", limited({ maxTokens: 5 }), [
    { bytes: pieces(["0123456789", "0123456789", "0123456789"]) },
  ]);
  check(
    "max_tokens 5 on Claude 5.x: 13 characters (2.5 per token), finish length",
    f.text === "0123456789012" && f.finish === "length" && f.done,
    JSON.stringify({ t: f.text, f: f.finish })
  );
  const f2 = await run(
    "deepseek-3.2",
    { ...kiroBody("deepseek-3.2", "short prompt"), _clientLimits: { maxTokens: 5 } },
    [{ bytes: pieces(["0123456789", "0123456789", "0123456789"]) }]
  );
  check(
    "max_tokens 5 on a non-Claude model: still 4 characters per token",
    f2.text === "01234567890123456789" && f2.finish === "length",
    JSON.stringify(f2.text)
  );
  const g = await run("claude-sonnet-5", limited({ maxTokens: 1000 }), [
    { bytes: pieces(["short answer"]) },
  ]);
  check(
    "max_tokens not reached: untouched, finish stop",
    g.text === "short answer" && g.finish === "stop"
  );
  const h = await run("claude-sonnet-5", limited({ stop: ["</block>"], maxTokens: 2 }), [
    { bytes: pieces(["0123456789</block>"]) },
  ]);
  check(
    "max_tokens before the stop sequence: finish length",
    h.text === "01234" && h.finish === "length" && h.stopSequence === undefined,
    JSON.stringify(h.text)
  );
  const tool = concat([
    frame("assistantResponseEvent", { content: "calling" }),
    frame("toolUseEvent", { toolUseId: "t1", name: "Bash", input: '{"command":"ls"}' }),
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
    frame("contextUsageEvent", { contextUsagePercentage: 2 }),
  ]);
  const t = await run("claude-sonnet-5", limited({ stop: ["never"], maxTokens: 64000 }), [
    { bytes: tool },
  ]);
  check(
    "tool call with limits set: finish tool_calls, no stop_sequence",
    t.finish === "tool_calls" && t.stopSequence === undefined && t.text === "calling"
  );
  const thinking = concat([
    frame("reasoningContentEvent", {
      text: "the stop text </block> inside thinking does not count",
    }),
    ...["<block>yes", "</block>"].map((p) => frame("assistantResponseEvent", { content: p })),
    frame("metadataEvent", { stopReason: "END_TURN" }),
  ]);
  const u = await run("claude-sonnet-5", limited({ stop: ["</block>"], maxTokens: 5 }), [
    { bytes: thinking },
  ]);
  check(
    "thinking is not cut and not counted against max_tokens",
    u.reasoning.includes("</block>") && u.text === "<block>yes" && u.stopSequence === "</block>",
    JSON.stringify({ r: u.reasoning.length, t: u.text })
  );

  const openai = buildKiroPayload(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "hi" }], stop: "END", max_tokens: 64 },
    true,
    { providerSpecificData: {} }
  ) as Record<string, any>;
  check(
    "request builder stashes stop + max_tokens",
    JSON.stringify(openai._clientLimits) === '{"stop":["END"],"maxTokens":64}',
    JSON.stringify(openai._clientLimits)
  );
  const none = buildKiroPayload(
    "claude-sonnet-5",
    { messages: [{ role: "user", content: "hi" }] },
    true,
    { providerSpecificData: {} }
  ) as Record<string, any>;
  check(
    "no client limits: nothing stashed (the 32000 default is not a client limit)",
    none._clientLimits === undefined
  );
  const viaClaude = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    {
      model: "claude-sonnet-5",
      max_tokens: 64,
      stop_sequences: ["</severity>"],
      messages: [{ role: "user", content: "hi" }],
    },
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  check(
    "Claude stop_sequences + max_tokens reach the stash",
    JSON.stringify(viaClaude._clientLimits) === '{"stop":["</severity>"],"maxTokens":64}',
    JSON.stringify(viaClaude._clientLimits)
  );
}

// 8. Claude-format answer details
{
  const { toClaudeMessageId } = await import("../../open-sse/utils/finishReason.ts");
  check(
    "message ids start with msg_",
    toClaudeMessageId("chatcmpl-1794294477263") === "msg_1794294477263" &&
      toClaudeMessageId("msg_abc") === "msg_abc" &&
      /^msg_\d+$/.test(toClaudeMessageId(undefined)) &&
      toClaudeMessageId("179429") === "msg_179429"
  );
  const { translateNonStreamingResponse } =
    await import("../../open-sse/handlers/responseTranslator.ts");
  const toClaude = (choice: Record<string, unknown>) =>
    translateNonStreamingResponse(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, ...choice }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
      "openai",
      "claude"
    ) as Record<string, any>;
  const stopped = toClaude({ finish_reason: "stop", stop_sequence: "</block>" });
  check(
    "non-streaming: stop_reason stop_sequence + the sequence",
    stopped.stop_reason === "stop_sequence" &&
      stopped.stop_sequence === "</block>" &&
      stopped.id === "msg_1",
    JSON.stringify({ s: stopped.stop_reason, q: stopped.stop_sequence, id: stopped.id })
  );
  const plain = toClaude({ finish_reason: "stop" });
  check(
    "non-streaming: plain stop is end_turn with stop_sequence null",
    plain.stop_reason === "end_turn" && plain.stop_sequence === null
  );
  check(
    "usage always has both cache counters",
    plain.usage.cache_read_input_tokens === 0 &&
      plain.usage.cache_creation_input_tokens === 0 &&
      plain.usage.input_tokens === 10,
    JSON.stringify(plain.usage)
  );
  check(
    "refusal: stop_reason refusal",
    toClaude({ finish_reason: "content_filter" }).stop_reason === "refusal"
  );

  const { toAnthropicErrorBody, withAnthropicErrorShape } =
    await import("../../src/shared/utils/anthropicErrorShape.ts");
  const e1 = toAnthropicErrorBody(400, {
    error: {
      message: "messages: Expected array",
      type: "invalid_request_error",
      code: "bad_request",
    },
  });
  check(
    "error body gets type error and keeps its fields",
    e1?.status === 400 &&
      e1.body.type === "error" &&
      (e1.body.error as any).type === "invalid_request_error" &&
      (e1.body.error as any).code === "bad_request"
  );
  const e2 = toAnthropicErrorBody(400, {
    error: {
      message: "Unable to determine provider for model 'x'.",
      type: "invalid_request_error",
    },
  });
  check(
    "unknown model becomes 404 not_found_error",
    e2?.status === 404 && (e2.body.error as any).type === "not_found_error"
  );
  const e3 = toAnthropicErrorBody(429, {
    error: { message: "slow down", type: "rate_limit_exceeded", code: "x" },
  });
  const e4 = toAnthropicErrorBody(502, { message: "upstream broke" });
  const e5 = toAnthropicErrorBody(402, { error: "out of credits" });
  check(
    "status decides the type when the type is not Anthropic's",
    (e3?.body.error as any).type === "rate_limit_error" &&
      (e4?.body.error as any).type === "api_error" &&
      (e4?.body.error as any).message === "upstream broke" &&
      (e5?.body.error as any).type === "billing_error"
  );
  const msg = "prompt is too long: 250000 tokens > 200000 maximum";
  const e6 = toAnthropicErrorBody(400, { error: { message: msg, type: "invalid_request_error" } });
  check(
    "the message text is never changed (Claude Code matches on it)",
    (e6?.body.error as any).message === msg
  );
  const ok = new Response('{"id":"msg_1"}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const stream = new Response("event: error\n\n", {
    status: 500,
    headers: { "content-type": "text/event-stream" },
  });
  const shaped = await withAnthropicErrorShape(
    new Response('{"error":{"message":"nope"}}', {
      status: 403,
      headers: { "content-type": "application/json", "x-keep": "1" },
    })
  );
  const shapedBody = await shaped.json();
  check(
    "only JSON errors are rewritten; success and streams pass untouched; headers kept",
    (await withAnthropicErrorShape(ok)) === ok &&
      (await withAnthropicErrorShape(stream)) === stream &&
      shaped.status === 403 &&
      shapedBody.type === "error" &&
      shapedBody.error.type === "permission_error" &&
      shaped.headers.get("x-keep") === "1"
  );
}

// 9. Thinking signatures (Kiro: reasoningContentEvent {signature}; history reasoningContent)
{
  initTranslators();
  const SIG = "TESTSIG" + "x".repeat(700);
  const signed = concat([
    frame("reasoningContentEvent", { text: "plan: read the file, " }),
    frame("reasoningContentEvent", { text: "then edit it" }),
    frame("reasoningContentEvent", { signature: SIG }),
    frame("assistantResponseEvent", { content: "Done." }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
    frame("contextUsageEvent", { contextUsagePercentage: 1 }),
  ]);
  const a = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "hi"), [{ bytes: signed }]);
  check(
    "executor passes Kiro's signature on as reasoning_signature",
    a.signature === SIG &&
      a.reasoning === "plan: read the file, then edit it" &&
      a.text === "Done.",
    JSON.stringify({ s: a.signature.length, r: a.reasoning })
  );
  const omitted = concat([
    frame("reasoningContentEvent", { signature: SIG }),
    frame("assistantResponseEvent", { content: "ok" }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
  ]);
  const b = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "hi"), [{ bytes: omitted }]);
  check(
    "signature without reasoning text (thinking off, display omitted): no thinking for the client",
    b.signature === "" && b.reasoning === "" && b.text === "ok"
  );

  // Streaming OpenAI -> Claude
  const { openaiToClaudeResponse } =
    await import("../../open-sse/translator/response/openai-to-claude.ts");
  const { hasValuableContent } = await import("../../open-sse/utils/streamHelpers.ts");
  const state: Record<string, unknown> = { toolCalls: new Map() };
  const events: Record<string, any>[] = [];
  for (const line of a.sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    for (const e of openaiToClaudeResponse(JSON.parse(line.slice(6)), state) || []) events.push(e);
  }
  for (const e of openaiToClaudeResponse(null, state) || []) events.push(e);
  const kinds = events.map((e) =>
    e.type === "content_block_delta"
      ? e.delta.type
      : e.type === "content_block_start"
        ? `start:${e.content_block.type}`
        : e.type
  );
  const sigEvent = events.find((e) => e.delta?.type === "signature_delta");
  const thinkStart = events.find((e) => e.content_block?.type === "thinking");
  check(
    "Claude stream: thinking_delta, then signature_delta in the same block, then the block stops before text",
    kinds
      .join(",")
      .includes(
        "start:thinking,thinking_delta,thinking_delta,signature_delta,content_block_stop,start:text"
      ) &&
      sigEvent?.index === thinkStart?.index &&
      sigEvent?.delta.signature === SIG,
    kinds.join(",")
  );
  check(
    "the stream filter keeps the signature_delta event",
    hasValuableContent(sigEvent as never, "claude") === true
  );

  // Non-streaming
  const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/sseParser.ts");
  const { translateNonStreamingResponse } =
    await import("../../open-sse/handlers/responseTranslator.ts");
  const openaiJson = parseSSEToOpenAIResponse(a.sse, "claude-sonnet-5") as Record<string, any>;
  check(
    "non-streaming OpenAI answer keeps reasoning_signature",
    openaiJson?.choices?.[0]?.message?.reasoning_signature === SIG
  );
  const claudeJson = translateNonStreamingResponse(openaiJson, "openai", "claude") as Record<
    string,
    any
  >;
  check(
    "non-streaming Claude answer: thinking block with its signature",
    claudeJson.content?.[0]?.type === "thinking" &&
      claudeJson.content[0].signature === SIG &&
      claudeJson.content[1]?.text === "Done.",
    JSON.stringify(claudeJson.content?.map((c: any) => c.type))
  );

  // Request side: Claude history -> Kiro history
  const creds = { providerSpecificData: { authMethod: "builder-id" } };
  const history = (thinking: Record<string, unknown>[]) => ({
    model: "claude-sonnet-5",
    max_tokens: 1000,
    tools: [
      { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
    ],
    messages: [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: [
          ...thinking,
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file text" }],
      },
    ],
  });
  const toKiro = (b: Record<string, unknown>) =>
    translateRequest("claude", "kiro", "claude-sonnet-5", b, true, creds, "kiro") as Record<
      string,
      any
    >;
  const assistantOf = (p: Record<string, any>) =>
    p.conversationState.history.find((h: any) => h.assistantResponseMessage)
      ?.assistantResponseMessage;
  const sent = assistantOf(
    toKiro(history([{ type: "thinking", thinking: "plan: read a", signature: SIG }]))
  );
  check(
    "Claude thinking + signature -> Kiro assistantResponseMessage.reasoningContent.reasoningText",
    sent?.reasoningContent?.reasoningText?.text === "plan: read a" &&
      sent.reasoningContent.reasoningText.signature === SIG &&
      sent.toolUses?.[0]?.toolUseId === "toolu_1",
    JSON.stringify(sent?.reasoningContent)?.slice(0, 80)
  );
  const unsigned = assistantOf(toKiro(history([{ type: "thinking", thinking: "no signature" }])));
  check(
    "thinking without a signature is not sent (Kiro: 400 signature Field required)",
    unsigned && unsigned.reasoningContent === undefined
  );
  const redacted = assistantOf(toKiro(history([{ type: "redacted_thinking", data: "abc" }])));
  check(
    "redacted_thinking goes back as reasoningContent.redactedContent",
    redacted?.reasoningContent?.redactedContent === "abc"
  );
  const viaOpenAI = translateRequest(
    "claude",
    "openai",
    "gpt-x",
    history([{ type: "thinking", thinking: "plan", signature: SIG }]),
    true,
    { _targetFormat: "openai" },
    "openai"
  ) as Record<string, any>;
  check(
    "other OpenAI-format upstreams never get reasoning_signature",
    JSON.stringify(viaOpenAI).includes("reasoning_signature") === false
  );
  const merged = buildKiroPayload(
    "claude-sonnet-5",
    {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "one",
          reasoning_content: "first",
          reasoning_signature: "S1",
        },
        {
          role: "assistant",
          content: "two",
          reasoning_content: "second",
          reasoning_signature: "S2",
        },
        { role: "user", content: "next" },
      ],
    },
    true,
    creds
  ) as Record<string, any>;
  const m = assistantOf(merged);
  check(
    "two assistant turns merged: one reasoningContent, the first",
    m?.reasoningContent?.reasoningText?.signature === "S1" &&
      m.content.includes("one") &&
      m.content.includes("two")
  );

  // A signature Kiro did not issue (for example from another provider of a combo)
  const withReasoning = toKiro(
    history([{ type: "thinking", thinking: "plan", signature: "foreign" }])
  );
  const invalid = {
    status: 400,
    json: {
      message: "messages.1.content.0: Invalid `signature` in `thinking` block",
      reason: "THINKING_SIGNATURE_INVALID",
    },
  };
  const r = await run("claude-sonnet-5", withReasoning, [
    invalid,
    { bytes: answer("Fixed it now") },
  ]);
  check(
    "400 THINKING_SIGNATURE_INVALID: sent once more without the earlier thinking, answer arrives",
    r.status === 200 &&
      r.text === "Fixed it now" &&
      JSON.stringify(r.sentReasoning) === "[true,false]" &&
      r.warnings.some((w) => w.includes("signature")),
    JSON.stringify({ s: r.status, sent: r.sentReasoning })
  );
  const r2 = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "hi"), [
    invalid,
    { bytes: answer("never") },
  ]);
  check(
    "the same 400 without earlier thinking is not retried",
    r2.status === 400 && r2.sentReasoning.length === 1
  );
  const other400 = { status: 400, json: { message: "Improperly formed request.", reason: null } };
  const r3 = await run("claude-sonnet-5", withReasoning, [other400, { bytes: answer("never") }]);
  check(
    "another 400 with earlier thinking is not retried",
    r3.status === 400 && r3.sentReasoning.length === 1
  );
}

// 10. An answer that an EventStream exception stops is explained in the log and sent as an error
{
  const seen: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args.map(String).join(" "));
  };
  try {
    const exception = frame("", { message: "Encountered unexpectedly high load" }, [
      [":exception-type", "InternalServerException"],
      [":message-type", "exception"],
      [":content-type", "application/json"],
    ]);
    const cutShort = concat([
      frame("reasoningContentEvent", { text: "half a thought" }),
      exception,
    ]);
    const a = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "hi"), [
      { bytes: cutShort },
    ]);
    const line = seen.find((l) => l.includes("answer stopped by")) || "";
    check(
      "exception after thinking: one warning with frame counts and the exception, then an error (no finish)",
      line.includes("reasoningContentEvent") &&
        line.includes("exception:InternalServerException") &&
        line.includes("unexpectedly high load") &&
        line.includes("sent to the client as an error") &&
        !a.finish &&
        !a.done &&
        a.sse.includes('"error":{'),
      line.slice(0, 200)
    );
    seen.length = 0;
    await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "hi"), [
      { bytes: answer("normal answer") },
    ]);
    check(
      "a normal answer logs nothing",
      !seen.some((l) => l.includes("ended without a stop reason")),
      seen.join(" | ").slice(0, 200)
    );
  } finally {
    console.warn = realWarn;
  }
}

// 11. A system prompt without earlier turns gets its own first turn (Kiro caches it there)
{
  const creds = { providerSpecificData: {} };
  const shape = (messages: unknown[], tools?: unknown[], model = "claude-sonnet-5") => {
    const p = buildKiroPayload(
      model,
      { messages, ...(tools ? { tools } : {}) },
      true,
      creds
    ) as Record<string, any>;
    return {
      p,
      h: p.conversationState.history.map((x: any) =>
        x.userInputMessage
          ? `U:${x.userInputMessage.content}`
          : `A:${x.assistantResponseMessage.content}`
      ),
      cur: p.conversationState.currentMessage.userInputMessage,
    };
  };
  const a = shape([
    { role: "system", content: "RULES" },
    { role: "user", content: "question" },
  ]);
  check(
    "system + one question: system turn, (empty), question in the current message",
    a.h.length === 2 &&
      a.h[0].includes("RULES") &&
      a.h[1] === "A:(empty)" &&
      a.cur.content.endsWith("question") &&
      !a.cur.content.includes("RULES"),
    JSON.stringify(a.h)
  );
  const b = shape([
    { role: "system", content: "RULES" },
    { role: "user", content: "another question" },
  ]);
  check(
    "the conversationId still follows the question, not the shared system turn (as before)",
    a.p.conversationState.conversationId !== b.p.conversationState.conversationId
  );
  const t = shape(
    [
      { role: "system", content: "RULES" },
      { role: "user", content: "do it" },
    ],
    [
      {
        type: "function",
        function: {
          name: "Bash",
          description: "run",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
  );
  check(
    "tools stay on the current message",
    t.cur.userInputMessageContext?.tools?.length === 1 &&
      !t.p.conversationState.history[0].userInputMessage.userInputMessageContext
  );
  const l = shape([
    { role: "system", content: "RULES" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]);
  check(
    "a conversation with earlier turns: the system prompt is its own turn too (shared cache with call 1)",
    l.h.length === 4 &&
      l.h[0].includes("RULES") &&
      !l.h[0].includes("first") &&
      l.h[1] === "A:(empty)" &&
      l.h[2].includes("first") &&
      l.h[3] === "A:ok",
    JSON.stringify(l.h)
  );
  check(
    "call 1 and call 2 of a session share one conversationId (it follows the first question)",
    a.p.conversationState.conversationId ===
      shape([
        { role: "system", content: "RULES" },
        { role: "user", content: "question" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ]).p.conversationState.conversationId
  );
  process.env.TROUTEAI_KIRO_SPLIT_SYSTEM = "first";
  const old = shape([
    { role: "system", content: "RULES" },
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
  ]);
  delete process.env.TROUTEAI_KIRO_SPLIT_SYSTEM;
  check(
    "TROUTEAI_KIRO_SPLIT_SYSTEM=first: the old rule (system + first message in one turn)",
    old.h.length === 2 && old.h[0].includes("RULES") && old.h[0].includes("first")
  );
  const longTool = [
    {
      type: "function",
      function: {
        name: "Bash",
        description: `Run a command. ${"Detail. ".repeat(1400)}END-OF-BASH-DOC`,
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const lt = shape(
    [
      { role: "system", content: "RULES" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ],
    longTool
  );
  check(
    "a tool description over 10,000 characters: its text in the system turn, not lost in a conversation",
    lt.h[0].includes("# Tool Documentation") &&
      lt.h[0].includes("END-OF-BASH-DOC") &&
      !lt.cur.content.includes("END-OF-BASH-DOC") &&
      /Full documentation in system prompt/.test(
        JSON.stringify(lt.cur.userInputMessageContext?.tools)
      ) &&
      !JSON.stringify(lt.p).includes("_toolDocs")
  );
  const n = shape([{ role: "user", content: "just this" }]);
  check("no system prompt: unchanged", n.h.length === 0 && n.cur.content.endsWith("just this"));

  // The refused-helper memory (section 5) must still work with the split system turn.
  const sys = "You are a reviewer of agent actions; answer with a verdict tag only. ".repeat(80);
  const h1 = shape(
    [
      { role: "system", content: sys },
      { role: "user", content: "action one" },
    ],
    undefined,
    "claude-opus-5.5"
  ).p;
  const h2 = shape(
    [
      { role: "system", content: sys },
      { role: "user", content: "action two" },
    ],
    undefined,
    "claude-opus-5.5"
  ).p;
  const conv = shape(
    [
      { role: "system", content: sys },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ],
    undefined,
    "claude-opus-5.5"
  ).p;
  check(
    "split helper calls get the same helper key; a real conversation gets none",
    kiroHelperPromptKey(h1).length === 64 &&
      kiroHelperPromptKey(h1) === kiroHelperPromptKey(h2) &&
      kiroHelperPromptKey(conv) === ""
  );
  const r1 = await run("claude-opus-5.5", h1, [
    { bytes: refusal("REASONING_EXTRACTION") },
    { bytes: answer("<block>no</block>") },
  ]);
  const r2 = await run("claude-opus-5.5", h2, [{ bytes: answer("<block>yes</block>") }]);
  check(
    "refused split helper: next call goes straight to Opus 4.8",
    r1.sentModels.join(",") === "claude-opus-5.5,claude-opus-4.8" &&
      r2.sentModels.join(",") === "claude-opus-4.8",
    `${r1.sentModels.join(">")} | ${r2.sentModels.join(">")}`
  );
}

// 12. Kiro usage: the window share already includes the answer; Claude's tokenizer
{
  const {
    claudeTokenizerFor,
    claudeTokensFromCl100k,
    claudeCharsPerToken,
    kiroRequestOverheadTokens,
  } = await import("../../open-sse/config/claudeTokens.ts");
  check(
    "tokenizer: Claude 5.x and Opus 4.7/4.8 new, Sonnet 4.5/4.6 old, others none",
    [
      "claude-opus-5.5",
      "kiro/claude-sonnet-5",
      "claude-opus-5-5",
      "claude-haiku-5.5",
      "claude-opus-4.8",
      "claude-opus-4-7",
      "claude-fable-5-2",
    ].every((m) => claudeTokenizerFor(m) === "new") &&
      ["claude-sonnet-4.5", "claude-sonnet-4-6", "claude-haiku-4.5", "claude-opus-4.6"].every(
        (m) => claudeTokenizerFor(m) === "old"
      ) &&
      ["gpt-5.6-sol", "deepseek-3.2", "", "claude"].every((m) => claudeTokenizerFor(m) === null)
  );
  check(
    "factors: 1000 cl100k -> 1610 (new) / 1220 (old) / 1000; 2.5 / 3.3 characters per token",
    claudeTokensFromCl100k("claude-opus-5.5", 1000) === 1610 &&
      claudeTokensFromCl100k("claude-sonnet-4.5", 1000) === 1220 &&
      claudeTokensFromCl100k("gpt-5", 1000) === 1000 &&
      claudeCharsPerToken("claude-sonnet-5") === 2.5 &&
      claudeCharsPerToken("claude-sonnet-4.6") === 3.3 &&
      claudeCharsPerToken("glm-5") === null
  );
  check(
    "Kiro request overhead: 1950 / 6028 (Opus 4.7) / 4150 / 0",
    kiroRequestOverheadTokens("claude-opus-5.5") === 1950 &&
      kiroRequestOverheadTokens("kiro/claude-opus-4.7") === 6028 &&
      kiroRequestOverheadTokens("claude-sonnet-4.5") === 4150 &&
      kiroRequestOverheadTokens("qwen3-coder-next") === 0
  );

  const text = "x".repeat(2500);
  const bytes = concat([
    frame("assistantResponseEvent", { content: text }),
    frame("metadataEvent", { stopReason: "END_TURN" }),
    frame("contextUsageEvent", { contextUsagePercentage: 2 }),
  ]);
  const r = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "hi"), [{ bytes }]);
  const total = 20000; // 2% of the 1M window
  check(
    "usage: total = Kiro's share, output = 2500 chars / 2.5, input = total - output",
    r.usage?.total_tokens === total &&
      r.usage?.completion_tokens === 1000 &&
      r.usage?.prompt_tokens === total - 1000,
    JSON.stringify(r.usage)
  );
}

// 13. A final refusal carries Anthropic's stop_details (category, explanation); others null
{
  const { openaiToClaudeResponse } =
    await import("../../open-sse/translator/response/openai-to-claude.ts");
  const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/sseParser.ts");
  const { translateNonStreamingResponse } =
    await import("../../open-sse/handlers/responseTranslator.ts");
  const claudeEvents = (sse: string) => {
    const state: Record<string, unknown> = { toolCalls: new Map() };
    const out: Record<string, any>[] = [];
    for (const line of sse.split("\n"))
      if (line.startsWith("data: {"))
        out.push(...(openaiToClaudeResponse(JSON.parse(line.slice(6)), state) || []));
    out.push(...(openaiToClaudeResponse(null, state) || []));
    return out;
  };
  const late = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short"), [
    { bytes: concat([frame("assistantResponseEvent", { content: "Partly " }), refusal("CYBER")]) },
  ]);
  const md = claudeEvents(late.sse).find((e) => e.type === "message_delta");
  check(
    "stream: refusal after text -> message_delta stop_reason refusal + stop_details cyber",
    md?.delta?.stop_reason === "refusal" &&
      md.delta.stop_details?.type === "refusal" &&
      md.delta.stop_details.category === "cyber" &&
      /select a different model/.test(md.delta.stop_details.explanation || ""),
    JSON.stringify(md?.delta)
  );
  const json = translateNonStreamingResponse(
    parseSSEToOpenAIResponse(late.sse, "claude-opus-5.5") as never,
    "openai",
    "claude"
  ) as Record<string, any>;
  check(
    "non-stream: stop_reason refusal + stop_details",
    json.stop_reason === "refusal" && json.stop_details?.category === "cyber",
    JSON.stringify({ s: json.stop_reason, d: json.stop_details })
  );
  const ok = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short"), [
    { bytes: answer("fine") },
  ]);
  const md2 = claudeEvents(ok.sse).find((e) => e.type === "message_delta");
  const json2 = translateNonStreamingResponse(
    parseSSEToOpenAIResponse(ok.sse, "claude-opus-5.5") as never,
    "openai",
    "claude"
  ) as Record<string, any>;
  check(
    "normal end: stop_details null (stream and non-stream)",
    md2?.delta?.stop_details === null &&
      json2.stop_details === null &&
      json2.stop_reason === "end_turn"
  );
  const noFallback = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "short"), [
    { bytes: refusal("REASONING_EXTRACTION") },
    { status: 429, json: { message: "limit" } },
  ]);
  const md3 = claudeEvents(noFallback.sse).find((e) => e.type === "message_delta");
  check(
    "refusal stays when the fallback cannot be asked: stop_details reasoning_extraction",
    md3?.delta?.stop_reason === "refusal" &&
      md3.delta.stop_details?.category === "reasoning_extraction",
    JSON.stringify(md3?.delta)
  );
}

// 14. Documents (Kiro has no document input): text documents as text, a PDF gets a note
{
  initTranslators();
  const creds = { providerSpecificData: {} };
  const pdf = {
    type: "document",
    title: "spec.pdf",
    source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK".repeat(500) },
  };
  const viaKiro = (content: unknown[]) =>
    JSON.stringify(
      translateRequest(
        "claude",
        "kiro",
        "claude-sonnet-5",
        { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content }] },
        true,
        creds,
        "kiro"
      )
    );
  const a = viaKiro([pdf, { type: "text", text: "summarize" }]);
  check(
    "broken / scanned PDF: a note that it has no readable text, no base64 in the prompt",
    a.includes("no readable text") && a.includes("spec.pdf") && !a.includes("JVBERi0xLjQK")
  );
  // A real (tiny) PDF: one page, Helvetica, the text "TRouteAI PDF 4721".
  const tiny = (() => {
    const stream = "BT /F1 18 Tf 20 70 Td (TRouteAI PDF 4721) Tj ET";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    objs.forEach((o, i) => {
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    out += `trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n`;
    return Buffer.from(out).toString("base64");
  })();
  const real = viaKiro([
    {
      type: "document",
      title: "tiny.pdf",
      source: { type: "base64", media_type: "application/pdf", data: tiny },
    },
    { type: "text", text: "what number?" },
  ]);
  check(
    "real PDF: its text reaches Kiro in a <document> block, no base64",
    real.includes("TRouteAI PDF 4721") &&
      real.includes("<document_content>") &&
      real.includes("tiny.pdf (PDF, 1 page)") &&
      !real.includes(tiny.slice(0, 40))
  );
  check("short text without images: no 'scanned' note", !real.includes("<note>"));
  const { extractPdfText } = await import("../../open-sse/utils/pdfText.ts");
  const mk = (objs: string[], tail = "") => {
    let out = "%PDF-1.4\n";
    objs.forEach((o, i) => {
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    return Buffer.from(`${out}${tail}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
  };
  const cyc = mk([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [2 0 R 2 0 R 3 0 R 2 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 40 >>\nstream\nBT /F1 12 Tf (Cycle text here ok fine) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 >>",
  ]);
  const c0 = Date.now();
  const cycText = extractPdfText(cyc.toString("base64"));
  check(
    "page tree that points at itself: read once, fast",
    cycText?.pages === 1 && cycText.text === "Cycle text here ok fine" && Date.now() - c0 < 500,
    JSON.stringify(cycText)
  );
  const { deflateSync } = await import("node:zlib");
  const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024), { level: 9 });
  const bombPdf = Buffer.concat([
    mk([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>",
    ]).subarray(0, -"trailer\n<< /Root 1 0 R >>\n%%EOF\n".length),
    Buffer.from(`4 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    bomb,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
  const b0 = Date.now();
  const bombText = extractPdfText(bombPdf.toString("base64"));
  check(
    "Flate bomb (64 MB of zeros): stopped at the inflate limit, no crash",
    bombText?.pages === 1 && bombText.text === "" && Date.now() - b0 < 2000,
    `${Date.now() - b0} ms ${JSON.stringify(bombText)}`
  );
  const imgPdf = mk([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >>",
    "<< /Length 30 >>\nstream\nBT /F1 9 Tf (Page 1) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /Length 1 >>\nstream\nx\nendstream",
  ]);
  const scanned = viaKiro([
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: imgPdf.toString("base64") },
    },
    { type: "text", text: "summarize" },
  ]);
  check(
    "PDF with an image that cannot be converted: its text plus a note naming the page",
    scanned.includes("Page 1") &&
      scanned.includes("<note>Page 1 is an image that could not be attached")
  );
  const b = viaKiro([
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "the secret word is plum" },
    },
    { type: "text", text: "what is it" },
  ]);
  check("text document: its text reaches Kiro", b.includes("the secret word is plum"));
  const tool = JSON.stringify(
    translateRequest(
      "claude",
      "kiro",
      "claude-sonnet-5",
      {
        model: "claude-sonnet-5",
        max_tokens: 100,
        tools: [
          { name: "Read", description: "r", input_schema: { type: "object", properties: {} } },
        ],
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_9", name: "Read", input: { file_path: "a.pdf" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [pdf] }],
          },
        ],
      },
      true,
      creds,
      "kiro"
    )
  );
  check(
    "PDF inside a tool result: text or note instead of the base64 JSON",
    tool.includes("no readable text") && !tool.includes("JVBERi0xLjQK")
  );
  const other = JSON.stringify(
    translateRequest(
      "claude",
      "openai",
      "gpt-x",
      {
        model: "gpt-x",
        max_tokens: 100,
        messages: [{ role: "user", content: [pdf, { type: "text", text: "hi" }] }],
      },
      true,
      { _targetFormat: "openai" },
      "openai"
    )
  );
  check(
    "other OpenAI-format targets unchanged (no note)",
    !other.includes("no readable text") && !other.includes("<document_content>")
  );
}

// 15. The test-only Kiro host override accepts loopback URLs only
{
  const { kiroRuntimeHost } = await import("../../open-sse/services/kiroRegion.ts");
  const saved = process.env.TROUTEAI_KIRO_RUNTIME_URL;
  const hostWith = (v: string | undefined) => {
    if (v === undefined) delete process.env.TROUTEAI_KIRO_RUNTIME_URL;
    else process.env.TROUTEAI_KIRO_RUNTIME_URL = v;
    return kiroRuntimeHost("us-east-1");
  };
  check(
    "TROUTEAI_KIRO_RUNTIME_URL: loopback used, anything else ignored",
    hostWith("http://127.0.0.1:20995") === "http://127.0.0.1:20995" &&
      hostWith("http://localhost:9/x") === "http://localhost:9" &&
      hostWith("https://evil.example.com") === "https://codewhisperer.us-east-1.amazonaws.com" &&
      hostWith("http://127.0.0.1.evil.com") === "https://codewhisperer.us-east-1.amazonaws.com" &&
      hostWith("file:///etc/passwd") === "https://codewhisperer.us-east-1.amazonaws.com" &&
      hostWith(undefined) === "https://codewhisperer.us-east-1.amazonaws.com"
  );
  if (saved === undefined) delete process.env.TROUTEAI_KIRO_RUNTIME_URL;
  else process.env.TROUTEAI_KIRO_RUNTIME_URL = saved;
}

// 16. Structured output for Kiro (an instruction) and the message_start input estimate
{
  initTranslators();
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const claudeBody = {
    model: "claude-sonnet-5",
    max_tokens: 100,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: "title please" }],
  };
  const kiro = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    structuredClone(claudeBody),
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  const content = String(kiro.conversationState.currentMessage.userInputMessage.content);
  check(
    "output_config.format json_schema -> Kiro gets the schema as an instruction at the end",
    content.includes("matches this JSON Schema") &&
      content.includes('"title"') &&
      content.trim().endsWith("}")
  );
  const other = translateRequest(
    "claude",
    "openai",
    "gpt-x",
    structuredClone(claudeBody),
    true,
    { _targetFormat: "openai" },
    "openai"
  ) as Record<string, any>;
  check(
    "other OpenAI-format targets: no response_format added (unchanged)",
    other.response_format === undefined
  );
  const plain = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    { model: "claude-sonnet-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  check(
    "no format: no instruction",
    !String(plain.conversationState.currentMessage.userInputMessage.content).includes("JSON Schema")
  );

  const { estimateRequestInputTokens } = await import("../../open-sse/config/claudeTokens.ts");
  const text = "word ".repeat(2000); // 10,000 characters
  const est = estimateRequestInputTokens(
    {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: text,
            images: [{ format: "png", source: { bytes: "A".repeat(50000) } }],
          },
        },
      },
    },
    "claude-sonnet-5",
    "kiro"
  );
  check(
    "input estimate of a Kiro body: about chars / 2.5 + Kiro's 1950, image bytes not counted",
    est > 1950 + 3900 && est < 1950 + 4400,
    String(est)
  );
  const { openaiToClaudeResponse } =
    await import("../../open-sse/translator/response/openai-to-claude.ts");
  const ev = openaiToClaudeResponse(
    { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { toolCalls: new Map(), estimatedInputTokens: 1234 }
  ) as Record<string, any>[];
  check(
    "message_start carries the input estimate",
    ev[0]?.type === "message_start" && ev[0].message.usage.input_tokens === 1234
  );
}

// 17. Answers that fail inside the stream: an error the client retries, never a cut-off "stop"
{
  const exc = (type: string, message: string) =>
    frame("", { message }, [
      [":exception-type", type],
      [":message-type", "exception"],
      [":content-type", "application/json"],
    ]);
  const errLine = (sse: string) =>
    sse
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)))
      .find((j) => j.error && !j.choices)?.error;
  // a) exception after content (Sonnet 5: no refusal fallback, so this also covers the peek for every model)
  const mid = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    {
      bytes: concat([
        frame("assistantResponseEvent", { content: "Half an ans" }),
        exc(
          "internalServerException",
          "Encountered unexpectedly high load when processing the request, please try again."
        ),
      ]),
    },
  ]);
  const midErr = errLine(mid.sse);
  check(
    "exception after content: text kept, then an error chunk (500 api_error), no finish, no [DONE]",
    mid.status === 200 &&
      mid.text === "Half an ans" &&
      midErr?.status === 500 &&
      midErr?.type === "api_error" &&
      /high load/.test(midErr?.message) &&
      !mid.finish &&
      !mid.sse.includes("[DONE]"),
    JSON.stringify({ midErr, finish: mid.finish })
  );
  const thr = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    {
      bytes: concat([
        frame("assistantResponseEvent", { content: "Hi" }),
        exc("ThrottlingException", "Too many requests"),
      ]),
    },
  ]);
  check(
    "ThrottlingException after content: 429 rate_limit_error",
    errLine(thr.sse)?.status === 429 && errLine(thr.sse)?.type === "rate_limit_error"
  );
  // b) cut off: content, then the stream ends without metadataEvent / contextUsageEvent / meteringEvent
  const cutOff = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "x"), [
    {
      bytes: concat([
        frame("reasoningContentEvent", { text: "think" }),
        frame("assistantResponseEvent", { content: "Partial" }),
      ]),
    },
  ]);
  const cutErr = errLine(cutOff.sse);
  check(
    "answer cut off before Kiro's closing frames: error kiro_stream_incomplete (502), no finish",
    cutOff.status === 200 &&
      cutOff.text === "Partial" &&
      cutErr?.code === "kiro_stream_incomplete" &&
      cutErr?.status === 502 &&
      !cutOff.finish &&
      cutOff.warnings.length === 0,
    JSON.stringify(cutErr)
  );
  // c) a complete answer whose only closing frame is contextUsageEvent still finishes normally
  const ctxOnly = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    {
      bytes: concat([
        frame("assistantResponseEvent", { content: "fine" }),
        frame("contextUsageEvent", { contextUsagePercentage: 1 }),
      ]),
    },
  ]);
  check(
    "closing frame without stopReason: normal finish (stop + [DONE])",
    ctxOnly.finish === "stop" && ctxOnly.done && !errLine(ctxOnly.sse)
  );
  // d) exception after the stop reason (answer complete): ignored, normal finish
  const late = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    {
      bytes: concat([
        frame("assistantResponseEvent", { content: "done" }),
        frame("metadataEvent", { stopReason: "END_TURN" }),
        exc("internalServerException", "late"),
      ]),
    },
  ]);
  check(
    "exception after END_TURN: the complete answer finishes normally",
    late.finish === "stop" && late.done && !errLine(late.sse)
  );
  // e) before any content: a plain HTTP error (Kiro's JSON shape), so another account / combo step can answer
  const pre = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    { bytes: exc("internalServerException", "Encountered unexpectedly high load") },
  ]);
  const preJson = JSON.parse(pre.sse || "{}");
  check(
    "exception before content: HTTP 500 {message, reason}, not a 200 stream",
    pre.status === 500 &&
      /high load/.test(preJson.message) &&
      preJson.reason === "internalServerException" &&
      pre.warnings.some((w) => /failed before answering/.test(w)),
    `${pre.status} ${pre.sse.slice(0, 120)}`
  );
  const preThr = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "x"), [
    { bytes: exc("ThrottlingException", "Rate exceeded") },
  ]);
  check("ThrottlingException before content (Opus 5.5): HTTP 429", preThr.status === 429);
  const empty = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    { bytes: new Uint8Array(0) },
  ]);
  check(
    "stream with no frames at all: HTTP 502 'without an answer'",
    empty.status === 502 && /without an answer/.test(empty.sse)
  );
  // f) a refusal on a model without a fallback still reaches the client as a refusal
  const noFb = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    { bytes: refusal("CYBER") },
  ]);
  check(
    "refusal on a model without a fallback: content_filter, one request",
    noFb.finish === "content_filter" && noFb.sentModels.length === 1
  );
  // g) the in-band frame in each client format, and the non-streaming parse
  const { inbandStreamErrorFrame } = await import("../../open-sse/utils/contextOverflowError.ts");
  const fc = inbandStreamErrorFrame("claude", { status: 500, type: "api_error", message: "m" });
  check(
    "Claude client: event: error (api_error) then message_stop",
    /^event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"m"\}\}/.test(
      fc
    ) && fc.includes("event: message_stop")
  );
  check(
    "Claude client: 429 -> rate_limit_error",
    inbandStreamErrorFrame("claude", { status: 429, type: "x", message: "m" }).includes(
      '"rate_limit_error"'
    )
  );
  const fo = inbandStreamErrorFrame("openai", {
    status: 502,
    code: "kiro_stream_incomplete",
    message: "m",
  });
  check(
    "OpenAI client: finish_reason error chunk + error + [DONE]",
    fo.includes('"finish_reason":"error"') &&
      fo.includes('"code":"kiro_stream_incomplete"') &&
      fo.endsWith("data: [DONE]\n\n")
  );
  check(
    "Responses client: response.failed",
    inbandStreamErrorFrame("openai-responses", { status: 500, message: "m" }).startsWith(
      "event: response.failed"
    )
  );
  const { convertKiroToOpenAI } =
    await import("../../open-sse/translator/response/kiro-to-openai.ts");
  const st: Record<string, any> = {};
  const out = convertKiroToOpenAI(
    {
      error: {
        status: 429,
        type: "rate_limit_error",
        code: "ThrottlingException",
        message: "slow",
      },
    },
    st
  );
  check(
    "Kiro translator: error chunk -> state.upstreamError (inband), nothing emitted",
    out === null && st.upstreamError?.inband === true && st.upstreamError.status === 429
  );
  const { parseNonStreamingResponseBody } =
    await import("../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts");
  const ns = await parseNonStreamingResponseBody({
    providerResponse: new Response(mid.sse, { headers: { "content-type": "text/event-stream" } }),
    upstreamStream: true,
    providerHeaders: null,
    finalBody: {},
    targetFormat: "kiro",
    model: "claude-sonnet-5",
    provider: "kiro",
  });
  check(
    "non-streaming: a failed Kiro answer is an error (invalid_sse), not half an answer",
    ns.kind === "invalid_sse" && /high load/.test((ns as { message: string }).message)
  );
  // h) the model that answered is named in an internal header for the streaming X-TRouteAI-Model
  const fb = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "x"), [
    { bytes: refusal("CYBER") },
    { bytes: answer("from four eight") },
  ]);
  check(
    "refusal fallback answer: model claude-opus-4.8 and the internal answering-model header",
    fb.answerModel === "claude-opus-4.8" &&
      fb.text === "from four eight" &&
      fb.answeringHeader === "claude-opus-4.8"
  );
  const plain = await run("claude-opus-5.5", kiroBody("claude-opus-5.5", "x"), [
    { bytes: answer("plain") },
  ]);
  check(
    "normal answer: no answering-model header",
    plain.answeringHeader === null && plain.finish === "stop"
  );
}

// 18. Scanned PDF pages go to Kiro as page images (JPEG as stored; Flate / CCITT fax as PNG)
{
  initTranslators();
  const { extractPdfPageImages } = await import("../../open-sse/utils/pdfText.ts");
  const { inflateSync } = await import("node:zlib");
  // A 70x20 black-and-white pattern; G4 / G3 1-D / G3 2-D data made from it by libtiff's tiffcp.
  const FAX = {
    W: 70,
    H: 20,
    bits: "3fffffffffffffffffc7ffffffffffffffffe0000fffffffffffffe0000fffffffffffffe0000fffffffffffffe0000fffffffffffffe0000fffffffffffffe00001ffffffffffffe0000e3fffffffffffffffffc7fffffffffffffffff8ffffffffffffffffff1fffe00003ffffffffe3ffe00003fffffffffc7fe00003ffffffffff8fe00003777777777771600003fffffffffffe200003ffffffffffffc00003ffffffffffffe00003ffffffffffffe00003",
    g4: "26bc336c7641853fff83c118a20cc540cc2e0cd5419838331e0cdf26a8c2308c2308c2308c2308c2408c408a78888888888883783be0020020",
    g31d: "00135f76002f6c700180614c0060185300180614c0060185300180614c00603405000c031116800938a80040a170011baa0ce002290619c0045e38670012abc338009aa850a142850a142850a21d38670010a870ce002a61a00055033800aa0670",
    g32d: "0019afbb001066d8e00380614c005c00700c29800b800e0185300141c00700c445a00210662a0018142e002066aa00314830ce0020663c00655786700113546118461184611846118461204620453c006150e19c0040e003540ce002c0",
  };
  const imagePdf = (dict: string, data: Buffer, text = "") => {
    const objs: Array<string | { dict: string; data: Buffer }> = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 70 20] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 6 0 R >> >> >>",
      {
        dict: "",
        data: Buffer.from(
          `q 70 0 0 20 0 0 cm /Im1 Do Q${text ? ` BT /F1 9 Tf (${text}) Tj ET` : ""}`
        ),
      },
      { dict: `/Type /XObject /Subtype /Image /Width ${FAX.W} /Height ${FAX.H} ${dict}`, data },
      "<< /Type /Font /Subtype /Type1 >>",
    ];
    const parts: Buffer[] = [Buffer.from("%PDF-1.5\n")];
    objs.forEach((o, i) => {
      if (typeof o === "string") parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`));
      else
        parts.push(
          Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`),
          o.data,
          Buffer.from("\nendstream\nendobj\n")
        );
    });
    parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
    return Buffer.concat(parts).toString("base64");
  };
  const pngRows = (b64: string) => {
    const b = Buffer.from(b64, "base64");
    let o = 8;
    const idat: Buffer[] = [];
    let w = 0,
      h = 0;
    while (o < b.length) {
      const len = b.readUInt32BE(o);
      const type = b.toString("latin1", o + 4, o + 8);
      if (type === "IHDR") {
        w = b.readUInt32BE(o + 8);
        h = b.readUInt32BE(o + 12);
      }
      if (type === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
    return { w, h, raw: inflateSync(Buffer.concat(idat)).toString("hex") };
  };
  const flat = extractPdfPageImages(
    imagePdf(
      "/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode",
      (await import("node:zlib")).deflateSync(Buffer.from(FAX.bits, "hex"))
    ),
    [1]
  );
  const ref = flat?.images[0] ? pngRows(flat.images[0].data) : null;
  check(
    "1-bit Flate page image -> PNG 70x20",
    ref?.w === 70 && ref?.h === 20 && flat?.images[0]?.mediaType === "image/png"
  );
  for (const [name, k] of [
    ["g4", -1],
    ["g31d", 0],
    ["g32d", 4],
  ] as const) {
    const fax = extractPdfPageImages(
      imagePdf(
        `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K ${k} /Columns 70 /Rows 20 >>`,
        Buffer.from(FAX[name], "hex")
      ),
      [1]
    );
    const got = fax?.images[0] ? pngRows(fax.images[0].data) : null;
    check(
      `CCITT ${name} (K ${k}): pixel-identical to the source`,
      !!got && got.raw === ref?.raw,
      `${fax?.unreadable}`
    );
  }
  const jpegBytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(200, 7),
    Buffer.from([0xff, 0xd9]),
  ]);
  const jpg = extractPdfPageImages(
    imagePdf("/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpegBytes),
    [1]
  );
  check(
    "JPEG page image passed through unchanged",
    jpg?.images[0]?.mediaType === "image/jpeg" &&
      jpg.images[0].data === jpegBytes.toString("base64")
  );
  const cmykJpg = extractPdfPageImages(
    imagePdf("/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode", jpegBytes),
    [1]
  );
  check(
    "CMYK JPEG: not attached, reported unreadable",
    cmykJpg?.images.length === 0 && cmykJpg.unreadable[0] === 1
  );
  const jbig2 = extractPdfPageImages(
    imagePdf("/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode", Buffer.alloc(20)),
    [1]
  );
  check("JBIG2: reported unreadable", jbig2?.images.length === 0 && jbig2.unreadable[0] === 1);
  // Through the translator: a fully scanned PDF in a tool result (Claude Code's Read)
  const scanPdf = imagePdf(
    `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 70 /Rows 20 >>`,
    Buffer.from(FAX.g4, "hex")
  );
  const viaRead = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    {
      model: "claude-sonnet-5",
      max_tokens: 100,
      tools: [{ name: "Read", description: "r", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_s", name: "Read", input: { file_path: "scan.pdf" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_s",
              content: [
                { type: "text", text: "PDF file read" },
                {
                  type: "document",
                  source: { type: "base64", media_type: "application/pdf", data: scanPdf },
                },
              ],
            },
          ],
        },
      ],
    },
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  const cur = viaRead.conversationState?.currentMessage?.userInputMessage;
  const allImages = [
    cur,
    ...(viaRead.conversationState?.history || []).map((h: any) => h.userInputMessage),
  ].flatMap((m: any) => m?.images || []);
  const sentText = JSON.stringify(viaRead);
  check(
    "scanned PDF in a Read result: page image sent to Kiro (png) + a note naming the page, no PDF base64",
    allImages.length === 1 &&
      allImages[0].format === "png" &&
      sentText.includes("Page 1 is a scanned image, attached as image") &&
      !sentText.includes(scanPdf.slice(0, 40)),
    `${allImages.length} images`
  );
  const docMsg = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    {
      model: "claude-sonnet-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "scan.pdf",
              source: { type: "base64", media_type: "application/pdf", data: scanPdf },
            },
            { type: "text", text: "what does it say" },
          ],
        },
      ],
    },
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  check(
    "scanned PDF document block: one page image on the current message",
    docMsg.conversationState?.currentMessage?.userInputMessage?.images?.length === 1
  );
}

// 19. Redacted (encrypted) reasoning: Kiro's {redactedContent} -> redacted_thinking -> back to Kiro
{
  initTranslators();
  const { openaiToClaudeResponse } =
    await import("../../open-sse/translator/response/openai-to-claude.ts");
  const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/sseParser.ts");
  const { translateNonStreamingResponse } =
    await import("../../open-sse/handlers/responseTranslator.ts");
  const ENC = "EncReasoning" + "Z".repeat(300);
  const r = await run("claude-sonnet-5", kiroBody("claude-sonnet-5", "x"), [
    {
      bytes: concat([
        frame("reasoningContentEvent", { redactedContent: ENC }),
        frame("assistantResponseEvent", { content: "answer" }),
        frame("metadataEvent", { stopReason: "END_TURN" }),
        frame("contextUsageEvent", { contextUsagePercentage: 1 }),
      ]),
    },
  ]);
  check(
    "executor: redactedContent -> reasoning_redacted delta, then the text",
    r.sse.includes(`"reasoning_redacted":"${ENC}"`) && r.text === "answer" && r.finish === "stop"
  );
  const state: Record<string, unknown> = { toolCalls: new Map() };
  const events: Record<string, any>[] = [];
  for (const line of r.sse.split("\n"))
    if (line.startsWith("data: {"))
      events.push(...(openaiToClaudeResponse(JSON.parse(line.slice(6)), state) || []));
  events.push(...(openaiToClaudeResponse(null, state) || []));
  const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block);
  check(
    "stream: a redacted_thinking block (data) before the text block",
    starts[0]?.type === "redacted_thinking" &&
      starts[0]?.data === ENC &&
      starts[1]?.type === "text" &&
      events.filter((e) => e.type === "content_block_stop").length === 2,
    JSON.stringify(starts.map((s) => s.type))
  );
  const ns = translateNonStreamingResponse(
    parseSSEToOpenAIResponse(r.sse, "claude-sonnet-5") as never,
    "openai",
    "claude"
  ) as Record<string, any>;
  check(
    "non-stream: content starts with redacted_thinking {data}",
    ns.content?.[0]?.type === "redacted_thinking" &&
      ns.content[0].data === ENC &&
      ns.content[1]?.type === "text"
  );
  const sent = translateRequest(
    "claude",
    "kiro",
    "claude-sonnet-5",
    {
      model: "claude-sonnet-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: ENC },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "next" },
      ],
    },
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  const histAssistant = (sent.conversationState?.history || [])
    .map((h: any) => h.assistantResponseMessage)
    .filter(Boolean)
    .at(-1);
  check(
    "request: redacted_thinking goes back as reasoningContent.redactedContent",
    histAssistant?.reasoningContent?.redactedContent === ENC &&
      !histAssistant.reasoningContent.reasoningText,
    JSON.stringify(histAssistant?.reasoningContent || null).slice(0, 80)
  );
  const other = JSON.stringify(
    translateRequest(
      "claude",
      "openai",
      "gpt-x",
      {
        model: "gpt-x",
        max_tokens: 100,
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: [
              { type: "redacted_thinking", data: ENC },
              { type: "text", text: "a" },
            ],
          },
          { role: "user", content: "n" },
        ],
      },
      true,
      { _targetFormat: "openai" },
      "openai"
    )
  );
  check("other OpenAI-format targets: no redacted data sent", !other.includes(ENC));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
