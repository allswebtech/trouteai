import type {
  SidebarItemDefinition,
  SidebarItemGroup,
  SidebarSectionChild,
  SidebarSectionDefinition,
} from "./types";

// ─── Item arrays ────────────────────────────────────────────────────────────

const HOME_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "home",
    href: "/home",
    i18nKey: "home",
    subtitleKey: "homeSubtitle",
    icon: "home",
    exact: true,
  },
];

const SETTINGS_ITEM: SidebarItemDefinition = {
  id: "settings",
  href: "/dashboard/settings",
  i18nKey: "settings",
  subtitleKey: "settingsSubtitle",
  icon: "settings",
};

// Core setup flow, in the order a user needs it: add providers → build combos →
// create an API key → copy the endpoint.
const SETUP_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "providers",
    href: "/dashboard/providers",
    i18nKey: "providers",
    subtitleKey: "providersSubtitle",
    icon: "dns",
  },
  {
    id: "combos",
    href: "/dashboard/combos",
    i18nKey: "combos",
    subtitleKey: "combosSubtitle",
    icon: "layers",
  },
  {
    id: "api-manager",
    href: "/dashboard/api-manager",
    i18nKey: "apiManager",
    subtitleKey: "apiManagerSubtitle",
    icon: "vpn_key",
  },
  {
    id: "endpoints",
    href: "/dashboard/endpoint",
    parent: "home",
    i18nKey: "endpoints",
    subtitleKey: "endpointsSubtitle",
    icon: "api",
  },
];

const ROUTER_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "combos-live",
    href: "/dashboard/combos/live",
    parent: "combos",
    i18nKey: "combosLive",
    labelFallback: "Combo Studio",
    subtitleKey: "combosLiveSubtitle",
    subtitleFallback: "Live routing cascade",
    icon: "account_tree",
  },
  {
    id: "quota",
    href: "/dashboard/quota",
    parent: "providers",
    i18nKey: "providerQuota",
    subtitleKey: "providerQuotaSubtitle",
    icon: "tune",
  },
  {
    id: "costs-quota-share",
    href: "/dashboard/costs/quota-share",
    parent: "analytics",
    i18nKey: "costsQuotaShare",
    subtitleKey: "costsQuotaShareSubtitle",
    icon: "pie_chart",
  },
];

const PROXY_ITEM: SidebarItemDefinition = {
  id: "proxy",
  href: "/dashboard/system/proxy",
  parent: "settings",
  i18nKey: "proxy",
  subtitleKey: "proxySubtitle",
  icon: "lan",
};

const ANALYTICS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "analytics",
    href: "/dashboard/analytics",
    i18nKey: "usage",
    subtitleKey: "usageSubtitle",
    icon: "analytics",
  },
  {
    id: "analytics-combo-health",
    href: "/dashboard/analytics/combo-health",
    parent: "analytics",
    i18nKey: "analyticsComboHealth",
    subtitleKey: "analyticsComboHealthSubtitle",
    icon: "monitor_heart",
  },
  {
    id: "analytics-utilization",
    href: "/dashboard/analytics/utilization",
    parent: "analytics",
    i18nKey: "analyticsUtilization",
    subtitleKey: "analyticsUtilizationSubtitle",
    icon: "bar_chart",
  },
  {
    id: "cache",
    href: "/dashboard/cache",
    parent: "analytics",
    i18nKey: "cache",
    subtitleKey: "cacheSubtitle",
    icon: "cached",
  },
  {
    id: "provider-stats",
    href: "/dashboard/provider-stats",
    parent: "analytics",
    i18nKey: "providerStats",
    subtitleKey: "providerStatsSubtitle",
    icon: "speed",
  },
];

const MONITORING_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "activity",
    href: "/dashboard/activity",
    i18nKey: "activity",
    subtitleKey: "activitySubtitle",
    icon: "timeline",
  },
];

const LOGS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "logs",
  titleKey: "logsGroup",
  titleFallback: "Logs",
  items: [
    {
      id: "logs",
      href: "/dashboard/logs",
      parent: "analytics",
      i18nKey: "logs",
      subtitleKey: "logsSubtitle",
      icon: "description",
    },
    {
      id: "logs-proxy",
      href: "/dashboard/logs/proxy",
      parent: "analytics",
      i18nKey: "logsProxy",
      subtitleKey: "logsProxySubtitle",
      icon: "lan",
    },
    {
      id: "logs-console",
      href: "/dashboard/logs/console",
      parent: "analytics",
      i18nKey: "consoleLogs",
      subtitleKey: "consoleLogsSubtitle",
      icon: "terminal",
    },
    {
      id: "logs-timeline",
      href: "/dashboard/logs/timeline",
      parent: "analytics",
      i18nKey: "logsTimeline",
      subtitleKey: "logsTimelineSubtitle",
      icon: "view_timeline",
    },
  ],
};

const SYSTEM_GROUP: SidebarItemGroup = {
  type: "group",
  id: "system",
  titleKey: "systemGroup",
  titleFallback: "System",
  items: [
    {
      id: "health",
      href: "/dashboard/health",
      i18nKey: "health",
      subtitleKey: "healthSubtitle",
      icon: "health_and_safety",
    },
    {
      id: "runtime",
      href: "/dashboard/runtime",
      i18nKey: "runtime",
      subtitleKey: "runtimeSubtitle",
      icon: "bolt",
    },
  ],
};

const COSTS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "costs",
    href: "/dashboard/costs",
    parent: "analytics",
    i18nKey: "costsOverview",
    subtitleKey: "costsOverviewSubtitle",
    icon: "account_balance_wallet",
  },
  {
    id: "costs-pricing",
    href: "/dashboard/costs/pricing",
    parent: "analytics",
    i18nKey: "costsPricing",
    subtitleKey: "costsPricingSubtitle",
    icon: "price_change",
  },
  {
    id: "costs-budget",
    href: "/dashboard/costs/budget",
    parent: "analytics",
    i18nKey: "costsBudget",
    subtitleKey: "costsBudgetSubtitle",
    icon: "savings",
  },
];

const AUDIT_GROUP: SidebarItemGroup = {
  type: "group",
  id: "audit",
  titleKey: "auditGroup",
  titleFallback: "Audit",
  items: [
    {
      id: "audit",
      href: "/dashboard/audit",
      parent: "activity",
      i18nKey: "auditLog",
      subtitleKey: "auditLogSubtitle",
      icon: "policy",
    },
  ],
};

const DEVTOOLS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "playground",
    href: "/dashboard/playground",
    debugOnly: true,
    i18nKey: "playground",
    subtitleKey: "playgroundSubtitle",
    icon: "science",
  },
];

const CONFIGURATION_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "settings-general",
    href: "/dashboard/settings/general",
    parent: "settings",
    i18nKey: "settingsGeneral",
    subtitleKey: "settingsGeneralSubtitle",
    icon: "tune",
  },
  {
    id: "settings-appearance",
    href: "/dashboard/settings/appearance",
    parent: "settings",
    i18nKey: "settingsAppearance",
    subtitleKey: "settingsAppearanceSubtitle",
    icon: "palette",
  },
  {
    id: "settings-ai",
    href: "/dashboard/settings/ai",
    parent: "settings",
    i18nKey: "settingsAi",
    subtitleKey: "settingsAiSubtitle",
    icon: "auto_awesome",
  },
  {
    id: "settings-routing",
    href: "/dashboard/settings/routing",
    parent: "settings",
    i18nKey: "globalRouting",
    subtitleKey: "globalRoutingSubtitle",
    icon: "route",
  },
  {
    id: "settings-resilience",
    href: "/dashboard/settings/resilience",
    parent: "settings",
    i18nKey: "settingsResilience",
    subtitleKey: "settingsResilienceSubtitle",
    icon: "health_and_safety",
  },
  {
    id: "settings-advanced",
    href: "/dashboard/settings/advanced",
    parent: "settings",
    i18nKey: "settingsAdvanced",
    subtitleKey: "settingsAdvancedSubtitle",
    icon: "engineering",
  },
  {
    id: "settings-security",
    href: "/dashboard/settings/security",
    parent: "settings",
    i18nKey: "settingsSecurity",
    subtitleKey: "settingsSecuritySubtitle",
    icon: "shield",
  },
  {
    id: "settings-feature-flags",
    href: "/dashboard/settings/feature-flags",
    parent: "settings",
    i18nKey: "settingsFeatureFlags",
    subtitleKey: "settingsFeatureFlagsSubtitle",
    icon: "flag",
  },
  {
    id: "settings-cache",
    href: "/dashboard/settings/cache",
    parent: "settings",
    i18nKey: "settingsCache",
    subtitleKey: "settingsCacheSubtitle",
    icon: "memory",
  },
  {
    id: "settings-sidebar",
    href: "/dashboard/settings/sidebar",
    parent: "settings",
    i18nKey: "settingsSidebar",
    subtitleKey: "settingsSidebarSubtitle",
    icon: "view_sidebar",
  },
];

// ─── Sections ────────────────────────────────────────────────────────────────

const byId = (items: readonly SidebarItemDefinition[], id: string) =>
  items.find((item) => item.id === id) as SidebarItemDefinition;

// The menu: six pages, no group headings. Show all menus adds one group, Status.
// Every other page keeps its address, is reached from the page it belongs to (`parent`), and is
// listed in LEGACY_PAGE_SECTIONS only so that its title, crumb and quick search keep working.
export const SIDEBAR_SECTIONS: readonly SidebarSectionDefinition[] = [
  {
    id: "home",
    titleKey: "home",
    titleFallback: "Home",
    children: [
      ...HOME_ITEMS,
      byId(SETUP_ITEMS, "providers"),
      byId(SETUP_ITEMS, "combos"),
      byId(SETUP_ITEMS, "api-manager"),
      byId(ANALYTICS_ITEMS, "analytics"),
      SETTINGS_ITEM,
    ],
    showTitle: false,
  },
  {
    id: "monitoring",
    titleKey: "status",
    titleFallback: "Status",
    children: [...MONITORING_ITEMS, ...SYSTEM_GROUP.items, ...DEVTOOLS_ITEMS],
  },
] as const;

const MENU_IDS = new Set<string>(
  SIDEBAR_SECTIONS.flatMap((section) =>
    section.children.map((child) => (child as SidebarItemDefinition).id)
  )
);
const offMenu = (items: readonly SidebarItemDefinition[]) =>
  items.filter((item) => !MENU_IDS.has(item.id));

/** Pages that are not in the menu (still answering at their old address). */
export const LEGACY_PAGE_SECTIONS: readonly SidebarSectionDefinition[] = [
  {
    id: "setup",
    titleKey: "setupSection",
    titleFallback: "Setup",
    children: offMenu(SETUP_ITEMS),
  },
  {
    id: "router",
    titleKey: "routerSection",
    titleFallback: "Routing",
    children: [...ROUTER_ITEMS, PROXY_ITEM],
  },
  {
    id: "analytics",
    titleKey: "analyticsSection",
    titleFallback: "Analytics",
    children: offMenu(ANALYTICS_ITEMS),
  },
  {
    id: "costs",
    titleKey: "costsSection",
    titleFallback: "Costs",
    children: COSTS_ITEMS,
  },
  {
    id: "devtools",
    titleKey: "monitoringSection",
    titleFallback: "Monitoring",
    children: [LOGS_GROUP, AUDIT_GROUP],
  },
  {
    id: "configuration",
    titleKey: "configurationSection",
    titleFallback: "Configuration",
    children: CONFIGURATION_ITEMS,
  },
] as const;

/** Menu pages and the others: for page titles, crumbs and quick search. */
export const ALL_PAGE_SECTIONS: readonly SidebarSectionDefinition[] = [
  ...SIDEBAR_SECTIONS,
  ...LEGACY_PAGE_SECTIONS,
];
