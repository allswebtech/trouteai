"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Card, Button, EmptyState } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useTranslations } from "next-intl";
import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import CacheEntriesTab from "./components/CacheEntriesTab";
import ReasoningCacheTab from "./components/ReasoningCacheTab";

interface SemanticCacheStats {
  memoryEntries: number;
  dbEntries: number;
  hits: number;
  misses: number;
  hitRate: string;
  tokensSaved: number;
}

interface PromptCacheProviderStats {
  requests: number;
  totalRequests?: number;
  cachedRequests?: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

interface PromptCacheMetrics {
  totalRequests: number;
  requestsWithCacheControl: number;
  totalInputTokens: number;
  totalCachedTokens: number;
  totalCacheCreationTokens: number;
  tokensSaved: number;
  estimatedCostSaved: number;
  byProvider: Record<string, PromptCacheProviderStats>;
  byStrategy: Record<string, PromptCacheProviderStats>;
  lastUpdated: string;
}

interface IdempotencyStats {
  activeKeys: number;
  windowMs: number;
}

interface CacheTrendPoint {
  timestamp: string;
  requests: number;
  cachedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
}

interface CacheConfig {
  semanticCacheEnabled: boolean;
}

interface CacheStats {
  semanticCache: SemanticCacheStats;
  promptCache: PromptCacheMetrics | null;
  trend: CacheTrendPoint[];
  idempotency: IdempotencyStats;
  config?: CacheConfig;
}

type CacheView = "prompt" | "semantic" | "reasoning";

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
        <span className="material-symbols-outlined text-[18px] leading-none" aria-hidden="true">
          {icon}
        </span>
        <span className="truncate" title={label}>
          {label}
        </span>
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-text-main">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

function SectionBadge({
  icon,
  children,
  tone = "neutral",
}: {
  icon: string;
  children: ReactNode;
  tone?: "neutral" | "green" | "amber";
}) {
  const toneClass =
    tone === "green"
      ? "border-success/20 bg-success/10 text-success"
      : tone === "amber"
        ? "border-warning/20 bg-warning/10 text-warning"
        : "border-border bg-surface-2 text-text-muted";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass}`}
    >
      <span className="material-symbols-outlined text-sm leading-none" aria-hidden="true">
        {icon}
      </span>
      {children}
    </span>
  );
}

function LinearMeter({
  label,
  value,
  tone = "green",
  helper,
}: {
  label: string;
  value: number;
  tone?: "green" | "blue" | "amber";
  helper?: string;
}) {
  const colorClass =
    tone === "amber" ? "bg-warning" : tone === "blue" ? "bg-text-muted" : "bg-primary";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-text-muted">{label}</span>
        <span className="font-semibold tabular-nums text-text-main">{value.toFixed(1)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ${colorClass}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      {helper && <div className="text-[11px] text-text-muted">{helper}</div>}
    </div>
  );
}

function DetailStat({
  label,
  value,
  accent = "text-text-main",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-control border border-border bg-surface px-3 py-2.5">
      <div className="truncate text-xs font-medium text-text-muted" title={label}>
        {label}
      </div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${accent}`}>{value}</div>
    </div>
  );
}

function InfoRow({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm text-text-muted">
      <span
        className="material-symbols-outlined shrink-0 text-base leading-5 text-text-muted"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span>{children}</span>
    </div>
  );
}

function formatHour(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function PromptTrendPanel({
  trend,
  title,
  description,
  busiestHourLabel,
  peakCacheRateLabel,
  cachedRequestsLabel,
  hoursTrackedLabel,
  hourLabel,
  activityLabel,
  requestsLabel,
  cacheRateLabel,
  cachedTokensLabel,
  noDataLabel,
}: {
  trend: CacheTrendPoint[];
  title: string;
  description: string;
  busiestHourLabel: string;
  peakCacheRateLabel: string;
  cachedRequestsLabel: string;
  hoursTrackedLabel: string;
  hourLabel: string;
  activityLabel: string;
  requestsLabel: string;
  cacheRateLabel: string;
  cachedTokensLabel: string;
  noDataLabel: string;
}) {
  if (trend.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-base text-text-muted" aria-hidden="true">
            timeline
          </span>
          <h3 className="text-sm font-semibold text-text-main">{title}</h3>
        </div>
        <p className="mt-2 text-sm text-text-muted">{noDataLabel}</p>
      </div>
    );
  }

  const trackedHours = trend.length;
  const totalCachedRequests = trend.reduce((sum, point) => sum + point.cachedRequests, 0);
  const busiestHour = trend.reduce((best, point) =>
    point.requests > best.requests ? point : best
  );
  const peakCacheRatePoint = trend.reduce((best, point) => {
    const bestRate = best.requests > 0 ? best.cachedRequests / best.requests : 0;
    const currentRate = point.requests > 0 ? point.cachedRequests / point.requests : 0;
    return currentRate > bestRate ? point : best;
  });
  const maxRequests = Math.max(1, ...trend.map((point) => point.requests));

  return (
    <div className="w-full self-start rounded-card border border-border bg-surface p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span
              className="material-symbols-outlined text-base text-text-muted"
              aria-hidden="true"
            >
              timeline
            </span>
            <h3 className="text-sm font-semibold text-text-main">{title}</h3>
          </div>
          <p className="mt-2 text-sm text-text-muted">{description}</p>
        </div>
        <SectionBadge icon="schedule">
          {trackedHours} {hoursTrackedLabel}
        </SectionBadge>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <DetailStat label={cachedRequestsLabel} value={totalCachedRequests.toLocaleString()} />
        <DetailStat label={busiestHourLabel} value={formatHour(busiestHour.timestamp)} />
        <DetailStat
          label={peakCacheRateLabel}
          value={`${((peakCacheRatePoint.cachedRequests / Math.max(peakCacheRatePoint.requests, 1)) * 100).toFixed(1)}%`}
        />
      </div>

      <div className="mt-5 overflow-hidden rounded-card border border-border bg-surface">
        <div className="grid grid-cols-[84px_minmax(0,1fr)_92px_120px] gap-3 border-b border-border px-4 py-3 text-xs font-medium text-text-muted">
          <span>{hourLabel}</span>
          <span>{activityLabel}</span>
          <span>{cacheRateLabel}</span>
          <span>{cachedTokensLabel}</span>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {trend
            .slice()
            .reverse()
            .map((point) => {
              const cacheRate =
                point.requests > 0 ? (point.cachedRequests / point.requests) * 100 : 0;
              const volumeWidth = Math.max(8, (point.requests / maxRequests) * 100);

              return (
                <div
                  key={point.timestamp}
                  className="grid grid-cols-[84px_minmax(0,1fr)_92px_120px] gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <div className="text-sm font-medium tabular-nums text-text-main">
                    {formatHour(point.timestamp)}
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${volumeWidth}%` }}
                      />
                    </div>
                    <div className="text-xs text-text-muted">
                      {point.requests.toLocaleString()} {requestsLabel.toLowerCase()}
                    </div>
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-text-main">
                    {cacheRate.toFixed(1)}%
                  </div>
                  <div className="text-sm font-semibold tabular-nums text-text-main">
                    {point.cachedTokens.toLocaleString()}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

const REFRESH_INTERVAL_MS = 10_000;
const REFRESH_INTERVAL_SECONDS = REFRESH_INTERVAL_MS / 1000;

export default function CachePage() {
  const t = useTranslations("cache");
  const tSettings = useTranslations("settings");
  const tRoot = useTranslations();
  const notify = useNotificationStore();
  const nodeMap = useProviderNodeMap();

  const [stats, setStats] = useState<CacheStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [activeView, setActiveView] = useState<CacheView>("prompt");

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/cache");
      if (res.ok) {
        const data: CacheStats = await res.json();
        setStats(data);
      }
    } catch (error) {
      console.error("[CachePage] Failed to fetch cache stats:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats();
    const id = setInterval(() => void fetchStats(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStats]);

  const handleClearAll = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/cache", { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        notify.success(t("clearSuccess", { count: data.cleared ?? 0 }));
        await fetchStats();
      } else {
        notify.error(t("clearError"));
      }
    } catch (error) {
      console.error("[CachePage] Failed to clear cache:", error);
      notify.error(t("clearError"));
    } finally {
      setClearing(false);
    }
  };

  const sc = stats?.semanticCache;
  const pc = stats?.promptCache;
  const trend = stats?.trend ?? [];
  const idp = stats?.idempotency;
  const semanticCacheEnabled = stats?.config?.semanticCacheEnabled !== false;

  const semanticHitRate = sc ? parseFloat(sc.hitRate) : 0;
  const semanticTotalRequests = sc ? sc.hits + sc.misses : 0;
  const promptCacheRate =
    pc && pc.totalRequests > 0 ? (pc.requestsWithCacheControl / pc.totalRequests) * 100 : 0;
  const promptReuseRatio =
    pc && pc.totalInputTokens > 0 ? (pc.totalCachedTokens / pc.totalInputTokens) * 100 : 0;
  const providerEntries = pc
    ? Object.entries(pc.byProvider).sort(([, left], [, right]) => {
        const leftCachedRequests = left.cachedRequests ?? left.requests;
        const leftTotalRequests = left.totalRequests ?? leftCachedRequests;
        const rightCachedRequests = right.cachedRequests ?? right.requests;
        const rightTotalRequests = right.totalRequests ?? rightCachedRequests;
        const leftRate = leftTotalRequests > 0 ? (leftCachedRequests / leftTotalRequests) * 100 : 0;
        const rightRate =
          rightTotalRequests > 0 ? (rightCachedRequests / rightTotalRequests) * 100 : 0;

        if (rightRate !== leftRate) {
          return rightRate - leftRate;
        }

        return right.cachedTokens - left.cachedTokens;
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button
          variant="secondary"
          icon="refresh"
          size="sm"
          onClick={() => void fetchStats()}
          disabled={loading}
          aria-label={t("refresh")}
        >
          {t("refresh")}
        </Button>
      </div>

      <div className="inline-flex w-fit items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5">
        <button
          type="button"
          onClick={() => setActiveView("prompt")}
          aria-pressed={activeView === "prompt"}
          className={`h-8 px-3 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
            activeView === "prompt"
              ? "bg-surface text-text-main border border-border dark:bg-white/10"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          {t("promptCache")}
        </button>
        <button
          type="button"
          onClick={() => setActiveView("semantic")}
          aria-pressed={activeView === "semantic"}
          className={`h-8 px-3 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
            activeView === "semantic"
              ? "bg-surface text-text-main border border-border dark:bg-white/10"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          {t("semanticCache")}
        </button>
        <button
          type="button"
          onClick={() => setActiveView("reasoning")}
          aria-pressed={activeView === "reasoning"}
          className={`h-8 px-3 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
            activeView === "reasoning"
              ? "bg-surface text-text-main border border-border dark:bg-white/10"
              : "text-text-muted hover:text-text-main"
          }`}
        >
          {t("reasoningCache")}
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 gap-6" aria-busy="true" aria-label={t("loadingCacheAria")}>
          <div className="h-96 rounded-card bg-surface-raised animate-pulse" />
        </div>
      )}

      {!loading && !stats && (
        <EmptyState
          icon="cached"
          title={t("unavailable")}
          description={t("unavailableDesc")}
          actionLabel={t("refresh")}
          onAction={() => void fetchStats()}
        />
      )}

      {!loading && stats && activeView === "prompt" && (
        <Card>
          <div className="flex flex-col gap-6 p-5 md:p-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="space-y-2">
                <SectionBadge icon="bolt" tone="green">
                  {t("promptCache")}
                </SectionBadge>
                <div>
                  <h2 className="text-sm font-semibold text-text-main">{t("promptCache")}</h2>
                  <p className="mt-1 max-w-3xl text-sm text-text-muted">
                    {t("promptCacheSectionDesc")}
                  </p>
                </div>
              </div>
              {pc && (
                <div className="text-sm text-text-muted">
                  {t("lastUpdated")}: {new Date(pc.lastUpdated).toLocaleString()}
                </div>
              )}
            </div>

            {pc ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                  <StatCard
                    icon="speed"
                    label={t("cacheRate")}
                    value={`${promptCacheRate.toFixed(1)}%`}
                    sub={`${pc.requestsWithCacheControl.toLocaleString()} / ${pc.totalRequests.toLocaleString()} ${t("requests").toLowerCase()}`}
                  />
                  <StatCard
                    icon="savings"
                    label={t("cacheReuseRatio")}
                    value={`${promptReuseRatio.toFixed(1)}%`}
                    sub={t("cacheReuseRatioDesc")}
                  />
                  <StatCard
                    icon="token"
                    label={t("cachedTokens")}
                    value={pc.totalCachedTokens.toLocaleString()}
                    sub={t("cachedTokensRead")}
                  />
                  <StatCard
                    icon="upload"
                    label={t("cacheCreationTokens")}
                    value={pc.totalCacheCreationTokens.toLocaleString()}
                    sub={t("cacheCreationWrite")}
                  />
                  <StatCard
                    icon="attach_money"
                    label={t("estCostSaved")}
                    value={`$${pc.estimatedCostSaved.toFixed(4)}`}
                    sub={t("promptCache")}
                  />
                </div>

                <div className="w-full rounded-card border border-border bg-surface p-5">
                  <div>
                    <h3 className="text-sm font-semibold text-text-main">{t("byProvider")}</h3>
                    <p className="mt-1 text-sm text-text-muted">{t("providerCacheRateDesc")}</p>
                  </div>

                  {providerEntries.length > 0 ? (
                    <div className="mt-3 overflow-x-auto rounded-card border border-border bg-surface">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs font-medium text-text-muted">
                            <th className="px-4 py-3 font-medium">{t("provider")}</th>
                            <th className="px-4 py-3 font-medium">{t("inputTokens")}</th>
                            <th className="px-4 py-3 font-medium">{t("cachedTokensCol")}</th>
                            <th className="px-4 py-3 font-medium">{t("cacheCreation")}</th>
                            <th className="px-4 py-3 font-medium">{t("cacheReuseRatio")}</th>
                            <th className="px-4 py-3 font-medium">{t("cacheRate")}</th>
                            <th className="px-4 py-3 font-medium">{t("cachedRequests")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {providerEntries.map(([provider, data]) => {
                            const cachedRequests = data.cachedRequests ?? data.requests;
                            const totalRequests = data.totalRequests ?? cachedRequests;
                            const cacheRate =
                              totalRequests > 0 ? (cachedRequests / totalRequests) * 100 : 0;
                            const reuseRatio =
                              data.inputTokens > 0
                                ? (data.cachedTokens / data.inputTokens) * 100
                                : 0;

                            return (
                              <tr key={provider} className="border-b border-border last:border-b-0">
                                <td className="px-4 py-3">
                                  <div className="font-medium text-text-main">
                                    {resolveProviderName(provider, nodeMap)}
                                  </div>
                                  <div className="mt-1 text-xs text-text-muted">
                                    {totalRequests.toLocaleString()} {t("requests").toLowerCase()}
                                  </div>
                                </td>
                                <td className="px-4 py-3 tabular-nums text-text-main">
                                  {data.inputTokens.toLocaleString()}
                                </td>
                                <td className="px-4 py-3 tabular-nums text-text-main">
                                  {data.cachedTokens.toLocaleString()}
                                </td>
                                <td className="px-4 py-3 tabular-nums text-text-main">
                                  {data.cacheCreationTokens.toLocaleString()}
                                </td>
                                <td className="px-4 py-3 font-semibold tabular-nums text-text-main">
                                  {reuseRatio.toFixed(1)}%
                                </td>
                                <td className="px-4 py-3 font-semibold tabular-nums text-text-main">
                                  {cacheRate.toFixed(1)}%
                                </td>
                                <td className="px-4 py-3 tabular-nums text-text-main">
                                  {cachedRequests.toLocaleString()} /{" "}
                                  {totalRequests.toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-card border border-dashed border-border bg-surface-2/40 px-4 py-6 text-center text-sm text-text-muted">
                      {t("noPromptCacheData")}
                    </div>
                  )}
                </div>

                <PromptTrendPanel
                  trend={trend}
                  title={t("trend24h")}
                  description={t("promptTrendDesc")}
                  busiestHourLabel={t("busiestHour")}
                  peakCacheRateLabel={t("peakCacheRate")}
                  cachedRequestsLabel={t("cachedRequests24h")}
                  hoursTrackedLabel={t("hoursTracked")}
                  hourLabel={t("trendHour")}
                  activityLabel={t("activityVolume")}
                  requestsLabel={t("requests")}
                  cacheRateLabel={t("cacheRate")}
                  cachedTokensLabel={t("cachedTokensCol")}
                  noDataLabel={t("noTrendData")}
                />
              </>
            ) : (
              <div className="rounded-card border border-dashed border-border bg-surface-2/40 px-4 py-6 text-center text-sm text-text-muted">
                {t("noPromptCacheData")}
              </div>
            )}
          </div>
        </Card>
      )}

      {!loading && stats && activeView === "semantic" && (
        <Card>
          <div className="flex flex-col gap-6 p-5 md:p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <SectionBadge
                    icon={semanticCacheEnabled ? "database" : "block"}
                    tone={semanticCacheEnabled ? "green" : "amber"}
                  >
                    {t("semanticCache")}
                  </SectionBadge>
                  <SectionBadge
                    icon={semanticCacheEnabled ? "check_circle" : "do_not_disturb_on"}
                    tone={semanticCacheEnabled ? "green" : "amber"}
                  >
                    {semanticCacheEnabled ? tSettings("enabled") : tRoot("disabled")}
                  </SectionBadge>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-text-main">{t("semanticCache")}</h2>
                  <p className="mt-1 max-w-3xl text-sm text-text-muted">
                    {t("semanticCacheSectionDesc")}
                  </p>
                </div>
              </div>

              <Button
                variant="danger"
                icon="delete_sweep"
                size="sm"
                onClick={() => void handleClearAll()}
                disabled={clearing || loading}
                loading={clearing}
                aria-label={t("clearAll")}
              >
                {t("clearAll")}
              </Button>
            </div>

            {!semanticCacheEnabled && (
              <div className="rounded-card border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
                {t("semanticCacheDisabledDesc")}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
              <StatCard
                icon="memory"
                label={t("memoryEntries")}
                value={sc?.memoryEntries ?? 0}
                sub={t("memoryEntriesSub")}
              />
              <StatCard
                icon="storage"
                label={t("dbEntries")}
                value={sc?.dbEntries ?? 0}
                sub={t("dbEntriesSub")}
              />
              <StatCard
                icon="trending_up"
                label={t("cacheHits")}
                value={sc?.hits ?? 0}
                sub={t("cacheHitsSub", { total: semanticTotalRequests })}
              />
              <StatCard
                icon="token"
                label={t("tokensSaved")}
                value={(sc?.tokensSaved ?? 0).toLocaleString()}
                sub={t("tokensSavedSub")}
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
              <div className="rounded-card border border-border bg-surface p-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-text-main">{t("performance")}</h3>
                    <p className="mt-1 text-sm text-text-muted">
                      {t("autoRefresh", { seconds: REFRESH_INTERVAL_SECONDS })}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-semibold tracking-tight tabular-nums text-text-main">
                      {semanticHitRate.toFixed(1)}%
                    </div>
                    <div className="text-xs text-text-muted">{t("hitRate")}</div>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <LinearMeter
                    label={t("hitRate")}
                    value={semanticHitRate}
                    helper={`${sc?.hits ?? 0} ${t("hits").toLowerCase()} / ${semanticTotalRequests} ${t("total").toLowerCase()}`}
                  />
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <DetailStat label={t("hits")} value={(sc?.hits ?? 0).toLocaleString()} />
                  <DetailStat label={t("misses")} value={(sc?.misses ?? 0).toLocaleString()} />
                  <DetailStat label={t("total")} value={semanticTotalRequests.toLocaleString()} />
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-card border border-border bg-surface p-5">
                  <h3 className="text-sm font-semibold text-text-main">{t("behavior")}</h3>
                  <div className="mt-4 grid gap-3">
                    <InfoRow icon="info">{t("behaviorDeterministic")}</InfoRow>
                    <InfoRow icon="info">
                      {t("behaviorBypass", { header: "X-TRouteAI-No-Cache: true" })}
                    </InfoRow>
                    <InfoRow icon="info">{t("behaviorTwoTier")}</InfoRow>
                    <InfoRow icon="info">
                      {t("behaviorTtl", { envVar: "SEMANTIC_CACHE_TTL_MS" })}
                    </InfoRow>
                  </div>
                </div>

                <div className="rounded-card border border-border bg-surface p-5">
                  <div className="flex items-center gap-2">
                    <span
                      className="material-symbols-outlined text-base text-text-muted"
                      aria-hidden="true"
                    >
                      fingerprint
                    </span>
                    <h3 className="text-sm font-semibold text-text-main">{t("idempotency")}</h3>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <DetailStat
                      label={t("activeDedupKeys")}
                      value={(idp?.activeKeys ?? 0).toLocaleString()}
                    />
                    <DetailStat
                      label={t("dedupWindow")}
                      value={idp ? `${(idp.windowMs / 1000).toFixed(0)}s` : "0s"}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-card border border-border bg-surface p-5">
              <div className="mb-4 flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-text-main">{t("entries")}</h3>
                <p className="text-sm text-text-muted">{t("semanticEntriesDesc")}</p>
              </div>
              <CacheEntriesTab />
            </div>
          </div>
        </Card>
      )}

      {activeView === "reasoning" && (
        <Card padding="none" className="overflow-hidden">
          <div className="p-6">
            <ReasoningCacheTab />
          </div>
        </Card>
      )}
    </div>
  );
}
