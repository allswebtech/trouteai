// Kiro client check: the requests TRouteAI builds must look like Kiro IDE 1.4.121's and pass
// Kiro's checks. Fake token only (no real credentials).
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-kiro-identity.mts
// Offline by default (fetch is replaced where a request would be made). KIRO_IDENTITY_ONLINE=1
// adds 4 checks that send the fake token to Kiro's real servers (needs internet). With a fake
// token Kiro answers: old/missing KiroIDE version -> 403 "bearer token invalid"; current version
// without profileArn -> 400 "profileArn is required"; current version with a valid profileArn ->
// 403 "bearer token invalid" (only the fake token is left to refuse).
import { KiroExecutor } from "../../open-sse/executors/kiro.ts";
import { fetchKiroAvailableModels } from "../../open-sse/services/kiroModels.ts";
import { getKiroUsage } from "../../open-sse/services/usage/kiro.ts";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.ts";
import { classifyProviderError } from "../../open-sse/services/errorClassifier.ts";
import { findKiroConnectionByIdentity } from "../../src/lib/oauth/kiroConnectionIdentity.ts";
import {
  KIRO_BUILDER_ID_PROFILE_ARN,
  KIRO_IDE_VERSION,
  KIRO_SOCIAL_PROFILE_ARN,
  resolveKiroProfileArn,
} from "../../open-sse/config/kiroIdentity.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}
const short = (t: string) => t.slice(0, 110).replace(/\s+/g, " ");

const builderId = {
  accessToken: "not-a-real-token",
  providerSpecificData: {
    authMethod: "builder-id",
    clientId: "fake-client-id",
    region: "us-east-1",
  },
};
// IAM Identity Center without a stored profile: Kiro then names the missing profileArn, which
// shows the client version was accepted.
const idcNoProfile = {
  accessToken: "not-a-real-token",
  providerSpecificData: { authMethod: "idc", clientId: "fake-client-id", region: "us-east-1" },
};

// 1. Chat headers built by the executor.
const executor = new KiroExecutor();
const headers = executor.buildHeaders(builderId as never, true) as Record<string, string>;
const ua = headers["User-Agent"] || "";
check("chat User-Agent has KiroIDE version", ua.includes(`KiroIDE-${KIRO_IDE_VERSION}-`), ua);
check(
  "chat X-Amz-User-Agent has KiroIDE version",
  (headers["X-Amz-User-Agent"] || "").includes(`KiroIDE-${KIRO_IDE_VERSION}-`)
);
check(
  "chat has no old kiro-ide/1.0.0 identity",
  !JSON.stringify(headers).includes("kiro-ide/1.0.0")
);
const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());
check(
  "chat sends one user-agent header each",
  lowerKeys.filter((k) => k === "user-agent").length === 1 &&
    lowerKeys.filter((k) => k === "x-amz-user-agent").length === 1
);
check(
  "chat sends Kiro IDE's agent-mode and opt-out headers",
  headers["x-amzn-kiro-agent-mode"] === "vibe" && headers["x-amzn-codewhisperer-optout"] === "true"
);
const again = executor.buildHeaders(builderId as never, true) as Record<string, string>;
check("machine id is stable per account", again["User-Agent"] === ua);

// 2. Which profileArn each login type sends (Kiro IDE's getFixedProfileArn).
check(
  "Builder ID -> fixed Builder ID profile",
  resolveKiroProfileArn(builderId.providerSpecificData) === KIRO_BUILDER_ID_PROFILE_ARN
);
check(
  "Google/GitHub login without profile -> fixed social profile",
  resolveKiroProfileArn({ authMethod: "imported", provider: "Github" }) === KIRO_SOCIAL_PROFILE_ARN
);
const ownArn = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/OWNPROFILE";
check(
  "own profile is kept",
  resolveKiroProfileArn({ authMethod: "idc", profileArn: ownArn }) === ownArn
);
check(
  "IAM Identity Center without profile -> none (discovery)",
  resolveKiroProfileArn({ authMethod: "idc" }) === undefined
);
check(
  "API key without profile -> none",
  resolveKiroProfileArn({ authMethod: "api_key" }) === undefined
);

const openaiBody = {
  model: "claude-haiku-4.5",
  max_tokens: 20,
  messages: [{ role: "user", content: "hi" }],
};
const builderPayload = buildKiroPayload("claude-haiku-4.5", openaiBody, true, builderId) as Record<
  string,
  unknown
>;
check(
  "translator unchanged: only a stored profile goes into its payload (the executor adds the rest)",
  builderPayload.profileArn === undefined
);

const seen: Array<{ url: string; status: number; text: string }> = [];
// 3 + 4 talk to Kiro's real servers (fake token), so they run only with KIRO_IDENTITY_ONLINE=1.
if (process.env.KIRO_IDENTITY_ONLINE === "1") {
  // 3. Real chat requests through the executor against Kiro (fake token).
  const chat = async (creds: typeof builderId) => {
    const body = buildKiroPayload("claude-haiku-4.5", openaiBody, true, creds);
    const result = await executor.execute({
      model: "claude-haiku-4.5",
      body,
      stream: true,
      credentials: creds,
    } as never);
    return { status: result.response.status, text: await result.response.text() };
  };
  const gate = await chat(idcNoProfile);
  check(
    "chat passes Kiro's version check",
    gate.status === 400 && /profileArn is required/i.test(gate.text),
    `${gate.status} ${short(gate.text)}`
  );
  const builderChat = await chat(builderId);
  check(
    "Builder ID chat passes the profile check (only the fake token is refused)",
    builderChat.status === 403 &&
      /bearer token/i.test(builderChat.text) &&
      !/profileArn/i.test(builderChat.text),
    `${builderChat.status} ${short(builderChat.text)}`
  );

  // 4. ListAvailableModels: first call carries the profile, Kiro accepts version + profile.
  await fetchKiroAvailableModels({
    accessToken: "not-a-real-token",
    providerSpecificData: builderId.providerSpecificData,
    fetchImpl: async (url, init) => {
      const res = await fetch(url, init);
      seen.push({ url: String(url), status: res.status, text: await res.clone().text() });
      return res;
    },
    fallbackModels: [{ id: "claude-haiku-4.5" }],
  });
  const first = seen.find((s) => s.url.includes("ListAvailableModels"));
  check(
    "ListAvailableModels (no own profile found) sends the Builder ID profile first",
    !!first && first.url.includes(encodeURIComponent(KIRO_BUILDER_ID_PROFILE_ARN))
  );
  check(
    "ListAvailableModels passes version + profile checks",
    !!first && first.status === 403 && /invalid token/i.test(first.text),
    first ? `${first.status} ${short(first.text)}` : "no request"
  );
}

// 5. GetUsageLimits for Builder ID: no fixed profile there (Kiro answers 403 for it when the
// account has its own; profile-less works). fetch is mocked: ListAvailableProfiles -> none.
const realFetch = globalThis.fetch;
let usageBody = "";
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  const body = String(init?.body || "");
  if (body.includes("maxResults"))
    return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
  usageBody = body;
  return new Response(JSON.stringify({ usageBreakdownList: [] }), { status: 200 });
}) as typeof fetch;
await getKiroUsage("not-a-real-token-usage", builderId.providerSpecificData).catch(() => null);
check(
  "GetUsageLimits for Builder ID without a profile sends none",
  usageBody !== "" && !usageBody.includes("profileArn")
);

// 6. The account's own profile from ListAvailableProfiles wins. It is kept in memory only, never
// written to the connection (an org's profile is shared, and imports match accounts by profile).
const accountArn = "arn:aws:codewhisperer:us-east-1:000000000000:profile/TESTPROFILE";
let sentProfile = "";
let profileLookups = 0;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const body = String(init?.body || "");
  if (body.includes("maxResults")) {
    profileLookups++;
    await new Promise((r) => setTimeout(r, 50));
    return new Response(JSON.stringify({ profiles: [{ arn: accountArn }] }), { status: 200 });
  }
  if (String(url).includes("generateAssistantResponse")) {
    sentProfile = JSON.parse(body).profileArn || "";
    return new Response("", { status: 200 });
  }
  return new Response("{}", { status: 200 });
}) as typeof fetch;
let saved: Record<string, unknown> | null = null;
const lookupCreds = {
  connectionId: "conn-lookup-test",
  accessToken: "not-a-real-token-lookup",
  providerSpecificData: {
    authMethod: "builder-id",
    clientId: "lookup-client",
    region: "us-east-1",
  },
};
const runChat = () =>
  executor.execute({
    model: "claude-haiku-4.5",
    body: buildKiroPayload("claude-haiku-4.5", openaiBody, true, lookupCreds),
    stream: true,
    credentials: lookupCreds,
    onCredentialsRefreshed: async (patch: Record<string, unknown>) => {
      saved = patch;
    },
  } as never);
await Promise.all([runChat(), runChat(), runChat()]);
await runChat();
check(
  "chat sends the account's own profile (not the fixed one)",
  sentProfile === accountArn,
  sentProfile
);
check(
  "4 requests (3 at once) of one account: one profile lookup",
  profileLookups === 1,
  `${profileLookups} lookups`
);
check(
  "the looked-up profile is not written to the connection",
  saved === null && !("profileArn" in lookupCreds.providerSpecificData)
);
const models = await fetchKiroAvailableModels({
  accessToken: "not-a-real-token-models",
  providerSpecificData: { authMethod: "builder-id", clientId: "models-client" },
  fetchImpl: async (url, init) => {
    seen.push({ url: String(url), status: 0, text: "" });
    return globalThis.fetch(url, init);
  },
});
void models;
const modelsUrl = seen.find(
  (s) => s.url.includes("ListAvailableModels") && s.url.includes("TESTPROFILE")
);
check("ListAvailableModels uses the account's own profile", !!modelsUrl);
globalThis.fetch = realFetch;

// 6b. Import matching: a profile shared by several connections does not pick one of them.
const shared = "arn:aws:codewhisperer:us-east-1:000000000000:profile/SHARED";
const conns = [
  { id: "a", authType: "oauth", providerSpecificData: { profileArn: shared, clientId: "ca" } },
  { id: "b", authType: "oauth", providerSpecificData: { profileArn: shared, clientId: "cb" } },
  { id: "c", authType: "oauth", providerSpecificData: { profileArn: "arn:only-c" } },
];
check(
  "shared profile alone matches no connection",
  findKiroConnectionByIdentity(conns, { profileArn: shared }) === null
);
check(
  "shared profile + client id matches that account",
  findKiroConnectionByIdentity(conns, { profileArn: shared, clientId: "cb" })?.id === "b"
);
check(
  "unique profile still matches",
  findKiroConnectionByIdentity(conns, { profileArn: "arn:only-c" })?.id === "c"
);

// 7. Error classes (Kiro only): the version error and a bad-token 403 do not ban accounts.
const versionMsg =
  "[403]: This version of Kiro is no longer supported. Please update to the latest version of Kiro to continue.";
check(
  "version 403 is not classified as a ban",
  classifyProviderError(403, versionMsg, "kiro") === null
);
check(
  "bad-token 403 is unauthorized, not a ban",
  classifyProviderError(
    403,
    "[403]: The bearer token included in the request is invalid.",
    "kiro"
  ) === "unauthorized" &&
    classifyProviderError(403, '{"message":"Invalid token","reason":null}', "kiro") ===
      "unauthorized"
);
check(
  "other Kiro 403 is still forbidden",
  classifyProviderError(403, "[403]: User is not authorized to make this call.", "kiro") ===
    "forbidden"
);
check(
  "other providers keep their old 403 handling",
  classifyProviderError(
    403,
    "[403]: The bearer token included in the request is invalid.",
    "codex"
  ) === classifyProviderError(403, "[403]: some other forbidden text", "codex")
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
