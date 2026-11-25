// What programs that start TRouteAI or sit in front of it rely on, checked in-process (no server,
// no network): the listen addresses, the API paths that must not redirect, the proxy header on
// event streams, the key headers, the keep-alive and body limits, the health states, the update
// check default and the deploy file. The same things end to end: tests/smoke/fit.sh.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-fit.mts
import fs from "node:fs";

import { resolveListenHosts } from "../../scripts/dev/listen-hosts.mjs";
import { stripApiTrailingSlash } from "../../scripts/dev/api-path.mjs";
import { addEventStreamProxyHeaders } from "../../scripts/dev/event-stream-headers.mjs";
import { updateCheckEnabled } from "../../bin/cli/update-check.mjs";
import { extractApiKey } from "../../src/sse/services/auth.ts";
import { getBodySizeLimit } from "../../src/shared/middleware/bodySizeGuard.ts";
import { CHAT_HARD_MAX_BODY_BYTES } from "../../src/shared/middleware/chatBodyAdmission.ts";
import { getUpstreamTimeoutConfig } from "../../src/shared/utils/runtimeTimeouts.ts";
import { resolveStreamFlagKeepaliveThreshold } from "../../open-sse/utils/keepaliveThreshold.ts";
import {
  markServerReady,
  markServerStarting,
  markServerStopping,
} from "../../src/lib/serverLifecycle.ts";
import { GET as healthz } from "../../src/app/healthz/route.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const MB = 1024 * 1024;

// ── Listen addresses ────────────────────────────────────────────────────────
const byDefault = resolveListenHosts(undefined, "build-box");
check(
  "no HOST: only this computer, both loopback addresses",
  same(byDefault.hosts, ["127.0.0.1", "::1"]) && byDefault.loopbackOnly,
  JSON.stringify(byDefault.hosts)
);
check(
  "HOST=localhost is the same as no HOST",
  same(resolveListenHosts("localhost", "build-box").hosts, ["127.0.0.1", "::1"])
);
check(
  "HOST equal to the machine name (csh) is ignored",
  same(resolveListenHosts("build-box", "build-box").hosts, ["127.0.0.1", "::1"])
);
const everywhere = resolveListenHosts("0.0.0.0", "build-box");
check(
  "HOST=0.0.0.0 still listens on every interface",
  same(everywhere.hosts, ["0.0.0.0"]) && everywhere.everyInterface && !everywhere.loopbackOnly
);
const panel = resolveListenHosts("127.0.0.1", "build-box");
check(
  "HOST=127.0.0.1 (what a hosting panel sets) is exactly that",
  same(panel.hosts, ["127.0.0.1"]) && panel.loopbackOnly
);

// ── API paths never redirect ────────────────────────────────────────────────
const paths: Array<[string, string, string?]> = [
  ["/v1/models/", "/v1/models"],
  ["/v1/", "/v1"],
  ["/v1/chat/completions/?x=1", "/v1/chat/completions?x=1"],
  ["/api/v1/models/", "/api/v1/models"],
  ["/models/", "/models"],
  ["/healthz/", "/healthz"],
  ["/v1/messages//", "/v1/messages"],
  ["/v1/models", "/v1/models"],
  ["/dashboard/", "/dashboard/"],
  ["/", "/"],
  ["/gw/v1/models/", "/gw/v1/models", "/gw"],
  ["/gw/healthz/", "/gw/healthz", "/gw"],
  ["/gw/dashboard/", "/gw/dashboard/", "/gw"],
  ["/v1/models/", "/v1/models/", "/gw"],
];
const pathFails = paths
  .map(([input, expected, basePath]) => [input, stripApiTrailingSlash(input, basePath), expected])
  .filter(([, got, expected]) => got !== expected)
  .map(([input, got]) => `${input} -> ${got}`);
check(
  `API paths lose a trailing slash, pages keep it, base path respected (${paths.length})`,
  pathFails.length === 0,
  pathFails.join(", ")
);

// ── X-Accel-Buffering on every event stream ─────────────────────────────────
function fakeResponse() {
  const headers = new Map<string, unknown>();
  const res = {
    written: null as unknown,
    setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    hasHeader: (name: string) => headers.has(name.toLowerCase()),
    writeHead(_status: number, ..._rest: unknown[]) {
      res.written = Object.fromEntries(headers);
      return res;
    },
  };
  addEventStreamProxyHeaders(res);
  return { res, headers };
}
{
  const { res, headers } = fakeResponse();
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
  check("event stream gets X-Accel-Buffering: no", headers.get("x-accel-buffering") === "no");
}
{
  const { res, headers } = fakeResponse();
  res.setHeader("content-type", "text/event-stream");
  res.writeHead(200);
  check(
    "event stream with the type set before writeHead gets it too",
    headers.get("x-accel-buffering") === "no"
  );
}
{
  const { res, headers } = fakeResponse();
  res.writeHead(200, ["Content-Type", "text/event-stream"]);
  check("raw header list is read", headers.get("x-accel-buffering") === "no");
}
{
  const { res, headers } = fakeResponse();
  res.writeHead(200, { "content-type": "application/json" });
  check("a JSON answer is left alone", !headers.has("x-accel-buffering"));
}

// ── Both key headers ────────────────────────────────────────────────────────
const req = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", headers });
check(
  "x-api-key alone is the key (no anthropic-version needed)",
  extractApiKey(req({ "x-api-key": "sk-fake-only" })) === "sk-fake-only"
);
check(
  "Bearer alone is the key",
  extractApiKey(req({ authorization: "Bearer sk-fake-bearer" })) === "sk-fake-bearer"
);
check(
  "both headers with the same key: that key",
  extractApiKey(req({ authorization: "Bearer sk-fake-same", "x-api-key": "sk-fake-same" })) ===
    "sk-fake-same"
);

// ── Streams behind a proxy ──────────────────────────────────────────────────
const timeouts = getUpstreamTimeoutConfig({});
check(
  "keep-alive while a stream is open: at least every 100 s by default",
  timeouts.sseHeartbeatIntervalMs > 0 && timeouts.sseHeartbeatIntervalMs <= 100_000,
  `${timeouts.sseHeartbeatIntervalMs} ms`
);
check(
  "idle limit of a stream: at least 10 minutes by default",
  timeouts.streamIdleTimeoutMs >= 600_000,
  `${timeouts.streamIdleTimeoutMs} ms`
);
const savedKeepalive = process.env.TROUTEAI_STREAM_KEEPALIVE_AFTER_MS;
delete process.env.TROUTEAI_STREAM_KEEPALIVE_AFTER_MS;
const streamFlagDefault = resolveStreamFlagKeepaliveThreshold("claude/claude-sonnet-4-6");
check(
  "stream: true without an SSE Accept gets keep-alives within 100 s",
  streamFlagDefault !== null && streamFlagDefault > 0 && streamFlagDefault <= 100_000,
  String(streamFlagDefault)
);
process.env.TROUTEAI_STREAM_KEEPALIVE_AFTER_MS = "0";
check(
  "TROUTEAI_STREAM_KEEPALIVE_AFTER_MS=0 switches it off",
  resolveStreamFlagKeepaliveThreshold("claude/claude-sonnet-4-6") === null
);
if (savedKeepalive === undefined) delete process.env.TROUTEAI_STREAM_KEEPALIVE_AFTER_MS;
else process.env.TROUTEAI_STREAM_KEEPALIVE_AFTER_MS = savedKeepalive;

const limits = ["/api/v1/messages", "/api/v1/chat/completions", "/api/v1/responses"].map(
  (p) => [p, getBodySizeLimit(p)] as const
);
check(
  "request bodies of 64 MB on the chat routes",
  limits.every(([, limit]) => limit >= 64 * MB) && CHAT_HARD_MAX_BODY_BYTES >= 64 * MB,
  limits.map(([p, l]) => `${p}=${Math.round(l / MB)}MB`).join(" ")
);

// ── Health states ───────────────────────────────────────────────────────────
async function health() {
  const res = healthz();
  return `${res.status} ${(await res.text()).trim()}`;
}
markServerStarting();
const starting = await health();
markServerReady();
const ready = await health();
markServerStopping();
const stopping = await health();
check(
  "/healthz: 503 starting, 200 ok, 503 stopping",
  starting === "503 starting" && ready === "200 ok" && stopping === "503 stopping",
  `${starting} | ${ready} | ${stopping}`
);

// ── Nothing leaves the machine by default ───────────────────────────────────
check("update check is off by default", updateCheckEnabled({}, true) === false);
check(
  "update check runs only when switched on",
  updateCheckEnabled({ TROUTEAI_UPDATE_CHECK: "true" }, true) === true &&
    updateCheckEnabled({ TROUTEAI_UPDATE_CHECK: "true" }, false) === false &&
    updateCheckEnabled({ TROUTEAI_UPDATE_CHECK: "true", SIXPANEL_SLOT: "a" }, true) === false
);

// ── The deploy file ─────────────────────────────────────────────────────────
const deploy = JSON.parse(fs.readFileSync("sixpanel.json", "utf8"));
check(
  "deploy file: the command, /healthz, one process, 64 MB bodies, no update check",
  String(deploy.start).includes("bin/trouteai.mjs") &&
    deploy.health?.path === "/healthz" &&
    deploy.node?.processes === 1 &&
    deploy.web?.maxBodyMb >= 64 &&
    deploy.env?.defaults?.TROUTEAI_UPDATE_CHECK === "false" &&
    !("HOST" in (deploy.env?.defaults ?? {})),
  JSON.stringify({ start: deploy.start, health: deploy.health })
);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
