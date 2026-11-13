"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";

const subscribePlatform = () => () => {};
const getPlatformIsMac = () => {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/.test(platform);
};
const getPlatformIsMacServer = () => false;
import ThemeToggle from "./ThemeToggle";
import TokenHealthBadge from "./TokenHealthBadge";
import DegradationBadge from "./DegradationBadge";
import LanguageSelector from "./LanguageSelector";
import { LANGUAGES } from "@/i18n/config";
import ProviderIcon from "./ProviderIcon";
import { useTranslations } from "next-intl";
import {
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  NOAUTH_PROVIDERS,
  CLAUDE_CODE_COMPATIBLE_PREFIX,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import {
  SIDEBAR_SECTIONS,
  getSectionItems,
  type SidebarItemDefinition,
  type HideableSidebarItemId,
} from "@/shared/constants/sidebarVisibility";

const isE2EMode = process.env.NEXT_PUBLIC_TROUTEAI_E2E_MODE === "1";

// Map sidebar item id → header description i18n key
const HEADER_DESCRIPTIONS: Partial<Record<HideableSidebarItemId | "proxy", string>> = {
  home: "homeDescription",
  endpoints: "endpointDescription",
  "api-manager": "apiManagerDescription",
  providers: "providerDescription",
  combos: "comboDescription",
  costs: "costsDescription",
  analytics: "analyticsDescription",
  cache: "cacheDescription",
  quota: "limitsDescription",
  runtime: "runtimeDescription",
  playground: "playgroundDescription",
  logs: "logsDescription",
  audit: "auditDescription",
  health: "healthDescription",
  proxy: "proxyDescription",
  "analytics-utilization": "analyticsUtilizationDescription",
  "analytics-combo-health": "analyticsComboHealthDescription",
  "costs-budget": "costsBudgetDescription",
  "costs-pricing": "costsPricingDescription",
  "logs-proxy": "logsProxyDescription",
  "logs-console": "logsConsoleDescription",
  "settings-general": "settingsGeneralDescription",
  "settings-appearance": "settingsAppearanceDescription",
  "settings-ai": "settingsAiDescription",
  "settings-security": "settingsSecurityDescription",
  "settings-routing": "settingsRoutingDescription",
  "settings-resilience": "settingsResilienceDescription",
  "settings-cache": "settingsCacheDescription",
  "settings-advanced": "settingsAdvancedDescription",
};

// Build href → sidebar item lookup (non-external items only)
const sidebarByHref = new Map<string, SidebarItemDefinition>();
for (const section of SIDEBAR_SECTIONS) {
  for (const item of getSectionItems(section)) {
    if (!item.external) sidebarByHref.set(item.href, item);
  }
}

function getSidebarItem(pathname: string): SidebarItemDefinition | undefined {
  const exact = sidebarByHref.get(pathname);
  if (exact) return exact;
  // Longest prefix match
  let best: SidebarItemDefinition | undefined;
  let bestLen = 0;
  for (const [href, item] of sidebarByHref) {
    if (pathname.startsWith(href) && href.length > bestLen) {
      best = item;
      bestLen = href.length;
    }
  }
  return best;
}

type HeaderProps = {
  onMenuClick?: () => void;
  onOpenCommandPalette?: () => void;
  showMenuButton?: boolean;
  /** Mobile sidebar state, exposed to screen readers via aria-expanded. */
  menuOpen?: boolean;
};

type PageInfo = {
  title: string;
  description: string;
  icon?: string;
  providerId?: string;
};

function usePageInfo(pathname: string | null): PageInfo {
  const ts = useTranslations("sidebar");
  const th = useTranslations("header");

  if (!pathname) return { title: "", description: "" };

  // Special: provider detail page /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const pid = providerMatch[1];
    const info = OAUTH_PROVIDERS[pid] || NOAUTH_PROVIDERS[pid] || APIKEY_PROVIDERS[pid];
    if (info) return { title: info.name, description: "", providerId: info.id };
    if (pid.startsWith(CLAUDE_CODE_COMPATIBLE_PREFIX))
      return { title: "CC Compatible", description: "", providerId: "claude" };
    if (pid.startsWith(OPENAI_COMPATIBLE_PREFIX))
      return { title: th("openaiCompatible"), description: "", providerId: "oai-cc" };
    if (pid.startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
      return { title: th("anthropicCompatible"), description: "", providerId: "anthropic-m" };
  }

  // Derive from sidebar
  const item = getSidebarItem(pathname);
  if (item) {
    const descKey = HEADER_DESCRIPTIONS[item.id];
    return {
      title: ts(item.i18nKey),
      description: descKey ? th(descKey) : "",
      icon: item.icon,
    };
  }

  return { title: "", description: "" };
}

export default function Header({
  onMenuClick,
  onOpenCommandPalette,
  showMenuButton = true,
  menuOpen,
}: HeaderProps) {
  const isMac = useSyncExternalStore(subscribePlatform, getPlatformIsMac, getPlatformIsMacServer);
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("header");
  const { title, description, icon, providerId } = usePageInfo(pathname);

  const handleLogout = async () => {
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      if (res.ok) {
        router.push("/login");
        router.refresh();
      }
    } catch (err) {
      console.error("Failed to logout:", err);
    }
  };

  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur sm:px-6">
      {/* Mobile menu button */}
      <div className="flex min-w-0 items-center gap-2 lg:hidden">
        {showMenuButton && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label={t("openMenu")}
            title={t("openMenu")}
            aria-expanded={menuOpen}
            aria-controls="mobile-sidebar"
            className="flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              menu
            </span>
          </button>
        )}
        {title && (
          <span className="truncate text-sm font-semibold text-text-main" title={title}>
            {title}
          </span>
        )}
      </div>

      {/* Page title with icon - desktop */}
      <div className="hidden min-w-0 items-center gap-2.5 lg:flex">
        {(icon || providerId) && (
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
            {icon ? (
              <span
                className="material-symbols-outlined text-[16px] text-primary-text"
                aria-hidden="true"
              >
                {icon}
              </span>
            ) : (
              providerId && <ProviderIcon providerId={providerId} size={16} type="color" />
            )}
          </div>
        )}
        {title && (
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h1
              className="truncate text-sm font-semibold tracking-tight text-text-main"
              title={title}
            >
              {title}
            </h1>
            {description && (
              <p className="hidden truncate text-xs text-text-muted xl:block" title={description}>
                {description}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="ms-auto flex shrink-0 items-center gap-1">
        {onOpenCommandPalette && (
          <>
            <button
              type="button"
              onClick={onOpenCommandPalette}
              className="me-1 hidden h-8 items-center gap-2 rounded-control border border-border bg-surface ps-2.5 pe-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 md:inline-flex"
              title={t("quickNavigationTitle")}
              aria-label={t("openQuickNavigation")}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                search
              </span>
              <span className="max-w-40 truncate text-xs">{t("quickNavigation")}</span>
              <kbd className="hidden h-5 items-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium text-text-muted lg:inline-flex">
                {isMac ? "⌘K" : "Ctrl+K"}
              </kbd>
            </button>
            <button
              type="button"
              onClick={onOpenCommandPalette}
              className="flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 md:hidden"
              aria-label={t("openQuickNavigation")}
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                search
              </span>
            </button>
          </>
        )}
        {/* Shown only when more than one language is configured (config/i18n.json). */}
        {LANGUAGES.length > 1 && <LanguageSelector />}
        <ThemeToggle />
        {!isE2EMode && <DegradationBadge />}
        {!isE2EMode && <TokenHealthBadge />}
        <button
          type="button"
          onClick={handleLogout}
          className="flex size-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          title={t("logout")}
          aria-label={t("logout")}
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            logout
          </span>
        </button>
      </div>
    </header>
  );
}
