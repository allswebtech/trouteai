// A fake Kiro runtime for tests: answers POST /generateAssistantResponse with AWS EventStream
// frames shaped like the real ones (measured 2026-11-10: reasoning {text} chunks + one
// {signature}, assistantResponseEvent / toolUseEvent, metadataEvent {stopReason},
// contextUsageEvent, meteringEvent). The answer is scripted from the prompts of
// anthropic-conformance.mjs, so that script can run against TRouteAI without Kiro.
// A thinking signature other than the mock's own gets 400 THINKING_SIGNATURE_INVALID, like Kiro.
// TRouteAI must run with TROUTEAI_KIRO_RUNTIME_URL=http://127.0.0.1:<port>.
// Usage: node mock-kiro.mjs <port>
import http from "node:http";

const port = Number(process.argv[2] || 20995);
const SIG = "MOCKSIG" + "Q".repeat(700);
const enc = new TextEncoder();
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function frame(eventType, payload, headers) {
  const headerBytes = [];
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

const textFrames = (text, size = 6) => {
  const out = [];
  for (let i = 0; i < text.length; i += size)
    out.push(frame("assistantResponseEvent", { content: text.slice(i, i + size) }));
  return out;
};
const chunksOf = (text) => text.match(/.{1,8}/gs) || [];
const thinking = (text) => [
  ...chunksOf(text).map((t) => frame("reasoningContentEvent", { text: t })),
  frame("reasoningContentEvent", { signature: SIG }),
];
const toolUse = (name, input) => [
  frame("toolUseEvent", {
    toolUseId: `toolu_bdrk_mock_${name}`,
    name,
    input: JSON.stringify(input),
  }),
  frame("toolUseEvent", { toolUseId: `toolu_bdrk_mock_${name}`, name, stop: true }),
];
const end = (stopReason, pct = 0.2) => [
  frame("metadataEvent", { stopReason }),
  frame("contextUsageEvent", { contextUsagePercentage: pct }),
  frame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.01 }),
];

const exception = (type, message) =>
  frame("", { message }, [
    [":exception-type", type],
    [":message-type", "exception"],
    [":content-type", "application/json"],
  ]);
// Failure scripts: the first request with the marker fails, every later one answers RETRY-OK
// (so a client that retries gets a full answer). Markers: MOCK-MIDSTREAM-EXCEPTION (text, then an
// EventStream exception), MOCK-CUTOFF (text, then the stream ends with no closing frames),
// MOCK-EXCEPTION-FIRST (an exception before any content).
const failSeen = new Map();
function failureScript(all) {
  const m = /MOCK-(MIDSTREAM-EXCEPTION|CUTOFF|EXCEPTION-FIRST)(?:-([A-Za-z0-9]+))?/.exec(all);
  if (!m) return null;
  const key = m[0];
  const n = (failSeen.get(key) || 0) + 1;
  failSeen.set(key, n);
  if (n > 1) return [...textFrames("RETRY-OK"), ...end("END_TURN")];
  if (m[1] === "MIDSTREAM-EXCEPTION")
    return [
      ...textFrames("Half an answer"),
      exception(
        "internalServerException",
        "Encountered unexpectedly high load when processing the request, please try again."
      ),
    ];
  if (m[1] === "CUTOFF") return [...thinking("partial thought"), ...textFrames("Half an answer")];
  return [
    exception(
      "internalServerException",
      "Encountered unexpectedly high load when processing the request, please try again."
    ),
  ];
}

function answer(body) {
  const state = body.conversationState || {};
  const current = state.currentMessage?.userInputMessage || {};
  const history = Array.isArray(state.history) ? state.history : [];
  const all = [
    ...history.map((h) => h.userInputMessage?.content || h.assistantResponseMessage?.content || ""),
    current.content || "",
  ].join("\n");
  const toolResults = current.userInputMessageContext?.toolResults || [];
  const resultText = toolResults
    .map((r) => (r.content || []).map((c) => c.text || "").join(""))
    .join(" ");
  const hasTools = (current.userInputMessageContext?.tools || []).length > 0;
  const thinkingOn =
    !!body.additionalModelRequestFields?.thinking &&
    body.additionalModelRequestFields.thinking.display !== "omitted";
  const failure = failureScript(current.content || "");
  if (failure) return failure;

  if (/weather in Paris/.test(all)) {
    if (/Sunny, 21/.test(resultText))
      return [...textFrames("It's sunny in Paris, 21°C."), ...end("END_TURN")];
    if (hasTools) return [...toolUse("get_weather", { city: "Paris" }), ...end("TOOL_USE")];
  }
  if (/time in Tokyo/.test(all)) {
    if (/09:41/.test(resultText))
      return [...textFrames("It's 09:41 in Tokyo."), ...end("END_TURN")];
    return [
      ...thinking("The user wants the time in Tokyo, so I call get_time."),
      ...toolUse("get_time", { city: "Tokyo" }),
      ...end("TOOL_USE"),
    ];
  }
  if (/Now add 9 to it/.test(current.content || ""))
    return [
      ...(thinkingOn ? thinking("391 + 9 = 400") : []),
      ...textFrames("400"),
      ...end("END_TURN"),
    ];
  if (/17 \* 23/.test(all))
    return [
      ...(thinkingOn ? thinking("17 * 23 = 17 * 20 + 17 * 3 = 340 + 51 = 391") : []),
      ...textFrames("391"),
      ...end("END_TURN"),
    ];
  if (/upper case/.test(all) && /hello world/i.test(all))
    return [...textFrames("HELLO WORLD"), ...end("END_TURN")];
  if (/primary colour/.test(all)) return [...textFrames("red"), ...end("END_TURN")];
  if (/Count from 1 to 5/.test(all)) return [...textFrames("1 2 3 4 5", 2), ...end("END_TURN")];
  if (/alpha beta STOPHERE gamma delta/.test(all))
    return [...textFrames("alpha beta STOPHERE gamma delta", 4), ...end("END_TURN")];
  if (/numbers from 1 to 300/.test(all))
    return [
      ...textFrames(Array.from({ length: 300 }, (_, i) => i + 1).join(" "), 20),
      ...end("END_TURN"),
    ];
  if (/pong/.test(all)) return [...textFrames("pong"), ...end("END_TURN")];
  return [...textFrames("Hello! How can I help?"), ...end("END_TURN")];
}

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {}
      if (req.method === "POST" && req.url?.startsWith("/generateAssistantResponse")) {
        const history = body.conversationState?.history || [];
        const foreign = history.some((h) => {
          const sig = h.assistantResponseMessage?.reasoningContent?.reasoningText?.signature;
          return typeof sig === "string" && sig !== SIG;
        });
        if (foreign) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              message: "messages.1.content.0: Invalid `signature` in `thinking` block",
              reason: "THINKING_SIGNATURE_INVALID",
            })
          );
          return;
        }
        // The "limited" test account is at its monthly limit, as Kiro answers it.
        if (String(req.headers.authorization || "").includes("token-limited")) {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              message: "You have reached the limit.",
              reason: "MONTHLY_REQUEST_COUNT",
            })
          );
          return;
        }
        const frames = answer(body).filter(Boolean);
        res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
        for (const f of frames) res.write(f);
        res.end();
        return;
      }
      // ListAvailableProfiles / other JSON-RPC calls: one profile, nothing else.
      res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
      res.end(
        JSON.stringify({
          profiles: [
            {
              arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/MOCK",
              profileName: "mock",
            },
          ],
        })
      );
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock kiro on ${port}`));
