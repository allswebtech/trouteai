// A key's default priority, a Responses turn that names its previous answer, and an account whose
// quota is used up. In-process, stand-in models and made-up data only.
//
// 1. A key stores a default priority (interactive, normal, background); a request without the
//    x-trouteai-priority header waits with it, a request with a valid header waits with the
//    header's. A store made before the field existed opens with its keys unchanged.
// 2. A Responses turn that sends only its new input (previous_response_id) goes to the account
//    that gave the answer it names; an unknown id is placed like a new conversation.
// 3. An account whose quota is used up is not the first pick of a new conversation.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-key-priority.mts
import { randomUUID } from "node:crypto";

process.env.INITIAL_PASSWORD = "Check-Pass-123";
process.env.JWT_SECRET = randomUUID() + randomUUID();
process.env.API_KEY_SECRET ||= "fake-check-secret-0000000000000000";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const sticky = await import("../../open-sse/services/combo/sessionStickiness.ts");
const leastBusy = await import("../../open-sse/services/combo/leastBusy.ts");
const { resolveRequestPriority } = await import("../../open-sse/services/combo/fairQueue.ts");
const { createApiKey, getApiKeyMetadata, updateApiKeyPermissions, resetApiKeyState } =
  await import("../../src/lib/db/apiKeys.ts");
const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
const { updateKeyPermissionsSchema } = await import("../../src/shared/validation/schemas/keys.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { markAccountExhaustedFrom429 } = await import("../../src/domain/quotaCache.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ── 1. A key's default priority ─────────────────────────────────────────────────────────
check("no header, normal key: normal", resolveRequestPriority(null, "normal") === "normal");
check(
  "no header, background key: background",
  resolveRequestPriority(null, "background") === "background"
);
check(
  "no header, interactive key: interactive",
  resolveRequestPriority("", "interactive") === "interactive"
);
check(
  "the header wins over the key",
  resolveRequestPriority("interactive", "background") === "interactive"
);
check("a header of normal wins too", resolveRequestPriority("Normal", "interactive") === "normal");
check(
  "a header with another value does not lift a background key",
  resolveRequestPriority("urgent", "background") === "background"
);
check("an unknown key default is normal", resolveRequestPriority(null, "urgent") === "normal");
check(
  "the key page's update takes the three values only",
  updateKeyPermissionsSchema.safeParse({ defaultPriority: "background" }).success &&
    !updateKeyPermissionsSchema.safeParse({ defaultPriority: "urgent" }).success
);

const created = (await createApiKey("shop-batch", "fake-machine-0001")) as {
  id: string;
  key: string;
};
const fresh = await getApiKeyMetadata(created.key);
check(
  "a new key waits as normal",
  fresh?.defaultPriority === "normal",
  String(fresh?.defaultPriority)
);
await updateApiKeyPermissions(created.id, { defaultPriority: "background" });
const saved = await getApiKeyMetadata(created.key);
check(
  "the default is stored with the key",
  saved?.defaultPriority === "background",
  String(saved?.defaultPriority)
);

// A store of the version before: no default_priority column and no record of its migration.
// It opens with the key as it was, and the key waits as normal.
await updateApiKeyPermissions(created.id, { defaultPriority: "normal", maxSessions: 3 });
const db = getDbInstance() as unknown as {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    get: (...a: unknown[]) => Record<string, unknown>;
    all: () => Array<Record<string, unknown>>;
  };
};
db.exec("ALTER TABLE api_keys DROP COLUMN default_priority");
db.exec("DELETE FROM _trouteai_migrations WHERE name LIKE '%default_priority%'");
const before = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(created.id);
const hadColumn = db
  .prepare("PRAGMA table_info(api_keys)")
  .all()
  .some((c) => c.name === "default_priority");
check("the older store has no default_priority column", !hadColumn);
resetDbInstance();
resetApiKeyState();
const reopened = getDbInstance() as unknown as typeof db;
const after = reopened.prepare("SELECT * FROM api_keys WHERE id = ?").get(created.id);
const changed = Object.keys(before).filter((k) => String(before[k]) !== String(after?.[k]));
check(
  "the older store opens with the key unchanged",
  !!after && changed.length === 0,
  changed.join(",")
);
check(
  "its key gets the default normal",
  after?.default_priority === "normal",
  String(after?.default_priority)
);
const reread = await getApiKeyMetadata(created.key);
check(
  "its key reads as before",
  reread?.defaultPriority === "normal" && reread?.maxSessions === 3 && reread?.name === "shop-batch"
);

// ── 2. A Responses turn follows the answer it names ─────────────────────────────────────
sticky.__setStickinessHeadroomFetcherForTests(async () => undefined);
sticky.__setStickinessConnectionFetcherForTests(async () => ({}));
sticky.__setStickinessQuotaCheckerForTests(() => false);
leastBusy.resetSlotUse();

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const models = [
  { model: "openai/fake-model-a", connectionId: "alpha" },
  { model: "openai/fake-model-b", connectionId: "bravo" },
];
const account = (modelStr: string) => (modelStr.endsWith("-a") ? "alpha" : "bravo");
let answers = 0;
const served: Record<string, string> = {};

async function handleSingleModel(body: Record<string, unknown>, modelStr: string) {
  const input = body.input as unknown;
  const tag =
    typeof input === "string"
      ? input
      : String((input as Array<{ content?: unknown }>).at(-1)?.content ?? "");
  served[tag] = account(modelStr);
  const id = `resp_${++answers}${account(modelStr)}`;
  if (body.stream === true) {
    const events =
      `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed" } })}\n\n`;
    return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(
    JSON.stringify({
      id,
      object: "response",
      model: modelStr,
      output: [
        {
          id: `msg_${answers}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function send(body: Record<string, unknown>) {
  const res = (await handleComboChat({
    body: { model: "resp-combo", ...body },
    combo: {
      name: "resp-combo",
      strategy: "round-robin",
      models,
      config: { concurrencyPerModel: 2, queueTimeoutMs: 3000, maxRetries: 0 },
    },
    handleSingleModel: handleSingleModel as never,
    isModelAvailable: async () => true,
    log: quiet,
    settings: { promptCacheAffinityEnabled: true },
    allCombos: [],
    signal: null,
  } as never)) as Response;
  const text = await res.text();
  const id = (text.match(/"id":"(resp_[^"]+)"/) || [])[1] ?? null;
  return { status: res.status, text, id };
}

const t1 = await send({ input: "shop: turn 1" });
const home = served["shop: turn 1"];
// The account of turn 1 was picked last, so a new conversation would now start on the other one.
const t2 = await send({
  previous_response_id: t1.id,
  input: [{ role: "user", content: "shop: turn 2" }],
});
check(
  "a turn naming its previous answer goes to that answer's account",
  served["shop: turn 2"] === home,
  `${home} → ${served["shop: turn 2"]}`
);
check(
  "a conversation keeps one pin: the answer it followed is dropped",
  sticky.peekStickyConnectionId(`response:${t1.id}`) === null &&
    sticky.peekStickyConnectionId(`response:${t2.id}`) === home
);
const t3 = await send({
  previous_response_id: t2.id,
  input: [{ role: "user", content: "shop: turn 3" }],
});
check(
  "and the turn after it too",
  served["shop: turn 3"] === home && t3.status === 200,
  `${served["shop: turn 3"]}`
);
check(
  "the answer passes unchanged",
  JSON.parse(t1.text).id === t1.id && JSON.parse(t1.text).output?.[0]?.content?.[0]?.text === "ok"
);
await send({
  previous_response_id: "resp_never_given",
  input: [{ role: "user", content: "shop: unknown" }],
});
check(
  "an unknown previous answer is placed like a new conversation",
  served["shop: unknown"] !== home,
  `${served["shop: unknown"]}`
);

const s1 = await send({ input: "streamed: turn 1", stream: true });
await send({
  previous_response_id: s1.id,
  input: [{ role: "user", content: "streamed: turn 2" }],
  stream: true,
});
check(
  "a streamed answer's id is followed as well",
  !!s1.id && served["streamed: turn 2"] === served["streamed: turn 1"],
  `${served["streamed: turn 1"]} → ${served["streamed: turn 2"]}`
);
check(
  "a streamed answer passes unchanged",
  s1.text.startsWith("event: response.created") && s1.text.includes("response.completed")
);

// ── 3. An account whose quota is used up is not the first pick ─────────────────────────
const full = (await createProviderConnection({
  provider: "claude",
  authType: "apikey",
  name: "charlie",
  apiKey: "sk-charlie-made-up",
})) as { id: string };
const spare = (await createProviderConnection({
  provider: "claude",
  authType: "apikey",
  name: "delta",
  apiKey: "sk-delta-made-up",
})) as { id: string };
markAccountExhaustedFrom429(full.id, "claude");
const limited = await leastBusy.readLimitedConnectionIds(["claude"]);
check("an account with its quota used up counts as not usable", limited.has(full.id));
check("an account with quota left stays usable", !limited.has(spare.id));
leastBusy.resetSlotUse();
const order = leastBusy.rankStartCandidates([
  { key: "combo:q:charlie", usable: !limited.has(full.id) },
  { key: "combo:q:delta", usable: !limited.has(spare.id) },
]);
check("a new conversation starts on the account with quota", order[0] === 1, JSON.stringify(order));

console.log(failed === 0 ? "all key-priority checks passed" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
