import { headers } from "next/headers";

import { carriesForwardingHeader, isCliTokenDisabled, matchesCliTokenSecret } from "@/lib/cliToken";
import { AUTHZ_HEADER_PEER_LOCALITY, CLI_TOKEN_HEADER } from "@/server/authz/headers";

type RequestWithPeer = Request & {
  ip?: string;
  socket?: { remoteAddress?: string };
};

export function isLoopback(ip: string): boolean {
  const normalized = ip.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * Read a header value preferring the Request's own headers (works in any
 * context — App Router request handlers, unit tests, raw fetch) and falling
 * back to `next/headers` only when the request object isn't carrying them.
 *
 * Calling `headers()` outside a request scope throws (see Next.js
 * `next-dynamic-api-wrong-context`), so we guard the import.
 */
async function readHeader(request: Request, name: string): Promise<string | null> {
  const fromRequest = request.headers?.get(name);
  if (fromRequest != null) return fromRequest;
  try {
    const hdrs = await headers();
    return hdrs.get(name);
  } catch {
    return null;
  }
}

function firstHeaderIp(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function requestPeerAddress(request: RequestWithPeer): string | null {
  return request.ip || request.socket?.remoteAddress || null;
}

async function isLocalCliRequest(request: RequestWithPeer): Promise<boolean> {
  // 1. Direct / non-middleware callers (raw Node, unit tests) may carry a real
  //    socket peer.
  const peerAddress = requestPeerAddress(request);
  if (peerAddress) return isLoopback(peerAddress);

  // 2. A proxy or tunnel on this computer connects from loopback; its headers say the caller
  //    is elsewhere (the socket stamp only looks at x-forwarded-for / x-real-ip).
  if (carriesForwardingHeader(request.headers)) return false;

  // 3. Behind the authz pipeline, trust ONLY the locality verdict the middleware
  //    stamped from the real TCP peer IP and the client's own forwarding headers (it
  //    strips any client copy of this header first). It comes before the forwarded
  //    headers below because Next.js itself fills in x-forwarded-for with the socket
  //    address before a route handler runs, so that header is present on every local
  //    call too. NEVER derive locality from the Host header — it is client-controlled.
  const locality = await readHeader(request, AUTHZ_HEADER_PEER_LOCALITY);
  if (locality !== null) return locality === "loopback";

  // 4. No verdict and a forwarded request: it came through a proxy, not a local CLI call.
  const forwardedPeer =
    firstHeaderIp(await readHeader(request, "cf-connecting-ip")) ||
    firstHeaderIp(await readHeader(request, "x-forwarded-for")) ||
    firstHeaderIp(await readHeader(request, "x-real-ip"));
  if (forwardedPeer) return false;

  // 5. No trusted locality signal → fail closed.
  return false;
}

/**
 * Validates the command token sent by the local `trouteai` command: the random secret in
 * DATA_DIR/cli-token (src/lib/cliToken.ts), the same rule as the authz pipeline. Only from this
 * computer, never through a proxy. Disabled via TROUTEAI_DISABLE_CLI_TOKEN=true.
 */
export async function isCliTokenAuthValid(request: Request): Promise<boolean> {
  if (isCliTokenDisabled()) return false;

  const token = await readHeader(request, CLI_TOKEN_HEADER);
  if (!token) return false;

  if (!(await isLocalCliRequest(request as RequestWithPeer))) return false;

  return matchesCliTokenSecret(token);
}
