import { errorResponse, unavailableResponse } from "../../utils/error.ts";
import { formatRetryAfter } from "../accountFallback.ts";
import { isRetryAfterEligibleStatus } from "./unavailableRetryGate.ts";

/**
 * The status a combo answers with when every step failed. Programs in front of the gateway
 * read a 429 as "this account is at its usage limit" and may park it for hours, so:
 *   - any outage among the steps (5xx, a time-out) and none answering is a 5xx;
 *   - only when every step was refused for a limit is the answer a 429;
 *   - otherwise the last step's status stands, as before.
 * 524 (a step that ran past the combo's own time limit) is reported as the 504 it means.
 */
export function isOutageStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function normalizeOutage(status: number): number {
  return status === 524 || status === 408 ? 504 : status;
}

export function comboFinalStatus(stepStatuses: number[], lastStatus: number): number {
  const outages = stepStatuses.filter(isOutageStatus).map(normalizeOutage);
  if (outages.length > 0) {
    return outages.every((s) => s === outages[0]) ? outages[0] : 503;
  }
  if (stepStatuses.length > 0 && stepStatuses.every((s) => s === 429)) return 429;
  return normalizeOutage(lastStatus);
}

/** A step answer that says its account's usage window is used up (not a short burst). */
export function isUsageLimitAnswer(response: Response | null | undefined): boolean {
  return (
    response?.status === 429 &&
    (response.headers?.get?.("anthropic-ratelimit-unified-status") || "").toLowerCase() ===
      "rejected"
  );
}

/** Retry-After of a 429 step answer as an ISO time, or null. */
export function retryAfterFromRateLimitAnswer(
  response: Response | null | undefined
): string | null {
  if (response?.status !== 429) return null;
  const value = response.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : new Date(value).getTime();
  return Number.isFinite(ms) && ms > Date.now() ? new Date(ms).toISOString() : null;
}

/** One failed attempt of a combo: its status, and its answer when there was one. */
export type ComboFailedAttempt = { status: number; response?: Response | null };

/**
 * The answer of a combo strategy whose every attempt failed, built the way the shared combo
 * loop ends: the status from comboFinalStatus, and when that is a 429 (or a 503) the earliest
 * reset any limited attempt named. The plan-usage headers go on a 429 only when every limited
 * attempt was a usage-limit answer, so a short burst never looks like a used-up window.
 */
export function comboFailureResponse(attempts: ComboFailedAttempt[], message: string): Response {
  const statuses = attempts.map((a) => a.status);
  const lastStatus = statuses.length > 0 ? statuses[statuses.length - 1] : 503;
  const status = comboFinalStatus(statuses, lastStatus);
  let earliest: string | null = null;
  let usageLimit = true;
  for (const attempt of attempts) {
    if (attempt.status !== 429) continue;
    if (!isUsageLimitAnswer(attempt.response)) usageLimit = false;
    const retryAfter = retryAfterFromRateLimitAnswer(attempt.response);
    if (retryAfter && (!earliest || new Date(retryAfter) < new Date(earliest))) {
      earliest = retryAfter;
    }
  }
  if (earliest && isRetryAfterEligibleStatus(status)) {
    return unavailableResponse(status, message, earliest, formatRetryAfter(earliest), {
      usageLimit,
    });
  }
  return errorResponse(status, message);
}
