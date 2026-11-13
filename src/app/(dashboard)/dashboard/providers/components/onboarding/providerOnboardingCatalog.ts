import { isAlibabaRegionalProvider } from "@/shared/constants/alibabaProviderRegions";
import {
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  isSelfHostedChatProvider,
  providerAllowsOptionalApiKey,
  supportsApiKeyOnFreeProvider,
} from "@/shared/constants/providers";

import { getPopularProviderRank } from "../../featuredProviders";

export type WizardProviderAuthKind = "apikey" | "oauth";

export type WizardProviderDefinition = {
  id: string;
  name?: string;
  icon?: string;
  color?: string;
  alias?: string;
  apiHint?: string;
  authHint?: string;
  freeNote?: string;
  website?: string;
  notice?: { apiKeyUrl?: string };
  noAuth?: boolean;
  deprecated?: boolean;
  deprecationReason?: string;
  hiddenFromDashboard?: boolean;
};

export type WizardProviderOption = {
  id: string;
  name: string;
  color?: string;
  alias?: string;
  description: string;
  authKind: WizardProviderAuthKind;
  apiKeyOptional: boolean;
  deprecated: boolean;
  /** Page where the user can get an API key (the key page, else the provider website). */
  apiKeyHelpUrl?: string;
};

export const SUPPORTED_WIZARD_OAUTH_PROVIDER_IDS = new Set([
  "claude",
  "codex",
  "antigravity",
  "agy",
  "kimi-coding",
  "github",
  "gitlab-duo",
  "kiro",
  "amazon-q",
  "cursor",
  "kilocode",
  "cline",
]);

function httpsUrlOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://") ? value : undefined;
}

function toProviderOption(
  provider: WizardProviderDefinition,
  authKind: WizardProviderAuthKind
): WizardProviderOption {
  const name = provider.name || provider.id;
  const fallbackDescription =
    authKind === "oauth"
      ? `Connect ${name} with the existing OAuth flow.`
      : `Connect ${name} with an API key.`;

  return {
    id: provider.id,
    name,
    color: provider.color,
    alias: provider.alias,
    description: provider.apiHint || provider.authHint || provider.freeNote || fallbackDescription,
    authKind,
    apiKeyOptional: Boolean(provider.noAuth || providerAllowsOptionalApiKey(provider.id)),
    deprecated: Boolean(provider.deprecated),
    apiKeyHelpUrl:
      httpsUrlOrUndefined(provider.notice?.apiKeyUrl) || httpsUrlOrUndefined(provider.website),
  };
}

/**
 * Popular providers first (in `POPULAR_PROVIDER_IDS` order), then the rest:
 * non-deprecated alphabetically, deprecated last.
 */
function sortProviderOptions(options: WizardProviderOption[]): WizardProviderOption[] {
  return [...options].sort((a, b) => {
    const aRank = getPopularProviderRank(a.id);
    const bRank = getPopularProviderRank(b.id);
    if (aRank !== bRank) {
      if (aRank === -1) return 1;
      if (bRank === -1) return -1;
      return aRank - bRank;
    }
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function getWizardApiKeyProviderOptions(): WizardProviderOption[] {
  const freeApiKeyProviders = Object.values(FREE_PROVIDERS).filter(
    (provider) => provider.noAuth || supportsApiKeyOnFreeProvider(provider.id)
  );
  const providers = [...Object.values(APIKEY_PROVIDERS), ...freeApiKeyProviders].filter(
    (provider) => !(provider as WizardProviderDefinition).hiddenFromDashboard
  );
  return sortProviderOptions(providers.map((provider) => toProviderOption(provider, "apikey")));
}

export function getWizardOAuthProviderOptions(): WizardProviderOption[] {
  const providersById = new Map<string, WizardProviderDefinition>();
  for (const provider of [...Object.values(OAUTH_PROVIDERS), ...Object.values(FREE_PROVIDERS)]) {
    if (SUPPORTED_WIZARD_OAUTH_PROVIDER_IDS.has(provider.id)) {
      providersById.set(provider.id, provider);
    }
  }
  return sortProviderOptions(
    [...providersById.values()].map((provider) => toProviderOption(provider, "oauth"))
  );
}

export function filterWizardProviderOptions(
  options: WizardProviderOption[],
  query: string
): WizardProviderOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => {
    const haystack = [option.id, option.name, option.alias, option.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

/** Splits an already-sorted option list into popular and other providers, keeping order. */
export function splitPopularProviderOptions(options: WizardProviderOption[]): {
  popular: WizardProviderOption[];
  others: WizardProviderOption[];
} {
  const popular: WizardProviderOption[] = [];
  const others: WizardProviderOption[] = [];
  for (const option of options) {
    (getPopularProviderRank(option.id) >= 0 ? popular : others).push(option);
  }
  return { popular, others };
}

// Providers whose connection needs a server address (base URL). Mirrors
// CONFIGURABLE_BASE_URL_PROVIDERS in providers/[id]/providerPageHelpers.ts plus the
// self-hosted providers. Not imported from there because that module pulls the full
// provider registry into this page's bundle. Keep both lists in sync.
const SERVER_ADDRESS_PROVIDER_IDS = new Set([
  "azure-openai",
  "azure-ai",
  "xiaomi-mimo",
  "siliconflow",
  "heroku",
  "databricks",
  "snowflake",
  "searxng-search",
  "petals",
  "comfyui",
  "kimi",
  "moonshot",
]);

// Mirrors getProviderRegionConfig().showsRegion in
// providers/[id]/components/modals/AlibabaProviderRegionField.tsx.
const REGION_PROVIDER_IDS = new Set(["bedrock", "vertex", "vertex-partner"]);

export type WizardProviderFieldNeeds = {
  baseUrl: boolean;
  region: boolean;
  cx: boolean;
};

/**
 * Extra fields a provider needs. The wizard always shows these fields and only
 * moves the remaining optional ones under "Advanced options".
 */
export function getWizardProviderFieldNeeds(
  providerId: string | null | undefined
): WizardProviderFieldNeeds {
  if (!providerId) return { baseUrl: false, region: false, cx: false };
  return {
    baseUrl: SERVER_ADDRESS_PROVIDER_IDS.has(providerId) || isSelfHostedChatProvider(providerId),
    region: REGION_PROVIDER_IDS.has(providerId) || isAlibabaRegionalProvider(providerId),
    cx: providerId === "google-pse-search",
  };
}

export function getDefaultConnectionName(option: Pick<WizardProviderOption, "name">): string {
  return `${option.name} Primary`;
}

const PROVIDER_SPECIFIC_FIELDS = ["baseUrl", "region", "cx", "customUserAgent"] as const;

export function buildProviderSpecificData(input: {
  baseUrl?: string;
  region?: string;
  cx?: string;
  customUserAgent?: string;
}): Record<string, string> | null {
  // Copy only these fields. The wizard passes its whole form, which also holds the
  // connection name and the API key; the key must never land in providerSpecificData
  // (stored as-is and returned unredacted by GET /api/providers).
  const providerSpecificData: Record<string, string> = {};
  for (const key of PROVIDER_SPECIFIC_FIELDS) {
    const value = input[key];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) providerSpecificData[key] = trimmed;
  }

  return Object.keys(providerSpecificData).length > 0 ? providerSpecificData : null;
}
