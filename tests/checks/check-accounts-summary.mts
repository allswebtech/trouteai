// The Accounts page's small rules: the one status word of a provider, when the Limits row is
// shown, and the address a catalog Connect opens. Pure functions, no server.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-accounts-summary.mts
const { accountStatus, anyAccountReportsLimits, providerPageHref } = await import(
  "../../src/app/(dashboard)/dashboard/providers/accountsSummary.ts"
);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

check("no account has no status", accountStatus({ total: 0 }) === null);
check("missing stats have no status", accountStatus(undefined) === null);
check("a working account", accountStatus({ total: 2, error: 0 }) === "works");
check("one failing account needs attention", accountStatus({ total: 2, error: 1 }) === "attention");
check("all turned off", accountStatus({ total: 1, allDisabled: true }) === "off");
check(
  "turned off wins over an old error",
  accountStatus({ total: 1, error: 1, allDisabled: true }) === "off"
);

check("no connection, no limits row", anyAccountReportsLimits([]) === false);
check(
  "a provider that reports no limits",
  anyAccountReportsLimits([{ provider: "openai-compatible-x", authType: "apikey" }]) === false
);
check(
  "an OAuth account of a provider with limits",
  anyAccountReportsLimits([{ provider: "claude", authType: "oauth" }]) === true
);
check(
  "limits hidden by the account's own switch",
  anyAccountReportsLimits([{ provider: "claude", authType: "oauth", quotaVisible: false }]) === false
);

check("no account: the add form opens", providerPageHref("anthropic", 0) === "/dashboard/providers/anthropic?add=1");
check("has an account: plain page", providerPageHref("anthropic", 2) === "/dashboard/providers/anthropic");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
