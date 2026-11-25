import { createHash, timingSafeEqual } from "node:crypto";

import { resolveDataDir } from "@/lib/dataPaths";

import { readCliToken } from "../../scripts/dev/cli-token-file.mjs";

/**
 * The command token (x-trouteai-cli-token) is checked in two places: the authz pipeline
 * (src/server/authz/policies/management.ts) and the route-level management check
 * (src/lib/middleware/cliTokenAuth.ts). Both use these helpers, so they accept exactly the same
 * thing: the random secret in DATA_DIR/cli-token (scripts/dev/cli-token-file.mjs), on a call
 * that came from this computer without a proxy, unless TROUTEAI_DISABLE_CLI_TOKEN=true.
 */
export function isCliTokenDisabled(): boolean {
  return process.env.TROUTEAI_DISABLE_CLI_TOKEN === "true";
}

// Headers a proxy or tunnel adds when it passes on a call from elsewhere. x-forwarded-for is not
// in the list because Next.js adds it to every request itself; whether the client sent one is
// recorded at the socket (scripts/dev/peer-stamp.mjs) and is part of the pipeline's locality.
const FORWARDING_HEADERS = ["forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip"];

type HeaderReader = { get(name: string): string | null } | undefined | null;

export function carriesForwardingHeader(headers: HeaderReader): boolean {
  if (!headers || typeof headers.get !== "function") return false;
  return FORWARDING_HEADERS.some((name) => {
    const value = headers.get(name);
    return typeof value === "string" && value.trim() !== "";
  });
}

/** Constant-time comparison with the secret in the data folder; false when it is missing. */
export function matchesCliTokenSecret(provided: string | null | undefined): boolean {
  if (isCliTokenDisabled() || typeof provided !== "string" || provided === "") return false;
  const secret = readCliToken(resolveDataDir());
  if (!secret) return false;
  // Hash both sides first so the comparison takes the same time whatever the lengths are.
  const expected = createHash("sha256").update(secret).digest();
  const given = createHash("sha256").update(provided.trim()).digest();
  return timingSafeEqual(expected, given);
}
