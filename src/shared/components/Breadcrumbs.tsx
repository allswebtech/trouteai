"use client";

/**
 * Breadcrumbs: none on the pages of the menu (the title is in the top bar). A deeper page shows
 * one crumb, its parent's name, then its own NAME (a provider, a combo), never an id.
 */

import { usePathname } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ALL_PAGE_SECTIONS,
  getSectionItems,
  type SidebarItemDefinition,
} from "@/shared/constants/sidebarVisibility";
import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  NOAUTH_PROVIDERS,
} from "@/shared/constants/providers";

const PAGES = ALL_PAGE_SECTIONS.flatMap(getSectionItems);

function findPage(pathname: string): { item: SidebarItemDefinition; rest: string[] } | null {
  let best: SidebarItemDefinition | null = null;
  for (const item of PAGES) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  if (!best) return null;
  const rest = pathname.slice(best.href.length).split("/").filter(Boolean);
  return { item: best, rest };
}

export default function Breadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations("breadcrumbs");
  const ts = useTranslations("sidebar");
  const te = useTranslations("easy");
  const hit = pathname ? findPage(pathname) : null;
  if (!hit) return null;
  const { item, rest } = hit;
  const label = (page: SidebarItemDefinition) => ts(page.i18nKey);

  let parent: SidebarItemDefinition | undefined;
  let name: string | null = null;
  if (rest.length === 0) {
    // A page of the menu has no crumb; a page that belongs to one shows its parent.
    parent = item.parent ? PAGES.find((page) => page.id === item.parent) : undefined;
    name = parent ? label(item) : null;
  } else if (rest.length === 1) {
    // A page below a page of the menu: a name, never an id.
    parent = item;
    const seg = rest[0];
    if (item.id === "providers") {
      if (seg === "new") name = te("addAccount");
      else {
        const info = OAUTH_PROVIDERS[seg] || NOAUTH_PROVIDERS[seg] || APIKEY_PROVIDERS[seg];
        name = info?.name ?? null;
      }
    } else if (item.id === "combos") {
      // A combo's own page draws its crumb with the name.
      if (seg === "playground") name = te("tryRoute");
      else if (seg !== "live") return null;
    }
  }
  if (!parent) return null;

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="mb-4 flex min-w-0 flex-wrap items-center gap-1 text-xs text-text-muted"
    >
      <Link
        href={parent.href}
        className="truncate rounded-sm transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        title={label(parent)}
      >
        {label(parent)}
      </Link>
      {name && (
        <>
          <span
            className="material-symbols-outlined text-[14px] text-text-muted/60 rtl:rotate-180"
            aria-hidden="true"
          >
            chevron_right
          </span>
          <span aria-current="page" className="truncate font-medium text-text-main" title={name}>
            {name}
          </span>
        </>
      )}
    </nav>
  );
}
