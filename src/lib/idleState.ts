/**
 * Is the server idle? Idle means: no request in flight (health probes do not count), no
 * WebSocket open (a live dashboard page, a Responses session), and no request for a while
 * (TROUTEAI_IDLE_AFTER_MS, 5 minutes by default). A server that has had no request since it
 * started is idle. Background jobs that call providers or wake up often pause while the server
 * is idle and resume on the next request, so an unused server costs no CPU and makes no
 * outbound calls.
 *
 * The HTTP server (scripts/dev/run-next.mjs) keeps the count of open requests and sockets and
 * the time of the last request on globalThis.__trouteaiActivity, because a .mjs file cannot import
 * this module. Where no HTTP server keeps them (an in-process script), the server is never idle
 * and nothing pauses.
 *
 * TROUTEAI_PAUSE_WHEN_IDLE=false switches pausing off: every job runs on its own schedule again.
 */

const DEFAULT_IDLE_AFTER_MS = 5 * 60_000;
const MIN_IDLE_AFTER_MS = 5_000;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

interface ActivityState {
  lastRequestAt: number;
  inFlight: number;
  wake?: () => void;
}

declare global {
  var __trouteaiActivity: ActivityState | undefined;
  var __trouteaiIdleJobs: { paused: Map<string, () => void>; seq: number } | undefined;
}

function jobs() {
  globalThis.__trouteaiIdleJobs ||= { paused: new Map(), seq: 0 };
  return globalThis.__trouteaiIdleJobs;
}

export function isIdlePausingEnabled(): boolean {
  const raw = process.env.TROUTEAI_PAUSE_WHEN_IDLE;
  return !raw || !FALSE_VALUES.has(raw.trim().toLowerCase());
}

function idleAfterMs(): number {
  const parsed = Number.parseInt(process.env.TROUTEAI_IDLE_AFTER_MS || "", 10);
  return Number.isFinite(parsed) && parsed >= MIN_IDLE_AFTER_MS ? parsed : DEFAULT_IDLE_AFTER_MS;
}

export function isIdle(now: number = Date.now()): boolean {
  const activity = globalThis.__trouteaiActivity;
  if (!activity || !isIdlePausingEnabled()) return false;
  if (activity.inFlight > 0) return false;
  return now - activity.lastRequestAt >= idleAfterMs();
}

function wakePausedJobs(): void {
  const { paused } = jobs();
  if (paused.size === 0) return;
  const resumes = [...paused.values()];
  paused.clear();
  // Off the request path: the request that woke the jobs should not wait for them.
  setImmediate(() => {
    for (const resume of resumes) {
      try {
        resume();
      } catch (error) {
        console.warn("[Idle] A paused job failed to resume:", (error as Error)?.message || error);
      }
    }
  });
}

if (globalThis.__trouteaiActivity) globalThis.__trouteaiActivity.wake = wakePausedJobs;

/**
 * Called by a job when its timer fires. When the server is idle the job is recorded as paused
 * and true is returned: the job then stops its timer and skips this run. `resume` is called once,
 * on the next request, and restarts the job.
 */
export function pauseWhileIdle(name: string, resume: () => void): boolean {
  if (!isIdle()) return false;
  park(name, resume);
  return true;
}

function park(name: string, resume: () => void): void {
  // Another copy of this module (the server is bundled in parts) may have set the hook.
  if (globalThis.__trouteaiActivity) globalThis.__trouteaiActivity.wake = wakePausedJobs;
  jobs().paused.set(name, resume);
}

/**
 * setInterval for a background job that has nothing to do while the server is idle (a sweep of
 * an in-memory cache, a poll). While idle the timer stops; on the next request it starts again,
 * and the job runs at once if a run was missed. `canPause` can keep it running (work pending).
 * Returns a function that stops the job for good.
 */
export function setIdleAwareInterval(
  name: string,
  run: () => unknown,
  everyMs: number,
  options: { canPause?: () => boolean } = {}
): () => void {
  const key = `${name}#${++jobs().seq}`;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt = Date.now();
  let stopped = false;

  const start = () => {
    timer = setInterval(tick, everyMs);
    timer.unref?.();
  };
  const resume = () => {
    if (stopped || timer) return;
    start();
    if (Date.now() - lastRunAt >= everyMs) {
      lastRunAt = Date.now();
      run();
    }
  };
  function tick() {
    if (isIdle() && (options.canPause ? options.canPause() : true)) {
      if (timer) clearInterval(timer);
      timer = null;
      park(key, resume);
      return;
    }
    lastRunAt = Date.now();
    run();
  }

  // The job's name on the timer callback, so a timer list (or a profiler) says whose it is.
  Object.defineProperty(tick, "name", { value: name });
  start();
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    cancelPausedJob(key);
  };
}

/** Forget a paused job (it was stopped on purpose and must not come back on the next request). */
export function cancelPausedJob(name: string): void {
  jobs().paused.delete(name);
}

/**
 * For a job on a long period that only has to skip a run while the server is idle: runs `run`
 * now, or, when idle, once on the next request instead.
 */
export function runUnlessIdle(name: string, run: () => unknown): void {
  if (pauseWhileIdle(name, () => void run())) return;
  void run();
}
