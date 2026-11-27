import { isProviderQuotaVisible } from "@/shared/utils/providerQuotaVisibility";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";

export type AccountStatus = "works" | "attention" | "off";

export interface AccountStats {
  total?: number;
  error?: number;
  allDisabled?: boolean;
}

/** One word for a provider's accounts: null when it has none. */
export function accountStatus(stats: AccountStats | null | undefined): AccountStatus | null {
  if (!stats || !stats.total) return null;
  if (stats.allDisabled) return "off";
  if (stats.error && stats.error > 0) return "attention";
  return "works";
}

/** The Limits page lists the accounts that can report limits; same rule as that page. */
export function anyAccountReportsLimits(
  connections: Array<{ provider?: string; authType?: string; quotaVisible?: boolean }>
): boolean {
  return connections.some(
    (c) =>
      isProviderQuotaVisible(c) &&
      USAGE_SUPPORTED_PROVIDERS.includes(c.provider as string) &&
      (c.authType === "oauth" || c.authType === "apikey")
  );
}

/** A catalog Connect opens the provider page with its add form open when it has no account. */
export function providerPageHref(providerId: string, accountCount: number): string {
  const base = `/dashboard/providers/${providerId}`;
  return accountCount > 0 ? base : `${base}?add=1`;
}
