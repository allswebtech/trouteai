// Check that Kiro keeps the client's effort / thinking where Kiro's live schema allows it
// (Claude 5.x, Opus 4.7/4.8: low..max; Opus/Sonnet 4.6: no xhigh; 4.5 models: no field), and
// that Claude Code's Anthropic-format effort (incl. "max") survives the claude -> openai -> kiro
// translation. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-kiro-effort.mts   (one line per case, exits 1 on a failure)
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { initTranslators, translateRequest } from "../../open-sse/translator/index.ts";

type Case = { name: string; model: string; body: Record<string, unknown>; want: string | null };

const messages = [{ role: "user", content: "hi" }];
const cases: Case[] = [
  {
    name: "opus-5.5 + output_config.effort high",
    model: "claude-opus-5.5",
    body: { messages, output_config: { effort: "high" } },
    want: "high",
  },
  {
    name: "opus-5.5 + reasoning_effort max",
    model: "claude-opus-5.5",
    body: { messages, reasoning_effort: "max" },
    want: "max",
  },
  {
    name: "opus-5 + thinking budget",
    model: "claude-opus-5",
    body: { messages, thinking: { type: "enabled", budget_tokens: 4000 } },
    want: "any",
  },
  {
    name: "opus-5.5-high suffix, no client field",
    model: "claude-opus-5.5-high",
    body: { messages },
    want: "high",
  },
  {
    name: "old sonnet-5-thinking alias",
    model: "claude-sonnet-5-thinking",
    body: { messages },
    want: "high",
  },
  {
    name: "sonnet-5 without effort: no thinking",
    model: "claude-sonnet-5",
    body: { messages },
    want: null,
  },
  {
    name: "sonnet-5.5 + effort high",
    model: "claude-sonnet-5.5",
    body: { messages, reasoning_effort: "high" },
    want: "high",
  },
  {
    name: "haiku-5.5 + effort medium",
    model: "claude-haiku-5.5",
    body: { messages, reasoning_effort: "medium" },
    want: "medium",
  },
  {
    name: "opus-4.8 + effort xhigh",
    model: "claude-opus-4.8",
    body: { messages, reasoning_effort: "xhigh" },
    want: "xhigh",
  },
  {
    name: "opus-4.6 + effort xhigh -> high (no xhigh there)",
    model: "claude-opus-4.6",
    body: { messages, reasoning_effort: "xhigh" },
    want: "high",
  },
  {
    name: "sonnet-4.6 + effort max",
    model: "claude-sonnet-4.6",
    body: { messages, reasoning_effort: "max" },
    want: "max",
  },
  {
    name: "sonnet-4.5 + effort high: no field (Kiro 400s it)",
    model: "claude-sonnet-4.5",
    body: { messages, reasoning_effort: "high" },
    want: null,
  },
  {
    name: "haiku-4.5 + effort high: no field",
    model: "claude-haiku-4.5",
    body: { messages, reasoning_effort: "high" },
    want: null,
  },
];

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
};
for (const c of cases) {
  let effort: string | null = null;
  let err = "";
  try {
    const payload = buildKiroPayload(c.model, c.body, false, {
      providerSpecificData: {},
    }) as Record<string, any>;
    const extra =
      payload?.additionalModelRequestFields ??
      payload?.conversationState?.additionalModelRequestFields;
    effort = extra?.output_config?.effort ?? null;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const ok = err === "" && (c.want === "any" ? effort !== null : effort === c.want);
  check(c.name, ok, `effort=${effort}${err ? ` error=${err}` : ""}`);
}

// Claude Code's request shape (Anthropic Messages, adaptive thinking + output_config.effort)
// through the full claude -> openai -> kiro translation.
initTranslators();
for (const [model, effort, want] of [
  ["claude-opus-5.5", "max", "max"],
  ["claude-opus-5.5", "xhigh", "xhigh"],
  ["claude-sonnet-5.5", "high", "high"],
  ["claude-haiku-5.5", "low", "low"],
] as const) {
  const body = {
    model,
    max_tokens: 128000,
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort },
    messages: [{ role: "user", content: "hi" }],
  };
  const k = translateRequest(
    "claude",
    "kiro",
    model,
    body,
    true,
    { providerSpecificData: {} },
    "kiro"
  ) as Record<string, any>;
  const got = k?.additionalModelRequestFields?.output_config?.effort ?? null;
  check(`Claude Code ${model} effort ${effort} via claude->kiro`, got === want, `effort=${got}`);
}
// Other OpenAI targets still get "xhigh" for "max" (OpenAI has no "max").
const toOpenAI = translateRequest(
  "claude",
  "openai",
  "gpt-5.5",
  {
    model: "gpt-5.5",
    max_tokens: 100,
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "hi" }],
  },
  true,
  null,
  "openai"
) as Record<string, any>;
check(
  "claude->openai keeps max -> xhigh for OpenAI",
  toOpenAI.reasoning_effort === "xhigh",
  `reasoning_effort=${toOpenAI.reasoning_effort}`
);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
