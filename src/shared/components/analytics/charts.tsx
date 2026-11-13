"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import Card from "../Card";
import { PROVIDER_COLORS } from "./chartColors";
import {
  fmtCompact as fmt,
  fmtFull,
  fmtCost,
  formatApiKeyLabel as maskApiKeyLabel,
} from "@/shared/utils/formatting";
import {
  getServiceTierDisplayLabel,
  translateCostText,
  type TranslationFn,
} from "@/shared/utils/serviceTierLabels";

function createDateFormatter(locale: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat(undefined, options);
  }
}

// ── Sort Indicator (shared by tables) ──────────────────────────────────────

export function SortIndicator({ active, sortOrder }: { active: boolean; sortOrder: string }) {
  if (!active) {
    return (
      <span className="material-symbols-outlined text-[12px] opacity-0 group-hover:opacity-30">
        unfold_more
      </span>
    );
  }
  return (
    <span className="material-symbols-outlined text-[12px] text-primary-text">
      {sortOrder === "asc" ? "expand_less" : "expand_more"}
    </span>
  );
}

// ── StatCard (primary KPI) ─────────────────────────────────────────────────

/**
 * Values are neutral by default. Only semantic colors (success / warning /
 * error / primary link) are honored; decorative palette colors fall back to
 * text-text-main so numbers never carry color without meaning.
 */
const SEMANTIC_VALUE_CLASSES = new Set([
  "text-success",
  "text-warning",
  "text-error",
  "text-primary-text",
  "text-text-main",
  "text-text-muted",
]);

function semanticValueClass(color?: string) {
  return color && SEMANTIC_VALUE_CLASSES.has(color) ? color : "text-text-main";
}

export function StatCard({
  icon,
  label,
  value,
  subValue,
  color = "text-text-main",
}: {
  icon: any;
  label: any;
  value: any;
  subValue?: any;
  color?: string;
}) {
  return (
    <Card padding="sm" className="flex flex-col min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted min-w-0">
        <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">
          {icon}
        </span>
        <span className="truncate" title={typeof label === "string" ? label : undefined}>
          {label}
        </span>
      </div>
      <span
        className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums truncate ${semanticValueClass(color)}`}
        title={String(value)}
      >
        {value}
      </span>
      {subValue && <span className="mt-0.5 text-xs text-text-muted truncate">{subValue}</span>}
    </Card>
  );
}

// ── CompactStatGrid (secondary metrics in a single card, grouped) ─────────

export type CompactStatSection = {
  title: string;
  items: Array<{ icon: string; label: string; value: any; color?: string }>;
  /** On mobile use 1 column instead of 2 — useful when values can be long (model names, etc.) */
  wideValues?: boolean;
};

export function CompactStatGrid({ sections }: { sections: CompactStatSection[] }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex flex-col gap-3">
        {sections.map((section, si) => (
          <div key={si}>
            {si > 0 && <div className="border-t border-border mb-3" />}
            <div className="text-sm font-semibold text-text-main mb-2">{section.title}</div>
            <div
              className={
                section.wideValues
                  ? "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-2"
                  : "grid grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-2"
              }
            >
              {section.items.map((stat, i) => (
                <div key={i} className="flex items-center justify-between gap-2 min-w-0 py-0.5">
                  <div
                    className={`flex items-center gap-1.5 ${section.wideValues ? "shrink-0" : "min-w-0"}`}
                  >
                    <span
                      className="material-symbols-outlined text-[16px] text-text-muted shrink-0"
                      aria-hidden="true"
                    >
                      {stat.icon}
                    </span>
                    <span
                      className={`text-xs font-medium text-text-muted ${section.wideValues ? "whitespace-nowrap" : "truncate"}`}
                      title={stat.label}
                    >
                      {stat.label}
                    </span>
                  </div>
                  <span
                    className={`text-sm font-semibold tabular-nums text-right ${section.wideValues ? "truncate min-w-0" : "shrink-0"} ${semanticValueClass(stat.color)}`}
                    title={String(stat.value)}
                  >
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── ActivityHeatmap ────────────────────────────────────────────────────────

export function ActivityHeatmap({ activityMap }) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const monthFormatter = useMemo(() => createDateFormatter(locale, { month: "short" }), [locale]);
  const weekdayFormatter = useMemo(
    () => createDateFormatter(locale, { weekday: "short" }),
    [locale]
  );

  const cells = useMemo(() => {
    const today = new Date();
    const days = [];
    let maxVal = 0;

    for (let i = 364; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const val = activityMap?.[key] || 0;
      if (val > maxVal) maxVal = val;
      days.push({ date: key, value: val, dayOfWeek: d.getDay() });
    }

    return { days, maxVal };
  }, [activityMap]);

  const weeks = useMemo(() => {
    const w = [];
    let current = [];
    const firstDay = cells.days[0]?.dayOfWeek || 0;
    for (let i = 0; i < firstDay; i++) {
      current.push(null);
    }
    for (const day of cells.days) {
      current.push(day);
      if (current.length === 7) {
        w.push(current);
        current = [];
      }
    }
    if (current.length > 0) w.push(current);
    return w;
  }, [cells]);

  // Auto-scroll to the right edge so the current date is visible
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [weeks]);
  const monthLabels = useMemo(() => {
    const labels = [];
    let lastMonth = -1;
    weeks.forEach((week, weekIdx) => {
      const firstDay = week.find((d) => d !== null);
      if (firstDay) {
        const m = new Date(firstDay.date).getMonth();
        if (m !== lastMonth) {
          labels.push({ weekIdx, label: monthFormatter.format(new Date(2024, m, 1)) });
          lastMonth = m;
        }
      }
    });
    return labels;
  }, [monthFormatter, weeks]);

  const weekdayLabels = useMemo(
    () => [1, 3, 5].map((day) => weekdayFormatter.format(new Date(2024, 0, 7 + day))),
    [weekdayFormatter]
  );

  function getCellColor(value) {
    if (!value || value === 0) return "bg-surface-2";
    const intensity = Math.min(value / (cells.maxVal || 1), 1);
    if (intensity < 0.25) return "bg-primary/20";
    if (intensity < 0.5) return "bg-primary/40";
    if (intensity < 0.75) return "bg-primary/60";
    return "bg-primary/90";
  }

  return (
    <Card className="p-4 h-full min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-main">{t("overview")}</h3>
        <span className="text-xs text-text-muted">
          {t("activitySummary", {
            active: Object.keys(activityMap || {}).length,
            tokens: fmt(
              Object.values(activityMap || {}).reduce((a: number, b: number) => a + b, 0)
            ),
            days: 365,
          })}
        </span>
      </div>

      <div ref={scrollRef} className="overflow-x-auto">
        <div className="w-max">
          <div className="flex gap-[3px] mb-1 ml-6" style={{ fontSize: "10px" }}>
            {monthLabels.map((m, i) => (
              <span
                key={i}
                className="text-text-muted"
                style={{
                  position: "relative",
                  left: `${m.weekIdx * 13}px`,
                  marginLeft: i === 0 ? 0 : "-20px",
                }}
              >
                {m.label}
              </span>
            ))}
          </div>

          <div className="flex gap-[3px]">
            <div className="flex flex-col gap-[3px] shrink-0 text-[10px] text-text-muted pr-1 sticky left-0 z-10 bg-surface">
              <span className="h-[10px]"></span>
              <span className="h-[10px] leading-[10px]">{weekdayLabels[0]}</span>
              <span className="h-[10px]"></span>
              <span className="h-[10px] leading-[10px]">{weekdayLabels[1]}</span>
              <span className="h-[10px]"></span>
              <span className="h-[10px] leading-[10px]">{weekdayLabels[2]}</span>
              <span className="h-[10px]"></span>
            </div>

            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((day, di) => (
                  <div
                    key={di}
                    title={
                      day
                        ? t("activityCellTitle", { date: day.date, tokens: fmtFull(day.value) })
                        : ""
                    }
                    className={`w-[10px] h-[10px] rounded-[2px] ${day ? getCellColor(day.value) : "bg-transparent"}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 mt-2 ml-6 text-[10px] text-text-muted">
        <span>{t("activityLess")}</span>
        <div className="w-[10px] h-[10px] rounded-[2px] bg-surface-2" />
        <div className="w-[10px] h-[10px] rounded-[2px] bg-primary/20" />
        <div className="w-[10px] h-[10px] rounded-[2px] bg-primary/40" />
        <div className="w-[10px] h-[10px] rounded-[2px] bg-primary/60" />
        <div className="w-[10px] h-[10px] rounded-[2px] bg-primary/90" />
        <span>{t("activityMore")}</span>
      </div>
    </Card>
  );
}

export function ApiKeyTable({ byApiKey }) {
  const t = useTranslations("analytics");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("totalTokens");
  const [sortOrder, setSortOrder] = useState("desc");

  const data = useMemo(() => byApiKey || [], [byApiKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (row) =>
        (row.apiKeyName || "").toLowerCase().includes(q) ||
        (row.apiKeyId || "").toLowerCase().includes(q)
    );
  }, [data, query]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = a[sortBy] ?? 0;
      const vb = b[sortBy] ?? 0;
      if (typeof va === "string") {
        return sortOrder === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortOrder === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [filtered, sortBy, sortOrder]);

  const toggleSort = useCallback(
    (field) => {
      if (sortBy === field) {
        setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
        return;
      }
      setSortBy(field);
      setSortOrder("desc");
    },
    [sortBy]
  );

  const hasData = data.length > 0;

  if (!hasData) {
    return (
      <Card className="p-4 flex-1">
        <h3 className="text-sm font-semibold text-text-main mb-3">{t("chartApiKeyBreakdown")}</h3>
        <div className="text-center text-text-muted text-sm py-8">{t("chartNoData")}</div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-main">{t("chartApiKeyBreakdown")}</h3>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("filterSearchKeys")}
          className="w-full max-w-[220px] h-8 px-3 rounded-control bg-surface border border-border text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:border-primary"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs font-medium text-text-muted bg-surface-2/60">
            <tr>
              <th
                className="px-4 py-2.5 text-left cursor-pointer group"
                onClick={() => toggleSort("apiKeyName")}
              >
                {t("chartApiKey")}{" "}
                <SortIndicator active={sortBy === "apiKeyName"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("requests")}
              >
                {t("chartRequests")}{" "}
                <SortIndicator active={sortBy === "requests"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("promptTokens")}
              >
                {t("chartInput")}{" "}
                <SortIndicator active={sortBy === "promptTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("completionTokens")}
              >
                {t("chartOutput")}{" "}
                <SortIndicator active={sortBy === "completionTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("totalTokens")}
              >
                {t("chartTotal")}{" "}
                <SortIndicator active={sortBy === "totalTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("cost")}
              >
                {t("chartCost")} <SortIndicator active={sortBy === "cost"} sortOrder={sortOrder} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((row, i) => (
              <tr
                key={`${row.apiKeyId || row.apiKeyName || "key"}-${i}`}
                className="hover:bg-surface-2/60 transition-colors"
              >
                <td className="px-4 py-2.5">
                  <span className="font-medium" title={row.apiKeyName || row.apiKeyId || "unknown"}>
                    {maskApiKeyLabel(row.apiKeyName, row.apiKeyId)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-muted">
                  {fmtFull(row.requests)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                  {fmt(row.promptTokens)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                  {fmt(row.completionTokens)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-text-main">
                  {fmt(row.totalTokens)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                  {fmtCost(row.cost)}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-text-muted">
                  {t("filterNoKeysMatch")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function MostActiveDay7d({ activityMap }) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const weekdayFormatter = useMemo(
    () => createDateFormatter(locale, { weekday: "long" }),
    [locale]
  );
  const dateFormatter = useMemo(
    () => createDateFormatter(locale, { month: "short", day: "numeric" }),
    [locale]
  );
  const data = useMemo(() => {
    if (!activityMap) return null;
    const today = new Date();
    let peakKey = null;
    let peakVal = 0;

    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const val = activityMap[key] || 0;
      if (val > peakVal) {
        peakVal = val;
        peakKey = key;
      }
    }
    if (!peakKey || peakVal === 0) return null;

    const peakDate = new Date(peakKey + "T12:00:00");
    return {
      weekday: weekdayFormatter.format(peakDate),
      label: dateFormatter.format(peakDate),
      tokens: peakVal,
    };
  }, [activityMap, dateFormatter, weekdayFormatter]);

  return (
    <Card className="p-4 flex flex-col justify-center" style={{ flex: 1, minHeight: 0 }}>
      <h3 className="text-sm font-semibold text-text-main mb-2">{t("mostActiveDay")}</h3>
      {data ? (
        <>
          <span
            className="text-xl font-semibold tracking-tight text-text-main capitalize"
            style={{ lineHeight: 1.2 }}
          >
            {data.weekday}
          </span>
          <span className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {t("datedTokenCount", { date: data.label, tokens: fmt(data.tokens) })}
          </span>
        </>
      ) : (
        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {t("noDataLast7Days")}
        </span>
      )}
    </Card>
  );
}

// ── WeeklySquares7d ────────────────────────────────────────────────────────

export function WeeklySquares7d({ activityMap }) {
  const t = useTranslations("analytics");
  const locale = useLocale();
  const weekdayFormatter = useMemo(
    () => createDateFormatter(locale, { weekday: "short" }),
    [locale]
  );
  const dateFormatter = useMemo(
    () => createDateFormatter(locale, { month: "short", day: "numeric" }),
    [locale]
  );
  const days = useMemo(() => {
    if (!activityMap) return [];
    const today = new Date();
    const result = [];
    let maxVal = 0;

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const val = activityMap[key] || 0;
      if (val > maxVal) maxVal = val;
      result.push({
        key,
        val,
        label: weekdayFormatter.format(d),
        dateLabel: dateFormatter.format(d),
      });
    }
    return result.map((d) => ({ ...d, intensity: maxVal > 0 ? d.val / maxVal : 0 }));
  }, [activityMap, dateFormatter, weekdayFormatter]);

  function getSquareStyle(intensity) {
    if (intensity === 0) return { background: "var(--color-surface-2)" };
    const pct = Math.round((0.15 + intensity * 0.75) * 100);
    return {
      background: `color-mix(in srgb, var(--color-primary) ${pct}%, transparent)`,
    };
  }

  return (
    <Card className="p-4 flex flex-col justify-center" style={{ flex: 1, minHeight: 0 }}>
      <h3 className="text-sm font-semibold text-text-main mb-3">{t("chartWeekly")}</h3>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, justifyContent: "center" }}>
        {days.map((d, i) => (
          <div
            key={d.key}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
          >
            <div
              title={t("activityCellTitle", { date: d.dateLabel, tokens: fmtFull(d.val) })}
              style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                ...getSquareStyle(d.intensity),
                transition: "all 0.2s",
                cursor: "default",
              }}
            />
            <span
              style={{
                fontSize: 9,
                fontWeight: 500,
                color: "var(--color-text-muted)",
              }}
            >
              {d.label}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── ModelTable (extracted — see ModelTable.tsx) ───────────────────

export { ModelTable } from "./ModelTable";

function getServiceTierIcon(serviceTier) {
  if (serviceTier === "priority") return "bolt";
  if (serviceTier === "flex") return "savings";
  return "speed";
}

function getServiceTierIconClass(serviceTier) {
  if (serviceTier === "priority") return "text-primary-text";
  if (serviceTier === "flex") return "text-success";
  return "text-text-muted";
}

function getServiceTierBarClass(serviceTier) {
  if (serviceTier === "priority") return "bg-primary";
  if (serviceTier === "flex") return "bg-success";
  return "bg-text-muted/50";
}

function getServiceTierCostClass(serviceTier) {
  // Savings (flex) is a good outcome; everything else is a plain value.
  return serviceTier === "flex" ? "text-success" : "text-text-main";
}

export function ServiceTierBreakdown({ byServiceTier, summary }) {
  const t = useTranslations("costs") as TranslationFn;
  const tAnalytics = useTranslations("analytics");
  const data = useMemo(() => byServiceTier || [], [byServiceTier]);
  const totalRequests = Number(summary?.totalRequests || 0);
  const totalCost = Number(summary?.totalCost || 0);

  if (!data.length) {
    return null;
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-main">
          {translateCostText(t, "serviceTierBreakdownTitle", "Service Tier")}
        </h3>
        <span className="text-xs text-text-muted">
          {translateCostText(t, "serviceTierBreakdownSubtitle", "Fast / Flex / Standard split")}
        </span>
      </div>
      <div className="divide-y divide-border">
        {data.map((tier) => {
          const isFlex = tier.serviceTier === "flex";
          const tierLabel = getServiceTierDisplayLabel(t, tier.serviceTier, tier.label);
          const requestPct =
            totalRequests > 0
              ? ((Number(tier.requests || 0) / totalRequests) * 100).toFixed(1)
              : "0";
          const costPct =
            totalCost > 0 ? ((Number(tier.cost || 0) / totalCost) * 100).toFixed(1) : "0";
          const usageSavings = Number(tier.usageSavingsTokens || 0);
          const costSavings = Number(tier.savings || 0);
          const usageSavingsText =
            isFlex && usageSavings > 0
              ? ` · ${fmt(usageSavings)} ${translateCostText(
                  t,
                  "serviceTierUsageSaved",
                  "usage saved"
                )}`
              : "";
          const costDetailText =
            isFlex && costSavings > 0
              ? `${fmtCost(costSavings)} ${translateCostText(t, "serviceTierCostSaved", "saved")}`
              : `${costPct}% ${translateCostText(t, "serviceTierCostShareSuffix", "of cost")}`;

          return (
            <div key={tier.serviceTier} className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`material-symbols-outlined text-[18px] ${getServiceTierIconClass(
                      tier.serviceTier
                    )}`}
                  >
                    {getServiceTierIcon(tier.serviceTier)}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-text-main">{tierLabel}</div>
                    <div className="text-xs text-text-muted">
                      {tAnalytics("requestTokenSummary", {
                        requests: fmtFull(tier.requests),
                        tokens: fmt(tier.totalTokens),
                      })}
                      {usageSavingsText}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`font-mono tabular-nums text-sm font-semibold ${getServiceTierCostClass(
                      tier.serviceTier
                    )}`}
                  >
                    {fmtCost(tier.cost)}
                  </div>
                  <div className="text-xs text-text-muted">{costDetailText}</div>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${getServiceTierBarClass(tier.serviceTier)}`}
                  style={{ width: `${requestPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── UsageDetail ────────────────────────────────────────────────────────────

export function UsageDetail({ summary }) {
  const t = useTranslations("analytics");
  const items = [
    { label: t("chartInput"), value: summary?.promptTokens, color: "text-text-muted" },
    { label: t("chartCacheRead"), value: 0, color: "text-text-muted" },
    { label: t("chartOutput"), value: summary?.completionTokens, color: "text-text-muted" },
  ];

  return (
    <Card className="p-4 flex-1">
      <h3 className="text-sm font-semibold text-text-main mb-3">{t("chartUsageDetail")}</h3>
      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className={`text-sm ${item.color}`}>{item.label}</span>
            <span className="font-mono tabular-nums font-medium text-sm text-text-main">
              {fmtFull(item.value)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── ProviderTable ──────────────────────────────────────────────────────────

export function ProviderTable({ byProvider }) {
  const t = useTranslations("analytics");
  const [sortBy, setSortBy] = useState("totalTokens");
  const [sortOrder, setSortOrder] = useState("desc");

  const data = useMemo(() => byProvider || [], [byProvider]);
  const totalTokens = useMemo(() => data.reduce((acc, p) => acc + p.totalTokens, 0), [data]);

  const toggleSort = useCallback(
    (field) => {
      if (sortBy === field) {
        setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortBy(field);
        setSortOrder("desc");
      }
    },
    [sortBy]
  );

  const sorted = useMemo(() => {
    const arr = [...data];
    arr.sort((a, b) => {
      const va = a[sortBy] ?? 0;
      const vb = b[sortBy] ?? 0;
      if (typeof va === "string")
        return sortOrder === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortOrder === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [data, sortBy, sortOrder]);

  if (!data.length) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-main mb-3">{t("chartProviderBreakdown")}</h3>
        <div className="text-center text-text-muted text-sm py-8">{t("chartNoData")}</div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-sm font-semibold text-text-main">{t("chartProviderBreakdown")}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs font-medium text-text-muted bg-surface-2/60">
            <tr>
              <th
                className="px-4 py-2.5 text-left cursor-pointer group"
                onClick={() => toggleSort("provider")}
              >
                {t("chartProvider")}{" "}
                <SortIndicator active={sortBy === "provider"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("requests")}
              >
                {t("chartRequests")}{" "}
                <SortIndicator active={sortBy === "requests"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("promptTokens")}
              >
                {t("chartInput")}{" "}
                <SortIndicator active={sortBy === "promptTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("completionTokens")}
              >
                {t("chartOutput")}{" "}
                <SortIndicator active={sortBy === "completionTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("totalTokens")}
              >
                {t("chartTotal")}{" "}
                <SortIndicator active={sortBy === "totalTokens"} sortOrder={sortOrder} />
              </th>
              <th
                className="px-4 py-2.5 text-right cursor-pointer group"
                onClick={() => toggleSort("cost")}
              >
                {t("chartCost")} <SortIndicator active={sortBy === "cost"} sortOrder={sortOrder} />
              </th>
              <th className="px-4 py-2.5 text-right w-36">{t("chartShare")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((p, i) => {
              const pct = totalTokens > 0 ? ((p.totalTokens / totalTokens) * 100).toFixed(1) : "0";
              return (
                <tr key={`${p.provider}-${i}`} className="hover:bg-surface-2/60 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: PROVIDER_COLORS[i % PROVIDER_COLORS.length] }}
                      />
                      <span className="font-medium capitalize">{p.provider}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-muted">
                    {fmtFull(p.requests)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                    {fmt(p.promptTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                    {fmt(p.completionTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-text-main">
                    {fmt(p.totalTokens)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-text-main">
                    {fmtCost(p.cost)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-16 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: PROVIDER_COLORS[i % PROVIDER_COLORS.length],
                          }}
                        />
                      </div>
                      <span className="text-xs font-mono text-text-muted w-10 text-right">
                        {pct}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
