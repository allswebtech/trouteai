// Install and first start, proven the way a person and a program that manages TRouteAI do it.
//
//   node tests/smoke/install-e2e.mjs [path/to/trouteai-<version>.tgz]
//
// 1. `npm pack` (or the given tarball), then the README's install line into a prefix of its own.
// 2. Start it with --port, --host and --data-dir on a spare port with a throwaway data folder,
//    wait for /healthz, make a key with `trouteai key create`, ask /v1/models with that key,
//    stop it with SIGTERM: the port is free and no process of it is left.
// 3. Upgrade: install the released 1.0.10 from npm into another prefix, start it on a
//    throwaway data folder, add a provider and a key, stop it, start the packed build on the same
//    folder: the provider is listed and the key still answers.
// 4. Idle numbers (printed, not a gate): memory (RSS) and CPU of the idle server over 60 s after 120 s idle.
//
// Works on Linux, macOS and Windows (the workflow .github/workflows/install.yml runs all three).
// What differs on Windows: npm is a .cmd file (the npm script is run through node instead); a
// global install puts the files directly in the prefix (no lib/ and bin/); process lists and
// memory come from PowerShell, not ps; and a signal sent from outside is TerminateProcess, so
// "stop with SIGTERM" ends the parent at once without a drain. The check still wants the whole
// tree gone, which is what a program that stops TRouteAI on Windows needs.
//
// Env: INSTALL_E2E_TARBALL (a ready tarball; saves the build of npm pack), INSTALL_E2E_KEEP=1 (keep
// the throwaway folder), INSTALL_E2E_IDLE_WAIT and INSTALL_E2E_IDLE_SAMPLE (seconds, default 120
// and 60; 0 for IDLE_SAMPLE skips the idle numbers), INSTALL_E2E_OLD (the released version, default
// 1.0.10). Throwaway folders and a spare port only; needs the network for the npm install of the old version.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The restart step: POST /api/restart, then /healthz answers again on the same port with the same parent pid.
const RESTART_STEP = true;

const WIN = process.platform === "win32";
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSWORD = "Install-E2e-Pass-123";
const OLD_VERSION = process.env.INSTALL_E2E_OLD || "1.0.10";
const IDLE_WAIT = Number(process.env.INSTALL_E2E_IDLE_WAIT ?? 120);
const IDLE_SAMPLE = Number(process.env.INSTALL_E2E_IDLE_SAMPLE ?? 60);
const INSTALL_LINE = ["--allow-scripts=tls-client-node,koffi", "--loglevel=error"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}
function info(text) {
  console.log(`      ${text}`);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-install-"));
const live = new Set(); // pids of every server tree started, killed at the end whatever happens

// ── npm ─────────────────────────────────────────────────────────────────────
// Prefer node + npm-cli.js (no .cmd, no shell); fall back to the npm on PATH.
function npmCommand() {
  const nodeDir = path.dirname(process.execPath);
  const rel = WIN ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js";
  const file = path.resolve(nodeDir, rel);
  if (fs.existsSync(file)) return { cmd: process.execPath, pre: [file], shell: false };
  return { cmd: WIN ? "npm.cmd" : "npm", pre: [], shell: WIN };
}
function npm(args, options = {}) {
  const { cmd, pre, shell } = npmCommand();
  return spawnSync(cmd, [...pre, ...args], {
    encoding: "utf8",
    shell,
    timeout: 600_000,
    ...options,
  });
}
function tail(text, lines = 12) {
  return String(text ?? "")
    .trim()
    .split("\n")
    .slice(-lines)
    .join(" | ")
    .slice(0, 600);
}

// A global install: <prefix>/lib/node_modules/<name> and <prefix>/bin/<name>; on Windows both are in <prefix>.
const packageDir = (prefix) => path.join(prefix, WIN ? "" : "lib", "node_modules", "trouteai");
const shimPath = (prefix) =>
  WIN ? path.join(prefix, "trouteai.cmd") : path.join(prefix, "bin", "trouteai");

function installInto(prefix, spec) {
  const out = npm(["install", "-g", "--prefix", prefix, spec, ...INSTALL_LINE], { cwd: work });
  const pkg = packageDir(prefix);
  const ok = out.status === 0 && fs.existsSync(path.join(pkg, "bin", "trouteai.mjs"));
  return { ok, pkg, detail: ok ? "" : `exit ${out.status} ${tail(out.stderr || out.stdout)}` };
}

// ── processes ───────────────────────────────────────────────────────────────
function powershell(script) {
  // Windows has no ps: the same facts from PowerShell.
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return out.status === 0 ? String(out.stdout) : "";
}
/** pid + every descendant, from the process table. */
function treeOf(root) {
  const rows = [];
  if (WIN) {
    const text = powershell(
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'
    );
    for (const line of text.split(/\r?\n/)) {
      const [pid, ppid] = line.trim().split(",").map(Number);
      if (pid) rows.push([pid, ppid]);
    }
  } else {
    const out = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    for (const line of String(out.stdout).split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) rows.push([pid, ppid]);
    }
  }
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found];
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function killTree(pids) {
  for (const pid of pids) {
    if (!alive(pid)) continue;
    try {
      if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch {}
  }
}
/** { rssMb, cpuSeconds } summed over the pids. */
function usage(pids) {
  const list = pids.filter(alive);
  if (list.length === 0) return null;
  let rss = 0;
  let cpu = 0;
  if (WIN) {
    const text = powershell(
      `Get-Process -Id ${list.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.WorkingSet64),$($_.TotalProcessorTime.TotalSeconds)" }`
    );
    for (const line of text.split(/\r?\n/)) {
      const [bytes, seconds] = line.trim().split(",").map(Number);
      if (bytes) {
        rss += bytes / 1048576;
        cpu += seconds || 0;
      }
    }
    return { rssMb: rss, cpuSeconds: cpu };
  }
  const out = spawnSync("ps", ["-o", "rss=,cputime=", "-p", list.join(",")], { encoding: "utf8" });
  for (const line of String(out.stdout).split("\n")) {
    const [kb, time] = line.trim().split(/\s+/);
    if (!kb || !time) continue;
    rss += Number(kb) / 1024;
    // [dd-]hh:mm:ss (Linux) or [hh:]mm:ss.cc (macOS)
    const [days, clock] = time.includes("-") ? time.split("-") : [0, time];
    cpu +=
      clock.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86400;
  }
  return { rssMb: rss, cpuSeconds: cpu };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () =>
      server.close(() => resolve(true))
    );
  });
}

// ── the server, started the way a program that manages it starts it ─────────
async function request(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json, headers: res.headers };
}

function startServer(pkg, dataDir, port, logFile) {
  const env = { ...process.env, INITIAL_PASSWORD: PASSWORD };
  for (const name of ["PORT", "HOST", "DATA_DIR", "DASHBOARD_PORT", "API_PORT", "NODE_OPTIONS"]) {
    delete env[name];
  }
  const log = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [
      path.join(pkg, "bin", "trouteai.mjs"),
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--data-dir",
      dataDir,
    ],
    { env, stdio: ["ignore", log, log], windowsHide: true }
  );
  fs.closeSync(log);
  const state = { child, exited: null, tree: [child.pid], logFile };
  live.add(child.pid);
  child.on("exit", (code, signal) => {
    state.exited = { code, signal, at: Date.now() };
  });
  return state;
}
async function waitHealthy(state, port, seconds = 180) {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop && !state.exited) {
    const res = await request(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    if (res?.status === 200 && res.text.trim() === "ok") {
      state.tree = treeOf(state.child.pid);
      for (const pid of state.tree) live.add(pid);
      return true;
    }
    await sleep(500);
  }
  return false;
}
function logTail(state) {
  try {
    return tail(fs.readFileSync(state.logFile, "utf8"));
  } catch {
    return "";
  }
}
/** SIGTERM the parent; the whole tree must end, the port must be free. */
async function stopServer(state, port, label) {
  const tree = new Set([...treeOf(state.child.pid), ...state.tree]);
  state.tree = [...tree];
  const sent = Date.now();
  if (!state.exited) state.child.kill("SIGTERM");
  while (state.tree.some(alive) && Date.now() - sent < 30_000) await sleep(200);
  const left = state.tree.filter(alive);
  const seconds = Math.round((Date.now() - sent) / 100) / 10;
  const portFree = await portIsFree(port);
  const ended = check(
    `${label}: SIGTERM ends the program and every process of it`,
    left.length === 0 && state.exited !== null,
    left.length
      ? `${left.length} process(es) left after 30 s${WIN ? "; on Windows a signal ends only the parent" : ""}`
      : `${seconds} s, exit ${state.exited?.code ?? state.exited?.signal}`
  );
  check(`${label}: the port is free after the stop`, portFree);
  if (left.length) killTree(left);
  for (const pid of state.tree) live.delete(pid);
  return ended && portFree;
}

async function login(port) {
  const base = `http://127.0.0.1:${port}`;
  const res = await request(`${base}/api/auth/login`, {
    method: "POST",
    headers: { origin: base },
    body: { password: PASSWORD },
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return { base, manage: { origin: base, cookie }, ok: res.status < 300 && !!cookie };
}

async function main() {
  console.log(
    `install-e2e on ${process.platform}/${process.arch}, Node ${process.versions.node}, work folder ${work}`
  );

  // ── pack ──────────────────────────────────────────────────────────────────
  let tarball = process.env.INSTALL_E2E_TARBALL || process.argv[2] || "";
  if (!tarball) {
    const packed = npm(["pack", "--pack-destination", work, "--loglevel=error"], {
      cwd: APP_DIR,
    });
    // The release build prints its own lines first; the file name is the last line.
    const lines = String(packed.stdout).trim().split(/\r?\n/);
    tarball = path.join(work, lines[lines.length - 1].trim());
    const ok = packed.status === 0 && !!tarball && fs.existsSync(tarball);
    if (!check("npm pack makes the tarball", ok, ok ? "" : tail(packed.stderr || packed.stdout))) {
      return;
    }
  } else {
    tarball = path.resolve(tarball);
    if (!check("tarball given", fs.existsSync(tarball), path.basename(tarball))) return;
  }
  const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;

  // ── install (the README's line) ───────────────────────────────────────────
  const prefix = path.join(work, "prefix-new");
  const installed = installInto(prefix, tarball);
  if (!check("npm install -g (README line) into its own prefix", installed.ok, installed.detail)) {
    return;
  }
  check(
    "the trouteai command is in the prefix",
    fs.existsSync(shimPath(prefix)),
    path.relative(prefix, shimPath(prefix))
  );
  const shimVersion = spawnSync(shimPath(prefix), ["--version"], {
    encoding: "utf8",
    shell: WIN,
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    },
  });
  check(
    "trouteai --version prints the version",
    String(shimVersion.stdout).trim() === version,
    String(shimVersion.stdout).trim() || tail(shimVersion.stderr)
  );

  // ── first start ───────────────────────────────────────────────────────────
  const dataDir = path.join(work, "data-new");
  let port = await freePort();
  let server = startServer(installed.pkg, dataDir, port, path.join(work, "server-new.log"));
  const healthy = await waitHealthy(server, port);
  check(
    "first start: /healthz answers ok",
    healthy,
    healthy
      ? ""
      : server.exited
        ? `exited ${server.exited.code}: ${logTail(server)}`
        : `no answer in 180 s: ${logTail(server)}`
  );
  if (!healthy) {
    await stopServer(server, port, "first start");
    return;
  }
  check(
    "the data folder has its secrets",
    ["server.env", "cli-token"].every((f) => fs.existsSync(path.join(dataDir, f))),
    fs.readdirSync(dataDir).join(" ")
  );

  const made = spawnSync(
    process.execPath,
    [
      path.join(installed.pkg, "bin", "trouteai.mjs"),
      "key",
      "create",
      "install test",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, DATA_DIR: dataDir } }
  );
  const key = String(made.stdout).trim();
  check(
    "trouteai key create prints a key",
    made.status === 0 && /^sk-/.test(key),
    made.status === 0 ? "" : `exit ${made.status}: ${tail(made.stderr)}`
  );
  const models = await request(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
  }).catch((error) => ({ status: String(error) }));
  check(
    "/v1/models answers 200 with that key",
    models.status === 200 && Array.isArray(models.json?.data),
    String(models.status)
  );
  const without = await request(`http://127.0.0.1:${port}/v1/models`).catch(() => ({ status: 0 }));
  check("/v1/models without a key is refused", without.status === 401, String(without.status));

  if (RESTART_STEP) {
    const session = await login(port);
    const parentPid = server.child.pid;
    const restart = await request(`${session.base}/api/restart`, {
      method: "POST",
      headers: session.manage,
    });
    await sleep(1500);
    let back = false;
    for (const stop = Date.now() + 30_000; Date.now() < stop && !back;) {
      const res = await request(`${session.base}/healthz`).catch(() => null);
      back = res?.status === 200;
      if (!back) await sleep(500);
    }
    check(
      "restart: /healthz answers again on the same port with the same parent pid",
      restart.status < 300 && back && alive(parentPid) && !server.exited,
      `restart ${restart.status}`
    );
    server.tree = treeOf(server.child.pid);
    for (const pid of server.tree) live.add(pid);
  }

  await stopServer(server, port, "first start");

  // ── upgrade: the released version, then the packed build on the same data ──
  const oldPrefix = path.join(work, "prefix-old");
  const old = installInto(oldPrefix, `trouteai@${OLD_VERSION}`);
  if (!check(`npm install -g trouteai@${OLD_VERSION} from npm`, old.ok, old.detail)) return;
  const upData = path.join(work, "data-upgrade");
  port = await freePort();
  server = startServer(old.pkg, upData, port, path.join(work, "server-old.log"));
  const oldUp = await waitHealthy(server, port);
  if (!check(`upgrade: ${OLD_VERSION} starts`, oldUp, oldUp ? "" : logTail(server))) {
    await stopServer(server, port, OLD_VERSION);
    return;
  }
  const session = await login(port);
  check(`upgrade: sign in on ${OLD_VERSION}`, session.ok);
  const node = await request(`${session.base}/api/provider-nodes`, {
    method: "POST",
    headers: session.manage,
    body: {
      name: "Upgrade",
      prefix: "upg",
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: "http://127.0.0.1:9/v1",
    },
  });
  const nodeId = node.json?.node?.id || node.json?.id;
  const conn = await request(`${session.base}/api/providers`, {
    method: "POST",
    headers: session.manage,
    body: { provider: nodeId, name: "upgrade-conn", apiKey: "sk-fake-upstream" },
  });
  check(
    `upgrade: provider added on ${OLD_VERSION}`,
    !!nodeId && conn.status < 300,
    `${node.status} ${conn.status}`
  );
  const keyMade = await request(`${session.base}/api/keys`, {
    method: "POST",
    headers: session.manage,
    body: { name: "upgrade key" },
  });
  const oldKey = keyMade.json?.key ?? "";
  const oldAnswer = await request(`${session.base}/v1/models`, {
    headers: { authorization: `Bearer ${oldKey}` },
  });
  check(
    `upgrade: key made on ${OLD_VERSION} answers`,
    /^sk-/.test(oldKey) && oldAnswer.status === 200,
    `${keyMade.status} ${oldAnswer.status}`
  );
  const secretBefore = fs.readFileSync(path.join(upData, "server.env"), "utf8");
  await stopServer(server, port, OLD_VERSION);

  server = startServer(installed.pkg, upData, port, path.join(work, "server-upgraded.log"));
  const upgraded = await waitHealthy(server, port);
  check(
    `upgrade: the packed build ${version} starts on the same data folder`,
    upgraded,
    upgraded ? "" : logTail(server)
  );
  if (!upgraded) {
    await stopServer(server, port, version);
    return;
  }
  const again = await login(port);
  check("upgrade: the same password still signs in", again.ok);
  const providers = await request(`${again.base}/api/providers`, { headers: again.manage });
  const nodes = await request(`${again.base}/api/provider-nodes`, { headers: again.manage });
  check(
    "upgrade: the provider is still listed",
    providers.text.includes("upgrade-conn") && nodes.text.includes("upg"),
    `${providers.status} ${nodes.status}`
  );
  const answer = await request(`${again.base}/v1/models`, {
    headers: { authorization: `Bearer ${oldKey}` },
  });
  check(
    "upgrade: the key of the old version still answers",
    answer.status === 200,
    String(answer.status)
  );
  check(
    "upgrade: the secret file is unchanged",
    fs.readFileSync(path.join(upData, "server.env"), "utf8") === secretBefore
  );

  // ── idle numbers (printed, not a gate) ──────────────────────────────────
  if (IDLE_SAMPLE > 0) {
    info(`idle numbers: waiting ${IDLE_WAIT} s, then sampling ${IDLE_SAMPLE} s`);
    await sleep(IDLE_WAIT * 1000);
    server.tree = treeOf(server.child.pid);
    const first = usage(server.tree);
    const t0 = Date.now();
    let peak = first?.rssMb ?? 0;
    while (Date.now() - t0 < IDLE_SAMPLE * 1000) {
      await sleep(Math.min(10_000, IDLE_SAMPLE * 1000));
      peak = Math.max(peak, usage(server.tree)?.rssMb ?? 0);
    }
    const last = usage(server.tree);
    if (first && last) {
      const seconds = (Date.now() - t0) / 1000;
      const cpu = ((last.cpuSeconds - first.cpuSeconds) / seconds) * 100;
      console.log(
        `IDLE  ${process.platform}/${process.arch} node ${process.versions.node}: RSS ${last.rssMb.toFixed(0)} MB (peak ${peak.toFixed(0)} MB), CPU ${cpu.toFixed(2)} % of one core over ${seconds.toFixed(0)} s, ${server.tree.length} process(es)`
      );
    } else info("idle numbers: the server ended before the sample");
  }
  await stopServer(server, port, `${version} on the upgraded data`);
}

try {
  await main();
} catch (error) {
  check(
    "the script ran to its end",
    false,
    String(error?.stack || error)
      .split("\n")
      .slice(0, 3)
      .join(" | ")
  );
} finally {
  killTree([...live]);
  if (process.env.INSTALL_E2E_KEEP) console.log(`kept ${work}`);
  else {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {}
  }
}
console.log(failed === 0 ? "\ninstall-e2e: all passed" : `\ninstall-e2e: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
