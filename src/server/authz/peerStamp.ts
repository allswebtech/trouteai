import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { classifyHostLocality } from "./routeGuard";

/**
 * Resolve the real peer IP from the trusted `<token>|<ip>` stamp that the custom
 * Node server writes into PEER_IP_HEADER (see scripts/dev/peer-stamp.mjs). Returns
 * the IP ONLY when the token constant-time-matches this process's stamp token;
 * any other value (no stamp, wrong/forged token, missing separator, empty IP)
 * returns null.
 *
 * Pure + dependency-free so the auth boundary is directly unit-testable.
 *
 * SECURITY: this is the ONLY trustworthy locality signal in the Next middleware
 * runtime (which has no socket). Never derive locality from the Host header — it
 * is fully client-controlled, so `Host: 127.0.0.1` from a remote attacker would
 * otherwise bypass the LOCAL_ONLY gate guarding spawn-capable routes.
 */
export function resolveStampedPeer(
  headerValue: string | null,
  token: string | undefined
): string | null {
  if (!headerValue || !token) return null;
  const sep = headerValue.indexOf("|");
  if (sep <= 0) return null;
  const provided = headerValue.slice(0, sep);
  const ip = headerValue.slice(sep + 1);
  if (!ip) return null;
  if (provided.length !== token.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return null;
  } catch {
    return null;
  }
  return ip;
}

/**
 * Resolve the trusted "request arrived via a reverse proxy" marker stamped by
 * the custom Node server (`scripts/dev/peer-stamp.mjs::stampPeerIp`). The stamp
 * is `<token>|1` when forwarding headers (`x-forwarded-for` / `x-real-ip`) were
 * present on the inbound TCP request, and `<token>|0` otherwise.
 *
 * Returns true ONLY when the token constant-time-matches this process's stamp
 * token AND the payload is exactly "1". Any other value — no stamp, forged
 * token, "0", junk — returns false (the safe default: assume no proxy hop).
 *
 * SECURITY: paired with `resolveStampedPeer()` to close the upstream
 * Vulnerability — when TRouteAI itself runs behind
 * an external reverse proxy (nginx / Caddy / Cloudflare Tunnel),
 * `req.socket.remoteAddress` is the proxy hop (usually 127.0.0.1), not the
 * end-user. Without this signal, `classifyHostLocality()` would return
 * "loopback" for every remote caller arriving via the proxy, granting access
 * to the LOCAL_ONLY tier that gates spawn-capable routes.
 * Consume via `classifyStampedPeerLocality()` below.
 */
export function resolveStampedViaProxy(
  headerValue: string | null,
  token: string | undefined
): boolean {
  if (!headerValue || !token) return false;
  const sep = headerValue.indexOf("|");
  if (sep <= 0) return false;
  const provided = headerValue.slice(0, sep);
  const payload = headerValue.slice(sep + 1);
  if (provided.length !== token.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return false;
  } catch {
    return false;
  }
  return payload === "1";
}

/**
 * The trusted locality verdict consumed by the LOCAL_ONLY route guard. Wraps
 * `resolveStampedPeer()` + `resolveStampedViaProxy()` + `classifyHostLocality()`
 * so the pipeline has a single boundary helper:
 *
 *   1. Resolve the real peer IP from PEER_IP_HEADER (or fail closed → remote).
 *   2. If the via-proxy marker is present, the loopback / private-LAN socket
 *      is the proxy hop, not the end-user — downgrade to "remote".
 *      (Public-IP sockets are already remote, so the marker is a no-op there.)
 *   3. Otherwise classify the raw IP normally (loopback / lan / remote).
 *
 * Pure; both header values are token-validated, so an attacker who knows the
 * header names but not the per-process token cannot influence the verdict in
 * any direction.
 */
export function classifyStampedPeerLocality(
  peerHeader: string | null,
  viaProxyHeader: string | null,
  token: string | undefined
): "loopback" | "lan" | "remote" {
  const ip = resolveStampedPeer(peerHeader, token);
  const viaProxy = resolveStampedViaProxy(viaProxyHeader, token);
  const locality = classifyHostLocality(ip);
  if (viaProxy && locality !== "remote") return "remote";
  return locality;
}

/** First syntactically-valid IP in an `X-Forwarded-For` CSV (left-most = the
 *  original client when a trusted proxy appends), or null. IPv4-mapped IPv6
 *  is normalized so loopback/private checks downstream see a single form. */
function firstValidForwardedIp(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const trimmed = part.trim().replace(/^::ffff:/i, "");
    if (trimmed && isIP(trimmed) !== 0) return trimmed;
  }
  return null;
}

/**
 * The trusted client IP for per-IP controls that must never be spoofable
 * (login brute-force guard, operator IP allow/block filter, audit logs).
 *
 *   - Direct public/LAN socket (no via-proxy marker): the real stamped TCP
 *     peer IP. Client-supplied forwarding headers are IGNORED — otherwise a
 *     remote attacker sets a fresh `X-Forwarded-For` per request and escapes
 *     every per-IP bucket.
 *   - Behind a trusted local reverse proxy (via-proxy marker set): the
 *     left-most valid IP from `CF-Connecting-IP` / `X-Forwarded-For` /
 *     `X-Real-IP`, i.e. the real end-user the proxy forwarded.
 *
 * Returns null only when there is no stamped peer at all (e.g. an edge/fetch
 * path with no socket, or peer stamping disabled) — callers then fall back to
 * their existing header-based resolution so no path regresses to "unknown".
 *
 * Both header values are token-validated, so a remote caller who knows the
 * header names but not the per-process token cannot influence the result.
 */
export function resolveTrustedClientIp(
  peerHeader: string | null,
  viaProxyHeader: string | null,
  forwarding: {
    cfConnectingIp?: string | null;
    xForwardedFor?: string | null;
    xRealIp?: string | null;
  },
  token: string | undefined
): string | null {
  const peerIp = resolveStampedPeer(peerHeader, token);
  if (!peerIp) return null;
  const viaProxy = resolveStampedViaProxy(viaProxyHeader, token);
  if (!viaProxy) {
    // Direct socket — the peer IS the client; never trust forwarding headers.
    return peerIp.replace(/^::ffff:/i, "");
  }
  // Trusted local proxy hop — the real client is in the forwarding headers.
  const forwarded =
    firstValidForwardedIp(forwarding.cfConnectingIp ?? null) ??
    firstValidForwardedIp(forwarding.xForwardedFor ?? null) ??
    firstValidForwardedIp(forwarding.xRealIp ?? null);
  // Fall back to the proxy's own IP if, somehow, no valid forwarded IP is
  // present (misconfigured proxy) — still unspoofable, just coarser.
  return forwarded ?? peerIp.replace(/^::ffff:/i, "");
}
