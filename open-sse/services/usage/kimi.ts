/**
 * usage/kimi.ts — Kimi Coding (kimi-coding / kimi-coding-apikey) usage fetcher + helpers.
 *
 * Extracted from services/usage.ts (god-file decomposition): the Kimi family — the coding
 * API config, membership-level → display-name mapping, and the getKimiUsage fetcher that
 * probes the official /v1/usages endpoint. Depends only on the sibling scalar/quota leaves
 * plus safePercentage — no host coupling — so it lives as a co-located provider leaf.
 * usage.ts imports getKimiUsage (dispatcher). Behavior-preserving move.
 */

import { safePercentage } from "@/shared/utils/formatting";
import {
  buildKimiCodeIdentityHeaders,
  getKimiCodeCliUserAgent,
} from "../../config/providers/registry/kimi/coding/runtime.ts";
import { toRecord, toNumber } from "./scalars.ts";
import { type UsageQuota, parseResetTime } from "./quota.ts";

type JsonRecord = Record<string, unknown>;

// Kimi Coding API config
const KIMI_CONFIG = {
  baseUrl: "https://api.kimi.com/coding/v1",
  usageUrl: "https://api.kimi.com/coding/v1/usages",
  apiVersion: "2023-06-01",
};

/**
 * Map Kimi membership level to display name
 * LEVEL_BASIC = Moderato, LEVEL_INTERMEDIATE = Allegretto,
 * LEVEL_ADVANCED = Allegro, LEVEL_STANDARD = Vivace
 */
function getKimiPlanName(level: unknown): string {
  if (!level) return "";
  const normalizedLevel = String(level);

  const levelMap = {
    LEVEL_BASIC: "Moderato",
    LEVEL_INTERMEDIATE: "Allegretto",
    LEVEL_ADVANCED: "Allegro",
    LEVEL_STANDARD: "Vivace",
  };

  return (
    levelMap[normalizedLevel as keyof typeof levelMap] ||
    normalizedLevel.replace("LEVEL_", "").toLowerCase()
  );
}

/**
 * Kimi Coding Usage - Fetch quota from Kimi API
 * Uses the official /v1/usages endpoint with custom X-Msh-* headers
 */
/** "session (5h)" for the 300-minute burst window, else the window's own length. */
function kimiWindowName(window: JsonRecord): string {
  const duration = Number(window.duration);
  const unit = String(window.timeUnit || "").toUpperCase();
  if (!Number.isFinite(duration) || duration <= 0) return "Ratelimit";
  const minutes = unit.includes("HOUR")
    ? duration * 60
    : unit.includes("DAY")
      ? duration * 1440
      : unit.includes("SECOND")
        ? duration / 60
        : duration;
  if (minutes === 300) return "session (5h)";
  if (minutes % 1440 === 0) return `window (${minutes / 1440}d)`;
  if (minutes % 60 === 0) return `window (${minutes / 60}h)`;
  return `window (${minutes}m)`;
}

/** limit_month_total -> "monthly (total)", limit_month_code -> "monthly (code)". */
function kimiUsagesName(key: string): string {
  const m = /^limit_(month|week|day|5h)_?(.*)$/.exec(key);
  if (!m) return key.replace(/_/g, " ");
  const period =
    m[1] === "month"
      ? "monthly"
      : m[1] === "week"
        ? "weekly"
        : m[1] === "day"
          ? "daily"
          : "session (5h)";
  return m[2] ? `${period} (${m[2].replace(/_/g, " ")})` : period;
}

export async function getKimiUsage(
  accessToken?: string,
  apiKey?: string,
  providerSpecificData: JsonRecord = {}
) {
  // API key auth takes precedence — Kimi's /usages endpoint accepts the same
  // API key used for /messages (verified live: responds with
  // authentication.method = METHOD_API_KEY). OAuth flow falls through to the
  // Bearer + device-headers shape used by Kimi Coding OAuth.
  const useApiKey = typeof apiKey === "string" && apiKey.length > 0;

  const authHeaders: Record<string, string> = useApiKey
    ? { "x-api-key": apiKey as string }
    : {
        Authorization: `Bearer ${accessToken}`,
        ...buildKimiCodeIdentityHeaders(providerSpecificData),
        "User-Agent": getKimiCodeCliUserAgent(),
      };

  try {
    const response = await fetch(KIMI_CONFIG.usageUrl, {
      method: "GET",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
    });

    const responseText = await response.text();

    if (!response.ok) {
      return {
        plan: "Kimi Coding",
        message: `Kimi Coding connected. API Error ${response.status}: ${responseText.slice(0, 100)}`,
      };
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return {
        plan: "Kimi Coding",
        message: "Kimi Coding connected. Invalid JSON response from API.",
      };
    }

    const quotas: Record<string, UsageQuota> = {};
    const dataObj = toRecord(data);

    // Parse Kimi usage response format
    // Format: { user: {...}, usage: { limit: "100", used: "92", remaining: "8", resetTime: "..." }, limits: [...] }
    const usageObj = toRecord(dataObj.usage);

    // Check for Kimi's actual usage fields (strings, not numbers)
    const usageLimit = toNumber(usageObj.limit || usageObj.Limit, 0);
    const usageUsed = toNumber(usageObj.used || usageObj.Used, 0);
    const usageRemaining = toNumber(usageObj.remaining || usageObj.Remaining, 0);
    const usageResetTime =
      usageObj.resetTime || usageObj.ResetTime || usageObj.reset_at || usageObj.resetAt;

    if (usageLimit > 0) {
      const percentRemaining = usageLimit > 0 ? (usageRemaining / usageLimit) * 100 : 0;

      quotas["Weekly"] = {
        used: usageUsed,
        total: usageLimit,
        remaining: usageRemaining,
        remainingPercentage: percentRemaining,
        resetAt: parseResetTime(usageResetTime),
        unlimited: false,
      };
    }

    // limits[]: the rolling burst window(s). The live payload carries `limit` and `used` (and
    // no `remaining`): {"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},
    // "detail":{"limit":"100","used":"20","resetTime":"..."}} — remaining is limit - used.
    const limitsArray = Array.isArray(dataObj.limits) ? dataObj.limits : [];
    for (let i = 0; i < limitsArray.length; i++) {
      const limitItem = toRecord(limitsArray[i]);
      const window = toRecord(limitItem.window);
      const detail = toRecord(limitItem.detail);

      const limit = toNumber(detail.limit || detail.Limit, 0);
      const hasRemaining = detail.remaining !== undefined || detail.Remaining !== undefined;
      const usedRaw = toNumber(detail.used || detail.Used, 0);
      const remaining = hasRemaining
        ? toNumber(detail.remaining || detail.Remaining, 0)
        : Math.max(0, limit - usedRaw);
      const resetTime = detail.resetTime || detail.reset_at || detail.resetAt;

      if (limit > 0) {
        quotas[kimiWindowName(window)] = {
          used: limit - remaining,
          total: limit,
          remaining,
          remainingPercentage: limit > 0 ? (remaining / limit) * 100 : 0,
          resetAt: parseResetTime(resetTime),
          unlimited: false,
        };
      }
    }

    // usages{}: the aggregate windows, each a used share 0..1 (limit_5h repeats limits[]).
    // {"limit_month_total":{"used_ratio":0.0795,"reset_time":"..."},"limit_month_code":{...}}
    const usagesObj = toRecord(dataObj.usages);
    for (const [key, value] of Object.entries(usagesObj)) {
      if (key === "limit_5h") continue;
      const entry = toRecord(value);
      const ratio = Number(entry.used_ratio);
      if (!Number.isFinite(ratio)) continue;
      const usedPct = Math.min(100, Math.max(0, ratio * 100));
      quotas[kimiUsagesName(key)] = {
        used: usedPct,
        total: 100,
        remaining: 100 - usedPct,
        remainingPercentage: 100 - usedPct,
        resetAt: parseResetTime(entry.reset_time || entry.resetTime),
        unlimited: false,
      };
    }

    // Check for quota windows (Claude-like format with utilization) as fallback
    const hasUtilization = (window: JsonRecord) =>
      window && typeof window === "object" && safePercentage(window.utilization) !== undefined;

    // `utilization` is the share USED, as in Claude's format (it was read as the share left).
    const createQuotaObject = (window: JsonRecord) => {
      const used = safePercentage(window.utilization) as number;
      const remaining = 100 - used;
      return {
        used,
        total: 100,
        remaining,
        resetAt: parseResetTime(window.resets_at),
        remainingPercentage: remaining,
        unlimited: false,
      };
    };

    if (hasUtilization(toRecord(dataObj.five_hour))) {
      quotas["session (5h)"] = createQuotaObject(toRecord(dataObj.five_hour));
    }

    if (hasUtilization(toRecord(dataObj.seven_day))) {
      quotas["weekly (7d)"] = createQuotaObject(toRecord(dataObj.seven_day));
    }

    // Check for model-specific quotas
    for (const [key, value] of Object.entries(dataObj)) {
      const valueRecord = toRecord(value);
      if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(valueRecord)) {
        const modelName = key.replace("seven_day_", "");
        quotas[`weekly ${modelName} (7d)`] = createQuotaObject(valueRecord);
      }
    }

    if (Object.keys(quotas).length > 0) {
      const userRecord = toRecord(dataObj.user);
      const membershipLevel = toRecord(userRecord.membership).level;
      const planName = getKimiPlanName(membershipLevel);
      return {
        plan: planName || "Kimi Coding",
        quotas,
      };
    }

    // No quota data in response
    const userRecord = toRecord(dataObj.user);
    const membershipLevel = toRecord(userRecord.membership).level;
    const planName = getKimiPlanName(membershipLevel);
    return {
      plan: planName || "Kimi Coding",
      message: "Kimi Coding connected. Usage tracked per request.",
    };
  } catch (error) {
    return {
      message: `Kimi Coding connected. Unable to fetch usage: ${(error as Error).message}`,
    };
  }
}
