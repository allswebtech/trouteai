// Check the context-overflow wording helpers (open-sse/utils/contextOverflowError.ts).
// Run from the repository root: DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-context-overflow.mts   (one line per case, exits 1 on a failure)
import {
  contextOverflowStreamFrame,
  isClearlyOverContextLimit,
  isContextOverflowText,
  normalizeContextOverflowResponse,
  toClaudeContextOverflowMessage,
} from "../../open-sse/utils/contextOverflowError.ts";
import { estimateRequestInputTokens } from "../../open-sse/services/requestTokenEstimate.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// Claude Code 2.1.319's own checks (read from its binary)
const ccPromptTooLong = (t: string) =>
  /prompt is too long|input is too long for requested model/i.test(t);
const ccNumbers = (t: string) => t.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);

// ── which texts are a context overflow ─────────────────────────────────────
const overflow = [
  "Input is too long.",
  "prompt is too long: 1022310 tokens > 1000000 maximum",
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens.",
  "Your input exceeds the context window of this model. Please adjust your input and try again.",
  "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
  "input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000, decrease input length or `max_tokens` and try again",
  "context_length_exceeded",
  "Prompt contains 140000 tokens and is too large for model with 128000 maximum context length",
  "prompt token count of 130000 exceeds the limit of 128000",
  "This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
  "Invalid request: Your request exceeded model token limit: 262144",
  "Request exceeded the context window of the model",
];
for (const t of overflow) check(`overflow: ${t.slice(0, 60)}`, isContextOverflowText(t));
const notOverflow = [
  "max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for this model",
  "Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM): Limit 30000, Used 29000",
  "This request would exceed your account's rate limit. Please try again later.",
  "messages.1.content.0.image.source.base64.media_type: Input should be 'image/jpeg'",
  "Invalid API key",
  "max_tokens is too large: 200000. This model supports at most 128000 completion tokens",
];
for (const t of notOverflow) check(`not overflow: ${t.slice(0, 60)}`, !isContextOverflowText(t));

// ── Claude wording ─────────────────────────────────────────────────────────
check(
  "Anthropic's own wording is left alone",
  toClaudeContextOverflowMessage(overflow[1]) === null
);
check(
  "Anthropic's max_tokens wording is left alone",
  toClaudeContextOverflowMessage(overflow[5]) === null
);
const kiro = toClaudeContextOverflowMessage("Input is too long.") || "";
check("Kiro: recoverable, no fake numbers", ccPromptTooLong(kiro) && !ccNumbers(kiro), kiro);
const oa = toClaudeContextOverflowMessage(overflow[2]) || "";
check(
  "OpenAI: numbers kept",
  ccNumbers(oa)?.[1] === "130500" && ccNumbers(oa)?.[2] === "128000",
  oa
);
const gem = toClaudeContextOverflowMessage(overflow[4]) || "";
check(
  "Gemini: numbers kept",
  ccNumbers(gem)?.[1] === "1200000" && ccNumbers(gem)?.[2] === "1048576",
  gem
);
const comp =
  toClaudeContextOverflowMessage(
    "This model's maximum context length is 128000 tokens. However, you requested 140000 tokens (100000 in the messages, 40000 in the completion)."
  ) || "";
check(
  "OpenAI input+completion: Claude Code's max_tokens retry wording",
  /input length and `max_tokens` exceed context limit: 100000 \+ 40000 > 128000/.test(comp),
  comp
);
const compOver =
  toClaudeContextOverflowMessage(
    "This model's maximum context length is 128000 tokens. However, you requested 170000 tokens (150000 in the messages, 20000 in the completion)."
  ) || "";
check(
  "OpenAI input alone over: prompt is too long",
  ccNumbers(compOver)?.[1] === "150000",
  compOver
);
check(
  "output-limit error is not reworded",
  toClaudeContextOverflowMessage(notOverflow[0]) === null
);
const copilot =
  toClaudeContextOverflowMessage("prompt token count of 130000 exceeds the limit of 128000") || "";
check(
  "Copilot: numbers kept",
  ccNumbers(copilot)?.[1] === "130000" && ccNumbers(copilot)?.[2] === "128000",
  copilot
);
const xai =
  toClaudeContextOverflowMessage(
    "This model's maximum prompt length is 131072 but the request contains 140000 tokens."
  ) || "";
check(
  "xAI: numbers kept",
  ccNumbers(xai)?.[1] === "140000" && ccNumbers(xai)?.[2] === "131072",
  xai
);
const vllm =
  "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 32768 tokens and your request has 8000 input tokens (32000 > 32768 - 8000).";
const vllmClaude = toClaudeContextOverflowMessage(vllm) || "";
check(
  "vLLM max_tokens too large: Claude Code's max_tokens retry wording, not a compact",
  /input length and `max_tokens` exceed context limit: 8000 \+ 32000 > 32768/.test(vllmClaude),
  vllmClaude
);
const orouter =
  toClaudeContextOverflowMessage(
    "This endpoint's maximum context length is 200000 tokens. However, you requested about 250000 tokens (240000 of text input, 0 of tool input, 10000 in the output). Please reduce the length."
  ) || "";
check(
  "OpenRouter: input numbers kept",
  ccNumbers(orouter)?.[1] === "240000" && ccNumbers(orouter)?.[2] === "200000",
  orouter
);

// ── tolerance ──────────────────────────────────────────────────────────────
check("1.00x limit: not clearly over", !isClearlyOverContextLimit(1_000_000, 1_000_000));
check("1.10x limit: not clearly over", !isClearlyOverContextLimit(1_100_000, 1_000_000));
check("1.11x limit: clearly over", isClearlyOverContextLimit(1_110_000, 1_000_000));
check("unknown limit: never over", !isClearlyOverContextLimit(5_000_000, 0));

// ── response normalizer ────────────────────────────────────────────────────
const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-test": "1" },
  });
{
  const r = await normalizeContextOverflowResponse(
    res(400, {
      error: {
        message: "[400]: Input is too long. [kr/claude-opus-5.5 (400)]",
        type: "invalid_request_error",
        code: "bad_request",
      },
    }),
    "claude"
  );
  const j = await r.json();
  check(
    "claude client: Anthropic error shape, recoverable",
    r.status === 400 &&
      j.type === "error" &&
      j.error.type === "invalid_request_error" &&
      ccPromptTooLong(j.error.message) &&
      r.headers.get("x-test") === "1",
    JSON.stringify(j)
  );
}
{
  const r = await normalizeContextOverflowResponse(
    res(400, { message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }),
    "openai"
  );
  const j = await r.json();
  check(
    "openai client: code context_length_exceeded",
    r.status === 400 && j.error.code === "context_length_exceeded",
    JSON.stringify(j)
  );
}
{
  const r = await normalizeContextOverflowResponse(
    res(400, {
      error: {
        message: "[400]: prompt is too long: 1022310 tokens > 1000000 maximum [kr/x (400)]",
        code: "bad_request",
      },
    }),
    "claude"
  );
  const j = await r.json();
  check(
    "claude client: wrapped Anthropic sentence sent alone, Anthropic shape",
    j.type === "error" &&
      j.error.message === "prompt is too long: 1022310 tokens > 1000000 maximum",
    JSON.stringify(j)
  );
}
{
  const body = {
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 5 tokens > 4 maximum" },
  };
  const r = await normalizeContextOverflowResponse(res(400, body), "claude");
  check(
    "claude client: an exact Anthropic error is passed byte for byte",
    JSON.stringify(await r.json()) === JSON.stringify(body)
  );
}
{
  const r = await normalizeContextOverflowResponse(
    res(400, { error: { message: vllm, type: "BadRequestError" } }),
    "openai"
  );
  const j = await r.json();
  check(
    "openai client: a max_tokens problem does not get context_length_exceeded",
    j.error.code !== "context_length_exceeded",
    JSON.stringify(j)
  );
}
{
  const f =
    contextOverflowStreamFrame("claude", {
      code: "context_length_exceeded",
      message: "Your input exceeds the context window of this model.",
    }) || "";
  const data = JSON.parse(f.split("data: ")[1] || "{}");
  check(
    "stream frame, claude: Anthropic error event",
    f.startsWith("event: error\n") &&
      data.type === "error" &&
      ccPromptTooLong(data.error?.message || ""),
    f
  );
  const o =
    contextOverflowStreamFrame("openai", {
      code: "context_length_exceeded",
      message: "too long",
    }) || "";
  check(
    "stream frame, openai: error chunk with the code",
    /"code":"context_length_exceeded"/.test(o) && o.startsWith("data: "),
    o
  );
  check(
    "stream frame: other errors untouched",
    contextOverflowStreamFrame("claude", { code: "rate_limit_exceeded", message: "slow down" }) ===
      null
  );
}
{
  const thinking = (i: number) => ({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "x".repeat(4000), signature: "s".repeat(4000) },
      { type: "text", text: `a${i}` },
    ],
  });
  const history = Array.from({ length: 20 }, (_, i) => [
    { role: "user", content: `q${i}` },
    thinking(i),
  ]).flat();
  const base = { system: "s".repeat(4000), messages: [{ role: "user", content: "q" }] };
  const withHistory = estimateRequestInputTokens({
    ...base,
    messages: [...history, { role: "user", content: "q" }],
  });
  const plain = estimateRequestInputTokens({
    ...base,
    messages: history
      .map((m) => (m.role === "assistant" ? { ...m, content: [m.content[1]] } : m))
      .concat([{ role: "user", content: "q" }]),
  });
  check(
    "estimate: earlier-turn thinking not counted",
    Math.abs(withHistory - plain) < 50,
    `${withHistory} vs ${plain}`
  );
  const toolLoop = estimateRequestInputTokens({
    messages: [
      { role: "user", content: "do it" },
      thinking(0),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
    ],
  });
  check(
    "estimate: thinking of the turn in progress (tool loop) counted",
    toolLoop > 1900,
    String(toolLoop)
  );
  check(
    "estimate: system prompt counted",
    estimateRequestInputTokens(base) >= 1000,
    String(estimateRequestInputTokens(base))
  );
  const gemini = estimateRequestInputTokens({
    contents: [
      { role: "user", parts: [{ text: "q" }] },
      { role: "model", parts: [{ text: "x".repeat(8000), thought: true }, { text: "a" }] },
      { role: "user", parts: [{ text: "q2" }] },
    ],
  });
  check("estimate: Gemini earlier thought parts not counted", gemini < 100, String(gemini));
  const responses = estimateRequestInputTokens({
    input: [
      { role: "user", content: "q" },
      { type: "reasoning", encrypted_content: "e".repeat(8000) },
      { role: "assistant", content: "a" },
      { role: "user", content: "q2" },
    ],
  });
  check(
    "estimate: Responses earlier reasoning items not counted",
    responses < 100,
    String(responses)
  );
}
{
  const body = { error: { message: "Invalid API key", type: "authentication_error" } };
  const r = await normalizeContextOverflowResponse(res(400, body), "claude");
  check(
    "other 400 errors are returned unchanged",
    JSON.stringify(await r.json()) === JSON.stringify(body)
  );
}
{
  const ok = new Response("{}", { status: 200 });
  check(
    "successful responses are not read",
    (await normalizeContextOverflowResponse(ok, "claude")) === ok
  );
  const sse = new Response("data: x\n\n", {
    status: 400,
    headers: { "content-type": "text/event-stream" },
  });
  check(
    "non-JSON errors are not read",
    (await normalizeContextOverflowResponse(sse, "claude")) === sse
  );
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
