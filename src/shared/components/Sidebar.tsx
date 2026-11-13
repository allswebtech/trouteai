"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { getActiveSidebarHref } from "@/shared/utils/sidebarRouteMatch";
import { filterSidebarSectionsByQuery } from "@/shared/utils/sidebarSearch";
import {
  expandActiveSection,
  hydrateExpandedSections,
  toggleExpandedSection,
} from "@/shared/utils/sidebarExpansionState";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import BrandCredit from "@/shared/components/BrandCredit";
import Button from "./Button";
import Input from "./Input";
import { ConfirmModal } from "./Modal";
import { useTranslations } from "next-intl";
import {
  HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY,
  normalizeHiddenSidebarGroupLabels,
} from "@/shared/constants/sidebarGroupVisibility";
import {
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  SIDEBAR_PRESET_KEY,
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  SIDEBAR_SECTION_ORDER_KEY,
  SIDEBAR_ITEM_ORDER_KEY,
  SIDEBAR_SECTIONS,
  normalizeHiddenSidebarItems,
  applySectionOrder,
  applyItemOrder,
  getSidebarPresetHiddenItems,
  type SidebarPresetId,
  type SidebarSectionId,
  type SidebarItemDefinition,
  type SidebarItemGroup,
  type SidebarItemOrder,
} from "@/shared/constants/sidebarVisibility";

const isE2EMode = process.env.NEXT_PUBLIC_TROUTEAI_E2E_MODE === "1";
const DEFAULT_EXPANDED: SidebarSectionId = "setup";
const EXPANDED_SECTIONS_KEY = "sidebar-expanded-sections";
const PINNED_SECTIONS_KEY = "sidebar-pinned-sections";
// A menu this short (e.g. the simple menu) shows every section open, without the accordion.
const SHORT_MENU_MAX_ITEMS = 12;

type SidebarProps = {
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

type HoveredItem = { id: string; label: string; x: number; y: number } | null;

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed as T;
    }
  } catch {}
  return fallback;
}

function saveToStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function Sidebar({ onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const sidebarRef = useRef<HTMLElement>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [hiddenSidebarItems, setHiddenSidebarItems] = useState<string[]>([]);
  // Nav items render only after settings load, so the full menu never flashes before the
  // saved (often much shorter) menu replaces it.
  const [sidebarSettingsLoaded, setSidebarSettingsLoaded] = useState(false);
  const [isSwitchingMenu, setIsSwitchingMenu] = useState(false);
  const [hiddenSidebarGroupLabels, setHiddenSidebarGroupLabels] = useState<string[]>([]);
  const [sidebarSectionOrder, setSidebarSectionOrder] = useState<SidebarSectionId[]>([]);
  const [sidebarItemOrder, setSidebarItemOrder] = useState<SidebarItemOrder>({});
  const [customAppName, setCustomAppName] = useState<string | null>(null);
  const [customLogo, setCustomLogo] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<SidebarSectionId>>(
    new Set([DEFAULT_EXPANDED])
  );
  const [pinnedSections, setPinnedSections] = useState<Set<SidebarSectionId>>(new Set());
  const [sidebarExpansionLoaded, setSidebarExpansionLoaded] = useState(false);
  const skipInitialActiveExpansion = useRef(false);
  const [hoveredItem, setHoveredItem] = useState<HoveredItem>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Load persisted state on mount. A stored [] intentionally means "all sections collapsed".
  useEffect(() => {
    const storedExpanded = loadFromStorage<SidebarSectionId[]>(EXPANDED_SECTIONS_KEY, [
      DEFAULT_EXPANDED,
    ]);
    const pinnedRaw = (() => {
      try {
        return localStorage.getItem(PINNED_SECTIONS_KEY);
      } catch {
        return null;
      }
    })();
    const storedPinned: SidebarSectionId[] =
      pinnedRaw !== null
        ? (JSON.parse(pinnedRaw) as SidebarSectionId[])
        : (SIDEBAR_SECTIONS.filter((s) => s.defaultPinned).map((s) => s.id) as SidebarSectionId[]);

    const initialPinned = new Set<SidebarSectionId>(storedPinned);
    const initialExpanded = hydrateExpandedSections(storedExpanded, initialPinned);

    skipInitialActiveExpansion.current = storedExpanded.length === 0;
    setExpandedSections(initialExpanded);
    setPinnedSections(initialPinned);
    setSidebarExpansionLoaded(true);
  }, []);

  useEffect(() => {
    const applySettings = (data) => {
      setShowDebug(data?.debugMode === true);
      setHiddenSidebarItems(normalizeHiddenSidebarItems(data?.[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]));
      setHiddenSidebarGroupLabels(
        normalizeHiddenSidebarGroupLabels(data?.[HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY])
      );
      setCustomAppName(data?.instanceName || null);
      setCustomLogo(data?.customLogoBase64 || data?.customLogoUrl || null);
    };

    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        applySettings(data);
        if (Array.isArray(data?.[SIDEBAR_SECTION_ORDER_KEY])) {
          setSidebarSectionOrder(data[SIDEBAR_SECTION_ORDER_KEY] as SidebarSectionId[]);
        }
        if (data?.[SIDEBAR_ITEM_ORDER_KEY] && typeof data[SIDEBAR_ITEM_ORDER_KEY] === "object") {
          setSidebarItemOrder(data[SIDEBAR_ITEM_ORDER_KEY] as SidebarItemOrder);
        }
      })
      .catch(() => {})
      .finally(() => setSidebarSettingsLoaded(true));

    const handleSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      if ("debugMode" in detail) setShowDebug(detail.debugMode === true);
      if (HIDDEN_SIDEBAR_ITEMS_SETTING_KEY in detail) {
        setHiddenSidebarItems(
          normalizeHiddenSidebarItems(detail[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY])
        );
      }
      if (HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY in detail) {
        setHiddenSidebarGroupLabels(
          normalizeHiddenSidebarGroupLabels(detail[HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY])
        );
      }
      if (SIDEBAR_SECTION_ORDER_KEY in detail && Array.isArray(detail[SIDEBAR_SECTION_ORDER_KEY])) {
        setSidebarSectionOrder(detail[SIDEBAR_SECTION_ORDER_KEY] as SidebarSectionId[]);
      }
      if (
        SIDEBAR_ITEM_ORDER_KEY in detail &&
        detail[SIDEBAR_ITEM_ORDER_KEY] &&
        typeof detail[SIDEBAR_ITEM_ORDER_KEY] === "object"
      ) {
        setSidebarItemOrder(detail[SIDEBAR_ITEM_ORDER_KEY] as SidebarItemOrder);
      }
      if ("instanceName" in detail) setCustomAppName((detail.instanceName as string) || null);
      if ("customLogoBase64" in detail) {
        setCustomLogo((detail.customLogoBase64 as string) || null);
      } else if ("customLogoUrl" in detail) {
        setCustomLogo((detail.customLogoUrl as string) || null);
      }
    };

    window.addEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, handleSettingsUpdated as EventListener);
    return () =>
      window.removeEventListener(
        SIDEBAR_SETTINGS_UPDATED_EVENT,
        handleSettingsUpdated as EventListener
      );
  }, []);

  const getSidebarLabel = (key: string, fallback: string) =>
    typeof t.has === "function" && t.has(key) ? t(key) : fallback;

  const resolveItem = (item: SidebarItemDefinition, hidden: Set<string>) => {
    if (hidden.has(item.id)) return null;
    const subtitle = item.subtitleKey
      ? getSidebarLabel(item.subtitleKey, item.subtitleFallback ?? "")
      : item.subtitleFallback;
    return {
      ...item,
      label: getSidebarLabel(item.i18nKey, item.labelFallback ?? item.id),
      subtitle: subtitle || undefined,
    };
  };

  const hiddenSidebarSet = new Set(hiddenSidebarItems);
  const hiddenSidebarGroupLabelsSet = new Set(hiddenSidebarGroupLabels);

  const orderedSections = applySectionOrder(
    SIDEBAR_SECTIONS.filter((section) => section.visibility !== "debug" || showDebug),
    sidebarSectionOrder
  );

  const visibleSections = orderedSections
    .map((section) => {
      const orderedChildren = applyItemOrder(
        section.children,
        sidebarItemOrder[section.id as SidebarSectionId] ?? []
      );

      const children = orderedChildren
        .map((child) => {
          if ("type" in child && child.type === "group") {
            const items = child.items
              .map((item) => resolveItem(item, hiddenSidebarSet))
              .filter(Boolean) as (SidebarItemDefinition & { label: string })[];
            if (items.length === 0) return null;
            // Smart-grouping: single visible item → inline flat (no group header)
            if (items.length === 1) return items[0];
            return {
              ...child,
              title: getSidebarLabel(child.titleKey, child.titleFallback),
              separatorHidden: hiddenSidebarGroupLabelsSet.has(child.id),
              items,
            } as SidebarItemGroup & {
              title: string;
              separatorHidden: boolean;
              items: (SidebarItemDefinition & { label: string })[];
            };
          }
          return resolveItem(child as SidebarItemDefinition, hiddenSidebarSet);
        })
        .filter(Boolean);

      return {
        ...section,
        title: getSidebarLabel(section.titleKey, section.titleFallback),
        children,
      };
    })
    .filter((section) => {
      const allItems = section.children.flatMap((child: any) =>
        child.type === "group" ? child.items : [child]
      );
      return allItems.length > 0;
    });

  const allVisibleItems = visibleSections.flatMap((section) =>
    section.children.flatMap((child: any) => (child.type === "group" ? child.items : [child]))
  );
  const isShortMenu = allVisibleItems.length <= SHORT_MENU_MAX_ITEMS;

  const activeHref = getActiveSidebarHref(pathname, allVisibleItems);

  const isSearching = searchQuery.trim().length > 0;
  const displaySections = isSearching
    ? filterSidebarSectionsByQuery(visibleSections, searchQuery)
    : visibleSections;

  // Keep the active page visible while preserving accordion semantics for unpinned sections.
  useEffect(() => {
    if (collapsed || !sidebarExpansionLoaded) return;
    if (skipInitialActiveExpansion.current) {
      skipInitialActiveExpansion.current = false;
      return;
    }
    for (const section of visibleSections) {
      const sectionItems = section.children.flatMap((child: any) =>
        child.type === "group" ? child.items : [child]
      );
      if (sectionItems.some((item: any) => !item.external && item.href === activeHref)) {
        setExpandedSections((prev) => {
          const next = expandActiveSection(pinnedSections, section.id as SidebarSectionId);
          if ([...next].every((id) => prev.has(id)) && next.size === prev.size) return prev;
          saveToStorage(EXPANDED_SECTIONS_KEY, [...next]);
          return next;
        });
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref, collapsed, pinnedSections, sidebarExpansionLoaded]);

  // Accordion toggle: opening a section closes all non-pinned sections
  const toggleSection = useCallback(
    (sectionId: SidebarSectionId) => {
      setExpandedSections((prev) => {
        const next = toggleExpandedSection(prev, pinnedSections, sectionId);
        saveToStorage(EXPANDED_SECTIONS_KEY, [...next]);
        return next;
      });
    },
    [pinnedSections]
  );

  const togglePin = useCallback((sectionId: SidebarSectionId) => {
    setPinnedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
        // Ensure the section is expanded when pinned
        setExpandedSections((prevExp) => {
          if (prevExp.has(sectionId)) return prevExp;
          const nextExp = new Set(prevExp);
          nextExp.add(sectionId);
          saveToStorage(EXPANDED_SECTIONS_KEY, [...nextExp]);
          return nextExp;
        });
      }
      saveToStorage(PINNED_SECTIONS_KEY, [...next]);
      return next;
    });
  }, []);

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await fetch("/api/restart", { method: "POST" });
    } catch (e) {
      // Expected to fail as server restarts
    }
    setIsRestarting(false);
    setShowRestartModal(false);
    setIsDisconnected(true);
    setTimeout(() => globalThis.location.reload(), 3000);
  };

  // Footer toggle: nothing hidden → offer the simple menu; anything hidden → offer everything.
  const isShowingAllMenus = hiddenSidebarItems.length === 0;
  const menuToggleLabel = isShowingAllMenus
    ? getSidebarLabel("simpleMenu", "Simple menu")
    : getSidebarLabel("showAllMenus", "Show all menus");
  const menuToggleHint = isShowingAllMenus
    ? getSidebarLabel("simpleMenuHint", "Show only the main pages")
    : getSidebarLabel("showAllMenusHint", "Show every page in the menu");

  const handleMenuModeToggle = async () => {
    const presetId: SidebarPresetId = isShowingAllMenus ? "minimal" : "all";
    const updates = {
      [HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]: getSidebarPresetHiddenItems(presetId),
      [SIDEBAR_PRESET_KEY]: presetId,
    };
    setIsSwitchingMenu(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent(SIDEBAR_SETTINGS_UPDATED_EVENT, { detail: updates }));
      } else {
        console.error("Failed to switch the sidebar menu:", res.statusText);
      }
    } catch (err) {
      console.error("Error switching the sidebar menu:", err);
    } finally {
      setIsSwitchingMenu(false);
    }
  };

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLElement>, id: string, label: string) => {
      if (!collapsed) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sidebarRect = sidebarRef.current?.getBoundingClientRect();
      setHoveredItem({
        id,
        label,
        x: (sidebarRect?.right ?? 64) + 8,
        y: rect.top + rect.height / 2,
      });
    },
    [collapsed]
  );

  const handleMouseLeave = useCallback(() => setHoveredItem(null), []);

  const renderNavLink = (item) => {
    const active = !item.external && activeHref === item.href;
    const className = cn(
      "group relative flex min-h-8 items-center gap-2.5 rounded-md text-sm transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      collapsed ? "mx-auto size-9 justify-center" : "px-2 py-1",
      active
        ? "bg-surface-2 font-medium text-text-main"
        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
    );
    const iconClassName = cn(
      "material-symbols-outlined shrink-0 text-[18px] transition-colors",
      active ? "fill-1 text-primary-text" : "text-text-muted group-hover:text-text-main"
    );
    const content = (
      <>
        {active && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute start-0 top-1/2 w-0.5 -translate-y-1/2 rounded-full bg-primary",
              collapsed ? "h-5" : "h-4"
            )}
          />
        )}
        <span className={iconClassName} aria-hidden="true">
          {item.icon}
        </span>
        {!collapsed && (
          <span className="truncate" title={item.subtitle || item.label}>
            {item.label}
          </span>
        )}
      </>
    );
    const sharedProps = {
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => handleMouseEnter(e, item.id, item.label),
      onMouseLeave: handleMouseLeave,
    };

    if (item.external) {
      return (
        <a
          key={item.href}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className={className}
          {...sharedProps}
        >
          {content}
        </a>
      );
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        prefetch={false}
        onClick={onClose}
        className={className}
        {...sharedProps}
      >
        {content}
      </Link>
    );
  };

  return (
    <>
      <aside
        ref={sidebarRef}
        className={cn(
          "flex h-full min-h-0 flex-col border-e border-border bg-sidebar transition-[width] duration-200 ease-out",
          collapsed ? "w-14" : "w-[232px]"
        )}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-control focus:bg-primary focus:p-3 focus:text-sm focus:text-on-primary"
        >
          {t("skipToContent")}
        </a>

        <div
          className={cn(
            "flex h-12 shrink-0 items-center gap-2 border-b border-border",
            collapsed ? "flex-col justify-center px-2 h-auto py-2" : "px-3"
          )}
        >
          <Link
            href="/home"
            prefetch={false}
            className={cn(
              "flex min-w-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              collapsed ? "justify-center" : "flex-1 gap-2"
            )}
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-on-primary">
              {customLogo ? (
                <img
                  src={customLogo}
                  alt={customAppName || APP_CONFIG.name}
                  className="size-4 object-contain"
                />
              ) : (
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                  alt_route
                </span>
              )}
            </div>
            {!collapsed && (
              <div className="flex min-w-0 flex-col leading-tight">
                <h1
                  className="truncate text-sm font-semibold tracking-tight text-text-main"
                  title={customAppName || APP_CONFIG.name}
                >
                  {customAppName || APP_CONFIG.name}
                </h1>
                <span className="truncate text-[11px] text-text-muted">
                  {APP_CONFIG.description}
                </span>
              </div>
            )}
          </Link>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                {collapsed ? "left_panel_open" : "left_panel_close"}
              </span>
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="px-3 pb-2 pt-3">
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tc("search")}
              aria-label={tc("search")}
              icon="search"
              className="gap-0"
              inputClassName="py-1.5 text-xs"
            />
          </div>
        )}

        <nav
          aria-label={t("mainNavigation")}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto pb-3 custom-scrollbar",
            collapsed ? "space-y-0.5 px-2 pt-2" : "px-3 pt-1"
          )}
        >
          {sidebarSettingsLoaded && isSearching && displaySections.length === 0 && (
            <p className="px-2 py-3 text-xs text-text-muted">{tc("noResults")}</p>
          )}
          {(sidebarSettingsLoaded ? displaySections : []).map((section, idx) => {
            const sectionId = section.id as SidebarSectionId;
            const isExpanded = isSearching || isShortMenu || expandedSections.has(sectionId);
            const isPinned = pinnedSections.has(sectionId);
            const isFirst = idx === 0;
            const sectionItems = section.children.flatMap((child: any) =>
              child.type === "group" ? child.items : [child]
            );

            // Collapsed (mini) mode: flat items with dividers between sections
            if (collapsed) {
              return (
                <div key={section.id}>
                  {!isFirst && <div className="mx-1 my-2 border-t border-border" />}
                  {sectionItems.map(renderNavLink)}
                </div>
              );
            }

            // Sections without a visible title (e.g. Home) render items directly
            if (section.showTitle === false) {
              return (
                <div key={section.id} className={cn("space-y-0.5", !isFirst && "mt-4")}>
                  {sectionItems.map(renderNavLink)}
                </div>
              );
            }

            // Expanded mode: collapsible section with pin (short menus: plain, always-open heading)
            return (
              <div key={section.id} className={isFirst ? "space-y-0.5" : "mt-4"}>
                {isShortMenu ? (
                  <div className="truncate px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                    {section.title}
                  </div>
                ) : (
                  <div
                    className="group/header flex cursor-pointer items-center gap-0.5 rounded-md px-2 py-1 transition-colors hover:bg-surface-2"
                    onClick={() => toggleSection(sectionId)}
                    role="button"
                    aria-expanded={isExpanded}
                  >
                    <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-text-muted transition-colors group-hover/header:text-text-main">
                      {section.title}
                    </span>

                    {/* Pin button — right side near chevron */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(sectionId);
                      }}
                      title={isPinned ? t("unpinSection") : t("pinSectionOpen")}
                      className={cn(
                        "shrink-0 rounded p-0.5 transition-opacity",
                        isPinned
                          ? "text-primary-text opacity-100"
                          : "text-text-muted/60 opacity-0 hover:text-text-main group-hover/header:opacity-100"
                      )}
                    >
                      <span
                        className="material-symbols-outlined"
                        style={{
                          fontSize: "12px",
                          ...(isPinned ? { fontVariationSettings: "'FILL' 1" } : {}),
                        }}
                      >
                        push_pin
                      </span>
                    </button>

                    <span
                      className={cn(
                        "material-symbols-outlined shrink-0 text-[16px] text-text-muted/60 transition-transform duration-200 group-hover/header:text-text-muted",
                        isExpanded && "rotate-180"
                      )}
                    >
                      expand_more
                    </span>
                  </div>
                )}

                {isExpanded && (
                  <div className="mt-0.5 space-y-0.5">
                    {section.children.map((child: any) => {
                      if (child.type === "group") {
                        if (child.items.length === 0) return null;
                        const separatorHidden = child.separatorHidden === true;
                        return (
                          <div key={child.id} className={separatorHidden ? "mt-0.5" : "mt-3"}>
                            {!separatorHidden && (
                              <div className="mb-0.5 flex items-center gap-2 px-2 py-0.5">
                                <span className="truncate text-[11px] font-medium text-text-muted">
                                  {child.title}
                                </span>
                              </div>
                            )}
                            {child.items.map(renderNavLink)}
                          </div>
                        );
                      }
                      return renderNavLink(child);
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border p-2">
          <button
            type="button"
            onClick={handleMenuModeToggle}
            disabled={!sidebarSettingsLoaded || isSwitchingMenu}
            aria-busy={isSwitchingMenu}
            title={collapsed ? menuToggleLabel : menuToggleHint}
            aria-label={collapsed ? menuToggleLabel : undefined}
            className={cn(
              "flex min-h-8 items-center gap-2 rounded-md text-xs font-medium transition-colors disabled:opacity-50",
              "text-text-muted hover:bg-surface-2 hover:text-text-main",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              collapsed ? "mx-auto size-9 justify-center" : "w-full px-2",
              !sidebarSettingsLoaded && "invisible"
            )}
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              {isShowingAllMenus ? "unfold_less" : "unfold_more"}
            </span>
            {!collapsed && <span className="truncate">{menuToggleLabel}</span>}
          </button>
          <div className={collapsed ? "flex flex-col gap-1" : "flex items-center gap-2"}>
            {!collapsed && (
              <span className="flex-1 truncate px-2 text-[11px] tabular-nums text-text-muted">
                {APP_CONFIG.name} v{APP_CONFIG.version}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowRestartModal(true)}
              title={t("restart")}
              aria-label={t("restart")}
              className={cn(
                "flex min-h-8 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors",
                "text-text-muted hover:bg-surface-2 hover:text-text-main",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                collapsed ? "mx-auto size-9" : "px-2"
              )}
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                restart_alt
              </span>
              {!collapsed && <span>{t("restart")}</span>}
            </button>
          </div>
          {!collapsed && <BrandCredit className="px-2" />}
        </div>
      </aside>

      {/* Styled tooltip for collapsed (mini) sidebar */}
      {collapsed && hoveredItem && (
        <div
          className="fixed z-[200] pointer-events-none flex items-center"
          style={{ left: hoveredItem.x, top: hoveredItem.y, transform: "translateY(-50%)" }}
        >
          <div className="whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-text-main shadow-elevated">
            {hoveredItem.label}
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={showRestartModal}
        onClose={() => setShowRestartModal(false)}
        onConfirm={handleRestart}
        title={t("restart")}
        message={t("restartConfirm")}
        confirmText={t("restart")}
        cancelText={tc("cancel")}
        variant="warning"
        loading={isRestarting}
      />

      {isDisconnected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center p-8">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-error/15 text-error">
              <span className="material-symbols-outlined text-[28px]" aria-hidden="true">
                power_off
              </span>
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">{t("serverDisconnected")}</h2>
            <p className="mb-6 text-sm text-zinc-400">{t("serverDisconnectedMsg")}</p>
            <Button variant="secondary" onClick={() => globalThis.location.reload()}>
              {t("reloadPage")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
