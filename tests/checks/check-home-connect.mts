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

const listed = ["best", "auto/free", "oa/gpt-x", "cc/sonnet-y"];
check("a combo name wins", pickHomeModel("best", listed, ["best", "auto/free"]) === "best");
check(
  "without a combo: the first provider/model that is not a combo",
  pickHomeModel(null, listed, ["best", "auto/free"]) === "oa/gpt-x"
);
check("a bare name is not a provider/model", pickHomeModel(null, ["best"], []) === null);
check("nothing listed: nothing to copy", pickHomeModel(null, [], []) === null);

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
