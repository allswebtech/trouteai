// Reads the samples idle.sh took with idle-probe.cjs and prints one PASS or FAIL line per rule.
// Exits non-zero when a rule failed.
import fs from "node:fs";

// Timers shorter than a minute that may stay alive on an idle server, each with the reason.
const ALLOWED_SHORT_TIMERS = [
  {
    owner: /^node:_http_server/,
    why: "Node's HTTP server checks open connections for header and request timeouts",
  },
];
const MINUTE = 60_000;

const samples = fs
  .readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const byLabel = Object.fromEntries(samples.map((s) => [s.label, s]));
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};
const describe = (t) => `${t.kind} ${t.ms} ms ${t.owner}${t.name ? ` (${t.name})` : ""}`;
const shortTimers = (s) =>
  s.timers.filter((t) => t.ms < MINUTE && !ALLOWED_SHORT_TIMERS.some((a) => a.owner.test(t.owner)));
const outboundUpTo = (label) => {
  const out = [];
  for (const s of samples) {
    out.push(...s.outbound);
    if (s.label === label) break;
  }
  return out;
};
const describeOut = (o) => `${o.kind} ${o.target} from ${o.chain?.[o.chain.length - 1] || o.owner}`;

for (const label of ["idle", "after-health", "after-request"]) {
  check(`sample "${label}" taken`, Boolean(byLabel[label]));
}
if (byLabel.idle) {
  const idle = byLabel.idle;
  const short = shortTimers(idle);
  check(
    `no timer shorter than a minute after ${Math.round(idle.at)} s idle`,
    short.length === 0,
    short.map(describe).join("; ")
  );
  const out = outboundUpTo("idle");
  check(
    "no connection out of the machine while idle",
    out.length === 0,
    [...new Set(out.map(describeOut))].join("; ")
  );
}
if (byLabel["after-health"]) {
  const short = shortTimers(byLabel["after-health"]);
  check(
    "a health probe does not wake the background jobs",
    short.length === 0,
    short.map(describe).join("; ")
  );
  const out = outboundUpTo("after-health");
  check(
    "no connection out of the machine after a health probe",
    out.length === 0,
    [...new Set(out.map(describeOut))].join("; ")
  );
}
if (byLabel["after-request"]) {
  const woke = byLabel["after-request"].timers.some((t) =>
    t.owner.startsWith("src/lib/config/hotReload.ts")
  );
  check("a request wakes the paused jobs (the settings reload poll runs again)", woke);
}
process.exit(failed > 0 ? 1 : 0);
