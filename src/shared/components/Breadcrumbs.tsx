"use client";

/**
 * Breadcrumbs — FASE-07 UX
 *
 * Dashboard breadcrumb navigation component. Automatically generates
 * breadcrumbs from the current path with friendly labels.
 * Uses usePathname() internally — no props needed.
 *
 * Usage:
 *   <Breadcrumbs />
 */

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";

const PATH_LABELS = {
  dashboard: "dashboard",
  providers: "providers",
  combos: "combos",
  settings: "settings",
  general: "general",
  appearance: "appearance",
  ai: "ai",
  routing: "routing",
  resilience: "resilience",
  advanced: "advanced",
  "feature-flags": "featureFlags",
  logs: "logs",
  console: "console",
  playground: "playground",
  endpoint: "endpoint",
  "api-manager": "apiManager",
  analytics: "analytics",
  costs: "costs",
  health: "health",
  runtime: "runtime",
  home: "home",
  activity: "activity",
  "combo-health": "comboHealth",
  utilization: "utilization",
  audit: "audit",
  cache: "cache",
  live: "live",
  budget: "budget",
  pricing: "pricing",
  "quota-share": "quotaShare",
  limits: "limits",
  "provider-stats": "providerStats",
  new: "new",
  quota: "quota",
  security: "security",
  sidebar: "sidebar",
  tokens: "tokens",
  usage: "usage",
};

/**
 * Get a friendly label for a path segment.
 * @param {string} segment
 * @returns {string}
 */
function getLabel(segment, t) {
  const key = PATH_LABELS[segment];
  return key ? t(key) : segment.charAt(0).toUpperCase() + segment.slice(1);
}

export default function Breadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations("breadcrumbs");
  if (!pathname || pathname === "/dashboard") return null;

  const segments = pathname.split("/").filter(Boolean);
  const crumbs = segments.map((seg, idx) => ({
    label: getLabel(seg, t),
    href: "/" + segments.slice(0, idx + 1).join("/"),
    isLast: idx === segments.length - 1,
  }));

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="mb-4 flex min-w-0 flex-wrap items-center gap-1 text-xs text-text-muted"
    >
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex min-w-0 items-center gap-1">
          {i > 0 && (
            <span
              className="material-symbols-outlined text-[14px] text-text-muted/60 rtl:rotate-180"
              aria-hidden="true"
            >
              chevron_right
            </span>
          )}
          {crumb.isLast ? (
            <span
              aria-current="page"
              className="truncate font-medium text-text-main"
              title={crumb.label}
            >
              {crumb.label}
            </span>
          ) : (
            <Link
              href={crumb.href}
              className="truncate rounded-sm transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              title={crumb.label}
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
