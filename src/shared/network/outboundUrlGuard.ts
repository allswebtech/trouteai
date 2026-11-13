import { isIP } from "node:net";

export const PROVIDER_URL_BLOCKED_MESSAGE = "Blocked private or local provider URL";
export const CLOUD_METADATA_BLOCKED_MESSAGE = "Blocked cloud-metadata endpoint";

// "block-metadata": allow private/LAN hosts but still reject cloud-metadata / link-local
// endpoints (the SSRF→IAM-credential pivot). Used by the provider-validation path under the
// local-first default; never relaxes the metadata block.
export type OutboundUrlGuardMode = "none" | "public-only" | "block-metadata";
export type OutboundUrlGuardErrorCode = "OUTBOUND_URL_GUARD_BLOCKED" | "OUTBOUND_URL_INVALID";

type OutboundUrlGuardErrorInit = {
  code: OutboundUrlGuardErrorCode;
  url: string;
  hostname?: string | null;
};

export class OutboundUrlGuardError extends Error {
  code: OutboundUrlGuardErrorCode;
  url: string;
  hostname?: string | null;

  constructor(message: string, init: OutboundUrlGuardErrorInit) {
    super(message);
    this.name = "OutboundUrlGuardError";
    this.code = init.code;
    this.url = init.url;
    this.hostname = init.hostname ?? null;
  }
}

function normalizeHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function isPrivateHost(hostname: string) {
  const normalized = normalizeHost(hostname);
  if (!normalized) return true;

  if (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    // `.internal` is reserved for private use (ICANN-style) and is the
    // hostname suffix used by GCP/Azure metadata probes
    // (e.g. `metadata.google.internal`).
    normalized.endsWith(".internal") ||
    normalized.startsWith("::ffff:")
  ) {
    return true;
  }

  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map((segment) => parseInt(segment, 10));
    const [a, b] = octets;

    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

const CLOUD_METADATA_HOSTNAMES = new Set([
  "169.254.169.254", // AWS / GCP / Azure / Oracle IMDS
  "metadata.google.internal", // GCP
  "metadata.goog", // GCP
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254", // AWS IPv6 IMDS
]);

/**
 * If `host` is an IPv4-mapped IPv6 address, return the embedded IPv4 in dotted
 * form; otherwise null. Covers both the dotted shorthand (`::ffff:169.254.169.254`)
 * and the hex form the WHATWG URL parser canonicalizes to (`::ffff:a9fe:a9fe`),
 * plus a fully-expanded `0:0:0:0:0:ffff:…` prefix. Without this, a metadata IP
 * wrapped as IPv4-mapped IPv6 (literal URL or an AAAA DNS answer) slips past the
 * metadata block in `block-metadata` mode, where `isPrivateHost` is not consulted.
 */
function mappedIpv4(host: string): string | null {
  const m = /^(?:0*:)*0*:ffff:(.+)$/i.exec(host);
  if (!m) return null;
  const tail = m[1];
  // Already dotted: "::ffff:169.254.169.254"
  if (isIP(tail) === 4) return tail;
  // Hex pair: "::ffff:a9fe:a9fe" -> 169.254.169.254
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/**
 * Cloud-metadata and IPv4 link-local (169.254.0.0/16) endpoints are the classic
 * SSRF→IAM-credential pivot and have no legitimate webhook/automation use case. They are
 * blocked UNCONDITIONALLY — even when private targets are explicitly opted in.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  // Canonicalize an IPv4-mapped IPv6 metadata address to its IPv4 form first, so
  // `::ffff:169.254.169.254` / `::ffff:a9fe:a9fe` cannot slip past this check.
  const effective = mappedIpv4(host) ?? host;
  if (CLOUD_METADATA_HOSTNAMES.has(effective)) return true;
  if (effective.startsWith("169.254.")) return true; // IPv4 link-local /16
  return false;
}

export function parseOutboundUrl(input: string | URL) {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    throw new OutboundUrlGuardError(`Invalid outbound URL: ${String(input)}`, {
      code: "OUTBOUND_URL_INVALID",
      url: String(input),
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlGuardError(`Invalid outbound URL protocol for ${url.toString()}`, {
      code: "OUTBOUND_URL_INVALID",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  }

  if (url.username || url.password) {
    throw new OutboundUrlGuardError("Blocked outbound URL with embedded credentials", {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  }

  return url;
}

export function parseAndValidatePublicUrl(input: string | URL) {
  const url = parseOutboundUrl(input);

  if (isPrivateHost(url.hostname)) {
    throw new OutboundUrlGuardError(PROVIDER_URL_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  }

  return url;
}

/**
 * Provider-validation variant. Allows private/LAN hosts (so a local OpenAI-compatible
 * provider at 127.0.0.1 validates) but ALWAYS rejects cloud-metadata / link-local endpoints —
 * the classic SSRF→IAM-credential pivot, which is never a legitimate provider endpoint.
 * Protocol and embedded-credential checks from {@link parseOutboundUrl} still apply.
 */
export function parseAndValidateNonMetadataUrl(input: string | URL) {
  const url = parseOutboundUrl(input);

  if (isCloudMetadataHost(url.hostname)) {
    throw new OutboundUrlGuardError(CLOUD_METADATA_BLOCKED_MESSAGE, {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname || null,
    });
  }

  return url;
}

// NOTE: `arePrivateProviderUrlsAllowed`, `areLocalProviderUrlsAllowed`,
// `getProviderOutboundGuard`, `getProviderValidationGuard`, and `parseAndValidateWebhookUrl`
// live in the sibling `./outboundUrlGuardPolicy.ts` module, NOT here. Those helpers need
// `@/shared/utils/featureFlags` (which transitively pulls in the DB layer), and this file is
// loaded by the packaged CLI (`trouteai setup-opencode` → cli-helper/config-generator/
// opencode.ts) where no `tsconfig.json` is present to resolve the `@/*` path alias. Keeping
// this module free of ANY `@/`-aliased import is what makes it safe to load from the CLI.
// Do not add a `@/`-aliased import here (packaging).
