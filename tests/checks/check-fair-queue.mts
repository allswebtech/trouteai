// The combo's fair queue: a request that finds every slot taken waits for the first slot that
// frees on any account, up to the wait budget; interactive goes before normal before
// background when slots are scarce; a client that leaves is taken out and never sent; past
// the budget the answer is a 429 that says the gateway is busy, with a Retry-After.
// In-process, round-robin combos with stand-in models that answer after a set time.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-fair-queue.mts
import { handleComboChat } from "../../open-sse/services/combo.ts";
import { busyResponse, waitForSlot } from "../../open-sse/services/combo/fairQueue.ts";
import * as semaphore from "../../open-sse/services/rateLimitSemaphore.ts";
import * as sticky from "../../open-sse/services/combo/sessionStickiness.ts";
import {
  ANTHROPIC_PING_FRAME,
  withEarlyStreamKeepalive,
} from "../../open-sse/utils/earlyStreamKeepalive.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const okAnswer = (model: string) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

// Every model answers after its own hold time; each call is written down with the request's
// tag (its user message) and the model it went to.
function standIn(holdMs: Record<string, number>, calls: Array<{ tag: string; model: string }>) {
  return async (body: Record<string, unknown>, modelStr: string) => {
    const messages = body.messages as Array<{ content: string }>;
    calls.push({ tag: messages[0].content, model: modelStr });
    await sleep(holdMs[modelStr] ?? 50);
    return okAnswer(modelStr);
  };
}

function run(
  comboName: string,
  models: string[],
  config: Record<string, unknown>,
  handleSingleModel: ReturnType<typeof standIn>,
  tag: string,
  extra: { priority?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  return handleComboChat({
    body: { model: comboName, messages: [{ role: "user", content: tag }] },
    combo: { name: comboName, strategy: "round-robin", models, config },
    handleSingleModel: handleSingleModel as never,
    isModelAvailable: async () => true,
    log: quiet,
    settings: { promptCacheAffinityEnabled: false, disableSessionStickiness: true },
    allCombos: [],
    signal: extra.signal ?? null,
    priority: extra.priority ?? null,
  } as never);
}

const A = "openai/fake-model-a";
const B = "openai/fake-model-b";

// 1. A waiting request takes the first slot that frees on ANY account, not the one it
// happened to land on: A is held 1500 ms, B 300 ms, budget 1000 ms.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 1500, [B]: 300 }, calls);
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 1000, maxRetries: 0 };
  const first = run("shop-first", [A, B], config, model, "r1");
  await sleep(20);
  const second = run("shop-first", [A, B], config, model, "r2");
  await sleep(20);
  const started = Date.now();
  const third = await run("shop-first", [A, B], config, model, "r3");
  const waited = Date.now() - started;
  await Promise.all([first, second]);
  const r3 = calls.find((c) => c.tag === "r3");
  check(
    "a waiting request gets the first slot that frees on any account, inside the budget",
    third.status === 200 && r3?.model === B && waited < 900,
    `status ${third.status}, served by ${r3?.model}, after ${waited} ms`
  );
}

// 2. Slots scarce: interactive before normal before background, first come first served
// within one priority.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 150 }, calls);
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 5000, maxRetries: 0 };
  const all = [run("shop-order", [A], config, model, "busy")];
  await sleep(20);
  const arrivals: Array<[string, string]> = [
    ["bg-1", "background"],
    ["normal-1", ""],
    ["int-1", "interactive"],
    ["int-2", "interactive"],
    ["normal-2", ""],
  ];
  for (const [tag, priority] of arrivals) {
    all.push(run("shop-order", [A], config, model, tag, { priority }));
    await sleep(10);
  }
  const answers = await Promise.all(all);
  const order = calls.map((c) => c.tag).join(",");
  check(
    "slots scarce: interactive, then normal, then background, FIFO within each",
    order === "busy,int-1,int-2,normal-1,normal-2,bg-1" && answers.every((r) => r.status === 200),
    order
  );
}

// 3. Free slots: the priority changes nothing, both start at once.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 200 }, calls);
  const config = { concurrencyPerModel: 4, queueTimeoutMs: 5000, maxRetries: 0 };
  const started = Date.now();
  const answers = await Promise.all([
    run("shop-free", [A], config, model, "bg", { priority: "background" }),
    run("shop-free", [A], config, model, "int", { priority: "interactive" }),
  ]);
  const took = Date.now() - started;
  check(
    "free slots: background and interactive both run at once",
    answers.every((r) => r.status === 200) && took < 380,
    `${took} ms`
  );
}

// 4. A client that leaves while waiting is taken out of the queue and never sent upstream.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 500 }, calls);
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 5000, maxRetries: 0 };
  const busy = run("shop-leave", [A], config, model, "busy");
  await sleep(20);
  const controller = new AbortController();
  const started = Date.now();
  const leaving = run("shop-leave", [A], config, model, "leaver", { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const answer = await leaving;
  const took = Date.now() - started;
  await busy;
  await sleep(50);
  check(
    "a client that leaves is removed from the queue at once and never sent",
    answer.status === 499 && took < 400 && !calls.some((c) => c.tag === "leaver"),
    `status ${answer.status} after ${took} ms, sent: ${calls.map((c) => c.tag).join(",")}`
  );
}

// 5. Past the budget: 429, a Retry-After in whole seconds, words that say the gateway is busy.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 1500, [B]: 1500 }, calls);
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 400, maxRetries: 0 };
  const held = [
    run("shop-busy", [A, B], config, model, "h1"),
    run("shop-busy", [A, B], config, model, "h2"),
  ];
  await sleep(30);
  const answer = await run("shop-busy", [A, B], config, model, "late");
  const text = await answer.text();
  const retryAfter = answer.headers.get("retry-after");
  await Promise.all(held);
  check(
    "past the budget: 429 with a whole-second Retry-After of at least 1",
    answer.status === 429 && /^[1-9][0-9]*$/.test(retryAfter ?? ""),
    `status ${answer.status} retry-after ${retryAfter}`
  );
  check(
    "past the budget: the words say the gateway is busy, never a usage limit",
    text.includes("The gateway is busy: all 2 slots of combo 'shop-busy' are in use") &&
      !/usage limit/i.test(text) &&
      !calls.some((c) => c.tag === "late"),
    text.slice(0, 200)
  );
}

// 6. A slot the queue handed over goes back when a check before the call throws; otherwise
// the account stays "full" until a restart and every later request waits out the budget.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 300 }, calls);
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 1500, maxRetries: 0 };
  let lookups = 0;
  const isModelAvailable = async () => {
    lookups++;
    if (lookups === 3) throw new Error("credential lookup failed");
    return true;
  };
  const go = (tag: string) =>
    handleComboChat({
      body: { model: "shop-leak", messages: [{ role: "user", content: tag }] },
      combo: { name: "shop-leak", strategy: "round-robin", models: [A], config },
      handleSingleModel: model as never,
      isModelAvailable,
      log: quiet,
      settings: { promptCacheAffinityEnabled: false, disableSessionStickiness: true },
      allCombos: [],
      signal: null,
    } as never);
  const hold = go("hold");
  await sleep(20);
  await go("r2").catch(() => null);
  await hold;
  await sleep(50);
  const inUse = Object.entries(semaphore.getStats())
    .filter(([k]) => k.startsWith("combo:shop-leak:"))
    .reduce((sum, [, s]) => sum + s.running, 0);
  const started = Date.now();
  const r3 = await go("r3");
  check(
    "a handed-over slot is released when a check before the call throws",
    inUse === 0 && r3.status === 200 && Date.now() - started < 1000,
    `slots in use ${inUse}, next request ${r3.status} after ${Date.now() - started} ms`
  );
}

// 7. A conversation pinned to a full account waits for it only a short while, then takes the
// other account's free slot instead of waiting out the budget and hearing "busy".
{
  sticky.__setStickinessHeadroomFetcherForTests(async () => undefined);
  sticky.__setStickinessConnectionFetcherForTests(async () => ({}));
  sticky.__setStickinessQuotaCheckerForTests(() => false);
  const calls: Array<{ tag: string; model: string }> = [];
  const model = standIn({ [A]: 1500, [B]: 50 }, calls);
  const models = [
    { model: A, connectionId: "alpha" },
    { model: B, connectionId: "beta" },
  ];
  const config = { concurrencyPerModel: 1, queueTimeoutMs: 1000, maxRetries: 0 };
  for (const text of ["hold-1", "conv-x"]) {
    sticky.recordStickyBinding(
      sticky.deriveMessageHash([{ role: "user", content: text }]),
      "alpha"
    );
  }
  const go = (tag: string) =>
    handleComboChat({
      body: { model: "shop-pin", messages: [{ role: "user", content: tag }] },
      combo: { name: "shop-pin", strategy: "round-robin", models, config },
      handleSingleModel: model as never,
      isModelAvailable: async () => true,
      log: quiet,
      settings: { promptCacheAffinityEnabled: false, disableSessionStickiness: false },
      allCombos: [],
      signal: null,
    } as never);
  const hold = go("hold-1");
  await sleep(30);
  const started = Date.now();
  const answer = await go("conv-x");
  const took = Date.now() - started;
  await hold;
  const served = calls.find((c) => c.tag === "conv-x")?.model;
  check(
    "a pinned turn whose account is full moves to a free account inside the budget",
    answer.status === 200 && served === B && took < 900,
    `status ${answer.status}, served by ${served}, after ${took} ms`
  );
  sticky.clearAllStickyBindings();
  sticky.__setStickinessHeadroomFetcherForTests(null);
  sticky.__setStickinessConnectionFetcherForTests(null);
  sticky.__setStickinessQuotaCheckerForTests(null);
}

// 8. A rate-limit pause on an idle account holds, and its end hands out every free slot.
{
  const key = "combo:shop-pause:direct";
  semaphore.markRateLimited(key, 300);
  const early = semaphore.tryAcquire(key, 3);
  early?.();
  check("a pause on an idle account keeps new requests out", early === null);
  const started = Date.now();
  const grants = await Promise.all(
    [1, 2, 3].map(() =>
      waitForSlot("shop-pause", [{ key, max: 3 }], {
        priority: "normal",
        deadlineMs: Date.now() + 2000,
      })
    )
  );
  const took = Date.now() - started;
  for (const g of grants) g.granted?.release();
  check(
    "the end of a pause hands a slot to every waiter it has room for",
    grants.every((g) => g.granted) && took >= 250 && took < 800,
    `${grants.filter((g) => g.granted).length} of 3 granted after ${took} ms`
  );
}

// 8b. A usage-limit 429 with a long reset pauses that account's slots for a few seconds at
// most: the account's own limit is kept elsewhere, and a long pause here outlived it, so the
// account stayed out of the rotation after it was usable again.
{
  const calls: Array<{ tag: string; model: string }> = [];
  const model = async (body: Record<string, unknown>, modelStr: string) => {
    const messages = body.messages as Array<{ content: string }>;
    calls.push({ tag: messages[0].content, model: modelStr });
    if (modelStr === A) {
      return new Response(JSON.stringify({ error: { message: "usage limit reached" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }
    return okAnswer(modelStr);
  };
  const config = { concurrencyPerModel: 2, queueTimeoutMs: 5000, maxRetries: 0 };
  await run("shop-limit", [A, B], config, model as never, "limit-1");
  const pauses = Object.entries(semaphore.getStats())
    .filter(([key, s]) => key.startsWith("combo:shop-limit:") && s.rateLimitedUntil)
    .map(([, s]) => new Date(s.rateLimitedUntil as string).getTime() - Date.now());
  const longest = pauses.length ? Math.max(...pauses) : 0;
  check(
    "a long usage-limit reset pauses the account's slots for a few seconds at most",
    calls.some((c) => c.model === A) && pauses.length > 0 && longest <= 5000,
    `pauses ${pauses.map((p) => Math.round(p)).join(",") || "none"} ms`
  );
}

// 9. A streamed Anthropic client whose answer was held past the keep-alive start: the busy
// refusal arrives as an Anthropic error event with the retry seconds.
{
  const late = new Promise<Response>((resolve) =>
    setTimeout(() => resolve(busyResponse("shop-stream", 2, 3, 7)), 150)
  );
  const res = await withEarlyStreamKeepalive(late, {
    thresholdMs: 20,
    intervalMs: 250,
    keepaliveFrame: ANTHROPIC_PING_FRAME,
  });
  const text = await res.text();
  const line = (text.match(/event: error\ndata: (.*)/) || [])[1] || "{}";
  let frame: { type?: string; error?: Record<string, unknown> } = {};
  try {
    frame = JSON.parse(line);
  } catch {}
  check(
    "a late busy refusal in a stream is an Anthropic error event with the retry seconds",
    frame.type === "error" &&
      frame.error?.type === "rate_limit_error" &&
      frame.error?.retry_after === 7 &&
      /The gateway is busy/.test(String(frame.error?.message)),
    line.slice(0, 220)
  );
}

if (failed > 0) process.exitCode = 1;
