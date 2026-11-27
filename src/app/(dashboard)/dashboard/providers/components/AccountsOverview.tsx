"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";

import { accountStatus, providerPageHref, type AccountStats } from "../accountsSummary";
import { providerText } from "../[id]/providerCredentialText";

export interface AccountsOverviewEntry {
  providerId: string;
  provider: {
    id?: string;
    name: string;
    color?: string;
    iconUrl?: string;
    textIcon?: string;
  };
  stats: AccountStats;
}

interface AccountsOverviewProps {
  /** Every provider the page knows, with its account stats; only the ones with accounts show. */
  entries: AccountsOverviewEntry[];
  showLimits: boolean;
  onAdd: () => void;
}

const STATUS_STYLE = {
  works: { dot: "bg-success", text: "text-success" },
  attention: { dot: "bg-warning", text: "text-warning" },
  off: { dot: "bg-text-muted/50", text: "text-text-muted" },
} as const;

/**
 * The first screen of the Accounts page: the head with Add account, one row per provider
 * that has an account (name, how many, one status word), and the two rows that lead on to the
 * limits and the media providers. The whole catalog stays below, in a closed fold.
 */
export default function AccountsOverview({ entries, showLimits, onAdd }: AccountsOverviewProps) {
  const t = useTranslations("providers");
  const connected = entries
    .map((entry) => ({ entry, status: accountStatus(entry.stats) }))
    .filter((row) => row.status !== null);

  const statusLabel = {
    works: providerText(t, "accountWorks", "Works"),
    attention: providerText(t, "accountNeedsAttention", "Needs attention"),
    off: providerText(t, "accountTurnedOff", "Turned off"),
  } as const;

  const rowClass =
    "flex min-h-14 items-center gap-3 rounded-card border border-border bg-surface px-3 py-2 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary/60";

  return (
    <section className="flex flex-col gap-3" data-testid="accounts-overview">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-text-main">
          {providerText(t, "accountsTitle", "Accounts")}
        </h1>
        <Button size="sm" icon="add" onClick={onAdd}>
          {providerText(t, "addAccount", "Add account")}
        </Button>
      </div>

      {connected.length === 0 ? (
        <p className="py-2 text-sm text-text-muted">
          {providerText(t, "noAccountYet", "No account yet.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {connected.map(({ entry, status }) => {
            const { providerId, provider, stats } = entry;
            const style = STATUS_STYLE[status!];
            return (
              <li key={providerId}>
                <Link
                  href={providerPageHref(providerId, stats.total ?? 0)}
                  className={rowClass}
                  data-testid={`account-row-${providerId}`}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-control border border-border bg-bg-subtle">
                    <ProviderIcon
                      providerId={provider.id || providerId}
                      src={provider.iconUrl}
                      alt={provider.name}
                      size={22}
                      type="color"
                      fallbackText={provider.textIcon}
                      fallbackColor={provider.color}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-snug text-text-main">
                      {provider.name}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {providerText(
                        t,
                        stats.total === 1 ? "accountCountOne" : "accountCountMany",
                        stats.total === 1 ? "1 account" : "{n} accounts",
                        { n: stats.total ?? 0 }
                      )}
                    </span>
                  </span>
                  <span
                    className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${style.text}`}
                  >
                    <span className={`size-2 rounded-full ${style.dot}`} aria-hidden="true" />
                    {statusLabel[status!]}
                  </span>
                  <span
                    className="material-symbols-outlined shrink-0 text-[20px] text-text-muted"
                    aria-hidden="true"
                  >
                    chevron_right
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <ul className="flex flex-col gap-2">
          {showLimits && (
            <li>
              <Link href="/dashboard/quota" className={rowClass}>
                <span className="material-symbols-outlined text-[20px] text-text-muted" aria-hidden="true">
                  data_usage
                </span>
                <span className="flex-1 text-sm font-medium text-text-main">
                  {providerText(t, "accountLimits", "Limits")}
                </span>
                <span
                  className="material-symbols-outlined shrink-0 text-[20px] text-text-muted"
                  aria-hidden="true"
                >
                  chevron_right
                </span>
              </Link>
            </li>
          )}
          <li>
            <Link href="/dashboard/media-providers" className={rowClass}>
              <span className="material-symbols-outlined text-[20px] text-text-muted" aria-hidden="true">
                perm_media
              </span>
              <span className="flex-1 text-sm font-medium text-text-main">
                {providerText(t, "accountMedia", "Images, speech and search")}
              </span>
              <span
                className="material-symbols-outlined shrink-0 text-[20px] text-text-muted"
                aria-hidden="true"
              >
                chevron_right
              </span>
            </Link>
          </li>
      </ul>
    </section>
  );
}
