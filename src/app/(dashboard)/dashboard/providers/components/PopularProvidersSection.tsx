"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Card } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";

import { POPULAR_PROVIDER_DESCRIPTIONS } from "../featuredProviders";

type ProviderMessageTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) {
    return t(key, values);
  }
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

export interface PopularProviderEntry {
  providerId: string;
  provider: { id?: string; name: string };
  stats: { total?: number };
}

interface PopularProvidersSectionProps {
  /** Popular providers in display order, with the page's per-provider connection stats. */
  entries: PopularProviderEntry[];
}

/**
 * Quick-start grid at the top of /dashboard/providers: the most common providers,
 * each with one obvious action ("Connect", or "Manage" once it has a connection).
 */
export default function PopularProvidersSection({ entries }: PopularProvidersSectionProps) {
  const router = useRouter();
  const t = useTranslations("providers");

  if (entries.length === 0) return null;

  const connectLabel = providerText(t, "connect", "Connect");
  const manageLabel = providerText(t, "popularManage", "Manage");
  const connectedLabel = providerText(t, "popularConnectedBadge", "Connected");

  return (
    <section
      aria-labelledby="popular-providers-heading"
      className="flex flex-col gap-4"
      data-testid="popular-providers"
    >
      <div>
        <h2 id="popular-providers-heading" className="text-xl font-semibold text-text-main">
          {providerText(t, "popularProviders", "Popular providers")}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {providerText(
            t,
            "popularProvidersDesc",
            "Pick one to add your API key. You can add more anytime."
          )}
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {entries.map(({ providerId, provider, stats }) => {
          const isConnected = Number(stats?.total || 0) > 0;
          const description = POPULAR_PROVIDER_DESCRIPTIONS[providerId];
          const nameId = `popular-provider-${providerId}-name`;

          return (
            <li key={providerId} className="flex">
              <Card
                padding="sm"
                className="flex w-full flex-col gap-3 shadow-soft transition-colors hover:border-primary/40"
                data-testid={`popular-provider-${providerId}`}
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-bg-subtle">
                    <ProviderIcon providerId={provider.id || providerId} size={24} type="color" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3
                        id={nameId}
                        className="break-words text-sm font-semibold leading-snug text-text-main"
                      >
                        {provider.name}
                      </h3>
                      {isConnected && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                          <span
                            className="material-symbols-outlined text-[14px] leading-none"
                            aria-hidden="true"
                          >
                            check_circle
                          </span>
                          {connectedLabel}
                        </span>
                      )}
                    </div>
                    {description && (
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">
                        {providerText(t, description.key, description.fallback)}
                      </p>
                    )}
                  </div>
                </div>

                <div className="mt-auto">
                  <Button
                    size="sm"
                    variant={isConnected ? "secondary" : "primary"}
                    icon={isConnected ? "settings" : "add"}
                    aria-describedby={nameId}
                    onClick={() => router.push(`/dashboard/providers/${providerId}`)}
                  >
                    {isConnected ? manageLabel : connectLabel}
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-text-muted">
        {providerText(t, "popularNotListedHint", "Don't see yours? Search all providers below.")}
      </p>
    </section>
  );
}
