// /v1/messages/count_tokens estimates (no network, temporary DATA_DIR):
// tools are counted, Claude's tokenizer factor is applied, Kiro's own per-request tokens are
// added for Kiro targets, and a combo name counts as its first switched-on model.
// Measured against Kiro on 7 real Claude Code requests (2026-11-10): -2.3% .. +4.9%.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-count-tokens.mts
import { POST } from "../../src/app/api/v1/messages/count_tokens/route.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { countTextTokens } from "../../src/shared/utils/tiktokenCounter.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const warnings: string[] = [];
const realWarn = console.warn;
const realLog = console.log;
console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));

const system = "You are a coding agent. Follow the rules of the project. ".repeat(40);
const messages = [{ role: "user", content: "Please read src/index.ts and fix the failing test." }];
const tools = [
  {
    name: "Read",
    description: "Read a file from the local filesystem.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];
const count = async (model: string, body: Record<string, unknown>) => {
  const res = await POST(
    new Request("http://x/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify({ model, ...body }),
    })
  );
  return (await res.json()) as { input_tokens: number; source?: string };
};

const cl = countTextTokens(system) + countTextTokens(messages[0].content);
const clTools = tools.reduce(
  (n, t) =>
    n +
    countTextTokens(
      JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema })
    ),
  0
);

const plain = await count("openai/gpt-4o", { system, messages });
const withTools = await count("openai/gpt-4o", { system, messages, tools });
check(
  "non-Claude model: cl100k as before",
  plain.input_tokens === cl,
  `${plain.input_tokens} vs ${cl}`
);
check(
  "tool definitions are counted",
  withTools.input_tokens === cl + clTools && clTools > 50,
  `${withTools.input_tokens} vs ${cl}+${clTools}`
);

const kiro = await count("kiro/claude-sonnet-5", { system, messages, tools });
check(
  "Kiro Claude 5.x: 1.61 x cl100k + Kiro's 1950",
  kiro.input_tokens === Math.ceil((cl + clTools) * 1.61) + 1950,
  `${kiro.input_tokens}`
);
const old = await count("kiro/claude-sonnet-4.5", { system, messages, tools });
check(
  "Kiro Sonnet 4.5: 1.22 x cl100k + 4150",
  old.input_tokens === Math.ceil((cl + clTools) * 1.22) + 4150,
  `${old.input_tokens}`
);

await createCombo({
  name: "claude-opus-5-5",
  strategy: "round-robin",
  models: ["kiro/claude-opus-5.5"],
});
await createCombo({
  name: "first-off",
  strategy: "priority",
  models: [{ kind: "model", model: "openai/gpt-4o", enabled: false }, "kiro/claude-opus-5.5"],
});
const viaCombo = await count("claude-opus-5-5", { system, messages, tools });
const direct = await count("kiro/claude-opus-5.5", { system, messages, tools });
check(
  "a combo name counts as its first model (Kiro Opus 5.5)",
  viaCombo.input_tokens === direct.input_tokens && viaCombo.source === "local",
  `${viaCombo.input_tokens} vs ${direct.input_tokens}`
);
const skipOff = await count("first-off", { system, messages, tools });
check(
  "a switched-off first step is skipped",
  skipOff.input_tokens === direct.input_tokens,
  `${skipOff.input_tokens}`
);
const bare = await count("claude-sonnet-5", { system, messages, tools });
check(
  "bare Claude name without an account: Claude factor, no Kiro overhead",
  bare.input_tokens === Math.ceil((cl + clTools) * 1.61),
  `${bare.input_tokens}`
);
check(
  "no 'No credentials' warning for counts",
  !warnings.some((w) => w.includes("No credentials")),
  warnings.join(" | ").slice(0, 200)
);

console.warn = realWarn;
realLog(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
