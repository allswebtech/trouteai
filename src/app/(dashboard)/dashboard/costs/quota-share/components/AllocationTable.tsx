"use client";

import { useTranslations } from "next-intl";
import type { PoolAllocation } from "@/lib/quota/dimensions";
import type { PoolUsageSnapshot } from "@/lib/quota/types";
import { CHART_SERIES_PALETTE } from "@/shared/constants/chartPalette";

interface AllocationTableProps {
  allocations: PoolAllocation[];
  usage: PoolUsageSnapshot | null;
  /** Map from apiKeyId to display name */
  keyLabels: Record<string, string>;
}

const SLICE_PALETTE = CHART_SERIES_PALETTE;

export default function AllocationTable({ allocations, usage, keyLabels }: AllocationTableProps) {
  const t = useTranslations("quotaShare");

  if (allocations.length === 0) {
    return (
      <div className="text-[11px] text-text-muted italic py-3 text-center bg-bg-subtle/40 rounded-md">
        {t("noAllocations")}
      </div>
    );
  }

  // Build per-key consumption lookup from first dimension (primary)
  const primaryDim = usage?.dimensions?.[0];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-xs text-text-muted border-b border-border">
            <th className="text-left py-1 pr-2 font-semibold">{t("apiKeyColumn")}</th>
            <th className="text-right py-1 pr-2 font-semibold">{t("weightColumn")}</th>
            <th className="text-right py-1 pr-2 font-semibold">{t("realConsumedColumn")}</th>
            <th className="text-right py-1 pr-2 font-semibold">{t("deficitColumn")}</th>
            <th className="text-right py-1 font-semibold">{t("policy")}</th>
          </tr>
        </thead>
        <tbody>
          {allocations.map((alloc, i) => {
            const color = SLICE_PALETTE[i % SLICE_PALETTE.length];
            const label = keyLabels[alloc.apiKeyId] || alloc.apiKeyId.slice(0, 12) + "…";

            const perKeyData = primaryDim?.perKey?.find((k) => k.apiKeyId === alloc.apiKeyId);
            const consumed = perKeyData?.consumed ?? null;
            const fairShare = perKeyData?.fairShare ?? null;
            const deficit = perKeyData !== undefined ? perKeyData.deficit : null;
            const borrowing = perKeyData?.borrowing ?? false;

            return (
              <tr key={alloc.apiKeyId} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 pr-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: color }}
                    />
                    <span className="font-mono truncate text-text-main">{label}</span>
                    {borrowing && (
                      <span
                        className="text-[10px] px-1 py-0.5 rounded bg-warning/10 text-warning font-bold shrink-0"
                        title={t("borrowingIndicator")}
                      >
                        {t("borrowingIndicator")}
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-1.5 pr-2 text-right font-bold tabular-nums" style={{ color }}>
                  {alloc.weight}%
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted">
                  {consumed !== null ? consumed.toLocaleString() : "—"}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {deficit !== null ? (
                    <span
                      className={
                        deficit > 0
                          ? "text-error"
                          : deficit < 0
                            ? "text-success"
                            : "text-text-muted"
                      }
                    >
                      {deficit > 0 ? "+" : ""}
                      {deficit.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                  {fairShare !== null && (
                    <span className="text-[11px] text-text-muted ml-1">
                      ({t("fairShareShort")}: {fairShare.toLocaleString()})
                    </span>
                  )}
                </td>
                <td className="py-1.5 text-right">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      alloc.policy === "hard"
                        ? "bg-error/10 text-error"
                        : alloc.policy === "soft"
                          ? "bg-warning/10 text-warning"
                          : "bg-success/10 text-success"
                    }`}
                  >
                    {t(`policy${alloc.policy[0].toUpperCase()}${alloc.policy.slice(1)}`)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
