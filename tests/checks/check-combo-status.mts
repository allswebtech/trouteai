// The opt-in combo strategies answer like the shared combo loop when nothing answered: any
// outage among the attempts is a 5xx (never a 429), and only when every attempt was limited is
// the answer a 429, with the earliest reset and, for a used-up window, the plan-usage headers.
// Covers nested combos in "execute" mode, fusion and pipeline. In-process, fake answers only.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-combo-status.mts
import { executeRuntimeUnitCombo } from "../../open-sse/services/combo/runtimeUnits.ts";
import { handleFusionChat } from "../../open-sse/services/fusion.ts";
import { handlePipelineChat } from "../../open-sse/services/pipeline.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const nowSec = () => Math.floor(Date.now() / 1000);

// What each fake model answers: "limit:<seconds>" is a used-up usage window that resets in
// that many seconds, "burst" a short 429 with no window, a number an outage with that status.
type Mode = string | number;
function answer(mode: Mode): Response {
  if (typeof mode === "number") {
    return new Response(JSON.stringify({ error: { message: "fake outage" } }), {
      status: mode,
      headers: { "content-type": "application/json" },
    });
  }
  if (mode === "burst") {
    return new Response(JSON.stringify({ error: { message: "fake burst limit" } }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "5" },
    });
  }
  const seconds = Number(mode.split(":")[1]);
  return new Response(JSON.stringify({ error: { message: "fake usage limit" } }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(seconds),
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(nowSec() + seconds),
    },
  });
}
const fakeModels = (modes: Record<string, Mode>) => async (_body: unknown, modelStr: string) =>
  answer(modes[modelStr] ?? 503);

const summary = (r: Response) =>
  `status ${r.status} retry-after ${r.headers.get("retry-after")} unified ${r.headers.get(
    "anthropic-ratelimit-unified-status"
  )}/${r.headers.get("anthropic-ratelimit-unified-reset")}`;
const retryAfterNear = (r: Response, sec: number) => {
  const ra = Number(r.headers.get("retry-after"));
  return Number.isFinite(ra) && ra <= sec && ra >= sec - 60;
};
const unifiedResetNear = (r: Response, sec: number) =>
  r.headers.get("anthropic-ratelimit-unified-status") === "rejected" &&
  Math.abs(Number(r.headers.get("anthropic-ratelimit-unified-reset")) - (nowSec() + sec)) <= 60;
const isOutage = (r: Response) => r.status >= 500;
const noLongWait = (r: Response) => {
  const ra = r.headers.get("retry-after");
  return ra === null || Number(ra) <= 60;
};

// ── nested combos in "execute" mode ─────────────────────────────────────────────────────
const unit = (modelStr: string) => ({
  kind: "model" as const,
  stepId: modelStr,
  executionKey: modelStr,
  modelStr,
  provider: "openai",
  providerId: null,
  connectionId: null,
  weight: 1,
  label: null,
});
async function runUnits(modes: Record<string, Mode>) {
  const result = await executeRuntimeUnitCombo({
    body: { model: "fake-units", messages: [{ role: "user", content: "hi" }] },
    combo: { name: "fake-units", models: [] },
    strategy: "priority",
    units: Object.keys(modes).map(unit),
    handleSingleModel: fakeModels(modes) as never,
    log: quiet as never,
    config: { maxRetries: 0, retryDelayMs: 0 },
    settings: {},
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 3,
      visitedComboNames: ["fake-units"],
      rootComboName: "fake-units",
      attemptBudget: { count: 0, limit: 50 },
    },
    baseOptions: {} as never,
    runCombo: (async () => answer(503)) as never,
  });
  return result.response;
}
{
  const r = await runUnits({ "openai/fake-a": 504, "openai/fake-b": "limit:3600" });
  check(
    "nested execute: an outage, then a usage limit: a 5xx, never 429, no long retry-after",
    isOutage(r) && noLongWait(r) && !r.headers.get("anthropic-ratelimit-unified-status"),
    summary(r)
  );
}
{
  const r = await runUnits({ "openai/fake-a": "limit:1800", "openai/fake-b": "limit:900" });
  check(
    "nested execute: every unit at its usage limit: 429 with the earliest reset and unified headers",
    r.status === 429 && retryAfterNear(r, 900) && unifiedResetNear(r, 900),
    summary(r)
  );
}
{
  const r = await runUnits({ "openai/fake-a": "limit:1800", "openai/fake-b": "burst" });
  check(
    "nested execute: a usage limit and a short burst: 429 without the plan-usage headers",
    r.status === 429 && !r.headers.get("anthropic-ratelimit-unified-status"),
    summary(r)
  );
}

// ── fusion ──────────────────────────────────────────────────────────────────────────────
async function runFusion(modes: Record<string, Mode>) {
  return handleFusionChat({
    body: { model: "fake-fusion", messages: [{ role: "user", content: "hi" }] },
    models: Object.keys(modes),
    handleSingleModel: fakeModels(modes) as never,
    log: quiet as never,
    comboName: "fake-fusion",
  } as never);
}
{
  const r = await runFusion({ "openai/fake-a": 503, "openai/fake-b": "limit:3600" });
  check(
    "fusion: one member down, one at its usage limit: a 5xx, never 429",
    isOutage(r) && noLongWait(r) && !r.headers.get("anthropic-ratelimit-unified-status"),
    summary(r)
  );
}
{
  const r = await runFusion({ "openai/fake-a": "limit:1800", "openai/fake-b": "limit:900" });
  check(
    "fusion: every member at its usage limit: 429 with the earliest reset and unified headers",
    r.status === 429 && retryAfterNear(r, 900) && unifiedResetNear(r, 900),
    summary(r)
  );
}

// ── pipeline ────────────────────────────────────────────────────────────────────────────
async function runPipeline(modes: Record<string, Mode>) {
  return handlePipelineChat({
    body: { model: "fake-pipeline", messages: [{ role: "user", content: "hi" }] },
    steps: Object.keys(modes).map((model) => ({ model })),
    handleSingleModel: fakeModels(modes) as never,
    log: quiet as never,
    comboName: "fake-pipeline",
    maxRetries: 0,
    retryDelayMs: 0,
  });
}
{
  const r = await runPipeline({ "openai/fake-a": "limit:1200", "openai/fake-b": 200 });
  check(
    "pipeline: a step at its usage limit: 429 with the step's retry-after and unified headers",
    r.status === 429 && retryAfterNear(r, 1200) && unifiedResetNear(r, 1200),
    summary(r)
  );
}
{
  const r = await runPipeline({ "openai/fake-a": 503, "openai/fake-b": 200 });
  check(
    "pipeline: a step down: its 5xx, never 429",
    r.status === 503 && noLongWait(r) && !r.headers.get("anthropic-ratelimit-unified-status"),
    summary(r)
  );
}

process.exit(failed === 0 ? 0 : 1);
