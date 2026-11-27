// One decision for "is this request from this computer": a loopback socket AND a loopback Host AND
// no forwarding header. A Host that is not this computer's loopback (a public name, a LAN name or
// address, a made-up name), the Host of the configured public base address, a missing or broken
// Host, or any forwarding header makes it REMOTE, whatever the socket and the other headers say.
// Checked at the socket stamp (scripts/dev/peer-stamp.mjs), in the pipeline locality verdict, the
// command token in the pipeline policy and in the route-level check, and the loopback-only gate.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-local-request.mts
import { randomUUID } from "node:crypto";

process.env.INITIAL_PASSWORD = "Check-Pass-123";
process.env.TROUTEAI_PEER_STAMP_TOKEN = randomUUID();
delete process.env.TROUTEAI_DISABLE_CLI_TOKEN;
const PUBLIC_HOST = "gw.example.test";
process.env.TROUTEAI_PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;

const { stampPeerIp } = await import("../../scripts/dev/peer-stamp.mjs");
const { isLocalNodeRequest, isLocalHostHeader } =
  await import("../../scripts/dev/request-locality.mjs");
const { ensureCliTokenFile } = await import("../../scripts/dev/cli-token-file.mjs");
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");
const { classifyStampedPeerLocality } = await import("../../src/server/authz/peerStamp.ts");
const { isCliTokenAuthValid } = await import("../../src/lib/middleware/cliTokenAuth.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const secret = ensureCliTokenFile(process.env.DATA_DIR as string, { warn: () => {} });
const stampToken = process.env.TROUTEAI_PEER_STAMP_TOKEN as string;

type Case = { socket?: string; host?: string | null; extra?: Record<string, string> };

// A Node request as the custom server sees it (lower-case header names), stamped by the server.
function nodeRequest({ socket = "127.0.0.1", host, extra = {} }: Case) {
  const headers: Record<string, string> = { "x-trouteai-cli-token": secret, ...extra };
  if (host !== null && host !== undefined) headers.host = host;
  const req = { headers, socket: { remoteAddress: socket } };
  stampPeerIp(req);
  return req;
}
// The same request as the authz pipeline gets it (a Fetch Request with the stamped headers).
function pipelineRequest(path: string, c: Case) {
  const req = nodeRequest(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (k !== "host") headers.set(k, String(v));
  if (req.headers.host) headers.set("host", req.headers.host);
  return new Request(`http://127.0.0.1${path}`, { method: "POST", headers });
}
const locality = (c: Case) => {
  const r = pipelineRequest("/api/keys", c);
  return classifyStampedPeerLocality(
    r.headers.get("x-trouteai-peer-ip"),
    r.headers.get("x-trouteai-via-proxy"),
    stampToken
  );
};
async function tokenAccepted(c: Case): Promise<boolean> {
  const outcome = await managementPolicy.evaluate({
    request: pipelineRequest("/api/keys", c),
    classification: classifyRoute("/api/keys", "POST"),
    requestId: "check",
  });
  return outcome.allow === true && outcome.subject?.label === "local-cli-token";
}
// A loopback-only route: allowed from loopback without any credential, refused otherwise.
async function loopbackOnlyOpen(c: Case): Promise<boolean> {
  const outcome = await managementPolicy.evaluate({
    request: pipelineRequest("/api/db-backups/exportAll", c),
    classification: classifyRoute("/api/db-backups/exportAll", "POST"),
    requestId: "check",
  });
  // Past the local-only gate a request without a credential still gets 401; the gate itself says 403.
  return !(outcome.allow === false && outcome.status === 403);
}

// ── The decision itself ─────────────────────────────────────────────────────
const local: Array<[string, Case]> = [
  ["loopback socket, Host localhost", { host: "localhost" }],
  ["Host localhost with a port", { host: "localhost:20017" }],
  ["Host 127.0.0.1 with a port", { host: "127.0.0.1:8799" }],
  ["Host 127.1.2.3", { host: "127.1.2.3" }],
  ["IPv6 loopback socket, Host [::1]:20017", { socket: "::1", host: "[::1]:20017" }],
  ["mapped IPv4 loopback socket", { socket: "::ffff:127.0.0.1", host: "localhost" }],
  ["upper case Host LOCALHOST:20017", { host: "LOCALHOST:20017" }],
  ["mixed case Host LocalHost", { host: "LocalHost" }],
];
for (const [name, c] of local) {
  check(
    `local: ${name}`,
    isLocalNodeRequest(nodeRequest(c)) && locality(c) === "loopback" && (await tokenAccepted(c)),
    locality(c)
  );
}

const remote: Array<[string, Case]> = [
  ["Host equal to the public base host", { host: PUBLIC_HOST }],
  ["Host equal to the public base host, upper case, with a port", { host: "GW.Example.Test:443" }],
  ["a LAN address as Host", { host: "192.168.1.20:20017" }],
  ["a LAN name as Host", { host: "kitchen-pc.local" }],
  ["a made-up name as Host", { host: "anything.invalid" }],
  ["a public address as Host", { host: "203.0.113.9" }],
  ["localhost.evil.test as Host", { host: "localhost.evil.test" }],
  ["no Host header", { host: null }],
  ["an empty Host header", { host: "" }],
  ["a Host that cannot be parsed", { host: "bad host/with path" }],
  ["a Host with a user part", { host: "localhost@evil.test" }],
  [
    "X-Forwarded-For with Host localhost",
    { host: "localhost", extra: { "x-forwarded-for": "203.0.113.9" } },
  ],
  ["X-Real-IP with Host localhost", { host: "localhost", extra: { "x-real-ip": "203.0.113.9" } }],
  [
    "a public Host AND X-Forwarded-For",
    { host: PUBLIC_HOST, extra: { "x-forwarded-for": "203.0.113.9" } },
  ],
  ["a non-loopback socket with Host localhost", { socket: "203.0.113.9", host: "localhost" }],
];
for (const [name, c] of remote) {
  const stamped = locality(c);
  check(
    `remote: ${name}`,
    stamped !== "loopback" && !(await tokenAccepted(c)) && !(await loopbackOnlyOpen(c)),
    stamped
  );
}
check(
  "remote: the pure decision agrees for the public base host",
  !isLocalHostHeader(PUBLIC_HOST) && !isLocalHostHeader(`${PUBLIC_HOST}:8080`)
);
check(
  "remote: a Host that only looks like loopback is refused",
  ["127.0.0.1.evil.test", "localhost:abc", "[::1", "::1"].every((h) => !isLocalHostHeader(h))
);

// A loopback address configured as the public base is not public: it must not lock the operator out.
process.env.TROUTEAI_PUBLIC_BASE_URL = "http://localhost:20017";
check(
  "a loopback public base address does not make localhost remote",
  isLocalNodeRequest(nodeRequest({ host: "localhost:20017" })) &&
    (await tokenAccepted({ host: "localhost" }))
);
process.env.TROUTEAI_PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;

// Every name of the public address counts, not only the first.
delete process.env.TROUTEAI_PUBLIC_BASE_URL;
process.env.NEXT_PUBLIC_SITE_URL = "https://site.example.test";
check(
  "the last public base name (NEXT_PUBLIC_SITE_URL) is read too",
  !isLocalHostHeader("site.example.test") && isLocalHostHeader("localhost")
);
delete process.env.NEXT_PUBLIC_SITE_URL;
process.env.TROUTEAI_PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;

// ── A request that reaches the checks without the stamp (no socket stamp, direct callers) ──
const direct = (host: string | null, extra: Record<string, string> = {}) => {
  const headers = new Headers({ "x-trouteai-cli-token": secret, ...extra });
  if (host !== null) headers.set("host", host);
  const request = new Request("http://127.0.0.1/api/keys", { method: "POST", headers });
  Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });
  return request;
};
check(
  "route (no stamp): loopback socket and Host localhost: accepted",
  await isCliTokenAuthValid(direct("localhost:20017"))
);
check(
  "route (no stamp): the public base Host is refused",
  !(await isCliTokenAuthValid(direct(PUBLIC_HOST)))
);
check(
  "route (no stamp): another Host is refused",
  !(await isCliTokenAuthValid(direct("192.168.1.20")))
);
check("route (no stamp): no Host is refused", !(await isCliTokenAuthValid(direct(null))));
check(
  "route (no stamp): X-Real-IP with Host localhost is refused",
  !(await isCliTokenAuthValid(direct("localhost", { "x-real-ip": "203.0.113.9" })))
);

const unstamped = (host: string | null) => {
  const headers = new Headers({ "x-trouteai-cli-token": secret });
  if (host !== null) headers.set("host", host);
  const request = new Request("http://127.0.0.1/api/keys", { method: "POST", headers });
  Object.defineProperty(request, "socket", { value: { remoteAddress: "127.0.0.1" } });
  return request;
};
const policyAccepts = async (request: Request) => {
  const outcome = await managementPolicy.evaluate({
    request: request as never,
    classification: classifyRoute("/api/keys", "POST"),
    requestId: "check",
  });
  return outcome.allow === true && outcome.subject?.label === "local-cli-token";
};
check(
  "policy (no stamp): loopback socket and Host localhost: accepted",
  await policyAccepts(unstamped("localhost"))
);
check(
  "policy (no stamp): the public base Host is refused",
  !(await policyAccepts(unstamped(PUBLIC_HOST)))
);
check("policy (no stamp): no Host is refused", !(await policyAccepts(unstamped(null))));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
