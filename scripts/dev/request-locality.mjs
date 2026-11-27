/**
 * The ONE decision "is this request from this computer?" (a request that is not is REMOTE).
 *
 * A request is local only when ALL of these hold:
 *   1. its socket peer is loopback (127.0.0.0/8, ::1, ::ffff:127.x),
 *   2. its Host header names this computer's loopback (localhost, 127.0.0.0/8, [::1], with or
 *      without a port, any case), and is not the host of the configured public base address,
 *   3. it carries none of the forwarding headers a proxy adds.
 * A missing or unparseable Host header is remote. This does not depend on a proxy adding a header:
 * a tunnel or proxy on this computer connects over loopback but passes the visitor's Host on.
 *
 * Used by the peer stamp (scripts/dev/peer-stamp.mjs, which feeds the authz pipeline, the command
 * token checks, the loopback-only routes, the first-password route and the per-IP controls) and by
 * the places that read a request without the stamp (src/server/authz/policies/management.ts,
 * src/lib/middleware/cliTokenAuth.ts, src/server/ws/liveServer.ts). Pure; no I/O.
 */

// The names the gateway reads for its public address, in the order publicOrigin.ts reads them.
const PUBLIC_BASE_URL_ENV = [
  "TROUTEAI_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
];

// A proxy or tunnel adds some of these when it passes on a call from elsewhere.
const FORWARDING_HEADER_NAMES = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
];

/** The lower-case host name of a Host header value (no port, IPv6 without brackets), or null. */
export function parseHostName(hostHeader) {
  if (typeof hostHeader !== "string") return null;
  const raw = hostHeader.trim();
  if (!raw || /[\s/\\@?#]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (!parsed.hostname) return null;
    return parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

/** True for localhost, 127.0.0.0/8 and ::1 (a host name, brackets and port already removed). */
export function isLoopbackName(name) {
  if (!name) return false;
  return name === "localhost" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** True when the Host header value names this computer's loopback and nothing else. */
export function isLoopbackHostHeader(hostHeader) {
  return isLoopbackName(parseHostName(hostHeader));
}

/** Host names of the configured public base addresses (loopback ones are not public: ignored). */
export function publicBaseHosts(env = process.env) {
  const hosts = [];
  for (const key of PUBLIC_BASE_URL_ENV) {
    const value = env[key];
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const name = parseHostName(new URL(value.trim()).host);
      if (name && !isLoopbackName(name)) hosts.push(name);
    } catch {
      /* not an address: ignored, like publicOrigin.ts does */
    }
  }
  return hosts;
}

/** True when the Host header is loopback AND not the public base host. */
export function isLocalHostHeader(hostHeader, env = process.env) {
  const name = parseHostName(hostHeader);
  if (!name || !isLoopbackName(name)) return false;
  return !publicBaseHosts(env).includes(name);
}

export function isLoopbackSocketAddress(address) {
  if (typeof address !== "string" || !address) return false;
  const ip = address.replace(/^::ffff:/i, "");
  return ip === "::1" || /^127(?:\.\d{1,3}){3}$/.test(ip);
}

/** Does this header bag carry a forwarding header? `get(name)` reads one header. */
export function carriesForwarding(get) {
  return FORWARDING_HEADER_NAMES.some((name) => {
    const value = get(name);
    return typeof value === "string" && value.trim() !== "";
  });
}

/**
 * The decision. `socketAddress`: the TCP peer (null when unknown: then only the headers decide,
 * for callers that have no socket). `get`: reads a request header by lower-case name.
 */
export function isLocalRequest({ socketAddress, get, env = process.env }) {
  if (socketAddress != null && !isLoopbackSocketAddress(socketAddress)) return false;
  if (!isLocalHostHeader(get("host"), env)) return false;
  return !carriesForwarding(get);
}

/** The same decision for a Node request (lower-case header object + socket). */
export function isLocalNodeRequest(req, { socket = true, env = process.env } = {}) {
  const headers = (req && req.headers) || {};
  const value = (name) => {
    const v = headers[name];
    return Array.isArray(v) ? v.join(",") : v;
  };
  return isLocalRequest({
    socketAddress: socket ? (req?.socket?.remoteAddress ?? "") : null,
    get: value,
    env,
  });
}
