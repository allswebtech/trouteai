// /v1/messages/count_tokens (no network, temporary DATA_DIR, a fake Anthropic upstream in-process):
// - a target with its own count answers with the provider's number, header x-trouteai-count: provider
// - every other target answers with an estimate of the client's content (tools counted, Claude's
//   tokenizer factor applied), header x-trouteai-count: estimated; tokens the provider adds around
//   the content (Kiro's own instructions) are in x-trouteai-count-overhead, not in the number
// - a count that fails is an error in the Anthropic shape with the matching status
// - a combo counts as the step that would answer first
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-count-tokens.mts
import { POST } from "../../src/app/api/v1/messages/count_tokens/route.ts";
import { createCombo } from "../../src/lib/db/combos.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
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

// The fake upstream: every count call is answered here; any other request fails the check.
type Upstream = { status: number; body: unknown; headers?: Record<string, string> } | Error;
let upstream: Upstream = { status: 200, body: { input_tokens: 11 } };
const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
const strayRequests: string[] = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes("/count_tokens")) {
    strayRequests.push(url);
    throw new Error("no network in this check");
  }
  const headers = new Headers(init?.headers);
  calls.push({
    url,
    key: headers.get("x-api-key"),
    body: JSON.parse(String(init?.body || "{}")),
  });
  if (upstream instanceof Error) throw upstream;
  return new Response(JSON.stringify(upstream.body), {
    status: upstream.status,
    headers: { "Content-Type": "application/json", ...(upstream.headers || {}) },
  });
}) as typeof fetch;

const system = "You are a coding agent. Follow the rules of the project. ".repeat(40);
const messages = [{ role: "user", content: "Please read src/index.ts and fix the failing test." }];
const sayOk = [{ role: "user", content: "Say OK" }];
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
type CountAnswer = {
  status: number;
  json: {
    input_tokens?: number;
    source?: string;
    type?: string;
    error?: { type?: string; message?: string };
  };
  count: string | null;
  overhead: string | null;
  reason: string | null;
  retryAfter: string | null;
  shouldRetry: string | null;
};
const count = async (model: string, body: Record<string, unknown>): Promise<CountAnswer> => {
  const res = await POST(
    new Request("http://x/v1/messages/count_tokens", {
      method: "POST",
      body: JSON.stringify({ model, ...body }),
    })
  );
  return {
    status: res.status,
    json: await res.json(),
    count: res.headers.get("x-trouteai-count"),
    overhead: res.headers.get("x-trouteai-count-overhead"),
    reason: res.headers.get("x-trouteai-count-reason"),
    retryAfter: res.headers.get("retry-after"),
    shouldRetry: res.headers.get("x-should-retry"),
  };
};
const anthropicError = (r: CountAnswer, status: number, type: string) =>
  r.status === status &&
  r.json?.type === "error" &&
  r.json?.error?.type === type &&
  typeof r.json?.error?.message === "string" &&
  r.json.input_tokens === undefined &&
  r.count === null;

const clSayOk = countTextTokens("Say OK");
const cl = countTextTokens(system) + countTextTokens(messages[0].content);
const clTools = tools.reduce(
  (n, t) =>
    n +
    countTextTokens(
      JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema })
    ),
  0
);

// --- Estimates: targets without a count of their own --------------------------------------
const plain = await count("openai/gpt-4o", { system, messages });
const withTools = await count("openai/gpt-4o", { system, messages, tools });
check(
  "non-Claude model: cl100k as before, marked as an estimate",
  plain.status === 200 &&
    plain.json.input_tokens === cl &&
    plain.count === "estimated" &&
    plain.reason === "no-provider-count" &&
    plain.overhead === null,
  `${plain.status} ${plain.json.input_tokens} vs ${cl}, ${plain.count}/${plain.reason}/${plain.overhead}`
);
check(
  "tool definitions are counted",
  withTools.json.input_tokens === cl + clTools && clTools > 50,
  `${withTools.json.input_tokens} vs ${cl}+${clTools}`
);

const kiroOk = await count("kiro/claude-sonnet-5", { messages: sayOk });
check(
  "Kiro, 'Say OK': the content's estimate, Kiro's 1950 apart in the overhead header",
  kiroOk.status === 200 &&
    kiroOk.json.input_tokens === Math.ceil(clSayOk * 1.61) &&
    kiroOk.json.input_tokens < 20 &&
    kiroOk.json.source === "local" &&
    kiroOk.count === "estimated" &&
    kiroOk.reason === "no-provider-count" &&
    kiroOk.overhead === "1950",
  `${kiroOk.json.input_tokens} overhead=${kiroOk.overhead} ${kiroOk.count}/${kiroOk.reason}`
);
const kiro = await count("kiro/claude-sonnet-5", { system, messages, tools });
check(
  "Kiro Claude 5.x: 1.61 x cl100k in the body, 1950 in the header",
  kiro.json.input_tokens === Math.ceil((cl + clTools) * 1.61) && kiro.overhead === "1950",
  `${kiro.json.input_tokens} overhead=${kiro.overhead}`
);
const old = await count("kiro/claude-sonnet-4.5", { system, messages, tools });
check(
  "Kiro Sonnet 4.5: 1.22 x cl100k in the body, 4150 in the header",
  old.json.input_tokens === Math.ceil((cl + clTools) * 1.22) && old.overhead === "4150",
  `${old.json.input_tokens} overhead=${old.overhead}`
);
const bare = await count("claude-sonnet-5", { system, messages, tools });
check(
  "a name no provider can be found for: Claude factor, no overhead, marked as an estimate",
  bare.status === 200 &&
    bare.json.input_tokens === Math.ceil((cl + clTools) * 1.61) &&
    bare.count === "estimated" &&
    bare.reason === "unknown-target" &&
    bare.overhead === null,
  `${bare.status} ${bare.json.input_tokens} ${bare.count}/${bare.reason}`
);
check("no upstream call for an estimate", calls.length === 0, `${calls.length} calls`);

// --- The provider's own count --------------------------------------------------------------
const noAccount = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "own-count target without an account: an error, not a quiet estimate",
  noAccount.status >= 400 &&
    noAccount.json.type === "error" &&
    noAccount.json.input_tokens === undefined &&
    noAccount.count === null &&
    calls.length === 0,
  `${noAccount.status} ${JSON.stringify(noAccount.json).slice(0, 160)}`
);

const account = (await createProviderConnection({
  provider: "anthropic",
  authType: "apikey",
  name: "count-a",
  apiKey: "sk-ant-fake-count-a",
  isActive: true,
  testStatus: "active",
})) as { id: string };

upstream = { status: 200, body: { input_tokens: 11 } };
const own = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "Claude target, 'Say OK': the provider's own count as it is",
  own.status === 200 &&
    own.json.input_tokens === 11 &&
    own.json.source === "provider" &&
    own.count === "provider" &&
    own.overhead === null &&
    own.reason === null,
  `${own.status} ${JSON.stringify(own.json)} ${own.count}/${own.overhead}`
);
const sent = calls.at(-1);
check(
  "the count went to the provider with the account's key and the client's content",
  !!sent &&
    sent.url.includes("/v1/messages/count_tokens") &&
    sent.key === "sk-ant-fake-count-a" &&
    sent.body.model === "claude-sonnet-5" &&
    Array.isArray(sent.body.messages) &&
    sent.body.messages.length === 1 &&
    (sent.body.messages[0] as { role?: string }).role === "user" &&
    (sent.body.messages[0] as { content?: string }).content === "Say OK",
  sent
    ? `${sent.url} key=${sent.key ? "set" : "none"} ${JSON.stringify(sent.body).slice(0, 120)}`
    : "no call"
);

// --- A count that fails is an error --------------------------------------------------------
upstream = {
  status: 429,
  body: { type: "error", error: { type: "rate_limit_error", message: "Rate limited (fake)" } },
  headers: { "retry-after": "7" },
};
const limited = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream 429: 429 rate_limit_error with its message and Retry-After",
  anthropicError(limited, 429, "rate_limit_error") &&
    limited.json.error?.message === "Rate limited (fake)" &&
    limited.retryAfter === "7" &&
    limited.shouldRetry === "false",
  `${limited.status} ${JSON.stringify(limited.json).slice(0, 160)} ra=${limited.retryAfter}`
);
upstream = {
  status: 529,
  body: { type: "error", error: { type: "overloaded_error", message: "Overloaded (fake)" } },
};
const overloaded = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream 529: 529 overloaded_error",
  anthropicError(overloaded, 529, "overloaded_error"),
  `${overloaded.status} ${JSON.stringify(overloaded.json).slice(0, 160)}`
);
upstream = { status: 500, body: { error: "boom" } };
const broken = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream 500: 500 api_error",
  anthropicError(broken, 500, "api_error"),
  `${broken.status} ${JSON.stringify(broken.json).slice(0, 160)}`
);
upstream = {
  status: 401,
  body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
};
const refused = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream 401 (the gateway's account): 502 api_error, not the client's own 401",
  anthropicError(refused, 502, "api_error"),
  `${refused.status} ${JSON.stringify(refused.json).slice(0, 160)}`
);
upstream = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
const timedOut = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream timeout: 504 timeout_error",
  anthropicError(timedOut, 504, "timeout_error"),
  `${timedOut.status} ${JSON.stringify(timedOut.json).slice(0, 160)}`
);
upstream = new TypeError("fetch failed");
const unreachable = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream unreachable: 502 api_error",
  anthropicError(unreachable, 502, "api_error"),
  `${unreachable.status} ${JSON.stringify(unreachable.json).slice(0, 160)}`
);
upstream = { status: 501, body: { error: { message: "Not implemented" } } };
const unsupported = await count("anthropic/claude-sonnet-5", { messages: sayOk });
check(
  "upstream without a count endpoint after all (501): a marked estimate",
  unsupported.status === 200 &&
    unsupported.count === "estimated" &&
    unsupported.reason === "no-provider-count" &&
    unsupported.json.input_tokens === Math.ceil(clSayOk * 1.61),
  `${unsupported.status} ${JSON.stringify(unsupported.json)} ${unsupported.count}`
);

const limitedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
await updateProviderConnection(account.id, { rateLimitedUntil: limitedUntil });
const allLimited = await count("anthropic/claude-sonnet-5", { messages: sayOk });
const callsWhileLimited = calls.length;
check(
  "every account at its limit: an error, no upstream call",
  allLimited.status >= 400 &&
    allLimited.json.type === "error" &&
    allLimited.json.input_tokens === undefined &&
    allLimited.count === null,
  `${allLimited.status} ${JSON.stringify(allLimited.json).slice(0, 160)}`
);

// --- A combo counts as the step that would answer first ------------------------------------
await createProviderConnection({
  provider: "kiro",
  authType: "oauth",
  name: "count-kiro",
  accessToken: "trouteai-fake-kiro-token",
  refreshToken: null,
  expiresAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
  providerSpecificData: { authMethod: "idc", region: "us-east-1" },
  testStatus: "active",
  isActive: true,
});
await createCombo({
  name: "claude-then-kiro",
  strategy: "priority",
  models: ["anthropic/claude-sonnet-5", "kiro/claude-sonnet-5"],
});
const comboLimited = await count("claude-then-kiro", { messages: sayOk });
check(
  "combo whose first step is at its limit: counts as the next step (Kiro estimate)",
  comboLimited.status === 200 &&
    comboLimited.count === "estimated" &&
    comboLimited.overhead === "1950" &&
    comboLimited.json.input_tokens === Math.ceil(clSayOk * 1.61) &&
    calls.length === callsWhileLimited,
  `${comboLimited.status} ${JSON.stringify(comboLimited.json)} ${comboLimited.count}/${comboLimited.overhead}`
);
await updateProviderConnection(account.id, { rateLimitedUntil: null });
upstream = { status: 200, body: { input_tokens: 13 } };
const comboOwn = await count("claude-then-kiro", { messages: sayOk });
check(
  "the same combo with the Claude account free again: the provider's own count",
  comboOwn.status === 200 && comboOwn.json.input_tokens === 13 && comboOwn.count === "provider",
  `${comboOwn.status} ${JSON.stringify(comboOwn.json)} ${comboOwn.count}`
);
await createCombo({
  name: "no-account-first",
  strategy: "priority",
  models: ["openai/gpt-4o", "anthropic/claude-sonnet-5"],
});
const skipNoAccount = await count("no-account-first", { messages: sayOk });
check(
  "combo whose first step has no account: counts as the step with one",
  skipNoAccount.status === 200 &&
    skipNoAccount.json.input_tokens === 13 &&
    skipNoAccount.count === "provider",
  `${skipNoAccount.status} ${JSON.stringify(skipNoAccount.json)} ${skipNoAccount.count}`
);

await createCombo({
  name: "claude-opus-5-5",
  strategy: "round-robin",
  models: ["kiro/claude-opus-5.5"],
});
await createCombo({
  name: "first-off",
  strategy: "priority",
  models: [
    { kind: "model", model: "anthropic/claude-sonnet-5", enabled: false },
    "kiro/claude-opus-5.5",
  ],
});
const viaCombo = await count("claude-opus-5-5", { system, messages, tools });
const direct = await count("kiro/claude-opus-5.5", { system, messages, tools });
check(
  "a combo name counts as its model (Kiro Opus 5.5), with the same headers",
  viaCombo.json.input_tokens === direct.json.input_tokens &&
    viaCombo.json.source === "local" &&
    viaCombo.count === "estimated" &&
    viaCombo.overhead === direct.overhead &&
    direct.overhead === "1950",
  `${viaCombo.json.input_tokens} vs ${direct.json.input_tokens}, ${viaCombo.overhead}`
);
const callsBeforeOff = calls.length;
const skipOff = await count("first-off", { system, messages, tools });
check(
  "a switched-off first step is skipped",
  skipOff.json.input_tokens === direct.json.input_tokens &&
    skipOff.count === "estimated" &&
    calls.length === callsBeforeOff,
  `${skipOff.json.input_tokens} ${skipOff.count}`
);

check(
  "no 'No credentials' warning for counts",
  !warnings.some((w) => w.includes("No credentials")),
  warnings.join(" | ").slice(0, 200)
);
check("no request left the process", strayRequests.length === 0, strayRequests.join(" "));

console.warn = realWarn;
realLog(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
