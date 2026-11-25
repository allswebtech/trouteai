// Preload for the idle tests. Load it through NODE_OPTIONS ("--require <this file>"), not as a
// command-line flag: a flag naming a "tests" folder lands in process.execArgv, where the server's
// test-runner detection sees it and switches background jobs off. It records
// what an idle server does: every timer with its period, the module that created it and how often
// it fired, every outbound connection, DNS lookup and child process, memory and CPU time.
//
// A connection or a lookup of anything other than this machine is recorded and then failed before
// it leaves the process, so an idle test never reaches the network even when a background job
// tries to.
//
// The probe writes nothing until it gets SIGUSR2. Then it appends one JSON line (a sample) to
// IDLE_PROBE_OUT. When the file `${IDLE_PROBE_OUT}.cmd` exists it is read first:
// {"label": "...", "heapSnapshot": "<file>"} names the sample and optionally writes a heap
// snapshot. Start node with --enable-source-maps so that owners are named by source file.
"use strict";

const childProcess = require("node:child_process");
const dns = require("node:dns");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const timers = require("node:timers");
const v8 = require("node:v8");

const OUT = process.env.IDLE_PROBE_OUT;
// IDLE_PROBE_STACKS=0 records no stacks: no owner names, but memory and CPU numbers that the
// probe itself does not inflate (stacks and source maps cost both).
const STACKS = process.env.IDLE_PROBE_STACKS !== "0";
const ROOT = path.resolve(__dirname, "../..");
const PROBE = __filename;
const t0 = Date.now();

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;

/** Timeout object -> record; destroyed timers are swept out now and then. */
const live = new Map();
let created = 0;
/** owner -> fires since the last sample */
let firesByOwner = new Map();
/** outbound attempts since the last sample */
let outbound = [];
let lastCpu = process.cpuUsage();
let lastSampleAt = t0;
let samples = 0;

function since() {
  return Math.round((Date.now() - t0) / 100) / 10;
}

const { SourceMap } = require("node:module");
const maps = new Map();
// Build chunks are minified; their source maps name the source file and line.
function mapFrame(file, line, col) {
  if (!file.endsWith(".js") || !file.includes(".build/next/server/")) return null;
  let sm = maps.get(file);
  if (sm === undefined) {
    try {
      sm = new SourceMap(JSON.parse(fs.readFileSync(`${file}.map`, "utf8")));
    } catch {
      sm = null;
    }
    maps.set(file, sm);
  }
  if (!sm) return null;
  const e = sm.findEntry(line - 1, col - 1);
  if (!e || !e.originalSource) return null;
  const src = e.originalSource.replace(/^(\.\.\/)+/, "").replace(/^\[project\]\//, "");
  return { file: src, line: String(e.originalLine + 1) };
}

function framesOf(stack) {
  const frames = [];
  for (const l of String(stack || "")
    .split("\n")
    .slice(1)) {
    if (l.includes(PROBE)) continue;
    const m = l.match(/\(?((?:[a-z]+:\/\/\/?)?[^()\s]+):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    let file = m[1].replace(/^file:\/\//, "");
    const mapped = mapFrame(path.resolve(ROOT, file), Number(m[2]), Number(m[3]));
    if (mapped) {
      frames.push(mapped);
      continue;
    }
    if (file.startsWith(ROOT + "/")) file = file.slice(ROOT.length + 1);
    frames.push({ file, line: m[2] });
  }
  return frames;
}

// The shared idle-aware timer helper is not the owner; the frame that called it is.
const isAppFrame = (f) =>
  /^(src|open-sse|scripts|bin)\//.test(f.file) &&
  !f.file.includes("turbopack") &&
  !f.file.startsWith("src/lib/idleState.ts");

// The first frame that belongs to the app names the owner; with no app frame, the package.
function ownerOf(stack) {
  const frames = framesOf(stack);
  const app = frames.find(isAppFrame);
  if (app) return `${app.file}:${app.line}`;
  const pkg = frames.find((f) => f.file.includes("node_modules/"));
  if (pkg) {
    const m = pkg.file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/);
    if (m) return `${m[1]}:${m[2].split("/").slice(-1)[0]}:${pkg.line}`;
  }
  const first = frames[0];
  return first ? `${first.file}:${first.line}` : "unknown";
}

function capture() {
  if (!STACKS) return { stack: "" };
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const e = new Error();
  Error.stackTraceLimit = limit;
  // V8 formats the stack only when it is read, so this stays cheap until a report needs it.
  return e;
}

function recordOwner(rec) {
  if (!rec.owner) rec.owner = ownerOf(rec.stack.stack);
  return rec.owner;
}

function sweep() {
  for (const t of live.keys()) if (t._destroyed) live.delete(t);
}

function wrap(kind, real) {
  return function probeTimer(cb, ms, ...args) {
    if (typeof cb !== "function") return real.call(this, cb, ms, ...args);
    const rec = {
      kind,
      ms: Number(ms) || 0,
      name: cb.name || "",
      stack: capture(),
      owner: null,
      at: since(),
    };
    const wrapped = function () {
      const owner = recordOwner(rec);
      firesByOwner.set(owner, (firesByOwner.get(owner) || 0) + 1);
      return cb.apply(this, arguments);
    };
    const t = real.call(this, wrapped, ms, ...args);
    if (t && typeof t === "object") live.set(t, rec);
    if (++created % 500 === 0) sweep();
    return t;
  };
}

globalThis.setTimeout = wrap("timeout", realSetTimeout);
globalThis.setInterval = wrap("interval", realSetInterval);
timers.setTimeout = globalThis.setTimeout;
timers.setInterval = globalThis.setInterval;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::", ""]);
function isLocal(host) {
  if (host === undefined || host === null) return true;
  const h = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return LOCAL_HOSTS.has(h) || h.startsWith("127.") || h.endsWith(".localhost");
}

// Network helpers are shared by every job; the caller below them names the job. Async stack
// frames ("at async ...") reach back through awaits, so the chain usually names it.
function noteOutbound(kind, target, blocked) {
  const stack = capture().stack;
  const chain = [
    ...new Set(
      framesOf(stack)
        .filter(isAppFrame)
        .map((f) => `${f.file}:${f.line}`)
    ),
  ];
  outbound.push({
    at: since(),
    kind,
    target,
    blocked,
    owner: ownerOf(stack),
    chain: chain.slice(0, 12),
  });
}

function blockedError(target) {
  const err = new Error(`connect ECONNREFUSED ${target} (blocked by the idle probe)`);
  err.code = "ECONNREFUSED";
  return err;
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function probeConnect(...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  let host;
  let port;
  let pathName;
  if (opts && typeof opts === "object") {
    host = opts.host ?? opts.hostname;
    port = opts.port;
    pathName = opts.path;
  } else if (typeof opts === "number" || /^\d+$/.test(String(opts))) {
    port = opts;
    host = typeof args[1] === "string" ? args[1] : undefined;
  } else if (typeof opts === "string") {
    pathName = opts;
  }
  if (pathName) return realConnect.apply(this, args);
  const target = `${host ?? "localhost"}:${port}`;
  if (isLocal(host)) return realConnect.apply(this, args);
  noteOutbound("connect", target, true);
  const socket = this;
  process.nextTick(() => socket.destroy(blockedError(target)));
  return socket;
};

const realLookup = dns.lookup;
dns.lookup = function probeLookup(hostname, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  if (isLocal(hostname)) return realLookup.apply(this, arguments);
  noteOutbound("dns", String(hostname), true);
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by the idle probe)`);
  err.code = "ENOTFOUND";
  process.nextTick(() => cb(err));
  return {};
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function probePromiseLookup(hostname, ...rest) {
  if (isLocal(hostname)) return realPromiseLookup.call(this, hostname, ...rest);
  noteOutbound("dns", String(hostname), true);
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname} (blocked by the idle probe)`);
  err.code = "ENOTFOUND";
  throw err;
};

for (const fn of ["spawn", "execFile", "exec", "fork"]) {
  const real = childProcess[fn];
  childProcess[fn] = function probeChild(cmd, ...rest) {
    noteOutbound("process", `${fn} ${String(cmd).split(/\s/)[0]}`, false);
    return real.call(this, cmd, ...rest);
  };
}

function readCmd() {
  try {
    const file = `${OUT}.cmd`;
    const cmd = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
    return cmd;
  } catch {
    return {};
  }
}

function sample() {
  const cmd = readCmd();
  sweep();
  const alive = [];
  for (const [t, rec] of live) {
    if (t._destroyed) continue;
    alive.push({
      kind: t._repeat ? "interval" : rec.kind,
      ms: t._repeat || t._idleTimeout || rec.ms,
      ref: typeof t.hasRef === "function" ? t.hasRef() : true,
      owner: recordOwner(rec),
      name: rec.name,
      createdAt: rec.at,
    });
  }
  alive.sort((a, b) => a.ms - b.ms || a.owner.localeCompare(b.owner));
  const cpu = process.cpuUsage(lastCpu);
  const mem = process.memoryUsage();
  const now = Date.now();
  const line = {
    label: cmd.label || `sample-${samples + 1}`,
    at: since(),
    windowSeconds: Math.round((now - lastSampleAt) / 100) / 10,
    cpuSeconds: Math.round((cpu.user + cpu.system) / 1e4) / 100,
    cpuTotalSeconds:
      Math.round(((process.cpuUsage().user + process.cpuUsage().system) / 1e6) * 100) / 100,
    rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
    heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    heapTotalMB: Math.round((mem.heapTotal / 1048576) * 10) / 10,
    externalMB: Math.round((mem.external / 1048576) * 10) / 10,
    heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576),
    resources: process.getActiveResourcesInfo().reduce((acc, r) => {
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {}),
    timers: alive,
    fires: Object.fromEntries([...firesByOwner].sort((a, b) => b[1] - a[1])),
    outbound,
  };
  firesByOwner = new Map();
  outbound = [];
  lastCpu = process.cpuUsage();
  lastSampleAt = now;
  samples++;
  if (cmd.heapSnapshot) {
    if (typeof globalThis.gc === "function") globalThis.gc();
    line.heapSnapshot = v8.writeHeapSnapshot(cmd.heapSnapshot);
  }
  if (OUT) fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
}

process.on("SIGUSR2", sample);
