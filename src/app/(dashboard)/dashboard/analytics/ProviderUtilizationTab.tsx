"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProviderNodeMap, resolveProviderName } from "@/lib/display/useProviderNodeMap";
import dynamic from "next/dynamic";

const ProviderCharts = dynamic(() => import("./components/ProviderCharts"), { ssr: false });
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { PROVIDER_COLORS as SERIES_COLORS } from "@/shared/components/analytics/chartColors";
import TimeRangeSelector from "@/shared/components/analytics/TimeRangeSelector";
import type {
  ProviderUtilizationPoint,
  ProviderUtilizationResponse,
  UtilizationTimeRange,
} from "@/shared/types/utilization";

// Series colors: primary teal first, then neutral/teal steps (no semantic colors for plain series).
const PROVIDER_COLORS = SERIES_COLORS;

function formatTimestamp(value: string, range: UtilizationTimeRange) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  if (range === "1h" || range === "24h") {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatTooltipTimestamp(value: string, range: UtilizationTimeRange) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: range === "1h" || range === "24h" ? "2-digit" : undefined,
    minute: range === "1h" || range === "24h" ? "2-digit" : undefined,
  }).format(date);
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function getLatestPoints(points: ProviderUtilizationPoint[]) {
  const latestByProvider = new Map<string, ProviderUtilizationPoint>();

  for (const point of points) {
    const current = latestByProvider.get(point.provider);
    if (!current || new Date(point.timestamp).getTime() > new Date(current.timestamp).getTime()) {
      latestByProvider.set(point.provider, point);
    }
  }

  return Array.from(latestByProvider.values()).sort((a, b) => b.remainingPct - a.remainingPct);
}

export default function ProviderUtilizationTab() {
  const t = useTranslations("analytics");
  const nodeMap = useProviderNodeMap();
  const [range, setRange] = useState<UtilizationTimeRange>("24h");
  const [aggregateBy, setAggregateBy] = useState<"provider" | "connection">("provider");
  const [data, setData] = useState<ProviderUtilizationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchUtilization = useCallback(
    async (
      selectedRange: UtilizationTimeRange,
      selectedAggregate: "provider" | "connection",
      signal?: AbortSignal
    ) => {
      setLoading(true);

      try {
        const response = await fetch(
          `/api/usage/utilization?range=${selectedRange}&aggregateBy=${selectedAggregate}`,
          {
            signal,
            cache: "no-store",
          }
        );

        if (!response.ok) {
          throw new Error("Failed to fetch utilization data");
        }

        const json = (await response.json()) as ProviderUtilizationResponse;
        setData(json);
        setError(null);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          return;
        }

        setError(
          fetchError instanceof Error ? fetchError.message : "Failed to fetch utilization data"
        );
        setData(null);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();

    fetchUtilization(range, aggregateBy, controller.signal);

    return () => controller.abort();
  }, [fetchUtilization, range, aggregateBy]);

  const providerColors = useMemo(() => {
    const colors = new Map<string, string>();

    for (const [index, provider] of (data?.providers ?? []).entries()) {
      colors.set(provider, PROVIDER_COLORS[index % PROVIDER_COLORS.length]);
    }

    return colors;
  }, [data?.providers]);

  const chartData = useMemo(() => {
    if (!data?.data.length) {
      return [];
    }

    const byTimestamp = new Map<string, Record<string, number | string>>();

    for (const point of data.data) {
      const entry = byTimestamp.get(point.timestamp) ?? {
        timestamp: point.timestamp,
        label: formatTimestamp(point.timestamp, data.timeRange),
      };

      entry[point.provider] = Number(point.remainingPct.toFixed(2));
      byTimestamp.set(point.timestamp, entry);
    }

    return Array.from(byTimestamp.entries())
      .sort(([left], [right]) => new Date(left).getTime() - new Date(right).getTime())
      .map(([, value]) => value);
  }, [data]);

  const latestPoints = useMemo(() => getLatestPoints(data?.data ?? []), [data?.data]);

  const hasData = Boolean(data?.data.length);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    setError(null);
    fetchUtilization(range, aggregateBy).finally(() => setRetrying(false));
  }, [range, aggregateBy, fetchUtilization]);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title={t("providerUtilizationTitle")}
        subtitle={t(`utilizationRange.${range}`)}
        icon="monitoring"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-0.5 rounded-control border border-border bg-surface-2 p-0.5">
              <button
                onClick={() => setAggregateBy("provider")}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                  aggregateBy === "provider"
                    ? "border-border bg-surface text-text-main shadow-none"
                    : "border-transparent text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">dns</span>
                {t("providerUtilizationGlobalView")}
              </button>
              <button
                onClick={() => setAggregateBy("connection")}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                  aggregateBy === "connection"
                    ? "border-border bg-surface text-text-main shadow-none"
                    : "border-transparent text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">account_tree</span>
                {t("providerUtilizationAccountSplit")}
              </button>
            </div>
            <TimeRangeSelector value={range} onChange={setRange} />
          </div>
        }
        className="overflow-hidden"
      >
        {loading && !hasData ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-text-muted">
            <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">
              progress_activity
            </span>
            {t("providerUtilizationLoading")}
          </div>
        ) : error ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
            <span className="material-symbols-outlined text-[32px] text-error">error</span>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-main">
                {t("providerUtilizationFailedToLoad")}
              </p>
              <p className="text-sm text-text-muted">{error}</p>
            </div>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="inline-flex items-center gap-2 rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {retrying ? (
                <>
                  <span className="material-symbols-outlined animate-spin text-[18px]">
                    progress_activity
                  </span>
                  {t("retrying")}
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">refresh</span>
                  {t("retry")}
                </>
              )}
            </button>
          </div>
        ) : !hasData ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
            <span className="material-symbols-outlined text-[40px] text-text-muted">timeline</span>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-text-main">{t("providerUtilizationNoData")}</p>
              <p className="max-w-md text-sm text-text-muted">
                {t("providerUtilizationNoDataDescription")}
              </p>
            </div>
            <div className="rounded-card border border-border bg-surface-2/40 p-4">
              <p className="text-xs font-medium text-text-main">
                {t("providerUtilizationGettingStarted")}
              </p>
              <ul className="mt-2 text-left text-xs text-text-muted">
                <li className="flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-primary">
                    check_circle
                  </span>
                  <span>
                    {t.rich("providerUtilizationStepConnect", {
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })}
                  </span>
                </li>
                <li className="mt-1 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-primary">
                    check_circle
                  </span>
                  <span>{t("providerUtilizationStepEnable")}</span>
                </li>
                <li className="mt-1 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[14px] text-primary">
                    check_circle
                  </span>
                  <span>{t("providerUtilizationStepAutomatic")}</span>
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <ProviderCharts
              chartData={chartData}
              providers={data?.providers ?? []}
              providerColors={providerColors}
              range={range}
              resolveProviderName={resolveProviderName}
              nodeMap={nodeMap}
              formatTimestamp={formatTimestamp}
              formatPercent={formatPercent}
              formatTooltipTimestamp={formatTooltipTimestamp}
            />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {latestPoints.map((point) => {
                const isLow = point.remainingPct <= 20;

                return (
                  <Card.Section key={point.provider} className="flex h-full flex-col gap-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-text-main">
                          <ProviderIcon providerId={point.provider} size={22} />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-text-main">
                            {resolveProviderName(point.provider, nodeMap)}
                          </p>
                          <p className="text-xs text-text-muted">
                            {t("providerUtilizationLatestSnapshot")}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
                          point.isExhausted
                            ? "bg-error/10 text-error"
                            : isLow
                              ? "bg-warning/10 text-warning"
                              : "bg-success/10 text-success"
                        }`}
                      >
                        {point.isExhausted
                          ? t("statusExhausted")
                          : isLow
                            ? t("statusLow")
                            : t("statusHealthy")}
                      </span>
                    </div>

                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <p className="text-2xl font-semibold tracking-tight text-text-main tabular-nums">
                          {point.remainingPct.toFixed(point.remainingPct < 10 ? 1 : 0)}%
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t("providerUtilizationRemainingCapacity")}
                        </p>
                      </div>
                      <div className="text-right text-xs text-text-muted">
                        <p>{formatTooltipTimestamp(point.timestamp, range)}</p>
                        <p className="mt-1">{point.windowKey}</p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={`h-full rounded-full transition-all ${
                            point.isExhausted ? "bg-error" : isLow ? "bg-warning" : "bg-primary"
                          }`}
                          style={{ width: `${Math.max(point.remainingPct, 0)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-text-muted">
                        <span>0%</span>
                        <span>{t("remainingQuota")}</span>
                        <span>100%</span>
                      </div>
                    </div>
                  </Card.Section>
                );
              })}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
