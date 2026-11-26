#!/usr/bin/env node
// A key that is removed, switched off or changed acts on the very next request, in the running
// process: no restart, no waiting for a cache. Starts the built app (`node app.cjs`) on a spare
// port with a throwaway data folder.
//
// Usage: node tests/smoke/key-removal-e2e.mjs [port]
// Env:   KEY_WATCH_SECONDS=180  also poll every 5 s for that long and print when each case turns
//        into a refusal (a measuring mode; the suite itself checks the very next request).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "../..");
const PORT = Number(process.argv[2] || process.env.KEYGONE_PORT || 21176);
const WATCH = Number(process.env.KEY_WATCH_SECONDS || 0);
const PASSWORD = "Keygone-Test-Pass-123";
const base = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-keygone-"));
const LOG = path.join(DATA, "app.log");

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = { ...process.env };
for (const k of ["HOST", "PORT", "DASHBOARD_PORT", "API_PORT", "TROUTEAI_UPDATE_CHECK"]) delete env[k];
Object.assign(env, { DATA_DIR: DATA, INITIAL_PASSWORD: PASSWORD, PORT: String(PORT) });

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

async function request(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const started = Date.now();
let ready = false;
while (Date.now() - started < 90_000) {
  try {
    if ((await request(`${base}/healthz`)).status === 200) {
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

const rawLogin = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { origin: base, "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
const session = (rawLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const bySession = { origin: base, cookie: session };
let tokenText = "";
for (let i = 0; i < 20 && !tokenText; i++) {
  try {
    tokenText = fs.readFileSync(path.join(DATA, "cli-token"), "utf8").trim();
  } catch {
    await sleep(250);
  }
}
const byToken = { "x-trouteai-cli-token": tokenText };

async function makeKey(name) {
  const made = await request(`${base}/api/keys`, { method: "POST", headers: byToken, body: { name } });
  return { id: made.json?.id, key: made.json?.key };
}
const models = (key) => request(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } });

const cases = [
  {
    name: "removed by the command token",
    act: (k) => request(`${base}/api/keys/${k.id}`, { method: "DELETE", headers: byToken }),
  },
  {
    name: "removed from the dashboard with a session",
    act: (k) => request(`${base}/api/keys/${k.id}`, { method: "DELETE", headers: bySession }),
  },
  {
    name: "switched off",
    act: (k) =>
      request(`${base}/api/keys/${k.id}`, {
        method: "PATCH",
        headers: byToken,
        body: { isActive: false },
      }),
  },
  {
    name: "banned",
    act: (k) =>
      request(`${base}/api/keys/${k.id}`, {
        method: "PATCH",
        headers: byToken,
        body: { isBanned: true },
      }),
  },
];

for (const c of cases) {
  const k = await makeKey(c.name);
  if (!k.key) {
    check(`${c.name}: key made`, false, "no key");
    continue;
  }
  const before = await models(k.key);
  const before2 = await models(k.key);
  const acted = await c.act(k);
  const t0 = Date.now();
  const first = await models(k.key);
  const refused = first.status === 401 || first.status === 403;
  if (WATCH > 0) {
    let at = refused ? 0 : null;
    while (at === null && Date.now() - t0 < WATCH * 1000) {
      await sleep(5000);
      const r = await models(k.key);
      if (r.status === 401 || r.status === 403) at = Math.round((Date.now() - t0) / 1000);
    }
    console.log(`MEASURE  ${c.name}: ${at === null ? `still answered after ${WATCH} s` : `refused after ${at} s`}`);
  }
  check(
    `${c.name}: answered before (${before.status}/${before2.status}), act ${acted.status}, the next request is refused`,
    before.status === 200 && before2.status === 200 && acted.status < 300 && refused,
    `next request ${first.status}`
  );
}

const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
