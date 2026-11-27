// State that two route bundles must share, held against the build's cut of its chunks: the build may
// make one copy of a module per route bundle, so the check loads each module twice as two fresh
// copies (a different query on the import) and asserts that both copies use one holder.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-shared-state.mts
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// The one-time sign-in codes: a code made by one copy is used once through the other.
const linkA = await import("../../src/lib/auth/loginLink.ts?copy=a");
const linkB = await import("../../src/lib/auth/loginLink.ts?copy=b");
check("the sign-in store is loaded as two copies", linkA.mintLoginLink !== linkB.mintLoginLink);
const code = linkA.mintLoginLink(1_000_000);
check("a code made by one copy is pending in the other", linkB.pendingLoginLinks() === 1);
check("the other copy accepts it once", linkB.consumeLoginLink(code, 1_001_000));
check("the first copy then refuses it", !linkA.consumeLoginLink(code, 1_002_000));

// The key caches: a clear by one copy empties what the other one holds.
const keysA = await import("../../src/lib/db/apiKeys.ts?copy=a");
const keysB = await import("../../src/lib/db/apiKeys.ts?copy=b");
check("the key module is loaded as two copies", keysA.clearApiKeyCaches !== keysB.clearApiKeyCaches);
const caches = (globalThis as { __trouteaiApiKeyCaches?: Record<string, Map<string, unknown>> })
  .__trouteaiApiKeyCaches;
check("the key caches are on globalThis", Boolean(caches?.validation && caches.modelPermission));
caches?.validation.set("k", { valid: true, timestamp: Date.now() });
caches?.modelPermission.set("k", { allowed: true, timestamp: Date.now() });
caches?.lastUsed.set("k", Date.now());
keysA.clearApiKeyCaches();
check(
  "a clear by one copy empties the caches the other copy reads",
  caches?.validation.size === 0 && caches.modelPermission.size === 0 && caches.lastUsed.size === 0
);
caches?.validation.set("k", { valid: true, timestamp: Date.now() });
keysB.clearApiKeyCaches();
check("and the other way round", caches?.validation.size === 0);

process.exit(failed > 0 ? 1 : 0);
