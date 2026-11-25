// Built-in swaps are off unless the user turned them on: a request gets the model it asked for,
// or the real error. Each switch, when on, keeps the old behaviour. In-process, no server.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-swaps.mts
import {
  getNextFamilyFallback,
  isModelFamilyFallbackEnabled,
} from "../../open-sse/services/modelFamilyFallback.ts";
import {
  resetEmergencyFallbackEnvCache,
  shouldUseFallback,
} from "../../open-sse/services/emergencyFallback.ts";
import {
  getBuiltInSuccessorAliases,
  resolveModelAliasWithKind,
  setCustomAliases,
  setRetiredModelSuccessorsEnabled,
} from "../../open-sse/services/modelDeprecation.ts";
import {
  getModelInfoCore,
  isBareModelConnectionDefaultForAnyName,
  resolveBareModelToConnectionDefault,
} from "../../open-sse/services/model.ts";
import { resolveBackgroundTaskRedirect } from "../../open-sse/handlers/chatCore/backgroundRedirect.ts";
import {
  getDefaultDegradationMap,
  setBackgroundDegradationConfig,
} from "../../open-sse/services/backgroundTaskDetector.ts";
import {
  applyTaskAwareRouting,
  hydrateTaskRoutingConfig,
} from "../../open-sse/services/taskAwareRouter.ts";
import { buildRuntimeSettingsSnapshot } from "../../src/lib/config/runtimeSettings.ts";
import {
  combineAnswerFallbackFacts,
  getAnswerFallbackFacts,
  runAsAnswerFallback,
} from "../../open-sse/services/answerFallbackContext.ts";
import { getCallLogById, saveCallLog } from "../../src/lib/usage/callLogs.ts";
import { executeRuntimeUnitCombo } from "../../open-sse/services/combo/runtimeUnits.ts";
import { tryPinnedModelDispatch } from "../../open-sse/services/combo/dispatchPrelude.ts";
import { handleFusionChat } from "../../open-sse/services/fusion.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import {
  removeFeatureFlagOverride,
  setFeatureFlagOverride,
} from "../../src/lib/db/featureFlags.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// 1. Family fallback: off when never stored or stored false, on only when stored true
{
  check(
    "family fallback: off when the setting was never stored",
    isModelFamilyFallbackEnabled({}) === false && isModelFamilyFallbackEnabled(null) === false
  );
  check(
    "family fallback: off when stored false, on when stored true",
    isModelFamilyFallbackEnabled({ modelFamilyFallback: false }) === false &&
      isModelFamilyFallbackEnabled({ modelFamilyFallback: true }) === true
  );
  // the table itself is unchanged: switched on, a sibling is still found
  const next = getNextFamilyFallback("claude-opus-4-7", new Set(["claude-opus-4-7"]));
  check("family fallback: switched on, the family table still names a sibling", !!next, `${next}`);
}

// 2. Emergency fallback: off by default, on by the environment or a stored flag
{
  const saved = process.env.TROUTEAI_EMERGENCY_FALLBACK;
  const decide = () => {
    resetEmergencyFallbackEnvCache();
    return shouldUseFallback(402, "payment required", false);
  };
  delete process.env.TROUTEAI_EMERGENCY_FALLBACK;
  removeFeatureFlagOverride("TROUTEAI_EMERGENCY_FALLBACK");
  const def = decide();
  check("emergency: off when nothing is set", def.shouldFallback === false, def.reason);
  process.env.TROUTEAI_EMERGENCY_FALLBACK = "true";
  const env = decide();
  check(
    "emergency: TROUTEAI_EMERGENCY_FALLBACK=true turns it on, same target as before",
    env.shouldFallback === true && env.provider === "nvidia" && env.model === "openai/gpt-oss-120b",
    env.reason
  );
  // a value the user stored in the dashboard wins over the environment and the default
  setFeatureFlagOverride("TROUTEAI_EMERGENCY_FALLBACK", "false");
  const storedOff = decide();
  delete process.env.TROUTEAI_EMERGENCY_FALLBACK;
  setFeatureFlagOverride("TROUTEAI_EMERGENCY_FALLBACK", "true");
  const storedOn = decide();
  check(
    "emergency: a stored choice stays (stored off beats env on, stored on beats default off)",
    storedOff.shouldFallback === false && storedOn.shouldFallback === true
  );
  removeFeatureFlagOverride("TROUTEAI_EMERGENCY_FALLBACK");
  if (saved === undefined) delete process.env.TROUTEAI_EMERGENCY_FALLBACK;
  else process.env.TROUTEAI_EMERGENCY_FALLBACK = saved;
  resetEmergencyFallbackEnvCache();
}

// 3. Built-in aliases: another spelling of the same model always applies (and is no fallback);
// a retired name answered by its successor applies only when switched on
{
  setCustomAliases({});
  setRetiredModelSuccessorsEnabled(false);
  const spelling = resolveModelAliasWithKind("kimi-k2");
  check(
    "alias: a spelling of the same model applies with the switch off",
    spelling.model === "moonshotai/Kimi-K2" && spelling.kind === "spelling",
    JSON.stringify(spelling)
  );
  const off = resolveModelAliasWithKind("claude-3-opus-20240229");
  check(
    "alias: a retired name is sent as is with the switch off",
    off.model === "claude-3-opus-20240229" && off.kind === null,
    JSON.stringify(off)
  );
  const successors = Object.keys(getBuiltInSuccessorAliases());
  const leaked = successors.filter((id) => resolveModelAliasWithKind(id).model !== id);
  check("alias: no successor entry applies with the switch off", leaked.length === 0, `${leaked}`);
  const gh = await getModelInfoCore("gh/gemini-3-pro", {});
  check(
    "alias: the provider table's successor (gh gemini-3-pro) is off too",
    gh.model === "gemini-3-pro",
    JSON.stringify(gh)
  );
  setRetiredModelSuccessorsEnabled(true);
  const on = resolveModelAliasWithKind("claude-3-opus-20240229");
  const ghOn = await getModelInfoCore("gh/gemini-3-pro", {});
  check(
    "alias: switched on, the retired name gets its successor as before",
    on.model === "claude-opus-4-20250514" &&
      on.kind === "successor" &&
      ghOn.model === "gemini-3.1-pro-preview",
    `${JSON.stringify(on)} ${ghOn.model}`
  );
  setRetiredModelSuccessorsEnabled(false);
  setCustomAliases({ "my-name": "claude-opus-4-20250514" });
  const custom = resolveModelAliasWithKind("my-name");
  check(
    "alias: the user's own alias is untouched by the switch",
    custom.model === "claude-opus-4-20250514" && custom.kind === "custom"
  );
  setCustomAliases({});
  check(
    "alias: the runtime setting is off when never stored, on only when stored true",
    buildRuntimeSettingsSnapshot({}).answerRetiredModelsWithSuccessor === false &&
      buildRuntimeSettingsSnapshot({ answerRetiredModelsWithSuccessor: true })
        .answerRetiredModelsWithSuccessor === true
  );
}

// 4. A connection's default model answers only a request that named no model of its own
{
  const def = "fake-default-model";
  const pick = (asked: string | null, resolved: string | null, anyBareName = false) =>
    resolveBareModelToConnectionDefault(asked, resolved, def, { anyBareName });
  check(
    "bare default: no model, an empty name and auto get the connection's default",
    pick(null, null) === def && pick("", "") === def && pick("auto", "auto") === def,
    `${pick(null, null)} ${pick("", "")} ${pick("auto", "auto")}`
  );
  check(
    "bare default: a user alias that resolved to auto gets the default too",
    pick("my-auto", "auto") === def
  );
  check(
    "bare default: any other bare name goes on as asked (it ends in model-not-found)",
    pick("some-unknown-model", "some-unknown-model") === "some-unknown-model"
  );
  check(
    "bare default: a provider/model name is never touched",
    pick("am/some-model", "some-model", true) === "some-model"
  );
  check(
    "bare default: the setting brings back the old rule for every bare name",
    pick("some-unknown-model", "some-unknown-model", true) === def &&
      isBareModelConnectionDefaultForAnyName({ bareModelUsesConnectionDefault: true }) &&
      !isBareModelConnectionDefaultForAnyName({})
  );
}

// 5. Background-task redirect and task routing stay off unless the user turns them on
{
  const [heavy, light] = Object.entries(getDefaultDegradationMap()).find(([a, b]) => a !== b) ?? [
    "",
    "",
  ];
  const bgHeaders = { "x-task-type": "background" };
  const bgBody = { model: heavy, messages: [{ role: "user", content: "title this chat" }] };
  setBackgroundDegradationConfig({ enabled: false });
  const off = resolveBackgroundTaskRedirect({ body: bgBody, headers: bgHeaders, model: heavy });
  setBackgroundDegradationConfig({ enabled: true });
  const on = resolveBackgroundTaskRedirect({ body: bgBody, headers: bgHeaders, model: heavy });
  setBackgroundDegradationConfig({ enabled: false });
  check(
    "background redirect: off by default, a background request keeps its model",
    !!heavy && off.redirect === null,
    `${heavy}`
  );
  check(
    "background redirect: switched on, the same request is redirected as before",
    on.redirect?.degradedModel === light,
    JSON.stringify(on.redirect)
  );
  hydrateTaskRoutingConfig({});
  const routed = applyTaskAwareRouting("claude-opus-4-20250514", {
    messages: [{ role: "user", content: "Summarize this text in one line: hello world" }],
  });
  check(
    "task routing: off when nothing is stored, the model stays",
    routed.wasRouted === false && routed.model === "claude-opus-4-20250514",
    JSON.stringify(routed)
  );
}

// 6. The layers around an attempt pass their reason in; the log row keeps the reasons and count
{
  const seen = await runAsAnswerFallback({ fallback: "global", attempts: 2 }, () =>
    runAsAnswerFallback({ fallback: "combo-step", attempts: 1 }, async () =>
      getAnswerFallbackFacts()
    )
  );
  check(
    "fallback store: inner layer first, attempts add up, nothing outside a run",
    seen?.fallback === "combo-step, global" &&
      seen?.attempts === 3 &&
      getAnswerFallbackFacts() === null,
    JSON.stringify(seen)
  );
  const both = combineAnswerFallbackFacts({ fallback: "family", attempts: 1 }, seen);
  check(
    "fallback store: an attempt's own token comes before the outer ones",
    both.fallback === "family, combo-step, global" && both.attempts === 4,
    JSON.stringify(both)
  );
  const id = "swaps-check-log-1";
  await saveCallLog({
    id,
    status: 200,
    model: "fake-model-b",
    requestedModel: "fake-model-a",
    provider: "fake-provider",
    fallback: "combo-step, global",
    fallbackAttempts: 3,
  });
  const plainId = "swaps-check-log-2";
  await saveCallLog({ id: plainId, status: 200, model: "fake-model-a", provider: "fake-provider" });
  const row = (await getCallLogById(id)) as Record<string, unknown> | null;
  const plain = (await getCallLogById(plainId)) as Record<string, unknown> | null;
  check(
    "log row: fallback reasons and attempts are stored and read back",
    row?.fallback === "combo-step, global" && row?.fallbackAttempts === 3,
    `${row?.fallback} ${row?.fallbackAttempts}`
  );
  check(
    "log row: a first-choice answer has no fallback and 0 attempts",
    plain?.fallback === null && plain?.fallbackAttempts === 0,
    `${plain?.fallback} ${plain?.fallbackAttempts}`
  );
}

// 7. The other ways a combo dispatches mark a later answer like the shared loop does
{
  const quiet = { info() {}, warn() {}, debug() {}, error() {} };
  const okBody = (model: string) =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-fake",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content: `answer from ${model}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const failing = new Set(["openai/fake-first"]);
  const seenFacts: Record<string, unknown> = {};
  const fakeSingle = async (_b: unknown, modelStr: string) => {
    seenFacts[modelStr] = getAnswerFallbackFacts();
    return failing.has(modelStr)
      ? new Response('{"error":{"message":"fake outage"}}', { status: 503 })
      : okBody(modelStr);
  };
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
  const exec = await executeRuntimeUnitCombo({
    body: { model: "fake-combo", messages: [{ role: "user", content: "hi" }] },
    combo: { name: "fake-combo", models: [] },
    strategy: "priority",
    units: [unit("openai/fake-first"), unit("openai/fake-second")],
    handleSingleModel: fakeSingle as never,
    log: quiet as never,
    config: { maxRetries: 0, retryDelayMs: 0 },
    settings: {},
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 3,
      visitedComboNames: ["fake-combo"],
      rootComboName: "fake-combo",
      attemptBudget: { count: 0, limit: 50 },
    },
    baseOptions: {} as never,
    runCombo: (async () => okBody("x")) as never,
  });
  const facts = seenFacts["openai/fake-second"] as { fallback?: string; attempts?: number } | null;
  check(
    "runtime units: a later unit answering is marked combo-step in the headers and the log facts",
    exec.response.ok &&
      exec.response.headers.get("X-TRouteAI-Fallback") === "combo-step" &&
      exec.response.headers.get("X-TRouteAI-Fallback-Attempts") === "1" &&
      facts?.fallback === "combo-step" &&
      facts?.attempts === 1 &&
      seenFacts["openai/fake-first"] === null,
    `${exec.response.headers.get("X-TRouteAI-Fallback")} ${JSON.stringify(facts)}`
  );

  const fusion = await handleFusionChat({
    body: { model: "fake-fusion", messages: [{ role: "user", content: "hi" }] },
    models: ["openai/fake-first", "openai/fake-second"],
    handleSingleModel: fakeSingle as never,
    log: quiet as never,
    comboName: "fake-fusion",
  } as never);
  check(
    "fusion: one panel member answering alone is marked combo-step",
    fusion.ok &&
      fusion.headers.get("X-TRouteAI-Fallback") === "combo-step" &&
      fusion.headers.get("X-TRouteAI-Fallback-Attempts") === "1",
    `${fusion.status} ${fusion.headers.get("X-TRouteAI-Fallback")}`
  );

  await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "fake-pin-conn",
    apiKey: "fake-key-not-real",
    isActive: true,
  });
  const pinCombo = {
    name: "fake-pin-combo",
    models: ["openai/fake-second", "openai/fake-third"],
  };
  const pinArgs = (pinnedModel: string) => ({
    body: { model: "fake-pin-combo", messages: [{ role: "user", content: "hi" }] },
    combo: pinCombo,
    pinnedModel,
    allCombos: [pinCombo],
    config: {} as never,
    clientRequestedStream: false,
    handleSingleModelWithTimeout: fakeSingle as never,
    log: quiet as never,
  });
  const pinLater = await tryPinnedModelDispatch(pinArgs("openai/fake-third"));
  const pinFirst = await tryPinnedModelDispatch(pinArgs("openai/fake-second"));
  check(
    "context pin: a pin that bypasses the first target is marked context-pin",
    !!pinLater &&
      pinLater.ok &&
      pinLater.headers.get("X-TRouteAI-Fallback") === "context-pin" &&
      (seenFacts["openai/fake-third"] as { fallback?: string } | null)?.fallback === "context-pin",
    `${pinLater?.status} ${pinLater?.headers.get("X-TRouteAI-Fallback")}`
  );
  check(
    "context pin: a pin on the first target is no fallback",
    !!pinFirst && pinFirst.ok && !pinFirst.headers.get("X-TRouteAI-Fallback"),
    `${pinFirst?.status} ${pinFirst?.headers.get("X-TRouteAI-Fallback")}`
  );
}

if (failed > 0) process.exitCode = 1;
