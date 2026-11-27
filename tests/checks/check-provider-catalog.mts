// The provider catalog route's list (src/lib/providers/addFlow.ts) held against the code's own
// catalog and the flow sets of the OAuth route, so it cannot drift from them: every provider of
// the catalog is listed once, each row has exactly the public fields and no secret, the flow
// of every row follows the sets, and the OAuth route reads its sets from the one shared module.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-provider-catalog.mts
import fs from "node:fs";

const { buildProviderCatalog } = await import("../../src/lib/providers/addFlow.ts");
const { STATIC_PROVIDER_CATALOG_GROUPS, STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER } =
  await import("../../src/lib/providers/catalog.ts");
const { PKCE_CALLBACK_PROVIDERS, BROWSER_DEVICE_FLOW_PROVIDERS, RETIRED_PKCE_PROVIDERS } =
  await import("../../src/lib/oauth/flowSets.ts");
const { PROVIDERS } = await import("../../src/lib/oauth/providers/index.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const rows = buildProviderCatalog() as Array<Record<string, unknown>>;
const byId = new Map(rows.map((r) => [String(r.id), r]));
const FLOWS = new Set(["api-key", "device-code", "link-and-paste", "own-page"]);
const FIELDS = ["apiHint", "authHint", "category", "flow", "id", "name", "website"];

// What the catalog holds, in its own order, each id once, hidden ones left out.
const expected = new Set<string>();
for (const category of STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER) {
  for (const [id, entry] of Object.entries(
    STATIC_PROVIDER_CATALOG_GROUPS[category].providers as Record<string, any>
  )) {
    if (!entry?.hiddenFromDashboard) expected.add(id);
  }
}
check("the list is not empty", rows.length > 50, String(rows.length));
check("every id once", byId.size === rows.length);
check(
  "exactly the catalog's visible providers",
  rows.length === expected.size && [...expected].every((id) => byId.has(id)),
  `${rows.length} against ${expected.size}`
);
check(
  "every row has the same seven fields and nothing else",
  rows.every((r) => Object.keys(r).sort().join() === FIELDS.join())
);
check(
  "every flow is one of the four",
  rows.every((r) => FLOWS.has(String(r.flow)))
);
check(
  "every row has an id, a name and a category",
  rows.every((r) => r.id && r.name && r.category)
);
const text = JSON.stringify(rows);
check("nothing that looks like a key in the answer", !/\bsk-[A-Za-z0-9_-]{16,}/i.test(text));

const flowOf = (id: string) => byId.get(id)?.flow;
// A provider of the shared sets is listed with the flow its set says.
for (const id of BROWSER_DEVICE_FLOW_PROVIDERS as Set<string>) {
  check(`${id} (browser device flow) is own-page`, flowOf(id) === "own-page");
}
for (const id of RETIRED_PKCE_PROVIDERS as Set<string>) {
  check(`${id} (retired browser flow) is own-page`, flowOf(id) === "own-page");
}
for (const id of PKCE_CALLBACK_PROVIDERS as Set<string>) {
  if ((BROWSER_DEVICE_FLOW_PROVIDERS as Set<string>).has(id)) continue;
  const device = (PROVIDERS as any)[id]?.flowType === "device_code";
  check(
    `${id} (browser callback) is ${device ? "device-code" : "link-and-paste"}`,
    flowOf(id) === (device ? "device-code" : "link-and-paste")
  );
}
// Every OAuth provider follows its own flowType.
for (const [id, p] of Object.entries(PROVIDERS as Record<string, any>)) {
  const row = byId.get(id);
  if (!row) continue;
  const f = String(row.flow);
  if (p.flowType === "import_token") check(`${id} (token import) is own-page`, f === "own-page");
  else if (p.flowType === "device_code" && f !== "own-page")
    check(`${id} (device code) is device-code`, f === "device-code");
}
check("github is device-code", flowOf("github") === "device-code");
check("claude is link-and-paste", flowOf("claude") === "link-and-paste");
check("codex is own-page", flowOf("codex") === "own-page");
check("zed (keychain import) is own-page", flowOf("zed") === "own-page");
check("an API-key provider (openai) is api-key", flowOf("openai") === "api-key");
check(
  "a provider needing no account is own-page",
  rows.some((r) => r.category === "no-auth" && r.flow === "own-page")
);

// The OAuth route takes its sets from the shared module and keeps no copy.
const route = fs.readFileSync("src/app/api/oauth/[provider]/[action]/route.ts", "utf8");
check(
  "the OAuth route imports the flow sets",
  /from "@\/lib\/oauth\/flowSets"/.test(route) &&
    !/const (PKCE_CALLBACK_PROVIDERS|BROWSER_DEVICE_FLOW_PROVIDERS|RETIRED_PKCE_PROVIDERS)\s*=/.test(
      route
    )
);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
