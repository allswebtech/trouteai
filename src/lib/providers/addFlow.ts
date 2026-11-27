import { PROVIDERS as OAUTH_FLOWS } from "@/lib/oauth/providers/index";
import { BROWSER_DEVICE_FLOW_PROVIDERS, RETIRED_PKCE_PROVIDERS } from "@/lib/oauth/flowSets";
import { KEYCHAIN_IMPORT_ONLY_PROVIDERS } from "@/app/api/oauth/[provider]/[action]/keychainImportOnly";
import {
  STATIC_PROVIDER_CATALOG_GROUPS,
  STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER,
  isManagedProviderConnectionId,
  type StaticProviderCatalogCategory,
} from "@/lib/providers/catalog";

/**
 * How an account is added to a provider:
 * - api-key: a key (or cookie, or address) sent to POST /api/providers
 * - device-code: the OAuth device flow (GET /api/oauth/<id>/device-code, then poll)
 * - link-and-paste: a sign-in link to open, and the code or address it ends on pasted back
 * - own-page: only in the gateway's own page (token import, keychain import, a flow that runs in
 *   the person's browser, or nothing to add at all)
 */
export type AddFlow = "api-key" | "device-code" | "link-and-paste" | "own-page";

export interface ProviderCatalogRow {
  id: string;
  name: string;
  category: StaticProviderCatalogCategory;
  authHint: string | null;
  apiHint: string | null;
  website: string | null;
  flow: AddFlow;
}

function oauthFlow(id: string): AddFlow {
  if (
    KEYCHAIN_IMPORT_ONLY_PROVIDERS.has(id) ||
    RETIRED_PKCE_PROVIDERS.has(id) ||
    BROWSER_DEVICE_FLOW_PROVIDERS.has(id)
  ) {
    return "own-page";
  }
  const flowType = (OAUTH_FLOWS as Record<string, { flowType?: string } | undefined>)[id]?.flowType;
  if (!flowType || flowType === "import_token") return "own-page";
  if (flowType === "device_code") return "device-code";
  return "link-and-paste";
}

export function providerAddFlow(id: string, category: StaticProviderCatalogCategory): AddFlow {
  if (category === "oauth") return oauthFlow(id);
  if (category === "no-auth") return "own-page";
  return isManagedProviderConnectionId(id) ? "api-key" : "own-page";
}

/** Every provider of the code's own catalog (hidden ones left out), no account data, no secret. */
export function buildProviderCatalog(): ProviderCatalogRow[] {
  const rows: ProviderCatalogRow[] = [];
  const seen = new Set<string>();
  for (const category of STATIC_PROVIDER_CATALOG_RESOLUTION_ORDER) {
    const group = STATIC_PROVIDER_CATALOG_GROUPS[category];
    for (const [id, entry] of Object.entries(group.providers)) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (entry.hiddenFromDashboard) continue;
      rows.push({
        id,
        name: String(entry.name ?? id),
        category,
        authHint: typeof entry.authHint === "string" ? entry.authHint : null,
        apiHint: typeof entry.apiHint === "string" ? entry.apiHint : null,
        website: typeof entry.website === "string" ? entry.website : null,
        flow: providerAddFlow(id, category),
      });
    }
  }
  return rows;
}
