/**
 * Provider catalog data — extracted from providers.ts (god-file decomposition).
 * Pure data literal; re-exported by the providers.ts barrel. No behavior change.
 */
// Upstream-proxy entries relied on the embedded-service manager,
// which is not part of this build. The category is kept (empty) so existing code paths stay valid.
type CatalogProviderEntry = {
  id: string;
  alias: string;
  name: string;
  icon: string;
  color: string;
  textIcon: string;
  website: string;
};

export const UPSTREAM_PROXY_PROVIDERS: Record<string, CatalogProviderEntry> = {};
