"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

type Row = { href: string; labelKey: string; icon: string };

const MAIN_ROWS: readonly Row[] = [
  { href: "/dashboard/settings/security", labelKey: "passwordAndAccess", icon: "shield" },
  { href: "/dashboard/settings/appearance", labelKey: "appearance", icon: "palette" },
  { href: "/dashboard/settings/general", labelKey: "yourData", icon: "database" },
];

const ADVANCED_ROWS: readonly Row[] = [
  { href: "/dashboard/settings/ai", labelKey: "ai", icon: "auto_awesome" },
  { href: "/dashboard/settings/routing", labelKey: "routing", icon: "route" },
  { href: "/dashboard/settings/resilience", labelKey: "whenProviderFails", icon: "health_and_safety" },
  { href: "/dashboard/settings/advanced", labelKey: "expert", icon: "engineering" },
  { href: "/dashboard/settings/feature-flags", labelKey: "featureFlags", icon: "flag" },
  { href: "/dashboard/settings/cache", labelKey: "cache", icon: "memory" },
  { href: "/dashboard/settings/sidebar", labelKey: "menu", icon: "view_sidebar" },
  { href: "/dashboard/system/proxy", labelKey: "proxy", icon: "lan" },
];

export default function SettingsListClient() {
  const t = useTranslations("easy");

  const renderRow = (row: Row) => (
    <li key={row.href}>
      <Link
        href={row.href}
        prefetch={false}
        className="flex min-h-12 items-center gap-3 px-4 text-sm text-text-main transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <span className="material-symbols-outlined text-[20px] text-text-muted" aria-hidden="true">
          {row.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{t(row.labelKey)}</span>
        <span
          className="material-symbols-outlined text-[20px] text-text-muted rtl:rotate-180"
          aria-hidden="true"
        >
          chevron_right
        </span>
      </Link>
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
        {MAIN_ROWS.map(renderRow)}
      </ul>
      <details className="group overflow-hidden rounded-card border border-border bg-surface">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 text-sm font-medium text-text-main marker:hidden hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1 truncate">{t("advanced")}</span>
          <span
            className="material-symbols-outlined text-[20px] text-text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          >
            expand_more
          </span>
        </summary>
        <ul className="divide-y divide-border border-t border-border">
          {ADVANCED_ROWS.map(renderRow)}
        </ul>
      </details>
    </div>
  );
}
