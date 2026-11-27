"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";

export type UsageTabId = "overview" | "requests" | "costs";

const TABS: Array<{ id: UsageTabId; href: string; labelKey: string }> = [
  { id: "overview", href: "/dashboard/analytics", labelKey: "overview" },
  { id: "requests", href: "/dashboard/logs", labelKey: "requests" },
  { id: "costs", href: "/dashboard/costs", labelKey: "costs" },
];

/**
 * The three tabs of the Usage pages. Each tab is its own page, so they are links; all three
 * fit side by side on a phone.
 */
export default function UsageTabs({ active }: { active: UsageTabId }) {
  const t = useTranslations("usageTabs");
  return (
    <nav
      aria-label={t("usage")}
      className="grid w-full grid-cols-3 gap-0.5 rounded-control border border-border bg-surface-2 p-0.5"
    >
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={selected ? "page" : undefined}
            className={cn(
              "focus-ring inline-flex h-11 items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors sm:h-9",
              selected
                ? "border-border bg-surface text-text-main"
                : "border-transparent text-text-muted hover:text-text-main"
            )}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export interface UsageMoreRow {
  href: string;
  label: string;
}

/**
 * The closed More fold at the end of a page: one row per page that used to be a menu item.
 * Shown only when there are rows.
 */
export function UsageMore({ rows }: { rows: UsageMoreRow[] }) {
  const t = useTranslations("usageTabs");
  if (rows.length === 0) return null;
  return (
    <details className="group rounded-card border border-border bg-surface">
      <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium text-text-main [&::-webkit-details-marker]:hidden">
        {t("more")}
        <span
          className="material-symbols-outlined text-[20px] text-text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          expand_more
        </span>
      </summary>
      <div className="flex flex-col border-t border-border">
        {rows.map((row) => (
          <Link
            key={row.href}
            href={row.href}
            className="focus-ring flex min-h-11 items-center justify-between gap-2 px-4 text-sm text-text-main hover:bg-surface-2"
          >
            {row.label}
            <span
              className="material-symbols-outlined text-[18px] text-text-muted rtl:rotate-180"
              aria-hidden="true"
            >
              chevron_right
            </span>
          </Link>
        ))}
      </div>
    </details>
  );
}

function useMoreRows(tab: UsageTabId | "activity"): UsageMoreRow[] {
  const t = useTranslations("usageTabs");
  if (tab === "overview") {
    return [
      { href: "/dashboard/analytics?tab=combo-health", label: t("comboHealth") },
      { href: "/dashboard/analytics?tab=utilization", label: t("limitsUsed") },
      { href: "/dashboard/analytics?tab=cache-health", label: t("cache") },
      { href: "/dashboard/analytics?tab=route-trace", label: t("routeTrace") },
      { href: "/dashboard/provider-stats", label: t("speedByAccount") },
    ];
  }
  if (tab === "requests") {
    return [
      { href: "/dashboard/logs/proxy", label: t("proxyLog") },
      { href: "/dashboard/logs/console", label: t("serverLog") },
      { href: "/dashboard/logs/timeline", label: t("timeline") },
    ];
  }
  if (tab === "costs") {
    return [
      { href: "/dashboard/costs/pricing", label: t("prices") },
      { href: "/dashboard/costs/budget", label: t("budget") },
      { href: "/dashboard/costs/quota-share", label: t("quotaSharing") },
    ];
  }
  return [{ href: "/dashboard/audit", label: t("auditLog") }];
}

/** The More fold of each Usage page (and of Activity), written once. */
export function UsageMoreFor({ tab }: { tab: UsageTabId | "activity" }) {
  return <UsageMore rows={useMoreRows(tab)} />;
}
