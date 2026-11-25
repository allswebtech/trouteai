// Images reach every model that can see, and a model that cannot see gets a plain error that
// says so. No network: fetch is replaced where a provider would be called.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-vision.mts
import { getResolvedModelCapabilities } from "../../src/lib/modelCapabilities.ts";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.ts";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.ts";
import { inlineRemoteImages } from "../../open-sse/utils/imageInput.ts";
import {
  countVisionSkippedAhead,
  describeCapabilityFilterExhaustion,
  filterTargetsByRequestCompatibility,
} from "../../open-sse/services/combo/comboStructure.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { VisionBridgeGuardrail } from "../../src/lib/guardrails/visionBridge.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const vision = (modelStr: string) => getResolvedModelCapabilities(modelStr).supportsVision;

// ── 1. capability data ────────────────────────────────────────────────────────
{
  const blindKiro = new Set([
    "deepseek-3.2",
    "minimax-m2.5",
    "minimax-m2.1",
    "glm-5",
    "qwen3-coder-next",
  ]);
  const kiro = (PROVIDER_MODELS as Record<string, Array<{ id: string }>>).kr || [];
  const wrong = kiro.filter((m) => vision(`kr/${m.id}`) !== !blindKiro.has(m.id)).map((m) => m.id);
  check(
    "every Kiro registry model has a known vision verdict",
    kiro.length > 0 && wrong.length === 0,
    wrong.join(", ")
  );
  for (const p of ["cc", "anthropic"]) {
    const models = (PROVIDER_MODELS as Record<string, Array<{ id: string }>>)[p] || [];
    const unknown = models.filter((m) => vision(`${p}/${m.id}`) !== true).map((m) => m.id);
    check(
      `every ${p} registry model can see`,
      models.length > 0 && unknown.length === 0,
      unknown.join(", ")
    );
  }
  // Current Claude models named the way clients send them (dashed and dotted spellings).
  const current = [
    "cc/claude-haiku-5-5",
    "cc/claude-sonnet-5-5",
    "cc/claude-opus-5-5",
    "cc/claude-fable-5-2",
    "anthropic/claude-haiku-5-5",
    "kr/claude-haiku-5.5",
    "kr/claude-sonnet-5.5",
    "kr/claude-opus-5.5",
    "kr/claude-fable-5.2",
  ];
  const notSeeing = current.filter((m) => vision(m) !== true);
  check(
    "current Claude models (Haiku/Sonnet/Opus 5.5, Fable 5.2) can see",
    notSeeing.length === 0,
    notSeeing.join(", ")
  );
}

// ── 2. Kiro: the image bytes reach Kiro, or the client gets an error naming the model ─────────
await initTranslators();
// A 1x1 PNG; the bytes are what must arrive upstream.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const creds = { accessToken: "fake-kiro-token", providerSpecificData: {} };
const anthropicImage = (source: Record<string, unknown>) => ({
  model: "x",
  max_tokens: 100,
  messages: [
    {
      role: "user",
      content: [
        { type: "image", source },
        { type: "text", text: "what is this?" },
      ],
    },
  ],
});
const openaiImage = (url: string) => ({
  model: "x",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url } },
      ],
    },
  ],
});
const kiroImages = (body: any) =>
  (body?.conversationState?.currentMessage?.userInputMessage?.images || []) as Array<{
    format: string;
    source: { bytes: string };
  }>;
const toKiro = (source: string, model: string, body: unknown) => {
  try {
    return {
      body: translateRequest(
        source,
        "kiro",
        model,
        structuredClone(body),
        true,
        creds,
        "kiro"
      ) as any,
    };
  } catch (error) {
    return { error: error as Error & { statusCode?: number } };
  }
};
const carried = (r: { body?: any }) =>
  kiroImages(r.body).length === 1 &&
  kiroImages(r.body)[0].source.bytes === PNG &&
  kiroImages(r.body)[0].format === "png";

for (const model of ["claude-sonnet-5", "claude-opus-5.5", "gpt-5.6-sol"]) {
  const a = toKiro(
    "claude",
    model,
    anthropicImage({ type: "base64", media_type: "image/png", data: PNG })
  );
  check(
    `Kiro ${model}, Anthropic base64 image: bytes reach Kiro`,
    carried(a),
    a.error?.message || JSON.stringify(kiroImages(a.body)).slice(0, 80)
  );
  const o = toKiro("openai", model, openaiImage(`data:image/png;base64,${PNG}`));
  check(
    `Kiro ${model}, OpenAI data-URL image: bytes reach Kiro`,
    carried(o),
    o.error?.message || ""
  );
}
{
  const r = toKiro("openai", "claude-sonnet-5", {
    model: "x",
    messages: [
      { role: "user", content: "take a screenshot" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "shot", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }],
      },
    ],
    tools: [
      {
        type: "function",
        function: { name: "shot", description: "screenshot", parameters: { type: "object" } },
      },
    ],
  });
  check(
    "Kiro, image returned by a tool (OpenAI tool message): bytes reach Kiro",
    carried(r),
    r.error?.message || ""
  );
}
{
  const r = toKiro("claude", "claude-sonnet-5", {
    model: "x",
    max_tokens: 100,
    messages: [
      { role: "user", content: "take a screenshot" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "shot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
        ],
      },
    ],
    tools: [{ name: "shot", description: "screenshot", input_schema: { type: "object" } }],
  });
  check(
    "Kiro, image returned by a tool (Anthropic tool_result): bytes reach Kiro",
    carried(r),
    r.error?.message || ""
  );
}
for (const model of ["deepseek-3.2", "glm-5"]) {
  for (const [dialect, body] of [
    ["claude", anthropicImage({ type: "base64", media_type: "image/png", data: PNG })],
    ["openai", openaiImage(`data:image/png;base64,${PNG}`)],
  ] as const) {
    const r = toKiro(dialect, model, body);
    const msg = r.error?.message || "";
    check(
      `Kiro ${model} (text-only), ${dialect} image: 400 naming the model and images`,
      r.error?.statusCode === 400 && msg.includes(model) && /images/.test(msg),
      msg || "no error"
    );
  }
}
{
  const r = toKiro(
    "claude",
    "claude-sonnet-5",
    anthropicImage({ type: "url", url: "https://images.example.test/cat.png" })
  );
  check(
    "Kiro, URL image that was not downloaded: 400 instead of a silent drop",
    r.error?.statusCode === 400 && /URL/.test(r.error?.message || ""),
    r.error?.message || `images ${kiroImages(r.body).length}`
  );
}

// ── 3. Image URLs for Kiro: downloaded (public addresses only), then sent as bytes ──────────
{
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    fetched.push(String(url));
    return new Response(Buffer.from(PNG, "base64"), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as never;
  try {
    // 203.0.113.0/24 is a documentation range: public, never a real host.
    const url = "https://203.0.113.7/cat.png";
    for (const [dialect, body] of [
      ["claude", anthropicImage({ type: "url", url })],
      ["openai", openaiImage(url)],
    ] as const) {
      const inlined = await inlineRemoteImages(structuredClone(body));
      const r = toKiro(dialect, "claude-sonnet-5", inlined);
      check(
        `Kiro, ${dialect} image given by URL: downloaded and its bytes reach Kiro`,
        carried(r),
        r.error?.message || ""
      );
    }
    check(
      "the image URL was fetched once per request",
      fetched.length === 2 && fetched[0] === url,
      fetched.join(" ")
    );
    fetched.length = 0;
    let refused = "";
    try {
      await inlineRemoteImages(openaiImage("http://127.0.0.1:9/secret.png"));
    } catch (error) {
      refused = (error as Error).message;
    }
    check(
      "an image URL on a private address is refused, never fetched",
      fetched.length === 0 && /public/.test(refused),
      refused
    );
    globalThis.fetch = (async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as never;
    let notImage = "";
    try {
      await inlineRemoteImages(openaiImage(url));
    } catch (error) {
      notImage = (error as Error).message;
    }
    check(
      "an image URL that returns no image: a named error",
      /did not return/.test(notImage),
      notImage
    );
    const plain = openaiImage(`data:image/png;base64,${PNG}`);
    check(
      "a body without image URLs is passed on unchanged",
      (await inlineRemoteImages(plain)) === plain
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 4. Anthropic client, OpenAI-format upstream: every image is carried or refused by name ─────
{
  const toOpenAI = (body: unknown) => {
    try {
      return {
        body: translateRequest(
          "claude",
          "openai",
          "gpt-x",
          structuredClone(body),
          true,
          { _targetFormat: "openai" },
          "openai"
        ) as any,
      };
    } catch (error) {
      return { error: error as Error & { statusCode?: number } };
    }
  };
  const urls = (body: any) =>
    JSON.stringify(body?.messages || [])
      .match(/"url":"[^"]+"/g)
      ?.map((m) => m.slice(7, -1)) || [];
  const shot = "https://203.0.113.7/shot.png";
  const r = toOpenAI({
    model: "x",
    max_tokens: 100,
    messages: [
      { role: "user", content: "take a screenshot" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "shot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "image", source: { type: "url", url: shot } }],
          },
        ],
      },
    ],
  });
  check(
    "tool_result image given by URL reaches an OpenAI-format upstream",
    urls(r.body).includes(shot),
    r.error?.message || urls(r.body).join(" ")
  );
  const f = toOpenAI(anthropicImage({ type: "file", file_id: "file_fake_0001" }));
  check(
    "image given by a file id: 400 that says so, not a silent drop",
    f.error?.statusCode === 400 && /file id/.test(f.error?.message || ""),
    f.error?.message || "no error"
  );
}

// ── 5. Combos: seeing targets serve, blind ones are skipped and the skip is counted ─────────
{
  const target = (modelStr: string, i: number) =>
    ({
      kind: "model",
      stepId: `s${i}`,
      executionKey: `k${i}`,
      modelStr,
      provider: modelStr.split("/")[0],
      providerId: null,
      connectionId: null,
      weight: 0,
      label: null,
    }) as never;
  const quiet = { info() {}, warn() {}, debug() {}, error() {} } as never;
  const body = openaiImage(`data:image/png;base64,${PNG}`) as Record<string, unknown>;
  const mixed = [
    target("kr/deepseek-3.2", 0),
    target("kr/claude-sonnet-5", 1),
    target("cc/claude-haiku-5-5", 2),
  ];
  const kept = filterTargetsByRequestCompatibility(mixed, body, quiet) as Array<{
    modelStr: string;
  }>;
  check(
    "mixed combo: the text-only target is skipped, the seeing ones stay in order",
    kept.map((t) => t.modelStr).join(",") === "kr/claude-sonnet-5,cc/claude-haiku-5-5",
    kept.map((t) => t.modelStr).join(",")
  );
  check(
    "mixed combo: the skipped first choice counts as one fallback",
    countVisionSkippedAhead(mixed, kept as never, body) === 1
  );
  const seeing = [target("cc/claude-haiku-5-5", 0), target("kr/claude-haiku-5.5", 1)];
  check(
    "combo of Haiku 5.5 targets (Claude and Kiro): both kept for an image request",
    filterTargetsByRequestCompatibility(seeing, body, quiet).length === 2
  );
  check(
    "no skip ahead of the first choice: no fallback counted",
    countVisionSkippedAhead(seeing, seeing, body) === 0
  );
  const blind = [target("kr/deepseek-3.2", 0), target("kr/glm-5", 1)];
  check(
    "combo of text-only targets: nothing kept",
    filterTargetsByRequestCompatibility(blind, body, quiet).length === 0
  );
  const ex = describeCapabilityFilterExhaustion(blind, body, "blind-combo");
  check(
    "combo of text-only targets: the error names the models and says images",
    !!ex &&
      ex.message.includes("kr/deepseek-3.2") &&
      ex.message.includes("kr/glm-5") &&
      /images/.test(ex.message),
    ex?.message || "none"
  );
}

// ── 6. Vision bridge (on by default): a combo with a seeing step keeps the real image ─────────
{
  const step = (model: string, i: number) => ({ id: `v-${i}`, kind: "model", model, weight: 0 });
  await createCombo({
    name: "vision-mixed",
    strategy: "priority",
    models: [step("kr/deepseek-3.2", 0), step("kr/claude-sonnet-5", 1)],
  });
  await createCombo({
    name: "vision-blind",
    strategy: "priority",
    models: [step("kr/deepseek-3.2", 0), step("kr/glm-5", 1)],
  });
  const described: string[] = [];
  const bridge = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({}),
      callVisionModel: async () => {
        described.push("x");
        return "a described picture";
      },
      hasUsableCredentials: async () => true,
    },
  });
  const ask = (model: string) =>
    bridge.preCall({ ...openaiImage(`data:image/png;base64,${PNG}`), model }, { model } as never);
  const mixed = await ask("vision-mixed");
  check(
    "vision bridge: mixed combo keeps the image for its seeing step",
    !mixed.modifiedPayload && described.length === 0,
    `described ${described.length}`
  );
  const blindCombo = await ask("vision-blind");
  check(
    "vision bridge: combo with no seeing step still gets the image described",
    !!blindCombo.modifiedPayload && described.length === 1,
    `described ${described.length}`
  );
}

// ── 7. Claude provider: the image reaches api.anthropic.com from both dialects ────────────────
{
  const realFetch = globalThis.fetch;
  let sent: any = null;
  globalThis.fetch = (async (url: unknown, init: { body?: string }) => {
    if (String(url).includes("/v1/messages")) sent = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "a dot" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as never;
  const upstreamImages = () =>
    (sent?.messages || []).flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "image") : []
    );
  try {
    const executor = await getExecutor("claude");
    const run = async (body: unknown) => {
      sent = null;
      await executor.execute({
        model: "claude-sonnet-5",
        body,
        stream: false,
        credentials: { accessToken: "sk-ant-oat01-fake", providerSpecificData: {} },
        clientHeaders: {},
        log: null,
      } as never);
      return upstreamImages();
    };
    const url = "https://203.0.113.7/cat.png";
    const cases: Array<[string, unknown, (img: any) => boolean]> = [
      [
        "Anthropic base64",
        {
          ...anthropicImage({ type: "base64", media_type: "image/png", data: PNG }),
          model: "claude-sonnet-5",
        },
        (img) => img.source?.type === "base64" && img.source.data === PNG,
      ],
      [
        "Anthropic URL",
        { ...anthropicImage({ type: "url", url }), model: "claude-sonnet-5" },
        (img) => img.source?.type === "url" && img.source.url === url,
      ],
      [
        "OpenAI data URL",
        translateRequest(
          "openai",
          "claude",
          "claude-sonnet-5",
          openaiImage(`data:image/png;base64,${PNG}`),
          false,
          null,
          "claude"
        ),
        (img) => img.source?.type === "base64" && img.source.data === PNG,
      ],
      [
        "OpenAI URL",
        translateRequest(
          "openai",
          "claude",
          "claude-sonnet-5",
          openaiImage(url),
          false,
          null,
          "claude"
        ),
        (img) => img.source?.type === "url" && img.source.url === url,
      ],
    ];
    for (const [label, body, ok] of cases) {
      const imgs = await run(body);
      check(
        `Claude provider, ${label} image: arrives upstream`,
        imgs.length === 1 && ok(imgs[0]),
        JSON.stringify(imgs).slice(0, 120)
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 8. A registry `strip` list refuses by name; the image is never dropped silently ──────────
{
  // A fake model entry, only for this run: no real model has a strip list today.
  (PROVIDER_MODELS as Record<string, any[]>).openai.push({
    id: "fake-no-image",
    name: "Fake no image",
    strip: ["image"],
  });
  const realFetch = globalThis.fetch;
  let sent: unknown = null;
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    sent = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as never;
  try {
    const quiet = { info() {}, warn() {}, debug() {}, error() {} };
    const result: any = await handleChatCore({
      body: {
        ...openaiImage(`data:image/png;base64,${PNG}`),
        model: "openai/fake-no-image",
        stream: false,
      },
      modelInfo: { provider: "openai", model: "fake-no-image" },
      credentials: { apiKey: "sk-fake-not-real", providerSpecificData: {} },
      log: quiet,
    } as never);
    const text = result?.response ? await result.response.text() : "";
    check(
      "a model whose strip list names images: 400 naming the model, nothing sent upstream",
      result?.status === 400 &&
        sent === null &&
        text.includes("model_content_not_supported") &&
        text.includes("openai/fake-no-image"),
      `status ${result?.status} sent ${JSON.stringify(sent)?.slice(0, 80)} ${text.slice(0, 120)}`
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (failed > 0) process.exit(1);
