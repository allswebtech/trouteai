"use client";

/**
 * FilterBar — Shared UI primitive (T-29)
 *
 * Reusable filter bar with search input and optional filter chips.
 * Used by RequestLoggerV2, ProxyLogger, and similar data tables.
 *
 * Usage:
 *   <FilterBar
 *     searchValue={search}
 *     onSearchChange={setSearch}
 *     placeholder="Search logs..."
 *     filters={[
 *       { key: 'status', label: 'Status', options: ['ok', 'error'] },
 *       { key: 'provider', label: 'Provider', options: ['openai', 'anthropic'] },
 *     ]}
 *     activeFilters={activeFilters}
 *     onFilterChange={(key, value) => setFilters({ ...filters, [key]: value })}
 *   />
 */

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";

export default function FilterBar({
  searchValue = "",
  onSearchChange,
  placeholder,
  filters = [],
  activeFilters = {},
  onFilterChange,
  children,
}) {
  const t = useTranslations("common");
  const [expandedFilter, setExpandedFilter] = useState(null);

  const handleClear = useCallback(() => {
    onSearchChange("");
    filters.forEach((f) => onFilterChange(f.key, ""));
    setExpandedFilter(null);
  }, [onSearchChange, filters, onFilterChange]);

  const hasActiveFilters = searchValue || Object.values(activeFilters).some((v) => v && v !== "");

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {/* Search input */}
      <div className="relative min-w-[200px] flex-[1_1_200px]">
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder || t("search")}
          className="h-8 w-full rounded-control border border-border bg-surface ps-8 pe-3 text-[13px] text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        <span
          className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
          aria-hidden="true"
        >
          search
        </span>
      </div>

      {/* Filter chips */}
      {filters.map((filter) => (
        <div key={filter.key} className="relative">
          <button
            onClick={() => setExpandedFilter(expandedFilter === filter.key ? null : filter.key)}
            className={
              activeFilters[filter.key]
                ? "inline-flex h-8 cursor-pointer items-center whitespace-nowrap rounded-control border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary-text"
                : "inline-flex h-8 cursor-pointer items-center whitespace-nowrap rounded-control border border-border bg-surface px-3 text-xs text-text-muted hover:bg-surface-2 hover:text-text-main"
            }
          >
            {filter.label}
            {activeFilters[filter.key] ? ` · ${activeFilters[filter.key]}` : ""}
          </button>
          {expandedFilter === filter.key && (
            <div className="absolute start-0 top-full z-50 mt-1 min-w-[140px] rounded-control border border-border bg-surface p-1 shadow-elevated">
              <button
                onClick={() => {
                  onFilterChange(filter.key, "");
                  setExpandedFilter(null);
                }}
                className="block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-start text-xs text-text-muted hover:bg-surface-2 hover:text-text-main"
              >
                {t("all")}
              </button>
              {(filter.options || []).map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    onFilterChange(filter.key, opt);
                    setExpandedFilter(null);
                  }}
                  className={
                    activeFilters[filter.key] === opt
                      ? "block w-full cursor-pointer rounded-md bg-primary/10 px-2.5 py-1.5 text-start text-xs font-medium text-primary-text"
                      : "block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-start text-xs text-text-main hover:bg-surface-2"
                  }
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Clear all */}
      {hasActiveFilters && (
        <button
          onClick={handleClear}
          className="inline-flex h-8 cursor-pointer items-center rounded-control px-3 text-xs font-medium text-error transition-colors hover:bg-error/10"
        >
          {t("clear")}
        </button>
      )}

      {/* Extra controls (e.g. refresh button) */}
      {children}
    </div>
  );
}
