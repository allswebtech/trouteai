// Status mapping rules: a limit is a 429, an outage is a 5xx, and only a used-up usage window
// carries the plan-usage headers. In-process, no server. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-status-mapping.mts
import {
  comboFinalStatus,
  isUsageLimitAnswer,
  retryAfterFromRateLimitAnswer,
} from "../../open-sse/services/combo/finalStatus.ts";
import { statusForModelCooldown } from "../../open-sse/services/accountFallback.ts";
import {
  createErrorResult,
  modelCooldownResponse,
  planUsageHeaders,
  providerCircuitOpenResponse,
  retryAfterHeaderSeconds,
  unavailableResponse,
} from "../../open-sse/utils/error.ts";
import { rateLimitOutlastsRetry } from "../../open-sse/executors/base.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ── the final status of a combo whose every step failed ──────────────────────────────────
check("combo: every step at its limit is a 429", comboFinalStatus([429, 429], 429) === 429);
check("combo: a limit and an overload is the 529", comboFinalStatus([429, 529], 529) === 529);
check("combo: an overload and a limit is the 529", comboFinalStatus([529, 429], 429) === 529);
check("combo: a limit and a closed socket is a 502", comboFinalStatus([429, 502], 502) === 502);
check("combo: two different outages are a 503", comboFinalStatus([503, 502], 502) === 503);
check(
  "combo: a step over the time limit (524) is a 504",
  comboFinalStatus([429, 524], 524) === 504
);
check("combo: a refused key and a limit keep the last", comboFinalStatus([401, 429], 429) === 429);
check("combo: a bad request stays a 400", comboFinalStatus([400], 400) === 400);
check("combo: no step status keeps the last", comboFinalStatus([], 503) === 503);

// ── the status of a model cooldown ───────────────────────────────────────────────────────
check("cooldown after a 429 is a 429", statusForModelCooldown("rate_limit", 429) === 429);
check("cooldown with no reason is a 429 (as before)", statusForModelCooldown(null, null) === 429);
check("used-up window is a 429", statusForModelCooldown("quota_exhausted", 429) === 429);
check("used-up credit is a 402", statusForModelCooldown("quota_exhausted", 402) === 402);
check("cooldown after a 529 is a 529", statusForModelCooldown("unknown", 529) === 529);
check("cooldown after a 503 is a 503", statusForModelCooldown("server_error", 503) === 503);
check("cooldown after a 502 is a 502", statusForModelCooldown("unknown", 502) === 502);
check("cooldown of unknown origin is a 503", statusForModelCooldown("unknown", null) === 503);
check("a refused model stays a 403", statusForModelCooldown("forbidden", 403) === 403);

// ── the executor's own 429 retry ──────────────────────────────────────────────────────────
check(
  "a used-up window is not retried on the same URL",
  rateLimitOutlastsRetry(new Headers({ "anthropic-ratelimit-unified-status": "rejected" }), 2000)
);
check(
  "a retry-after past the delay is not retried",
  rateLimitOutlastsRetry(new Headers({ "retry-after": "3600" }), 2000)
);
check(
  "a plain 429 is still retried",
  !rateLimitOutlastsRetry(new Headers({}), 2000) &&
    !rateLimitOutlastsRetry(new Headers({ "retry-after": "1" }), 2000)
);

// ── answers built by the gateway ──────────────────────────────────────────────────────────
check("an outage never asks for more than a minute", retryAfterHeaderSeconds(503, 1800) === 60);
check("a limit keeps its full wait", retryAfterHeaderSeconds(429, 1800) === 1800);
{
  const r = unavailableResponse(429, "limit", 900, "reset after 15m", { usageLimit: true });
  const reset = Number(r.headers.get("anthropic-ratelimit-unified-reset"));
  const body = await r.json();
  check(
    "a usage-limit 429 carries retry-after, the unified headers and rate_limit_error",
    r.headers.get("retry-after") === "900" &&
      r.headers.get("anthropic-ratelimit-unified-status") === "rejected" &&
      Math.abs(reset - (nowSec() + 900)) <= 2 &&
      body?.error?.type === "rate_limit_error",
    JSON.stringify(body)
  );
}
{
  const r = unavailableResponse(429, "busy", 3, "reset after 3s");
  check(
    "a short rate limit carries no unified headers",
    r.headers.get("anthropic-ratelimit-unified-status") === null
  );
}
{
  const r = unavailableResponse(503, "down", 1800, "reset after 30m", { usageLimit: true });
  check(
    "a 503 never carries the unified headers or a long retry-after",
    r.headers.get("anthropic-ratelimit-unified-status") === null &&
      r.headers.get("retry-after") === "60"
  );
}
check(
  "a breaker answer is a 503 with at most a minute",
  providerCircuitOpenResponse("x", 600).status === 503 &&
    providerCircuitOpenResponse("x", 600).headers.get("retry-after") === "60"
);
{
  const plain = modelCooldownResponse({ model: "m", retryAfter: 30 });
  const window = modelCooldownResponse({ model: "m", retryAfter: 3600, usageLimit: true });
  check(
    "a model cooldown has the unified headers only for a used-up window",
    plain.headers.get("anthropic-ratelimit-unified-status") === null &&
      window.headers.get("anthropic-ratelimit-unified-status") === "rejected"
  );
}

// ── the provider's own headers ────────────────────────────────────────────────────────────
{
  const upstream = new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": "1900000000",
    "retry-after": "120",
    "x-other": "no",
  });
  const h = planUsageHeaders(upstream, 429);
  check(
    "a provider 429 passes its unified headers and retry-after through",
    h["anthropic-ratelimit-unified-status"] === "rejected" &&
      h["anthropic-ratelimit-unified-reset"] === "1900000000" &&
      h["retry-after"] === "120" &&
      !("x-other" in h)
  );
  check(
    "a provider 5xx does not pass a retry-after through",
    !("retry-after" in planUsageHeaders(upstream, 503))
  );
  check(
    "no provider headers: none invented",
    Object.keys(planUsageHeaders(new Headers(), 200)).length === 0
  );
  const result = createErrorResult(429, "limit", null, undefined, undefined, undefined, {
    upstreamHeaders: upstream,
  });
  check(
    "an upstream error answer keeps the provider's unified headers",
    result.response.headers.get("anthropic-ratelimit-unified-status") === "rejected"
  );
  check(
    "a usage-limit step answer is recognised",
    isUsageLimitAnswer(result.response) &&
      !isUsageLimitAnswer(new Response("{}", { status: 429 })) &&
      retryAfterFromRateLimitAnswer(result.response) !== null
  );
}

if (failed > 0) process.exit(1);
