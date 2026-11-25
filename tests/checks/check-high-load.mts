// The provider's "high load" answer (a 500 that says so) in a round-robin combo: a request with
// no pinned account is answered by another account; a conversation pinned to its account never
// leaves it for it and keeps its pin (its prompt cache is there). In-process, stand-in models.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-high-load.mts
import { handleComboChat } from "../../open-sse/services/combo.ts";
import * as sticky from "../../open-sse/services/combo/sessionStickiness.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
sticky.__setStickinessHeadroomFetcherForTests(async () => undefined);
sticky.__setStickinessConnectionFetcherForTests(async () => ({}));
sticky.__setStickinessQuotaCheckerForTests(() => false);

const A = "openai/fake-model-a";
const B = "openai/fake-model-b";
const C = "openai/fake-model-c";
const models = [
  { model: A, connectionId: "alpha" },
  { model: B, connectionId: "bravo" },
  { model: C, connectionId: "charlie" },
];
let calls: Array<{ tag: string; model: string }> = [];
let highLoad = new Set<string>();
const hold: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handleSingleModel(body: Record<string, unknown>, modelStr: string) {
  const messages = body.messages as Array<{ role: string; content: string }>;
  calls.push({ tag: messages[messages.length - 1].content, model: modelStr });
  if (hold[modelStr]) await sleep(hold[modelStr]);
  if (highLoad.has(modelStr)) {
    return new Response(
      JSON.stringify({ error: { type: "api_error", message: "encountered unexpectedly high load" } }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      model: modelStr,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function send(
  comboName: string,
  messages: Array<{ role: string; content: string }>,
  config: Record<string, unknown> = {
    concurrencyPerModel: 2,
    queueTimeoutMs: 3000,
    maxRetries: 1,
    retryDelayMs: 10,
  }
) {
  return handleComboChat({
    body: { model: comboName, messages },
    combo: {
      name: comboName,
      strategy: "round-robin",
      models,
      config,
    },
    handleSingleModel: handleSingleModel as never,
    isModelAvailable: async () => true,
    log: quiet,
    settings: { promptCacheAffinityEnabled: false, disableSessionStickiness: false },
    allCombos: [],
    signal: null,
  } as never);
}
// The account a new conversation starts on depends on what ran before; each case makes the
// account it needs the high-load one after seeing where its first call went.
const firstModel = () => calls[0]?.model;

// 1. No pinned account: the high-load account is not asked again; one other account answers.
{
  calls = [];
  highLoad = new Set([A, B, C]);
  // Learn where this request starts, then let only that account be under high load.
  const probe = await send("shop-load-1", [{ role: "user", content: "probe-1" }]);
  await probe.text();
  // A new conversation starts on the account used least recently: the one the probe left out.
  const unused = [A, B, C].find((m) => !calls.some((c) => c.model === m)) ?? firstModel();
  calls = [];
  highLoad = new Set([unused!]);
  const answer = await send("shop-load-1", [{ role: "user", content: "new-1" }]);
  const modelsAsked = calls.map((c) => c.model);
  check(
    "a high-load answer moves a new request to another account that answers",
    answer.status === 200 &&
      highLoad.has(modelsAsked[0]) &&
      !highLoad.has(modelsAsked[modelsAsked.length - 1]),
    `status ${answer.status}, asked ${modelsAsked.join(" -> ")}`
  );
}

// 2. Every account under high load: the client hears the provider's own 500, no usage limit.
{
  calls = [];
  highLoad = new Set([A, B, C]);
  const answer = await send("shop-load-2", [{ role: "user", content: "new-2" }]);
  const text = await answer.text();
  check(
    "with every account under high load, the client gets the provider's 500, not a usage limit",
    answer.status === 500 && /high load/.test(text) && !/usage limit/i.test(text),
    `status ${answer.status}, asked ${calls.map((c) => c.model).join(" -> ")}`
  );
}

// 3. A conversation pinned to alpha: a high load there never sends it to another account, and
// its pin stays.
{
  calls = [];
  highLoad = new Set([A]);
  const turn = [
    { role: "user", content: "conv-p: turn 1" },
    { role: "assistant", content: "done" },
    { role: "user", content: "conv-p: turn 2" },
  ];
  const hash = sticky.deriveMessageHash(turn)!;
  sticky.recordStickyBinding(hash, "alpha");
  const answer = await send("shop-load-3", turn);
  await answer.text();
  const others = calls.filter((c) => c.model !== A);
  check(
    "a pinned conversation never leaves its account for a high-load answer",
    answer.status === 500 && calls.length >= 1 && others.length === 0,
    `status ${answer.status}, asked ${calls.map((c) => c.model).join(" -> ")}`
  );
  check(
    "a pinned conversation keeps its pin after a high-load answer",
    sticky.peekStickyConnectionId(hash) === "alpha",
    String(sticky.peekStickyConnectionId(hash))
  );
}


// 4. A pinned turn whose own account is full has gone on to another account; when THAT one says
// "high load", the turn tries the next free account instead of giving up with the 500.
{
  calls = [];
  highLoad = new Set([B]);
  hold[A] = 1500;
  const one = { concurrencyPerModel: 1, queueTimeoutMs: 2000, maxRetries: 1, retryDelayMs: 10 };
  const holdTurn = [{ role: "user", content: "hold-q" }];
  const turn = [
    { role: "user", content: "conv-q: turn 1" },
    { role: "assistant", content: "done" },
    { role: "user", content: "conv-q: turn 2" },
  ];
  sticky.recordStickyBinding(sticky.deriveMessageHash(holdTurn)!, "alpha");
  sticky.recordStickyBinding(sticky.deriveMessageHash(turn)!, "alpha");
  const holding = send("shop-load-4", holdTurn, one);
  await sleep(30);
  const answer = await send("shop-load-4", turn, one);
  await answer.text();
  await holding;
  hold[A] = 0;
  const asked = calls.filter((c) => c.tag === "conv-q: turn 2").map((c) => c.model);
  check(
    "a pinned turn already moved off its full account tries the next account after a high load",
    answer.status === 200 && asked[asked.length - 1] === C,
    `status ${answer.status}, asked ${asked.join(" -> ")}`
  );
}

sticky.clearAllStickyBindings();
sticky.__setStickinessHeadroomFetcherForTests(null);
sticky.__setStickinessConnectionFetcherForTests(null);
sticky.__setStickinessQuotaCheckerForTests(null);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
