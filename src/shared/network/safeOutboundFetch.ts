import { isIP } from "node:net";
import dns from "node:dns";
import { runWithProxyContext, getOriginalFetch } from "@trouteai/open-sse/utils/proxyFetch.ts";
import { FetchTimeoutError, fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import {
  CLOUD_METADATA_BLOCKED_MESSAGE,
  isCloudMetadataHost,
  isPrivateHost,
  OutboundUrlGuardError,
  type OutboundUrlGuardMode,
  parseAndValidateNonMetadataUrl,
  parseAndValidatePublicUrl,
  parseOutboundUrl,
  PROVIDER_URL_BLOCKED_MESSAGE,
} from "@/shared/network/outboundUrlGuard";

const DEFAULT_IDEMPOTENT_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

export type SafeOutboundFetchGuard = OutboundUrlGuardMode;
export type SafeOutboundFetchErrorCode =
  "INVALID_URL" | "URL_GUARD_BLOCKED" | "TIMEOUT" | "REDIRECT_BLOCKED" | "NETWORK_ERROR";

export interface SafeOutboundFetchRetryOptions {
  attempts?: number;
  backoffMs?: number | number[];
  methods?: string[];
  statusCodes?: number[];
}

export interface SafeOutboundFetchOptions extends RequestInit {
  timeoutMs?: number;
  allowRedirect?: boolean;
  retry?: SafeOutboundFetchRetryOptions | false;
  guard?: SafeOutboundFetchGuard;
  proxyConfig?: unknown;
  /** Bypass the global proxy/TLS patched fetch and use the native Node.js
   *  fetch directly. Use when a provider endpoint has compatibility issues
   *  with the undici dispatcher layer. */
  bypassProxyPatch?: boolean;
}

type SafeOutboundFetchPresetMap = {
  validationRead: SafeOutboundFetchOptions;
  validationWrite: SafeOutboundFetchOptions;
  modelsProbe: SafeOutboundFetchOptions;
  modelsDiscovery: SafeOutboundFetchOptions;
  modelsPagination: SafeOutboundFetchOptions;
};

export const SAFE_OUTBOUND_FETCH_PRESETS: SafeOutboundFetchPresetMap = {
  validationRead: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  validationWrite: {
    timeoutMs: 15000,
    allowRedirect: false,
    retry: false,
  },
  modelsProbe: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  modelsDiscovery: {
    timeoutMs: 10000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [200],
      methods: ["GET", "HEAD"],
    },
  },
  modelsPagination: {
    timeoutMs: 15000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [250],
      methods: ["GET", "HEAD"],
    },
  },
};

type SafeOutboundFetchErrorInit = {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;
  cause?: unknown;
};

export class SafeOutboundFetchError extends Error {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;

  constructor(message: string, init: SafeOutboundFetchErrorInit) {
    super(message);
    this.name = "SafeOutboundFetchError";
    this.code = init.code;
    this.url = init.url;
    this.method = init.method;
    this.attempts = init.attempts;
    this.isRetryable = init.isRetryable;
    this.timeoutMs = init.timeoutMs;
    this.status = init.status;
    this.location = init.location ?? null;
    if (init.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = init.cause;
    }
  }
}

function normalizeMethod(method?: string) {
  return (method || "GET").toUpperCase();
}

function normalizeUrl(input: string | URL) {
  try {
    return parseOutboundUrl(input);
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method: "GET",
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw new SafeOutboundFetchError(`Invalid outbound URL: ${String(input)}`, {
      code: "INVALID_URL",
      url: String(input),
      method: "GET",
      attempts: 1,
      isRetryable: false,
      cause: error,
    });
  }
}

function applyUrlGuard(targetUrl: URL, guard: SafeOutboundFetchGuard, method: string) {
  if (guard === "none") return;

  try {
    // "public-only" rejects every private host; "block-metadata" allows private/LAN
    // hosts but still rejects cloud-metadata / link-local endpoints.
    if (guard === "block-metadata") {
      parseAndValidateNonMetadataUrl(targetUrl);
    } else {
      parseAndValidatePublicUrl(targetUrl);
    }
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method,
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * DNS-rebind / TOCTOU SSRF guard. The string-level {@link applyUrlGuard} only
 * inspects the literal hostname, so an attacker-controlled domain whose A/AAAA
 * record points at a private / loopback / cloud-metadata address slips past it
 * (classic DNS rebinding — the same class fixed for remote images in
 * GHSA-cmhj-wh2f-9cgx). Here we resolve the hostname and reject if ANY answer
 * falls in a blocked range, mirroring the per-mode policy:
 *   - "public-only"    → block private AND cloud-metadata addresses
 *   - "block-metadata" → allow private/LAN, block only cloud-metadata
 *
 * Literal-IP hosts are already fully checked by the string guard, so DNS is
 * skipped for them. A host that fails to resolve is blocked (fail closed).
 *
 * This closes the practical attack (the resolved IP is validated right before
 * the request). A residual TOCTOU window remains: undici performs its own DNS
 * lookup at connect time, which could in theory return a different address than
 * the one validated here. Fully closing it requires pinning the connection to a
 * validated IP (see createPinnedFetch in remoteImageFetch.ts); that is invasive
 * through the proxy/timeout dispatcher chain used below and is intentionally out
 * of scope for this minimal fix.
 */
const guardLookup = (hostname: string) => dns.promises.lookup(hostname, { all: true });

async function assertResolvedIpsAllowed(targetUrl: URL, guard: SafeOutboundFetchGuard) {
  if (guard === "none") return;

  const hostname = targetUrl.hostname;
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // Literal IPs were already validated by the string-level guard above.
  if (!bare || isIP(bare) !== 0) return;

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await guardLookup(bare);
  } catch {
    throw new SafeOutboundFetchError(`${PROVIDER_URL_BLOCKED_MESSAGE} (host did not resolve)`, {
      code: "URL_GUARD_BLOCKED",
      url: targetUrl.toString(),
      method: "GET",
      attempts: 1,
      isRetryable: false,
    });
  }
  if (!resolved.length) {
    throw new SafeOutboundFetchError(`${PROVIDER_URL_BLOCKED_MESSAGE} (host did not resolve)`, {
      code: "URL_GUARD_BLOCKED",
      url: targetUrl.toString(),
      method: "GET",
      attempts: 1,
      isRetryable: false,
    });
  }

  for (const { address } of resolved) {
    // Cloud-metadata is blocked in BOTH guard modes (SSRF→IAM pivot).
    if (isCloudMetadataHost(address)) {
      throw new SafeOutboundFetchError(`${CLOUD_METADATA_BLOCKED_MESSAGE} (DNS rebinding)`, {
        code: "URL_GUARD_BLOCKED",
        url: targetUrl.toString(),
        method: "GET",
        attempts: 1,
        isRetryable: false,
      });
    }
    // Private ranges are blocked only under "public-only".
    if (guard === "public-only" && isPrivateHost(address)) {
      throw new SafeOutboundFetchError(`${PROVIDER_URL_BLOCKED_MESSAGE} (DNS rebinding)`, {
        code: "URL_GUARD_BLOCKED",
        url: targetUrl.toString(),
        method: "GET",
        attempts: 1,
        isRetryable: false,
      });
    }
  }
}

function getRetryConfig(retry: SafeOutboundFetchRetryOptions | false | undefined, method: string) {
  if (retry === false) {
    return {
      attempts: 1,
      shouldRetryMethod: false,
      statusCodes: new Set<number>(),
      backoffMs: [] as number[],
    };
  }

  const methods = new Set(
    (retry?.methods || DEFAULT_IDEMPOTENT_METHODS).map((value) => value.toUpperCase())
  );
  const attempts = Math.max(1, retry?.attempts || 1);
  const backoffMs = Array.isArray(retry?.backoffMs)
    ? retry?.backoffMs
    : typeof retry?.backoffMs === "number"
      ? [retry.backoffMs]
      : [];
  const statusCodes = new Set(retry?.statusCodes || []);

  return {
    attempts,
    shouldRetryMethod: methods.has(method),
    statusCodes,
    backoffMs,
  };
}

function getBackoffDelay(backoffMs: number[], attemptNumber: number) {
  if (backoffMs.length === 0) return 0;
  return backoffMs[Math.min(attemptNumber - 1, backoffMs.length - 1)] || 0;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancellation errors when preparing a retry.
  }
}

function normalizeFetchFailure(
  error: unknown,
  targetUrl: string,
  method: string,
  attempts: number
): SafeOutboundFetchError {
  if (error instanceof SafeOutboundFetchError) {
    error.attempts = attempts;
    return error;
  }

  if (error instanceof FetchTimeoutError) {
    return new SafeOutboundFetchError(error.message, {
      code: "TIMEOUT",
      url: targetUrl,
      method,
      attempts,
      timeoutMs: error.timeoutMs,
      isRetryable: true,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;

  return new SafeOutboundFetchError(message || `Outbound request failed for ${targetUrl}`, {
    code: "NETWORK_ERROR",
    url: targetUrl,
    method,
    attempts,
    isRetryable: code !== "PROXY_UNREACHABLE",
    cause: error,
  });
}

export async function safeOutboundFetch(url: string | URL, options: SafeOutboundFetchOptions = {}) {
  const targetUrl = normalizeUrl(url);
  const method = normalizeMethod(options.method);
  const {
    timeoutMs,
    allowRedirect = false,
    retry,
    guard = "none",
    proxyConfig,
    bypassProxyPatch = false,
    signal,
    ...fetchOptions
  } = options;

  applyUrlGuard(targetUrl, guard, method);
  // DNS-rebind guard: the string-level check above only sees the hostname; this
  // resolves it and rejects if any answer is a blocked (private/metadata) IP.
  await assertResolvedIpsAllowed(targetUrl, guard);

  const retryConfig = getRetryConfig(retry, method);
  const redirect = allowRedirect ? (fetchOptions.redirect ?? "follow") : "manual";

  for (let attempt = 1; attempt <= retryConfig.attempts; attempt++) {
    try {
      const executeFetch = () =>
        fetchWithTimeout(targetUrl.toString(), {
          ...fetchOptions,
          method,
          redirect,
          signal,
          timeoutMs,
          // When bypassing the proxy patch, use the original native fetch directly.
          fetchFn: bypassProxyPatch ? getOriginalFetch() : undefined,
        });

      const response = bypassProxyPatch
        ? await executeFetch()
        : proxyConfig
          ? await runWithProxyContext(proxyConfig, executeFetch)
          : await executeFetch();

      if (!allowRedirect && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        throw new SafeOutboundFetchError(
          `Redirect blocked for ${method} ${targetUrl.toString()} (${response.status})`,
          {
            code: "REDIRECT_BLOCKED",
            url: targetUrl.toString(),
            method,
            attempts: attempt,
            status: response.status,
            location,
            isRetryable: false,
          }
        );
      }

      if (
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        retryConfig.statusCodes.has(response.status)
      ) {
        await cancelResponseBody(response);
        await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
        continue;
      }

      return response;
    } catch (error) {
      const normalizedError = normalizeFetchFailure(error, targetUrl.toString(), method, attempt);
      const shouldRetry =
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        normalizedError.isRetryable;

      if (!shouldRetry) {
        throw normalizedError;
      }

      await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
    }
  }

  throw new SafeOutboundFetchError(`Outbound request failed for ${targetUrl.toString()}`, {
    code: "NETWORK_ERROR",
    url: targetUrl.toString(),
    method,
    attempts: retryConfig.attempts,
    isRetryable: false,
  });
}

export function getSafeOutboundFetchErrorStatus(error: unknown) {
  if (!(error instanceof SafeOutboundFetchError)) return null;

  if (error.code === "TIMEOUT") return 504;
  if (
    error.code === "INVALID_URL" ||
    error.code === "URL_GUARD_BLOCKED" ||
    error.code === "REDIRECT_BLOCKED"
  ) {
    return 503;
  }

  return null;
}
