// Check that the fallback response id is unique even for answers made in one millisecond, and
// that the five places that build it use the one helper. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-response-ids.mts
import fs from "node:fs";
import { newResponseId } from "../../open-sse/utils/responseId.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const realNow = Date.now;
Date.now = () => 1_700_000_000_000;
const ids = new Set<string>();
for (let i = 0; i < 10000; i++) ids.add(newResponseId());
Date.now = realNow;
check("10000 ids made in one millisecond are all different", ids.size === 10000, `${ids.size}`);
check(
  "an id starts with resp_ and the millisecond",
  [...ids].every((id) => /^resp_1700000000000_[a-z0-9]{6,}$/.test(id))
);

const sites = [
  "open-sse/handlers/responseTranslator.ts",
  "open-sse/handlers/sseParser.ts",
  "open-sse/translator/response/openai-to-antigravity.ts",
  "open-sse/translator/index.ts",
  "open-sse/utils/streamPayloadCollector.ts",
];
for (const file of sites) {
  const text = fs.readFileSync(file, "utf8");
  check(`${file} has no clock-only id`, !text.includes("`resp_${Date.now()}`"));
  check(`${file} uses newResponseId`, text.includes("newResponseId("));
}
process.exit(failed ? 1 : 0);
