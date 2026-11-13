/**
 * Alternate protocols declared by a provider.
 *
 * Some upstreams publish the same catalog over more than one protocol (e.g. Xiaomi
 * MiMo exposes /v1/chat/completions and /anthropic/v1/messages on the same host).
 * Switching protocol switches the URL, the auth header and the extra headers, so an
 * alternate carries all three, not just the URL.
 *
 * The choice lives on the connection, in providerSpecificData.targetFormat, and only
 * applies when it matches a declared alternate: an unknown value falls back to the
 * default format and never produces an orphaned URL/auth pair.
 */
import type { RegistryEntry } from "./shared.ts";

export interface AlternateFormat {
  format: string;
  baseUrl: string;
  chatPath?: string;
  authHeader?: string;
  headers?: Record<string, string>;
  urlSuffix?: string;
  label: string;
}

export function resolveAlternateFormat(
  entry: RegistryEntry | null | undefined,
  providerSpecificData: unknown
): AlternateFormat | null {
  const alternates = entry?.alternateFormats;
  if (!alternates?.length) return null;
  const requested = (providerSpecificData as { targetFormat?: unknown } | null | undefined)
    ?.targetFormat;
  if (typeof requested !== "string" || !requested) return null;
  return alternates.find((alt) => alt.format === requested) ?? null;
}
