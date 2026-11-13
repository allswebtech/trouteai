#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import next from "next";

// Footprint note: `--max-old-space-size` only takes effect at LAUNCH (V8 ignores
// it at runtime via setFlagsFromString), so the heap cap that keeps idle RSS low
// is passed by the start commands (package.json "start", sixpanel.json) and by
// bin/trouteai.mjs (re-runs itself with 35% of RAM, 512-4096 MB, TROUTEAI_MAX_HEAP_MB overrides),
// not here. app.cjs cannot set the heap flag itself; for a capped panel run, use the
// startup command `node --max-old-space-size=256 app.cjs` (as sixpanel.json does).
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { resolveRuntimePorts, withRuntimePortEnv } from "../build/runtime-env.mjs";
import { createTrouteaiWsBridge } from "./v1-ws-bridge.mjs";
import { createResponsesWsProxy } from "./responses-ws-proxy.mjs";
import { ensurePeerStampToken, stampPeerIp } from "./peer-stamp.mjs";
import methodGuard from "./http-method-guard.cjs";
import headResponseGuard from "./head-response-guard.cjs";
import { ensureNativeSqlite } from "./ensure-native-sqlite.mjs";
import { isTurbopackCacheCorruption, purgeAllTurbopackCaches } from "./turbopackCacheHeal.mjs";
import { randomUUID } from "node:crypto";
import { getMainServerTimeoutConfig } from "./main-server-timeouts.mjs";
import { normalizeBasePath } from "../build/normalizeBasePath.mjs";
import { applyTerminalLogLevel, wantsInfoLogs } from "./terminalLog.mjs";

const { maybeHandleDisallowedMethod } = methodGuard;

// Node 25+ exposes a localStorage getter on the server that prints an
// ExperimentalWarning on first access unless --localstorage-file is given.
// Replace the accessor (without calling it) with undefined, as on older Node.
const hasLocalStorageFile = [...process.execArgv, process.env.NODE_OPTIONS || ""].some((arg) =>
  arg.includes("--localstorage-file")
);
if (!hasLocalStorageFile) {
  for (const key of ["localStorage", "sessionStorage"]) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    if (desc && desc.configurable && typeof desc.get === "function") {
      Object.defineProperty(globalThis, key, {
        value: undefined,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
  }
}

// Mirrors src/shared/utils/wsPath.ts::deriveLiveWsPath.
function deriveLiveWsPath(publicUrl) {
  if (!publicUrl || !/^wss?:\/\//.test(publicUrl)) return "/live-ws";
  try {
    const { pathname } = new URL(publicUrl);
    return pathname && pathname !== "/" ? pathname : "/live-ws";
  } catch {
    return "/live-ws";
  }
}
const { wrapRequestListenerWithHeadResponseGuard } = headResponseGuard;

// Add check for conflicting app/ directory
const rootAppDir = path.join(process.cwd(), "app");
if (fs.existsSync(rootAppDir) && fs.statSync(rootAppDir).isDirectory()) {
  console.error("\x1b[31m[FATAL ERROR]\x1b[0m Next.js App Router conflict detected!");
  console.error(`A root-level 'app/' directory was found at: ${rootAppDir}`);
  console.error("This conflicts with the 'src/app/' directory on Windows environments.");
  console.error("Next.js will serve 404s for all pages because it prefers the root 'app/' folder.");
  console.error("Please rename or delete the root 'app/' directory before starting TRouteAI.\n");
  process.exit(1);
}

const mode = process.argv[2] === "start" ? "start" : "dev";
const dev = mode === "dev";

// Self-heal a stale better-sqlite3 native binary after a Node version switch
// (nvm 22 <-> 24) before bootstrap touches the DB. No-op when the ABI matches.
if (dev) {
  ensureNativeSqlite();
}

const bootstrappedEnv = bootstrapEnv({
  // Production terminals only get bootstrap notes when APP_LOG_LEVEL asks for details.
  showInfo: (env) => dev || wantsInfoLogs(env.APP_LOG_LEVEL),
});
const runtimePorts = resolveRuntimePorts(bootstrappedEnv);
const mergedEnv = withRuntimePortEnv(bootstrappedEnv, runtimePorts);

for (const [key, value] of Object.entries(mergedEnv)) {
  if (value !== undefined) {
    process.env[key] = value;
  }
}

// Production: keep the terminal to warnings and errors unless APP_LOG_LEVEL asks for more.
if (!dev) {
  applyTerminalLogLevel(process.env.APP_LOG_LEVEL);
}

// The mergedEnv copy above pulls NODE_ENV straight from `.env`, and an older `.env`
// may still contain `NODE_ENV=production`. Next's programmatic `next()`
// entry (unlike the `next` CLI) trusts that value verbatim, so `npm run dev`
// would boot the dev bundler with NODE_ENV=production. That desyncs Next's
// webpack CSS pipeline and `src/app/globals.css` reaches webpack's JS parser
// instead of PostCSS — failing as `Module parse failed: Unexpected character
// '@'` on the `@import "tailwindcss"` line. Force NODE_ENV to track the run
// mode, exactly like the `next` CLI does.
process.env.NODE_ENV = dev ? "development" : "production";
process.env.TROUTEAI_INTERNAL_SCHEME = "http";

const { dashboardPort } = runtimePorts;
const hostname = process.env.HOST || "0.0.0.0";
// Turbopack by default in dev (matches the Next 16 CLI default and the production
// build default in build-next-isolated.mjs); TROUTEAI_USE_TURBOPACK=0 is the
// webpack escape hatch.
const useTurbopack = dev && mergedEnv.TROUTEAI_USE_TURBOPACK !== "0";
process.env.TROUTEAI_WS_BRIDGE_SECRET ||= randomUUID();
// Per-process secret used to prove the trusted peer-IP stamp came from this
// server (read by the authz middleware in the same process). See peer-stamp.mjs.
ensurePeerStampToken();

// Next 16 picks Turbopack by default in dev. Passing `turbopack: false` to the
// programmatic next() entry is *not* enough on its own:
//   - parseBundlerArgs (node_modules/next/dist/lib/bundler.js) sees no positive
//     bundler flag and falls back to `process.env.TURBOPACK = 'auto'`.
//   - next-dev-server.js then reads `process.env.TURBOPACK` directly and
//     starts Turbopack regardless of the option we passed.
// Force webpack by both passing `webpack: true` and clearing the env var.
if (!useTurbopack) {
  delete process.env.TURBOPACK;
}
function createNextApp() {
  return next({
    dev,
    dir: process.cwd(),
    hostname,
    port: dashboardPort,
    turbopack: useTurbopack,
    webpack: !useTurbopack,
  });
}

let nextApp = createNextApp();

// Best-effort self-heal for a corrupted Turbopack persistent dev cache:
// on Windows an mmap of an SST cache file can fail ("os error 1455" / paging
// file too small), which Turbopack surfaces as a misleading module-resolve
// error. This is an UPSTREAM Turbopack cache-corruption bug — not our code.
// When `prepare()` rejects with that signature we purge the cache and retry
// ONCE. Caveat: the failure often surfaces as a runtime overlay rather than a
// `prepare()` rejection, so this cannot always intercept it — the reliable
// remedy remains manually deleting `.build/next/**/cache/turbopack`.
async function prepareWithHeal() {
  try {
    await nextApp.prepare();
  } catch (error) {
    const detail =
      error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    if (!useTurbopack || !isTurbopackCacheCorruption(detail)) throw error;
    console.warn(
      "[Next] Turbopack dev cache looks corrupted (Windows mmap / os error 1455 — known upstream bug). Purging and retrying once…"
    );
    const removed = purgeAllTurbopackCaches();
    for (const dir of removed) console.warn(`[Next] purged Turbopack cache: ${dir}`);
    nextApp = createNextApp();
    await nextApp.prepare();
    console.warn("[Next] Turbopack dev cache purged; startup retry succeeded.");
  }
}

async function start() {
  await prepareWithHeal();

  const requestHandler = nextApp.getRequestHandler();
  const upgradeHandler = nextApp.getUpgradeHandler();
  const responsesWsProxy = createResponsesWsProxy({
    baseUrl: `http://127.0.0.1:${dashboardPort}`,
    bridgeSecret: process.env.TROUTEAI_WS_BRIDGE_SECRET,
  });
  // Live dashboard WebSocket (src/server/ws/liveServer.ts) is served on the main port at this
  // path; the handler is registered on globalThis by the live server at boot.
  const liveWsPath = `${normalizeBasePath(process.env.TROUTEAI_BASE_PATH)}${deriveLiveWsPath(
    process.env.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL
  )}`;
  const wsBridge = createTrouteaiWsBridge({
    baseUrl: `http://127.0.0.1:${dashboardPort}`,
  });

  // In-flight request counter shared with the graceful-shutdown drain
  // (src/lib/gracefulShutdown.ts reads globalThis.__trouteaiShutdown.activeRequests
  // in waitForDrain()). Tracked at the HTTP-server level so it covers EVERY
  // request including streaming SSE — res "close" fires when the stream ends
  // or the client disconnects, so a long-lived completion is counted the whole
  // time and the drain waits for it. Same global shape the .ts module creates;
  // we ensure it here because the server may start before instrumentation runs.
  const shutdownState = (globalThis.__trouteaiShutdown ||= {
    init: false,
    shuttingDown: false,
    activeRequests: 0,
  });
  const server = http.createServer(
    wrapRequestListenerWithHeadResponseGuard((req, res) => {
      if (maybeHandleDisallowedMethod(req, res)) return;
      // Stamp the real TCP peer IP before Next sees the request, so the authz
      // middleware can decide LOCAL_ONLY locality without trusting the Host header.
      stampPeerIp(req);
      shutdownState.activeRequests++;
      let counted = true;
      const release = () => {
        if (counted) {
          counted = false;
          shutdownState.activeRequests--;
        }
      };
      res.on("close", release);
      res.on("finish", release);
      return requestHandler(req, res);
    })
  );
  // Node's http.Server default keepAliveTimeout (5_000ms) races pooled
  // keep-alive HTTP clients that idle longer than that between requests (e.g.
  // the JVM java.net.http.HttpClient used by JetBrains AI Assistant), which
  // reuse a socket the server already tore down and get 0 response bytes back.
  // Raise both timeouts well above any realistic client idle-pool
  // window, mirroring src/lib/apiBridgeServer.ts's pattern.
  const mainServerTimeouts = getMainServerTimeoutConfig();
  server.keepAliveTimeout = mainServerTimeouts.keepAliveTimeoutMs;
  server.headersTimeout = mainServerTimeouts.headersTimeoutMs;
  server.on("upgrade", async (req, socket, head) => {
    try {
      const pathname = (req.url || "/").split("?")[0];
      if (pathname === liveWsPath && typeof globalThis.__trouteaiLiveWsUpgrade === "function") {
        globalThis.__trouteaiLiveWsUpgrade(req, socket, head);
        return;
      }
      const responsesWsHandled = await responsesWsProxy.handleUpgrade(req, socket, head);
      if (responsesWsHandled) return;
      const handled = await wsBridge.handleUpgrade(req, socket, head);
      if (handled) return;
      await upgradeHandler(req, socket, head);
    } catch (error) {
      if (!socket.destroyed) {
        socket.destroy(error instanceof Error ? error : undefined);
      }
      console.error("[WS] Upgrade handling failed:", error);
    }
  });

  server.on("error", (error) => {
    console.error("[FATAL] Next custom server failed:", error);
    process.exit(1);
  });

  // Single shutdown owner: src/lib/gracefulShutdown.ts (registered by Next
  // instrumentation in this same process) owns the SIGINT/SIGTERM/SIGHUP
  // handlers and runs the full drain sequence. We only hand it the server +
  // Next close handles via globalThis (the .mjs runner cannot import the .ts
  // module). Registering our own signal handlers too would race its sequence
  // and call process.exit() before in-flight requests finish draining.
  globalThis.__trouteaiServerHandles = {
    closeServer: () => new Promise((resolve) => server.close(() => resolve())),
    closeNext: () => nextApp.close(),
  };

  // Fallback only: if graceful shutdown never registered (e.g. instrumentation
  // failed to load), still exit cleanly on a signal instead of hanging.
  const fallbackShutdown = async (signal) => {
    if (globalThis.__trouteaiShutdown?.init) return; // owner present → let it run
    try {
      await new Promise((resolve) => server.close(resolve));
      await nextApp.close();
    } catch (error) {
      console.error("[SHUTDOWN] Failed during signal:", signal, error);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void fallbackShutdown("SIGINT"));
  process.on("SIGTERM", () => void fallbackShutdown("SIGTERM"));

  server.listen(dashboardPort, hostname, () => {
    if (!dev) {
      const shownHost = ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(hostname)
        ? "localhost"
        : hostname;
      process.stdout.write(
        `  ✓ TRouteAI is ready, listening on http://${shownHost}:${dashboardPort}\n`
      );
      return;
    }
    const bundler = useTurbopack ? "turbopack" : "webpack";
    console.log(
      `[Next] ${mode} server listening on http://${hostname}:${dashboardPort} (${bundler})`
    );
  });
}

start().catch((error) => {
  console.error("[FATAL] Failed to start Next custom server:", error);
  process.exit(1);
});
