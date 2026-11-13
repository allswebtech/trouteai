import { isIP } from "node:net";

/**
 * Extract the real client IP from X-Forwarded-For header.
 * Skips invalid entries like "unknown" or empty strings.
 * Falls back to remoteAddress if no valid IP found.
 *
 * @param xForwardedFor - Value of the X-Forwarded-For header (may be CSV)
 * @param remoteAddress - Fallback from the raw socket (req.socket.remoteAddress)
 * @returns The first valid IP address found, or "unknown"
 */
export function extractClientIp(
  xForwardedFor: string | null | undefined,
  remoteAddress: string | undefined
): string {
  if (xForwardedFor) {
    const entries = xForwardedFor.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed && isIP(trimmed) !== 0) {
        return trimmed; // First valid IP wins
      }
    }
  }
  return remoteAddress?.trim() ?? "unknown";
}

/**
 * Strip an IPv4-mapped IPv6 prefix ("::ffff:127.0.0.1" -> "127.0.0.1") so the
 * loopback check below catches both representations Node may report.
 */
function normalizePeer(addr: string | undefined): string {
  const trimmed = (addr ?? "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

/**
 * Whether the TCP peer is a loopback address (i.e. the request reached us via
 * a local reverse proxy such as nginx). Only then is it safe to trust the
 * forwarding headers — from a direct public socket those headers are
 * attacker-controlled and must be ignored, otherwise per-IP brute-force
 * buckets (login lockout, etc.) become spoofable / shareable.
 *
 */
function isLoopbackPeer(addr: string | undefined): boolean {
  const ip = normalizePeer(addr);
  if (!ip) return false;
  if (ip === "::1") return true;
  return ip.startsWith("127.");
}

export type IpScope = "loopback" | "private" | "public" | "unknown";

/**
 * Whether an IPv4/IPv6 address falls inside a private (RFC 1918 / RFC 4193) or
 * link-local range. Uses bounded string-prefix checks (no variable-length regex)
 * to stay ReDoS-safe. Callers must pass an already-normalized, validated IP.
 */
function isPrivateIp(ip: string): boolean {
  // IPv4 private / link-local ranges.
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true; // link-local (APIPA)
  if (ip.startsWith("172.")) {
    // 172.16.0.0 – 172.31.255.255 (the /12 block).
    const secondOctet = Number.parseInt(ip.split(".")[1] ?? "", 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  // IPv6 unique-local (fc00::/7 → fc/fd) and link-local (fe80::/10).
  const lower = ip.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  return false;
}

/**
 * Classify an address by network scope: `loopback` (the host itself),
 * `private` (LAN / RFC 1918 / ULA / link-local), `public` (routable), or
 * `unknown` (empty / non-IP string like "unknown").
 *
 * Used to distinguish audit events — notably failed dashboard logins
 * (`auth.login.failed`) — that originate from the box itself or the local
 * network from genuinely external ones, so an internal mistyped password or a
 * browser-autofill replay does not read as an external intrusion attempt.
 */
export function classifyIpScope(addr: string | null | undefined): IpScope {
  const ip = normalizePeer(addr ?? undefined);
  if (!ip) return "unknown";
  if (isLoopbackPeer(ip)) return "loopback";
  // isIP returns 0 for non-IP strings ("unknown", hostnames); only classify
  // real addresses beyond loopback so hostnames never resolve to private.
  if (isIP(ip) === 0) return "unknown";
  if (isPrivateIp(ip)) return "private";
  return "public";
}

/**
 * Extract client IP from a Request or NextRequest object.
 *
 * Behind a local reverse proxy (TCP peer is loopback) we trust the standard
 * forwarding headers in priority order: CF-Connecting-IP > X-Forwarded-For >
 * X-Real-IP. Directly from a public socket those headers are spoofable, so we
 * key by the unspoofable TCP peer address instead. When no peer is known
 * (edge runtime / fetch path with no socket) we fall back to the headers so
 * we don't regress to "unknown" for every request in that path.
 */
export function getClientIpFromRequest(req: {
  headers?: Headers | { get?: (n: string) => string | null };
  socket?: { remoteAddress?: string };
  ip?: string;
}): string {
  // Helper to get header value from either Headers object or plain object
  const getHeader = (name: string): string | null => {
    if (!req.headers) return null;
    if (typeof (req.headers as Headers).get === "function") {
      return (req.headers as Headers).get(name);
    }
    return null;
  };

  // The authz pipeline stamps an unspoofable client IP (AUTHZ_HEADER_CLIENT_IP,
  // "x-trouteai-client-ip") derived from the token-stamped TCP peer + via-proxy
  // marker. When present it is authoritative — per-IP controls (login
  // brute-force guard, audit logs) must key off it so a remote attacker cannot
  // open a fresh per-IP bucket per request via a forged X-Forwarded-For. The
  // header is stripped from client input and re-set by the pipeline, so it can
  // only have arrived from our own middleware. Fall through to the legacy
  // socket/forwarding resolution only on paths the pipeline does not stamp.
  const trustedClientIp = getHeader("x-trouteai-client-ip");
  if (trustedClientIp) {
    const trimmed = trustedClientIp.trim();
    if (trimmed && isIP(trimmed) !== 0) return normalizePeer(trimmed);
  }

  const remoteAddress = req.ip ?? req.socket?.remoteAddress;
  const hasPeer = Boolean(normalizePeer(remoteAddress));
  const trustForwardingHeaders = !hasPeer || isLoopbackPeer(remoteAddress);

  if (trustForwardingHeaders) {
    const cfIp = getHeader("cf-connecting-ip");
    if (cfIp && isIP(cfIp.trim()) !== 0) return cfIp.trim();

    const xff = getHeader("x-forwarded-for");
    const realIp = getHeader("x-real-ip");
    return extractClientIp(xff ?? realIp, remoteAddress);
  }

  // Direct public peer — forwarding headers are attacker-controlled, ignore.
  return normalizePeer(remoteAddress);
}
