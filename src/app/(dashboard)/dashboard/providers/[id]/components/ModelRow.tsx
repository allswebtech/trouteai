"use client";
/**
 * ModelRow
 *
 * Extracted from ProviderDetailPageClient.tsx. Contains:
 *   - ModelSourceBadge (tiny utility)
 *   - ModelVisibilityToolbar (filter/test toolbar)
 *   - ModelRow (catalog model row with compat controls)
 *
 * Leaf component: imports from shared, leaf helpers, and sibling components.
 * Never imports from ProviderDetailPageClient.
 */
import React, { useState, useRef, useEffect } from "react";
import {
  getModelCatalogSourceLabel,
  normalizeModelCatalogSource,
} from "@/shared/utils/modelCatalogSearch";
import { providerText } from "../providerPageHelpers";
import ModelCompatPopover from "./ModelCompatPopover";
import ModelSwitch from "./ModelSwitch";

// ---------------------------------------------------------------------------
// Shared prop types
// ---------------------------------------------------------------------------

/** PATCH fields for provider model compat (matches API + `ModelCompatPerProtocol` shape). */
export type ModelCompatSavePatch = {
  normalizeToolCallId?: boolean;
  preserveOpenAIDeveloperRole?: boolean;
  upstreamHeaders?: Record<string, string>;
  compatByProtocol?: Record<
    string,
    {
      normalizeToolCallId?: boolean;
      preserveOpenAIDeveloperRole?: boolean;
      upstreamHeaders?: Record<string, string>;
    }
  >;
  isHidden?: boolean;
};

// ---------------------------------------------------------------------------
// ModelSourceBadge
// ---------------------------------------------------------------------------

function getModelSourceBadgeClass(source?: string): string {
  switch (normalizeModelCatalogSource(source)) {
    case "imported":
      return "border-info/30 bg-info/10 text-info";
    case "custom":
      return "border-success/30 bg-success/10 text-success";
    case "fallback":
      return "border-warning/30 bg-warning/10 text-warning";
    case "alias":
      return "border-primary/30 bg-primary/10 text-primary-text";
    case "system":
    default:
      return "border-border bg-sidebar/70 text-text-muted";
  }
}

export function ModelSourceBadge({ source }: { source?: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getModelSourceBadgeClass(
        source
      )}`}
    >
      {getModelCatalogSourceLabel(source)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ModelVisibilityToolbar
// ---------------------------------------------------------------------------

export interface ModelVisibilityToolbarProps {
  t: ((key: string, values?: Record<string, unknown>) => string) & {
    has?: (key: string) => boolean;
  };
  filterValue: string;
  onFilterChange: (value: string) => void;
  activeCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  selectAllDisabled?: boolean;
  deselectAllDisabled?: boolean;
  onTestAll?: () => void;
  testingAll?: boolean;
  testProgress?: { done: number; total: number } | null;
  visibilityFilter?: "all" | "visible" | "hidden";
  onVisibilityFilterChange?: (filter: "all" | "visible" | "hidden") => void;
  autoHideFailed?: boolean;
  onAutoHideFailedChange?: (v: boolean) => void;
  freeFilter?: "all" | "free" | "paid";
  onFreeFilterChange?: (filter: "all" | "free" | "paid") => void;
  sortFreeFirst?: boolean;
  onSortFreeFirstChange?: (v: boolean) => void;
}

export function ModelVisibilityToolbar({
  t,
  filterValue,
  onFilterChange,
  activeCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  selectAllDisabled,
  deselectAllDisabled,
  onTestAll,
  testingAll,
  testProgress,
  visibilityFilter,
  onVisibilityFilterChange,
  autoHideFailed,
  onAutoHideFailedChange,
  freeFilter,
  onFreeFilterChange,
  sortFreeFirst,
  onSortFreeFirstChange,
}: ModelVisibilityToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const hasMore = Boolean(
    (freeFilter !== undefined && onFreeFilterChange) ||
    onSortFreeFirstChange ||
    onAutoHideFailedChange ||
    onTestAll
  );

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1">
        <span
          className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[15px] text-text-muted"
          aria-hidden="true"
        >
          search
        </span>
        <input
          type="text"
          value={filterValue}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={providerText(t, "filterModels", "Filter models…")}
          aria-label={providerText(t, "filterModels", "Filter models…")}
          className="w-full rounded-lg border border-border bg-sidebar/50 py-1.5 pl-7 pr-3 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      {visibilityFilter !== undefined && onVisibilityFilterChange && (
        <div
          role="group"
          aria-label={providerText(t, "modelOnOff", "Model on/off")}
          className="flex items-center gap-1 rounded-lg border border-border bg-sidebar/50 p-0.5"
        >
          {(["all", "visible", "hidden"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={visibilityFilter === f}
              onClick={() => onVisibilityFilterChange(f)}
              className={`rounded px-2 py-1 text-xs ${
                visibilityFilter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {f === "all"
                ? providerText(t, "modelFilterAll", "All")
                : f === "visible"
                  ? providerText(t, "modelFilterOn", "On")
                  : providerText(t, "modelFilterOff", "Off")}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onSelectAll}
        disabled={selectAllDisabled}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 py-1 text-[12px] text-text-main disabled:cursor-not-allowed disabled:opacity-50"
        title={providerText(t, "allModelsOn", "All on")}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          toggle_on
        </span>
        <span>{providerText(t, "allModelsOn", "All on")}</span>
      </button>
      <button
        type="button"
        onClick={onDeselectAll}
        disabled={deselectAllDisabled}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 py-1 text-[12px] text-text-main disabled:cursor-not-allowed disabled:opacity-50"
        title={providerText(t, "allModelsOff", "All off")}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          toggle_off
        </span>
        <span>{providerText(t, "allModelsOff", "All off")}</span>
      </button>
      {hasMore && (
        <div ref={moreRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 py-1 text-[12px] text-text-main"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              {testingAll ? "progress_activity" : "tune"}
            </span>
            <span>
              {testingAll && testProgress
                ? providerText(t, "testingAllModels", "Testing {done}/{total}", testProgress)
                : providerText(t, "modelsMore", "More")}
            </span>
          </button>
          {moreOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 flex w-60 flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-elevated"
            >
              {onTestAll && (
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    setMoreOpen(false);
                    onTestAll();
                  }}
                  disabled={testingAll}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 py-1 text-[12px] text-text-main disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    science
                  </span>
                  <span>{providerText(t, "testAllModels", "Test all")}</span>
                </button>
              )}
              {onAutoHideFailedChange && (
                <label
                  className="flex items-center gap-1.5 text-xs text-text-muted"
                  title={providerText(
                    t,
                    "autoHideFailedHint",
                    "When enabled, Test all turns off non-transient failures so they disappear from /v1/models. Single-model tests never auto-turn-off."
                  )}
                >
                  <input
                    type="checkbox"
                    checked={autoHideFailed ?? false}
                    onChange={(e) => onAutoHideFailedChange(e.target.checked)}
                    className="rounded border-border bg-sidebar"
                  />
                  {providerText(t, "hideFailedAuto", "Auto-hide failed")}
                </label>
              )}
              {freeFilter !== undefined && onFreeFilterChange && (
                <div
                  role="group"
                  aria-label={providerText(t, "freeFilterGroup", "Price")}
                  className="flex items-center gap-1 rounded-lg border border-border bg-sidebar/50 p-0.5"
                >
                  {(["all", "free", "paid"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={freeFilter === f}
                      onClick={() => onFreeFilterChange(f)}
                      className={`flex-1 rounded px-2 py-1 text-xs ${
                        freeFilter === f
                          ? "bg-primary text-primary-foreground"
                          : "text-text-muted hover:text-text-main"
                      }`}
                    >
                      {f === "all"
                        ? providerText(t, "freeFilterAll", "All")
                        : f === "free"
                          ? providerText(t, "freeFilterFreeOnly", "Free only")
                          : providerText(t, "freeFilterPaidOnly", "Paid only")}
                    </button>
                  ))}
                </div>
              )}
              {onSortFreeFirstChange && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!!sortFreeFirst}
                  onClick={() => onSortFreeFirstChange(!sortFreeFirst)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] ${
                    sortFreeFirst
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-transparent text-text-main"
                  }`}
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    sort
                  </span>
                  <span>{providerText(t, "sortFreeFirst", "Free first")}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <span className="whitespace-nowrap text-xs text-text-muted">
        {providerText(t, "modelsActiveCount", "{active}/{total} active", {
          active: activeCount,
          total: totalCount,
        })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelRow
// ---------------------------------------------------------------------------

export interface ModelRowProps {
  model: { id: string; name?: string; source?: string; isHidden?: boolean };
  fullModel: string;
  provider: string;
  alias?: string;
  copied?: string;
  onCopy: (text: string, key: string) => void;
  onSetAlias?: (alias: string) => void;
  onDeleteAlias?: () => void;
  t: (key: string, values?: Record<string, unknown>) => string;
  showDeveloperToggle?: boolean;
  effectiveModelNormalize: (modelId: string, protocol?: string) => boolean;
  effectiveModelPreserveDeveloper: (modelId: string, protocol?: string) => boolean;
  saveModelCompatFlags: (modelId: string, patch: ModelCompatSavePatch) => void;
  getUpstreamHeadersRecord: (protocol: string) => Record<string, string>;
  compatDisabled?: boolean;
  onToggleHidden?: (modelId: string, hidden: boolean) => Promise<void>;
  togglingHidden?: boolean;
  onTestModel?: (modelId: string, fullModel: string) => Promise<void>;
  testStatus?: "ok" | "error" | null;
  testingModel?: boolean;
}

export default function ModelRow({
  model,
  fullModel,
  provider,
  alias,
  copied,
  onCopy,
  onSetAlias,
  onDeleteAlias,
  t,
  showDeveloperToggle = true,
  effectiveModelNormalize,
  effectiveModelPreserveDeveloper,
  getUpstreamHeadersRecord,
  saveModelCompatFlags,
  compatDisabled,
  onToggleHidden,
  togglingHidden,
  onTestModel,
  testStatus,
  testingModel,
}: ModelRowProps) {
  const isHidden = Boolean(model.isHidden);
  const [editing, setEditing] = useState(false);
  const [aliasValue, setAliasValue] = useState(alias || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = () => {
    setAliasValue(alias || "");
    setEditing(true);
  };

  const handleAliasSubmit = () => {
    const trimmed = aliasValue.trim();
    if (trimmed && trimmed !== alias) {
      onSetAlias?.(trimmed);
    } else if (!trimmed && alias) {
      onDeleteAlias?.();
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAliasSubmit();
    }
    if (e.key === "Escape") {
      setAliasValue(alias || "");
      setEditing(false);
    }
  };

  return (
    <div className="flex min-w-[220px] max-w-md items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-sidebar/50">
      <div
        className={`flex min-w-0 flex-1 flex-wrap items-center gap-2 transition-opacity ${
          isHidden ? "opacity-50" : ""
        }`}
      >
        <span
          className="material-symbols-outlined shrink-0 text-base"
          style={{ color: isHidden ? "var(--color-text-muted)" : undefined }}
        >
          smart_toy
        </span>
        <code className="rounded bg-sidebar px-1.5 py-0.5 font-mono text-xs text-text-muted">
          {fullModel}
        </code>
        <ModelSourceBadge source={model.source} />
        {onSetAlias && (
          <span className="flex min-w-0 items-center text-[10px] gap-1">
            {editing ? (
              <input
                ref={inputRef}
                type="text"
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                onBlur={handleAliasSubmit}
                onKeyDown={handleKeyDown}
                placeholder={providerText(t, "aliasInputPlaceholder", "alias name")}
                className="bg-surface border border-primary/50 rounded px-1 py-0.5 text-[10px] text-text-main outline-none w-24"
              />
            ) : (
              <span
                className={`truncate text-[10px] italic cursor-pointer hover:text-primary transition-colors ${alias ? "text-primary/80" : "text-text-muted"}`}
                onClick={startEditing}
                title={
                  alias
                    ? providerText(t, "clickToEditAlias", "Alias: {alias} (click to edit)", {
                        alias,
                      })
                    : providerText(t, "clickToSetAlias", "Click to set alias")
                }
              >
                {alias || model.name || providerText(t, "clickToSetAlias", "Click to set alias")}
              </span>
            )}
          </span>
        )}
        <button
          onClick={() => onCopy(fullModel, `model-${model.id}`)}
          className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
          title={t("copyModel")}
        >
          <span className="material-symbols-outlined text-sm">
            {copied === `model-${model.id}` ? "check" : "content_copy"}
          </span>
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onTestModel && (
          <button
            onClick={() => onTestModel(model.id, fullModel)}
            disabled={testingModel}
            className={`rounded p-0.5 hover:bg-sidebar transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${testStatus === "ok" ? "text-success" : testStatus === "error" ? "text-error" : "text-text-muted hover:text-primary"}`}
            title={
              testingModel
                ? t("testingModel")
                : testStatus === "ok"
                  ? "OK"
                  : testStatus === "error"
                    ? "Error"
                    : t("testModel")
            }
          >
            {testingModel ? (
              <span className="material-symbols-outlined text-sm animate-spin">
                progress_activity
              </span>
            ) : testStatus === "ok" ? (
              <span className="material-symbols-outlined text-sm">check_circle</span>
            ) : testStatus === "error" ? (
              <span className="material-symbols-outlined text-sm">error</span>
            ) : (
              <span className="material-symbols-outlined text-sm">play_circle</span>
            )}
          </button>
        )}
        {onToggleHidden && (
          <ModelSwitch
            isOn={!isHidden}
            onToggle={() => onToggleHidden(model.id, !isHidden)}
            disabled={togglingHidden}
            label={providerText(t, "modelOnOff", "Model on/off")}
            title={
              isHidden
                ? providerText(t, "turnModelOn", "Turn on")
                : providerText(t, "turnModelOff", "Turn off")
            }
          />
        )}
        <ModelCompatPopover
          t={t}
          providerId={provider}
          modelId={model.id}
          effectiveModelNormalize={(p) => effectiveModelNormalize(model.id, p)}
          effectiveModelPreserveDeveloper={(p) => effectiveModelPreserveDeveloper(model.id, p)}
          getUpstreamHeadersRecord={getUpstreamHeadersRecord}
          onCompatPatch={(protocol, payload) =>
            saveModelCompatFlags(model.id, { compatByProtocol: { [protocol]: payload } })
          }
          showDeveloperToggle={showDeveloperToggle}
          disabled={compatDisabled}
        />
      </div>
    </div>
  );
}
