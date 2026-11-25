/**
 * "Listed means routable" for the client model list.
 *
 * A client builds its model picker from `GET /v1/models`; a name in that list that then
 * answers 404 or 503 looks like a broken gateway. These helpers apply the same skips the
 * request path applies before it sends anything upstream (src/sse/handlers/chat.ts and
 * src/sse/services/auth.ts): switched-off combo steps, accounts in a terminal state, steps
 * pinned to an account that is gone, and the API key's own account allowlist. An account
 * that is only cooling down after a usage limit is still usable: it comes back by itself,
 * so its names stay listed.
 *
 * The dashboard reads the same list with its login session and no API key. It keeps the
 * full list: the owner must still see a combo whose steps are all off in order to turn
 * one back on.
 */

import { isComboStepDisabled } from "@/lib/combos/steps";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

/** Feature flag that keeps the old "list everything configured" behaviour reachable. */
export const ROUTABLE_ONLY_FLAG = "MODELS_CATALOG_ROUTABLE_ONLY";

/** Statuses the request path never selects an account in (auth.ts isTerminalConnectionStatus). */
const TERMINAL_CONNECTION_STATUSES = new Set(["banned", "expired", "credits_exhausted"]);

function isRoutableOnlyCatalogEnabled(): boolean {
  try {
    return isFeatureFlagEnabled(ROUTABLE_ONLY_FLAG);
  } catch {
    return true;
  }
}

/**
 * True when this request gets only the names that can be served now: every client call
 * (an API key, or no login at all), unless the owner switched the rule off.
 */
export async function shouldListRoutableOnly(request: Request): Promise<boolean> {
  if (!isRoutableOnlyCatalogEnabled()) return false;
  if (extractApiKey(request)) return true;
  try {
    return !(await isDashboardSessionAuthenticated(request));
  } catch {
    return true;
  }
}

/** True when the request path could still pick this account for a request. */
export function isCatalogUsableConnection(connection: { testStatus?: unknown } | null): boolean {
  if (!connection) return false;
  const status =
    typeof connection.testStatus === "string" ? connection.testStatus.trim().toLowerCase() : "";
  return !TERMINAL_CONNECTION_STATUSES.has(status);
}

function normalizeConnectionIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * The accounts an API key may use, the way the request path works it out: its own
 * allowlist, narrowed to the pool's accounts for a quota key. `null` means every account;
 * an empty list means none.
 */
export async function resolveAllowedConnectionIds(
  keyMeta: { allowedConnections?: unknown; allowedQuotas?: unknown } | null
): Promise<string[] | null> {
  const own = normalizeConnectionIds(keyMeta?.allowedConnections);
  const quotas = keyMeta?.allowedQuotas;
  if (!Array.isArray(quotas) || quotas.length === 0) return own;
  const { resolveQuotaKeyScope, constrainConnectionsToQuota } = await import("@/lib/quota/quotaKey");
  const scope = await resolveQuotaKeyScope(quotas as string[]);
  return constrainConnectionsToQuota(own ?? [], scope.connectionIds);
}

/** Keep only the accounts in `allowed`; `null` keeps every account. */
export function filterByAllowedConnections<T extends { id?: unknown }>(
  connections: T[],
  allowed: string[] | null
): T[] {
  if (allowed === null) return connections;
  const allowedSet = new Set(allowed);
  return connections.filter(
    (connection) => typeof connection.id === "string" && allowedSet.has(connection.id)
  );
}

/** The combo as the request path runs it: steps switched off are left out. */
export function withoutDisabledSteps<T>(combo: T): T {
  const models = (combo as { models?: unknown })?.models;
  if (!Array.isArray(models) || !models.some(isComboStepDisabled)) return combo;
  return { ...combo, models: models.filter((entry) => !isComboStepDisabled(entry)) };
}

export type RoutableComboTarget = {
  modelStr?: string;
  provider?: string | null;
  connectionId?: string | null;
  allowedConnectionIds?: string[] | null;
};

/** The accounts a combo step may run on: its pinned account, then its own allowlist. */
export function selectStepConnections<T extends { id?: unknown }>(
  connections: T[],
  target: RoutableComboTarget
): T[] {
  let selected = connections;
  const pinned = typeof target.connectionId === "string" ? target.connectionId.trim() : "";
  if (pinned) selected = selected.filter((connection) => connection.id === pinned);
  return filterByAllowedConnections(selected, normalizeConnectionIds(target.allowedConnectionIds));
}
