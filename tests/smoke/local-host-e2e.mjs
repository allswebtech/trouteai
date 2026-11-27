#!/usr/bin/env node
// A caller on a loopback socket counts as local only with a loopback Host too. Starts the built
// app (`node app.cjs`) on a spare port with a throwaway data folder and a public base address; a
// request over loopback with the real command token is refused when its Host is the public base
// host (or any other non-loopback name, or missing) and accepted with Host localhost.
//
// Usage: node tests/smoke/local-host-e2e.mjs [port]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "../..");
const PORT = Number(process.argv[2] || process.env.LOCALHOST_PORT || 21177);
const PUBLIC_HOST = "gw.example.test";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-localhost-"));
const LOG = path.join(DATA, "app.log");

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
for (const k of ["HOST", "PORT", "DASHBOARD_PORT", "API_PORT", "TROUTEAI_UPDATE_CHECK"])
  delete env[k];
Object.assign(env, {
  DATA_DIR: DATA,
  INITIAL_PASSWORD: "Localhost-Test-Pass-123",
  PORT: String(PORT),
  TROUTEAI_PUBLIC_BASE_URL: `https://${PUBLIC_HOST}`,
});
const out = fs.openSync(LOG, "a");
const app = spawn(process.execPath, [path.join(APP_DIR, "app.cjs")], {
  cwd: APP_DIR,
  env,
  stdio: ["ignore", out, out],
  detached: true,
});
function cleanup() {
  try {
    process.kill(-app.pid, "SIGKILL");
  } catch {}
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on("exit", cleanup);

// node:http, so the Host header is exactly what is given (none at all with host: null).
function call(pathname, { method = "GET", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) h["content-type"] = "application/json";
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method, headers: h, setHost: false },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      }
    );
    if (host !== null && host !== undefined) req.setHeader("host", host);
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const started = Date.now();
let ready = false;
while (Date.now() - started < 90_000) {
  try {
    if ((await call("/healthz", { host: "localhost" })).status === 200) {
      ready = true;
      break;
    }
  } catch {}
  await sleep(300);
}
if (!ready) {
  console.log("FAIL  server did not start");
  console.log(fs.readFileSync(LOG, "utf8").split("\n").slice(-20).join("\n"));
  process.exit(1);
}

let token = "";
for (let i = 0; i < 20 && !token; i++) {
  try {
    token = fs.readFileSync(path.join(DATA, "cli-token"), "utf8").trim();
  } catch {
    await sleep(250);
  }
}
const withToken = { "x-trouteai-cli-token": token };
const refused = (r) => [400, 401, 403].includes(r.status); // no Host at all: Node itself answers 400

const listLocal = await call("/api/keys", { host: `localhost:${PORT}`, headers: withToken });
check(
  "command token, Host localhost: accepted",
  listLocal.status === 200,
  `status ${listLocal.status}`
);
const listIp = await call("/api/keys", { host: `127.0.0.1:${PORT}`, headers: withToken });
check(
  "command token, Host 127.0.0.1 (what the manager sends): accepted",
  listIp.status === 200,
  `status ${listIp.status}`
);
const listV6 = await call("/api/keys", { host: `[::1]:${PORT}`, headers: withToken });
check("command token, Host [::1]: accepted", listV6.status === 200, `status ${listV6.status}`);
for (const [name, host] of [
  ["the public base host", PUBLIC_HOST],
  ["the public base host with a port", `${PUBLIC_HOST}:443`],
  ["a LAN address", "192.168.1.20"],
  ["a made-up name", "anything.invalid"],
  ["no Host", null],
]) {
  const r = await call("/api/keys", { host, headers: withToken });
  check(`command token, Host ${name}: refused`, refused(r), `status ${r.status}`);
}

const linkLocal = await call("/api/auth/link", {
  method: "POST",
  host: `localhost:${PORT}`,
  headers: withToken,
});
check("sign-in link, Host localhost: made", linkLocal.status === 200, `status ${linkLocal.status}`);
const linkPublic = await call("/api/auth/link", {
  method: "POST",
  host: PUBLIC_HOST,
  headers: withToken,
});
check("sign-in link, public Host: refused", refused(linkPublic), `status ${linkPublic.status}`);

// A loopback-only route is refused (403) to a public Host before any credential is looked at.
const onlyLocal = await call("/api/db-backups/exportAll", { host: `localhost:${PORT}` });
const onlyPublic = await call("/api/db-backups/exportAll", { host: PUBLIC_HOST });
check(
  "loopback-only route: public Host gets 403, Host localhost gets past the gate",
  onlyPublic.status === 403 && onlyLocal.status !== 403,
  `public ${onlyPublic.status}, localhost ${onlyLocal.status}`
);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
