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

const models = [
  { provider: "oa", model: "gpt-x", fullModel: "oa/gpt-x" },
  { provider: "cc", model: "sonnet-y", fullModel: "cc/sonnet-y" },
  { provider: "cc", model: "haiku-y", fullModel: "cc/haiku-y" },
];
check("a combo name wins", pickHomeModel("best", [{ provider: "claude" }], models, {}) === "best");
check(
  "without a combo: the first model of the first account",
  pickHomeModel(null, [{ provider: "claude" }, { provider: "openai" }], models, {
    claude: "cc",
    openai: "oa",
  }) === "cc/sonnet-y"
);
check(
  "an account whose provider id is the model's provider",
  pickHomeModel(null, [{ provider: "oa" }], models, {}) === "oa/gpt-x"
);
check("no account and no combo: nothing to copy", pickHomeModel(null, [], models, {}) === null);
check(
  "an account with no model is skipped for the next one",
  pickHomeModel(null, [{ provider: "none" }, { provider: "oa" }], models, {}) === "oa/gpt-x"
);

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
