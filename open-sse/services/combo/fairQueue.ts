/**
 * One fair queue per combo.
 *
 * A request that finds every usable slot of a combo taken waits here for the FIRST slot that
 * frees on any of its targets, up to a wait budget. Waiters are served by priority
 * (interactive, then normal, then background) and first come, first served within one
 * priority. A freed slot is handed straight to the waiter, so a request that arrives later
 * cannot take it first. With free slots nobody waits and the priority changes nothing.
 */
import * as semaphore from "../rateLimitSemaphore.ts";

export type RequestPriority = "interactive" | "normal" | "background";

const RANK: Record<RequestPriority, number> = { interactive: 0, normal: 1, background: 2 };

export function parseRequestPriority(value: unknown): RequestPriority {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "interactive" || text === "background" ? text : "normal";
}

/**
 * The priority a request waits with: its x-trouteai-priority header when that names a priority,
 * otherwise the default of its API key, otherwise normal. A header with another value does not
 * count, so it cannot lift a "background" key to normal.
 */
export function resolveRequestPriority(
  header: string | null | undefined,
  keyDefault: unknown
): RequestPriority {
  const text = typeof header === "string" ? header.trim().toLowerCase() : "";
  if (text === "interactive" || text === "normal" || text === "background") return text;
  return parseRequestPriority(keyDefault);
}

export interface SlotKey {
  key: string;
  max: number;
}

export interface SlotGrant {
  key: string;
  release: () => void;
}

// Both arms name `reason` and `position`: this workspace compiles without strictNullChecks,
// where `granted: null` does not narrow the union, so a field only one arm has cannot be read.
export type WaitResult =
  | { granted: SlotGrant; reason?: undefined; position?: undefined }
  | { granted: null; reason: "timeout" | "aborted"; position: number };

interface Waiter {
  rank: number;
  seq: number;
  keys: Map<string, number>;
  settle: (result: WaitResult) => void;
}

const queues = new Map<string, Waiter[]>();
let nextSeq = 0;
let listening = false;

function ordered(queue: Waiter[]): Waiter[] {
  return [...queue].sort((a, b) => a.rank - b.rank || a.seq - b.seq);
}

function removeWaiter(comboName: string, waiter: Waiter): number {
  const queue = queues.get(comboName);
  if (!queue) return 0;
  const position = ordered(queue).indexOf(waiter) + 1;
  const index = queue.indexOf(waiter);
  if (index !== -1) queue.splice(index, 1);
  if (queue.length === 0) queues.delete(comboName);
  return position;
}

// Hands free slots of `freedKey` to waiters, first in order first, while the gate has room:
// the end of a rate-limit pause can free several slots at once.
function handOut(freedKey: string): void {
  for (const [comboName, queue] of [...queues]) {
    for (const waiter of ordered(queue)) {
      const max = waiter.keys.get(freedKey);
      if (max === undefined) continue;
      const release = semaphore.tryAcquire(freedKey, max);
      if (!release) return;
      removeWaiter(comboName, waiter);
      waiter.settle({ granted: { key: freedKey, release } });
    }
  }
}

function ensureListening(): void {
  if (listening) return;
  listening = true;
  semaphore.onSlotFree(handOut);
}

/** Takes a free slot on the first key that has one, without waiting. */
export function tryTakeAny(keys: SlotKey[]): SlotGrant | null {
  for (const { key, max } of keys) {
    const release = semaphore.tryAcquire(key, max);
    if (release) return { key, release };
  }
  return null;
}

/**
 * Waits for the first slot that frees on any of `keys`. Ends at `deadlineMs` (a time stamp)
 * or at once when `signal` aborts: a request whose client left is taken out of the queue.
 */
export function waitForSlot(
  comboName: string,
  keys: SlotKey[],
  opts: { priority: RequestPriority; deadlineMs: number; signal?: AbortSignal | null }
): Promise<WaitResult> {
  ensureListening();
  if (opts.signal?.aborted) {
    return Promise.resolve({ granted: null, reason: "aborted", position: 0 });
  }
  const taken = tryTakeAny(keys);
  if (taken) return Promise.resolve({ granted: taken });

  return new Promise<WaitResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const waiter: Waiter = {
      rank: RANK[opts.priority],
      seq: nextSeq++,
      keys: new Map(keys.map((k) => [k.key, k.max])),
      settle: (result) => {
        if (timer) clearTimeout(timer);
        if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
    };
    const queue = queues.get(comboName) ?? [];
    queue.push(waiter);
    queues.set(comboName, queue);

    timer = setTimeout(
      () => {
        const position = removeWaiter(comboName, waiter);
        waiter.settle({ granted: null, reason: "timeout", position });
      },
      Math.max(0, opts.deadlineMs - Date.now())
    );
    onAbort = () => {
      const position = removeWaiter(comboName, waiter);
      waiter.settle({ granted: null, reason: "aborted", position });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function waitingCount(comboName: string): number {
  return queues.get(comboName)?.length ?? 0;
}

// Recent average time a request holds a slot, per combo, for the Retry-After estimate.
const averageHoldMs = new Map<string, number>();
const DEFAULT_HOLD_MS = 10_000;

export function recordSlotHold(comboName: string, heldMs: number): void {
  if (!Number.isFinite(heldMs) || heldMs < 0) return;
  const previous = averageHoldMs.get(comboName);
  averageHoldMs.set(
    comboName,
    previous === undefined ? heldMs : Math.round(previous * 0.8 + heldMs * 0.2)
  );
}

/** Whole seconds until this waiter can expect a slot: position x average hold / slots. */
export function estimateRetryAfterSeconds(
  comboName: string,
  position: number,
  totalSlots: number
): number {
  const hold = averageHoldMs.get(comboName) ?? DEFAULT_HOLD_MS;
  const seconds = (Math.max(1, position) * hold) / Math.max(1, totalSlots) / 1000;
  return Math.max(1, Math.ceil(seconds));
}

/** The 429 a request gets when the wait budget ran out: the gateway is busy, no usage limit. */
export function busyResponse(
  comboName: string,
  totalSlots: number,
  waiting: number,
  retryAfterSec: number
): Response {
  const message =
    `The gateway is busy: all ${totalSlots} slots of combo '${comboName}' are in use and ` +
    `${waiting} requests are waiting; try again in ${retryAfterSec} seconds`;
  return new Response(
    JSON.stringify({ error: { message, type: "rate_limit_error", code: "gateway_busy" } }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) },
    }
  );
}

/** For tests only. */
export function resetFairQueues(): void {
  for (const [comboName, queue] of [...queues]) {
    for (const waiter of [...queue]) {
      removeWaiter(comboName, waiter);
      waiter.settle({ granted: null, reason: "aborted", position: 0 });
    }
  }
  averageHoldMs.clear();
}
