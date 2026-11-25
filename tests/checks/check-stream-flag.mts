// Check that only the body's `stream: true` asks for an event stream: the helpers every route
// uses, and the canned replies for Claude Code's warmup requests. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-stream-flag.mts
import { bodyRequestsStream, resolveStreamFlag } from "../../open-sse/utils/aiSdkCompat.ts";
import { handleBypassRequest } from "../../open-sse/utils/bypassHandler.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const flagCases: Array<[unknown, boolean]> = [
  [true, true],
  [false, false],
  [undefined, false],
  [null, false],
  ["true", false],
  [1, false],
];
for (const [value, want] of flagCases) {
  check(
    `resolveStreamFlag(${JSON.stringify(value)}) is ${want}`,
    resolveStreamFlag(value) === want
  );
}

const bodyCases: Array<[string, unknown, boolean]> = [
  ["stream: true", { stream: true }, true],
  ["stream: false", { stream: false }, false],
  ["no stream field", { model: "m" }, false],
  ["alias streaming: true", { streaming: true }, true],
  ["alias non_stream wins over stream: true", { stream: true, non_stream: true }, false],
  ["not an object", "stream", false],
  ["null", null, false],
];
for (const [name, body, want] of bodyCases) {
  check(`bodyRequestsStream: ${name} is ${want}`, bodyRequestsStream(body) === want);
}

const warmup = (extra: Record<string, unknown>) => ({
  messages: [{ role: "user", content: [{ type: "text", text: "Warmup" }] }],
  ...extra,
});
for (const [name, extra, wantSse] of [
  ["stream: true", { stream: true }, true],
  ["stream: false", { stream: false }, false],
  ["no stream field", {}, false],
] as Array<[string, Record<string, unknown>, boolean]>) {
  const res = handleBypassRequest(warmup(extra), "claude-fake-model", "claude-cli/0.0.0")
    ?.response as Response | undefined;
  const type = res?.headers.get("content-type") || "";
  check(
    `warmup reply, ${name}: ${wantSse ? "event stream" : "JSON"}`,
    !!res && type.includes("text/event-stream") === wantSse,
    type
  );
}

process.exit(failed ? 1 : 0);
