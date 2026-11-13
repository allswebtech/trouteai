/**
 * Graceful Shutdown — E-2 Critical Fix
 *
 * Handles SIGTERM / SIGINT to drain in-flight requests before exit.
 * Critical for Docker containers and Kubernetes pods where hard kills
 * can drop active SSE streams.
 *
 * Usage:
 *   import { initGracefulShutdown } from "@/lib/gracefulShutdown";
 *   initGracefulShutdown();
 *
 * @module lib/gracefulShutdown
 */

import { markServerStopping } from "@/lib/serverLifecycle";

/** Grace period before forced exit (default 30s, configurable) */
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || "30000", 10);

declare global {
  var __trouteaiShutdown:
    { init: boolean; shuttingDown: boolean; activeRequests: number } | undefined;
  /**
   * The custom Node HTTP server + Next app, registered by scripts/dev/run-next.mjs
   * so the single shutdown owner here can stop accepting new connections and
   * close Next before draining. The .mjs runner cannot import this .ts module,
   * so it hands the handles over via globalThis instead.
   */
  var __trouteaiServerHandles:
    | { closeServer?: () => Promise<void>; closeNext?: () => Promise<void> }
    | undefined;
}

/**
 * Register the custom server's close handles so this module (the single owner
 * of the process signal handlers) can shut the listener and Next down as part
 * of the drain sequence. Called by scripts/dev/run-next.mjs, which owns the
 * `http.Server` and the Next app instance.
 */
export function registerServerHandles(handles: {
  closeServer?: () => Promise<void>;
  closeNext?: () => Promise<void>;
}): void {
  globalThis.__trouteaiServerHandles = handles;
}

function getShutdownState() {
  if (!globalThis.__trouteaiShutdown) {
    globalThis.__trouteaiShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
  }
  return globalThis.__trouteaiShutdown;
}

/**
 * Check if the server is currently shutting down.
 * Route handlers can use this to reject new requests.
 */
export function isDraining(): boolean {
  return getShutdownState().shuttingDown;
}

/**
 * Track a new in-flight request. Call `done()` when it completes.
 * Returns a done callback.
 */
export function trackRequest(): () => void {
  const state = getShutdownState();
  state.activeRequests++;
  let called = false;
  return () => {
    if (!called) {
      called = true;
      state.activeRequests--;
    }
  };
}

/**
 * Get current active request count (for monitoring/health endpoints).
 */
export function getActiveRequestCount(): number {
  return getShutdownState().activeRequests;
}

/**
 * Wait for all in-flight requests to complete, with timeout.
 */
async function waitForDrain(): Promise<void> {
  const state = getShutdownState();
  const start = Date.now();
  const CHECK_INTERVAL_MS = 250;

  return new Promise((resolve) => {
    const check = () => {
      if (state.activeRequests <= 0) {
        console.log("[Shutdown] All in-flight requests drained.");
        resolve();
        return;
      }

      if (Date.now() - start > SHUTDOWN_TIMEOUT_MS) {
        console.warn(
          `[Shutdown] Timeout after ${SHUTDOWN_TIMEOUT_MS}ms with ${state.activeRequests} active requests. Forcing exit.`
        );
        resolve();
        return;
      }

      console.log(`[Shutdown] Waiting for ${state.activeRequests} in-flight request(s)...`);
      setTimeout(check, CHECK_INTERVAL_MS);
    };

    check();
  });
}

/**
 * Perform cleanup: close DB connections, flush logs.
 */
async function cleanup(): Promise<void> {
  try {
    const [{ closeDbInstance }, { flushSpendBatchWriter }, { closeLogRotation }] =
      await Promise.all([
        import("@/lib/db/core"),
        import("@/lib/spend/batchWriter"),
        import("@/lib/logRotation"),
      ]);
    const flushResult = await flushSpendBatchWriter();
    if (flushResult.flushedEntries > 0) {
      console.log(
        `[Shutdown] Spend batch writer flushed ${flushResult.flushedEntries} pending entry(ies).`
      );
    }
    if (closeDbInstance()) {
      console.log("[Shutdown] SQLite database checkpointed and closed.");
    }
    closeLogRotation();
    console.log("[Shutdown] Log rotation timer stopped.");
  } catch (err) {
    console.error("[Shutdown] Error during cleanup:", (err as Error).message);
  }
}

/**
 * Initialize graceful shutdown handlers.
 * Should be called once during server startup.
 */
export function initGracefulShutdown(): void {
  const state = getShutdownState();
  if (state.init) return;
  state.init = true;

  const shutdown = async (signal: string) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    markServerStopping();

    console.log(`\n[Shutdown] Received ${signal}. Draining ${state.activeRequests} request(s)...`);

    // Stop accepting NEW connections first (markServerStopping + isDraining
    // already 503 new /api requests), then let in-flight requests finish,
    // then tear Next and the data layer down. server.close() resolves only
    // once existing connections end, so run it concurrently with the drain
    // poll under the same timeout rather than serially before it.
    const handles = globalThis.__trouteaiServerHandles;
    const serverClosed = handles?.closeServer
      ? handles.closeServer().catch((err) => {
          console.error("[Shutdown] Error closing HTTP server:", (err as Error).message);
        })
      : Promise.resolve();

    await Promise.race([
      Promise.all([waitForDrain(), serverClosed]),
      // Hard ceiling so a stuck server.close() (lingering keep-alive socket)
      // cannot outlast the drain budget; waitForDrain already self-limits.
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS + 1000)),
    ]);

    if (handles?.closeNext) {
      try {
        await handles.closeNext();
      } catch (err) {
        console.error("[Shutdown] Error closing Next app:", (err as Error).message);
      }
    }

    await cleanup();

    console.log("[Shutdown] Bye.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // On Windows, closing the console window delivers CTRL_CLOSE_EVENT, which
  // Node/libuv maps to a JS-visible "SIGHUP" event — without this listener, closing
  // the window never runs cleanup() (WAL checkpoint + closeDbInstance()), leaving
  // storage.sqlite's WAL un-checkpointed for the next launch.
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  console.log("[Shutdown] Graceful shutdown handlers registered.");
}
