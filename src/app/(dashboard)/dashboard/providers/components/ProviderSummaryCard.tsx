"use client";

import { Button, Card, Input } from "@/shared/components";

import type { ProviderDisplayMode } from "../providerPageStorage";
import { CategoryDot } from "./CategoryDot";
import ProviderDisplayModeControl from "./ProviderDisplayModeControl";

type ProviderMessageTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

type SummaryStat = {
  configured: number;
  total: number;
};

export interface ProviderSummaryStats {
  all: SummaryStat;
  free: SummaryStat;
  noauth: SummaryStat;
  oauth: SummaryStat;
  apikey: SummaryStat;
  compatible: SummaryStat;
  webcookie: SummaryStat;
  search: SummaryStat;
  audio: SummaryStat;
  local: SummaryStat;
  upstreamproxy: SummaryStat;
  cloudagent: SummaryStat;
  ide: SummaryStat;
  webfetch: SummaryStat;
}

interface ProviderSummaryCardProps {
  activeCategory: string | null;
  activeServiceKind: string | null;
  onServiceKindChange(kind: string | null): void;
  disabledConfigured: boolean;
  displayMode: ProviderDisplayMode;
  modelSearchQuery: string;
  onBatchTest(mode: string): void;
  onCategoryChange(category: string | null, freeOnly: boolean): void;
  onDisplayModeChange(mode: ProviderDisplayMode): void;
  onNewProvider(): void;
  onImportFromFile(): void;
  searchQuery: string;
  setModelSearchQuery(value: string): void;
  setSearchQuery(value: string): void;
  showFreeOnly: boolean;
  summaryStats: ProviderSummaryStats;
  t: ProviderMessageTranslator;
  tc: ProviderMessageTranslator;
  testingMode: string | null;
  /** Whether the "Filters & tools" panel is open (owned by the page, remembered per browser). */
  toolsOpen: boolean;
  onToolsOpenChange(open: boolean): void;
}

function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) {
    return t(key, values);
  }
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

const SERVICE_KIND_CHIPS: Array<{ key: string; icon: string; labelKey: string; fallback: string }> =
  [
    { key: "image", icon: "image", labelKey: "serviceKindImage", fallback: "Image" },
    { key: "video", icon: "videocam", labelKey: "serviceKindVideo", fallback: "Video" },
    { key: "music", icon: "music_note", labelKey: "serviceKindMusic", fallback: "Music" },
    { key: "tts", icon: "record_voice_over", labelKey: "serviceKindTts", fallback: "Text→Speech" },
    { key: "stt", icon: "hearing", labelKey: "serviceKindStt", fallback: "Speech→Text" },
    {
      key: "embedding",
      icon: "scatter_plot",
      labelKey: "serviceKindEmbedding",
      fallback: "Embedding",
    },
  ];

export default function ProviderSummaryCard({
  activeCategory,
  activeServiceKind,
  onServiceKindChange,
  disabledConfigured,
  displayMode,
  modelSearchQuery,
  onBatchTest,
  onCategoryChange,
  onDisplayModeChange,
  onNewProvider,
  onImportFromFile,
  searchQuery,
  setModelSearchQuery,
  setSearchQuery,
  showFreeOnly,
  summaryStats,
  t,
  tc,
  testingMode,
  toolsOpen,
  onToolsOpenChange,
}: ProviderSummaryCardProps) {
  // The advanced controls live in the "Filters & tools" panel, collapsed by default. The
  // page owns the open/closed state (it also gates each section's "Test all" button).
  const toggleTools = () => onToolsOpenChange(!toolsOpen);

  const categories = [
    { key: null, color: null, label: t("providerSummaryAll"), stat: summaryStats.all },
    { key: "oauth", color: "bg-blue-500", label: t("oauthLabel"), stat: summaryStats.oauth },
    { key: "ide", color: "bg-cyan-500", label: "IDE", stat: summaryStats.ide },
    {
      key: "free",
      color: "bg-green-500",
      label: t("freeTier"),
      stat: summaryStats.free,
      title: t("freeAggregated"),
    },
    { key: "no-auth", color: "bg-stone-500", label: t("noAuthLabel"), stat: summaryStats.noauth },
    {
      key: "upstream-proxy",
      color: "bg-indigo-500",
      label: t("upstreamProxyLabel"),
      stat: summaryStats.upstreamproxy,
    },
    { key: "apikey", color: "bg-amber-500", label: t("apiKeyLabel"), stat: summaryStats.apikey },
    {
      key: "compatible",
      color: "bg-orange-500",
      label: t("compatibleLabel"),
      stat: summaryStats.compatible,
    },
    { key: "webcookie", color: "bg-purple-500", label: "Web Cookie", stat: summaryStats.webcookie },
    { key: "search", color: "bg-teal-500", label: "Search", stat: summaryStats.search },
    {
      key: "webfetch",
      color: "bg-orange-500",
      label: t("webFetch"),
      stat: summaryStats.webfetch,
      title: t("webFetchTooltip"),
    },
    { key: "audio", color: "bg-rose-500", label: "Audio", stat: summaryStats.audio },
    { key: "local", color: "bg-emerald-500", label: "Local", stat: summaryStats.local },
    {
      key: "cloudagent",
      color: "bg-violet-500",
      label: "Cloud Agent",
      stat: summaryStats.cloudagent,
    },
  ].filter(
    (category) =>
      !["no-auth", "upstream-proxy", "cloudagent"].includes(category.key) || category.stat.total > 0
  );

  // Filters that can hide providers. Counted on the toggle (and explained when the
  // panel is collapsed) so a closed panel never silently narrows the list.
  const activeFilterCount =
    (activeCategory || showFreeOnly ? 1 : 0) +
    (activeServiceKind ? 1 : 0) +
    (modelSearchQuery.trim() ? 1 : 0) +
    (displayMode !== "all" ? 1 : 0);

  const clearFilters = () => {
    onCategoryChange(null, false);
    onServiceKindChange(null);
    setModelSearchQuery("");
    onDisplayModeChange("all");
  };

  const searchPlaceholder = providerText(t, "searchAllProviders", "Search all providers…");
  const clearFiltersLabel = providerText(t, "clearFilters", "Clear filters");

  return (
    <Card padding="sm">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              icon="search"
              inputClassName={searchQuery ? "pr-9" : ""}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-text-muted hover:text-text-primary transition-colors"
                aria-label={tc("clear")}
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>
          <Button
            variant={toolsOpen ? "secondary" : "outline"}
            icon="tune"
            iconRight={toolsOpen ? "expand_less" : "expand_more"}
            onClick={toggleTools}
            aria-expanded={toolsOpen}
            data-testid="provider-tools-toggle"
          >
            {providerText(t, "filtersAndTools", "Filters & tools")}
            {activeFilterCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>

        {!toolsOpen && activeFilterCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="material-symbols-outlined text-[16px] text-primary" aria-hidden="true">
              filter_alt
            </span>
            <span>
              {providerText(
                t,
                "filtersActiveHint",
                "Some filters are on, so not every provider is shown."
              )}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {clearFiltersLabel}
            </button>
          </div>
        )}

        {toolsOpen && (
          <div
            className="flex flex-col gap-3 border-t border-border pt-3"
            data-testid="provider-tools-panel"
          >
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative flex-1 min-w-[160px]">
                <Input
                  value={modelSearchQuery}
                  onChange={(e) => setModelSearchQuery(e.target.value)}
                  placeholder={t("searchByModel") || "Search by model…"}
                  aria-label={t("searchByModel") || "Search by model"}
                  icon="psychology"
                  inputClassName={modelSearchQuery ? "pr-9" : ""}
                />
                {modelSearchQuery && (
                  <button
                    onClick={() => setModelSearchQuery("")}
                    className="absolute inset-y-0 right-0 flex items-center pr-2.5 text-text-muted hover:text-text-primary transition-colors"
                    aria-label={tc("clear")}
                  >
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                )}
              </div>
              <ProviderDisplayModeControl
                disabledConfigured={disabledConfigured}
                mode={displayMode}
                onChange={onDisplayModeChange}
                t={t}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon="checklist" onClick={onNewProvider}>
                {providerText(t, "stepByStepSetup", "Step-by-step setup")}
              </Button>
              <Button size="sm" variant="secondary" icon="upload_file" onClick={onImportFromFile}>
                {providerText(t, "importFromFile", "Import from file")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="play_arrow"
                loading={testingMode === "all"}
                disabled={!!testingMode}
                onClick={() => onBatchTest("all")}
                title={t("testAll")}
              >
                {testingMode === "all" ? t("testing") : t("testAll")}
              </Button>
              {activeFilterCount > 0 && (
                <Button size="sm" variant="ghost" icon="filter_alt_off" onClick={clearFilters}>
                  {clearFiltersLabel}
                </Button>
              )}
            </div>

            <div className="border-t border-border pt-3 flex flex-wrap items-center gap-2">
              {categories.map((cat) => {
                const isActive =
                  (cat.key === null && !activeCategory && !showFreeOnly) ||
                  (cat.key === "free" && showFreeOnly) ||
                  (cat.key !== "free" &&
                    cat.key !== null &&
                    !showFreeOnly &&
                    activeCategory === cat.key);
                return (
                  <button
                    key={cat.key ?? "all"}
                    onClick={() => onCategoryChange(cat.key, cat.key === "free")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-on-primary border-primary"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/30"
                    }`}
                    title={cat.title || cat.label}
                  >
                    {cat.color && <CategoryDot color={cat.color} label={cat.label} />}
                    <span>{cat.label}</span>
                    <span
                      className={`text-[11px] ${isActive ? "text-on-primary/80" : "text-text-muted"}`}
                    >
                      {cat.stat.configured}
                      <span className="opacity-70">/{cat.stat.total}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="border-t border-border pt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted mr-1">
                {providerText(t, "filterByMedia", "Media")}
              </span>
              {SERVICE_KIND_CHIPS.map((chip) => {
                const isActive = activeServiceKind === chip.key;
                return (
                  <button
                    key={chip.key}
                    onClick={() => onServiceKindChange(isActive ? null : chip.key)}
                    aria-pressed={isActive}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-on-primary border-primary"
                        : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/30"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]">{chip.icon}</span>
                    <span>{providerText(t, chip.labelKey, chip.fallback)}</span>
                  </button>
                );
              })}
              {activeServiceKind && (
                <button
                  onClick={() => onServiceKindChange(null)}
                  className="text-[11px] text-text-muted hover:text-text-primary underline-offset-2 hover:underline"
                >
                  {providerText(t, "clearMediaFilter", "Clear")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
