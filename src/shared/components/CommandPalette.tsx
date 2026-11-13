"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  SIDEBAR_SECTIONS,
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  normalizeHiddenSidebarItems,
  type SidebarItemDefinition,
  type SidebarSectionChild,
} from "@/shared/constants/sidebarVisibility";

function isSidebarGroup(
  child: SidebarSectionChild
): child is Extract<SidebarSectionChild, { type: "group" }> {
  return "type" in child && child.type === "group";
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  if (!isOpen) return null;
  return <CommandPaletteDialog onClose={onClose} />;
}

interface PaletteItem {
  id: string;
  href: string;
  icon: string;
  label: string;
  subtitle?: string;
  external: boolean;
  sectionId: string;
  sectionLabel: string;
  subgroupId?: string;
  subgroupLabel?: string;
}

interface PaletteSubgroup {
  subgroupId: string | null;
  subgroupLabel: string | null;
  items: { item: PaletteItem; flatIndex: number }[];
}

interface PaletteGroup {
  sectionId: string;
  sectionLabel: string;
  subgroups: PaletteSubgroup[];
}

function CommandPaletteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const t = useTranslations("sidebar");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hiddenItems, setHiddenItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/settings", { signal: ctrl.signal })
      .then((res) => res.json())
      .then((data) => {
        setHiddenItems(
          new Set(normalizeHiddenSidebarItems(data?.[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]))
        );
      })
      .catch(() => {
        // ignore aborts and fetch failures; palette still works with empty hidden set
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);

  const safeTranslate = useCallback(
    (key: string, fallback: string) => {
      try {
        return t(key);
      } catch {
        return fallback;
      }
    },
    [t]
  );

  const allItems = useMemo<PaletteItem[]>(
    () =>
      SIDEBAR_SECTIONS.flatMap((section) => {
        const sectionLabel = safeTranslate(section.titleKey, section.titleFallback);
        return section.children.flatMap<PaletteItem>((child) => {
          if (isSidebarGroup(child)) {
            const subgroupLabel = safeTranslate(child.titleKey, child.titleFallback);
            return child.items
              .filter((item) => !hiddenItems.has(item.id))
              .map<PaletteItem>((item) => ({
                id: item.id,
                href: item.href,
                icon: item.icon,
                label: safeTranslate(item.i18nKey, item.id),
                subtitle: item.subtitleKey ? safeTranslate(item.subtitleKey, "") : undefined,
                external: item.external ?? false,
                sectionId: section.id,
                sectionLabel,
                subgroupId: child.id,
                subgroupLabel,
              }));
          }
          const item = child as SidebarItemDefinition;
          if (hiddenItems.has(item.id)) return [];
          return [
            {
              id: item.id,
              href: item.href,
              icon: item.icon,
              label: safeTranslate(item.i18nKey, item.id),
              subtitle: item.subtitleKey ? safeTranslate(item.subtitleKey, "") : undefined,
              external: item.external ?? false,
              sectionId: section.id,
              sectionLabel,
            },
          ];
        });
      }),
    [hiddenItems, safeTranslate]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allItems;
    return allItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.sectionLabel.toLowerCase().includes(q) ||
        item.subgroupLabel?.toLowerCase().includes(q)
    );
  }, [allItems, query]);

  const grouped = useMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [];
    const sectionById = new Map<string, PaletteGroup>();
    filtered.forEach((item, flatIndex) => {
      // Look up the section/subgroup by id across the whole list, not just the
      // previous item — a section's children can interleave root items and
      // groups (e.g. "router" has a trailing root item after its groups),
      // which would otherwise produce two separate "_root" subgroups sharing
      // the same React key.
      let section = sectionById.get(item.sectionId);
      if (!section) {
        section = {
          sectionId: item.sectionId,
          sectionLabel: item.sectionLabel,
          subgroups: [],
        };
        sectionById.set(item.sectionId, section);
        groups.push(section);
      }
      const itemSubgroupId = item.subgroupId ?? null;
      let subgroup = section.subgroups.find((sg) => sg.subgroupId === itemSubgroupId);
      if (!subgroup) {
        subgroup = {
          subgroupId: itemSubgroupId,
          subgroupLabel: item.subgroupLabel ?? null,
          items: [],
        };
        section.subgroups.push(subgroup);
      }
      subgroup.items.push({ item, flatIndex });
    });
    return groups;
  }, [filtered]);

  const handleNavigate = useCallback(
    (href: string, external: boolean) => {
      onClose();
      if (external) {
        window.open(href, "_blank", "noopener,noreferrer");
      } else {
        router.push(href);
      }
    },
    [onClose, router]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length)
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[selectedIndex];
        if (item) {
          handleNavigate(item.href, item.external);
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [filtered, selectedIndex, onClose, handleNavigate]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-flat-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-card border border-border bg-surface shadow-elevated"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
          <span
            className="material-symbols-outlined shrink-0 text-[18px] text-text-muted"
            aria-hidden="true"
          >
            search
          </span>
          <input
            ref={inputRef}
            type="text"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-main outline-none placeholder:text-text-muted"
            placeholder="Search pages, settings, tools..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="flex size-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
              onClick={() => {
                setQuery("");
                setSelectedIndex(0);
              }}
              tabIndex={-1}
              aria-label="Clear search"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                close
              </span>
            </button>
          )}
          <kbd className="hidden h-5 shrink-0 items-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium text-text-muted sm:inline-flex">
            Esc
          </kbd>
        </div>

        {grouped.length > 0 ? (
          <ul
            ref={listRef}
            className="custom-scrollbar max-h-[60vh] overflow-y-auto p-1.5"
            role="listbox"
          >
            {grouped.map((group) => (
              <li key={group.sectionId} role="presentation">
                <div className="sticky top-0 z-10 bg-surface px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  {group.sectionLabel}
                </div>
                <ul role="group" aria-label={group.sectionLabel}>
                  {group.subgroups.map((subgroup) => (
                    <li
                      key={`${group.sectionId}::${subgroup.subgroupId ?? "_root"}`}
                      role="presentation"
                    >
                      {subgroup.subgroupLabel && (
                        <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-text-muted">
                          {subgroup.subgroupLabel}
                        </div>
                      )}
                      <ul
                        role={subgroup.subgroupLabel ? "group" : "presentation"}
                        aria-label={subgroup.subgroupLabel ?? undefined}
                      >
                        {subgroup.items.map(({ item, flatIndex }) => (
                          <li
                            key={item.id}
                            role="option"
                            aria-selected={flatIndex === selectedIndex}
                            data-flat-index={flatIndex}
                          >
                            <button
                              type="button"
                              className={`flex min-h-9 w-full items-center gap-2.5 rounded-md ${
                                subgroup.subgroupLabel ? "ps-6 pe-2.5" : "px-2.5"
                              } py-1.5 text-start transition-colors ${
                                flatIndex === selectedIndex
                                  ? "bg-surface-2 text-text-main"
                                  : "text-text-main hover:bg-surface-2"
                              }`}
                              onClick={() => handleNavigate(item.href, item.external)}
                              onMouseEnter={() => setSelectedIndex(flatIndex)}
                            >
                              <span
                                className={`material-symbols-outlined text-[18px] shrink-0 ${
                                  flatIndex === selectedIndex
                                    ? "text-primary-text"
                                    : "text-text-muted"
                                }`}
                                aria-hidden="true"
                              >
                                {item.icon}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="truncate text-sm">{item.label}</p>
                                {item.subtitle && (
                                  <p className="truncate text-xs text-text-muted">
                                    {item.subtitle}
                                  </p>
                                )}
                              </div>
                              {item.external && (
                                <span
                                  className="material-symbols-outlined shrink-0 text-[14px] text-text-muted"
                                  aria-hidden="true"
                                >
                                  open_in_new
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <div className="py-10 text-center text-sm text-text-muted">No results</div>
        )}

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium">
              ↵
            </kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="inline-flex h-5 items-center rounded border border-border bg-surface-2 px-1.5 font-sans text-[10px] font-medium">
              Esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
