export const HIDEABLE_SIDEBAR_ITEM_IDS = [
  "home",
  "endpoints",
  "api-manager",
  "providers",
  "combos",
  "combos-live",
  "quota",
  "costs-quota-share",
  "analytics",
  "analytics-combo-health",
  "analytics-utilization",
  "cache",
  "provider-stats",
  "activity",
  "logs",
  "logs-proxy",
  "logs-console",
  "logs-timeline",
  "health",
  "runtime",
  "costs",
  "costs-pricing",
  "costs-budget",
  "audit",
  "playground",
  "settings-general",
  "settings-appearance",
  "settings-ai",
  "settings-routing",
  "settings-resilience",
  "settings-advanced",
  "settings-security",
  "settings-feature-flags",
  "settings-cache",
  "settings-sidebar",
] as const;

export type HideableSidebarItemId = (typeof HIDEABLE_SIDEBAR_ITEM_IDS)[number];

/** Sidebar entries that are intentionally always available and cannot be hidden by presets. */
export type AlwaysVisibleSidebarItemId = "proxy";

export type SidebarItemId = HideableSidebarItemId | AlwaysVisibleSidebarItemId;

export type SidebarSectionId =
  "home" | "setup" | "router" | "analytics" | "costs" | "monitoring" | "devtools" | "configuration";

export interface SidebarItemDefinition {
  id: SidebarItemId;
  href: string;
  i18nKey: string;
  subtitleKey?: string;
  /** Literal label shown when `i18nKey` has no translation (avoids per-locale edits). */
  labelFallback?: string;
  /** Literal subtitle shown when `subtitleKey` is absent/untranslated. */
  subtitleFallback?: string;
  icon: string;
  exact?: boolean;
  external?: boolean;
}

export interface SidebarItemGroup {
  type: "group";
  id: string;
  titleKey: string;
  titleFallback: string;
  items: readonly SidebarItemDefinition[];
}

export type SidebarSectionChild = SidebarItemDefinition | SidebarItemGroup;

export interface SidebarSectionDefinition {
  id: SidebarSectionId;
  titleKey: string;
  titleFallback: string;
  children: readonly SidebarSectionChild[];
  showTitle?: boolean;
  visibility?: "always" | "debug";
  defaultPinned?: boolean;
}

export type SidebarPresetId = "all" | "minimal" | "developer" | "admin";

export interface SidebarPresetDefinition {
  id: SidebarPresetId;
  icon: string;
  hiddenItems: HideableSidebarItemId[];
}

export type SidebarItemOrder = Partial<Record<SidebarSectionId, string[]>>;
