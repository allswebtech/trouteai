/**
 * Provider catalog data — extracted from providers.ts (god-file decomposition).
 * Pure data literal; re-exported by the providers.ts barrel. No behavior change.
 */
// Cloud coding-agent services (Jules, Devin, Codex Cloud) were task APIs for the removed
// cloud-agents feature, not chat/model providers. The category is kept (empty) so
// existing code paths stay valid.
type CatalogProviderEntry = {
  id: string;
  alias: string;
  name: string;
  icon: string;
  color: string;
  textIcon: string;
  website: string;
};

export const CLOUD_AGENT_PROVIDERS: Record<string, CatalogProviderEntry> = {};
