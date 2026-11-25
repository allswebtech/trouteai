// Where new conversations of a round-robin combo start: on the least busy usable account, and
// among equally busy ones on the one used least recently; a later turn keeps the account of
// its conversation (its prompt cache). In-process, stand-in models, prompt-cache affinity on.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-new-conversations.mts
import { handleComboChat } from "../../open-sse/services/combo.ts";
import * as semaphore from "../../open-sse/services/rateLimitSemaphore.ts";
import * as sticky from "../../open-sse/services/combo/sessionStickiness.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

sticky.__setStickinessHeadroomFetcherForTests(async () => undefined);
sticky.__setStickinessConnectionFetcherForTests(async () => ({}));
sticky.__setStickinessQuotaCheckerForTests(() => false);

const A = "openai/fake-model-a";
const B = "openai/fake-model-b";
const models = [
  { model: A, connectionId: "alpha" },
  { model: B, connectionId: "bravo" },
];
const SYSTEM = "You are a coding agent. Work in the repository the user names.";
const calls: Array<{ tag: string; model: string }> = [];
const hold: Record<string, number> = {};

async function handleSingleModel(body: Record<string, unknown>, modelStr: string) {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const tag = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  calls.push({ tag, model: modelStr });
  await sleep(hold[modelStr] ?? 20);
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
  disableSessionStickiness = false
) {
  return handleComboChat({
    body: { model: comboName, messages },
    combo: {
      name: comboName,
      strategy: "round-robin",
      models,
      config: { concurrencyPerModel: 2, queueTimeoutMs: 3000, maxRetries: 0 },
    },
    handleSingleModel: handleSingleModel as never,
    isModelAvailable: async () => true,
    log: quiet,
    settings: { promptCacheAffinityEnabled: true, disableSessionStickiness },
    allCombos: [],
    signal: null,
  } as never);
}
const first = (c: string) => [
  { role: "system", content: SYSTEM },
  { role: "user", content: `${c}: turn 1` },
];
const second = (c: string) => [
  ...first(c),
  { role: "assistant", content: "done" },
  { role: "user", content: `${c}: turn 2` },
];
const servedBy = (tag: string) => calls.find((c) => c.tag === tag)?.model;

// 1. Ten new conversations with one system text, one after the other: they spread evenly
// instead of all hashing onto the account the shared prefix points at.
{
  const firsts: Record<string, number> = {};
  for (let n = 1; n <= 10; n++) {
    const answer = await send("shop-spread", first(`conv-${n}`));
    const m = servedBy(`conv-${n}: turn 1`) ?? "none";
    if (answer.status === 200) firsts[m] = (firsts[m] || 0) + 1;
  }
  check(
    "ten new conversations with one system text spread 5 and 5 over two idle accounts",
    firsts[A] === 5 && firsts[B] === 5,
    JSON.stringify(firsts)
  );
  // 2. The second turn of every conversation stays on the account of its first turn.
  const moved: string[] = [];
  for (let n = 1; n <= 10; n++) {
    await send("shop-spread", second(`conv-${n}`));
    if (servedBy(`conv-${n}: turn 2`) !== servedBy(`conv-${n}: turn 1`)) moved.push(`conv-${n}`);
  }
  check("every second turn stays on the account of its conversation", moved.length === 0, moved.join(","));
}

// 3. A new conversation goes to the account with fewer requests running, even when the other
// was used less recently.
{
  hold[A] = 400;
  hold[B] = 400;
  const running = [send("shop-busy", first("busy-1"))];
  await sleep(30);
  const busyModel = servedBy("busy-1: turn 1");
  running.push(send("shop-busy", first("busy-2")));
  await sleep(30);
  running.push(send("shop-busy", first("busy-3")));
  await Promise.all(running);
  const b2 = servedBy("busy-2: turn 1");
  const b3 = servedBy("busy-3: turn 1");
  check(
    "a new conversation starts on the account with fewer requests running",
    !!busyModel && b2 !== busyModel && !!b3,
    `busy-1 ${busyModel}, busy-2 ${b2}, busy-3 ${b3}`
  );
  hold[A] = 20;
  hold[B] = 20;
}

// 4. Two new conversations that arrive at the same moment start on two accounts.
{
  const together = await Promise.all([
    send("shop-together", first("together-1")),
    send("shop-together", first("together-2")),
  ]);
  const t1 = servedBy("together-1: turn 1");
  const t2 = servedBy("together-2: turn 1");
  check(
    "two new conversations that arrive together start on two accounts",
    together.every((r) => r.status === 200) && !!t1 && !!t2 && t1 !== t2,
    `${t1}, ${t2}`
  );
}

// 5. An account whose slots are paused (after a failed answer) is not where a new
// conversation starts.
{
  const before = calls.length;
  // Learn the slot key of alpha: it is the one still running after bravo has answered.
  hold[A] = 400;
  hold[B] = 20;
  const probe = [send("shop-pause", first("probe-1")), send("shop-pause", first("probe-2"))];
  await sleep(150);
  const gates = semaphore.getStats();
  const keyA = Object.entries(gates).find(
    ([k, s]) => k.startsWith("combo:shop-pause:") && s.running > 0
  )?.[0];
  await Promise.all(probe);
  hold[A] = 20;
  hold[B] = 20;
  if (keyA) semaphore.markRateLimited(keyA, 1500);
  const answers = [];
  for (let n = 1; n <= 3; n++) answers.push(await send("shop-pause", first(`pause-${n}`)));
  const served = [1, 2, 3].map((n) => servedBy(`pause-${n}: turn 1`));
  check(
    "a new conversation never starts on an account whose slots are paused",
    !!keyA && calls.length > before && answers.every((r) => r.status === 200) && served.every((m) => m === B),
    `key ${keyA}, served ${served.join(",")}`
  );
}

// 6. With session stickiness switched off no pin is kept, so the first turn is not moved off the
// account the shared prompt prefix points at: the second turn would land there and lose the cache.
{
  const moved: string[] = [];
  for (let n = 1; n <= 6; n++) {
    await send("shop-nopin", first(`np-${n}`), true);
    await send("shop-nopin", second(`np-${n}`), true);
    if (servedBy(`np-${n}: turn 2`) !== servedBy(`np-${n}: turn 1`)) moved.push(`np-${n}`);
  }
  check(
    "without session stickiness both turns of a conversation stay on one account",
    moved.length === 0,
    moved.join(",")
  );
}

sticky.clearAllStickyBindings();
sticky.__setStickinessHeadroomFetcherForTests(null);
sticky.__setStickinessConnectionFetcherForTests(null);
sticky.__setStickinessQuotaCheckerForTests(null);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
