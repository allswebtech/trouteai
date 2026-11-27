// Check the values Home hands to a coding tool (the model name to copy, the accounts that need
// attention, the key name) and the Home defaults. In-process, no server:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-home-connect.mts
import fs from "node:fs";
import {
  CODING_TOOL_KEY_NAME,
  countNeedsAttention,
  pickHomeModel,
} from "../../src/app/(dashboard)/dashboard/home-start/homeConnect.ts";
import { shouldShowProviderTopologyOnHome } from "../../src/app/(dashboard)/dashboard/homeAppearance.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const listed = [
  { id: "best", ownedBy: "combo" },
  { id: "auto/free", ownedBy: "combo" },
  { id: "pepper/pepper-1", ownedBy: "chipotle" },
  { id: "oa/gpt-x", ownedBy: "openai" },
  { id: "cc/sonnet-y", ownedBy: "claude" },
];
check("a combo name wins", pickHomeModel("best", [{ provider: "openai" }], listed) === "best");
check(
  "without a combo: the first model of the first account",
  pickHomeModel(null, [{ provider: "claude" }, { provider: "openai" }], listed) === "cc/sonnet-y"
);
check(
  "a provider that needs no account is not the person's model",
  pickHomeModel(null, [{ provider: "openai" }], listed) === "oa/gpt-x"
);
check(
  "an account with no listed model is skipped for the next one",
  pickHomeModel(null, [{ provider: "none" }, { provider: "openai" }], listed) === "oa/gpt-x"
);
check("no account and no combo: nothing to copy", pickHomeModel(null, [], listed) === null);

check(
  "needs attention counts only failing accounts",
  countNeedsAttention([
    { isActive: true, testStatus: "active" },
    { isActive: true, testStatus: "error" },
    { isActive: false, testStatus: "error" },
  ]) === 1
);
check("the key made on Home is named Coding tool", CODING_TOOL_KEY_NAME === "Coding tool");
check("the provider map is off unless switched on", shouldShowProviderTopologyOnHome(undefined) === false);
check("the provider map shows when switched on", shouldShowProviderTopologyOnHome(true) === true);

const page = fs.readFileSync("src/app/(dashboard)/home/page.tsx", "utf8");
check(
  "the security banner comes after the page body",
  page.indexOf("<BootstrapBanner") > page.indexOf("<HomePageClient")
);
check("the all-set card is gone", !fs.existsSync("src/app/(dashboard)/dashboard/home-start/GetStartedCard.tsx"));

process.exit(failed ? 1 : 0);
