"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";

export interface ApiKeyUsageLimitPayload {
  key: {
    id: string;
    name: string;
    usageLimitEnabled: boolean;
    dailyUsageLimitUsd: number | null;
    weeklyUsageLimitUsd: number | null;
  };
  status: {
    enabled: boolean;
    dailyLimitUsd: number | null;
    weeklyLimitUsd: number | null;
    dailySpentUsd: number;
    weeklySpentUsd: number;
    dailyWindowStartIso: string;
    dailyResetAtIso: string;
    weeklyWindowStartIso: string;
    weeklyResetAtIso: string | null;
    dailyExceeded: boolean;
    weeklyExceeded: boolean;
  };
}

export interface ApiKeyUsageLimitSavePayload {
  usageLimitEnabled: boolean;
  dailyUsageLimitUsd: number | null;
  weeklyUsageLimitUsd: number | null;
}

function createCurrencyFormatter(locale: string) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseUsdInput(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatResetHint(resetAtIso: string | null, t: ReturnType<typeof useTranslations>): string {
  if (!resetAtIso) return t("fallbackRollingDays", { days: 7 });
  const resetMs = Date.parse(resetAtIso);
  if (!Number.isFinite(resetMs)) return t("fallbackRollingDays", { days: 7 });
  const deltaMs = resetMs - Date.now();
  if (deltaMs <= 0) return t("resetDueNow");
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  if (deltaMs < dayMs) {
    return t("resetsInHours", { count: Math.max(1, Math.ceil(deltaMs / hourMs)) });
  }
  return t("resetsInDays", { count: Math.max(1, Math.ceil(deltaMs / dayMs)) });
}

function UsageQuotaMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <p className="text-xs font-medium text-text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-text-main tabular-nums">
        {value}
      </p>
    </div>
  );
}

export function ApiKeyUsageLimitCard({
  payload,
  loading,
  locale,
  onSave,
}: {
  payload: ApiKeyUsageLimitPayload | null;
  loading: boolean;
  locale: string;
  onSave: (next: ApiKeyUsageLimitSavePayload) => Promise<void>;
}) {
  const t = useTranslations("usageLimits");
  const [enabled, setEnabled] = useState(false);
  const [dailyLimit, setDailyLimit] = useState("");
  const [weeklyLimit, setWeeklyLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!payload) return;
    setEnabled(payload.key.usageLimitEnabled);
    setDailyLimit(
      typeof payload.key.dailyUsageLimitUsd === "number"
        ? String(payload.key.dailyUsageLimitUsd)
        : ""
    );
    setWeeklyLimit(
      typeof payload.key.weeklyUsageLimitUsd === "number"
        ? String(payload.key.weeklyUsageLimitUsd)
        : ""
    );
    setError(null);
  }, [payload]);

  const formatter = useMemo(() => createCurrencyFormatter(locale), [locale]);
  const status = payload?.status;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        usageLimitEnabled: enabled,
        dailyUsageLimitUsd: parseUsdInput(dailyLimit),
        weeklyUsageLimitUsd: parseUsdInput(weeklyLimit),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-text-muted text-[18px]">paid</span>
            <h3 className="text-sm font-semibold text-text-main">{t("apiKeyUsdQuota")}</h3>
            {payload?.key.name && (
              <span
                className="truncate rounded-control bg-surface-2 px-2 py-0.5 text-xs text-text-muted"
                title={payload.key.name}
              >
                {payload.key.name}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">{t("apiKeyUsdQuotaDescription")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={loading || !payload}
          onClick={() => setEnabled((prev) => !prev)}
          className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 py-2 text-xs font-semibold transition-colors ${
            enabled
              ? "border-primary/30 bg-primary/10 text-primary-text"
              : "border-border bg-surface-2 text-text-muted"
          } ${loading || !payload ? "opacity-50" : ""}`}
        >
          <span className="material-symbols-outlined text-[14px]">paid</span>
          {enabled ? t("enabled") : t("disabled")}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <UsageQuotaMetric
          label={t("dailySpend")}
          value={loading || !status ? "..." : formatter.format(status.dailySpentUsd)}
        />
        <UsageQuotaMetric
          label={t("weeklySpend")}
          value={loading || !status ? "..." : formatter.format(status.weeklySpentUsd)}
        />
        <div className="rounded-card border border-border bg-surface p-4">
          <label className="text-xs font-medium text-text-muted">{t("dailyQuota")}</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={dailyLimit}
            onChange={(event) => setDailyLimit(event.target.value)}
            className="mt-2 w-full rounded-control border border-border bg-surface px-2 py-1.5 text-sm text-text-main"
            placeholder="0.00"
          />
        </div>
        <div className="rounded-card border border-border bg-surface p-4">
          <label className="text-xs font-medium text-text-muted">{t("weeklyQuota")}</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={weeklyLimit}
            onChange={(event) => setWeeklyLimit(event.target.value)}
            className="mt-2 w-full rounded-control border border-border bg-surface px-2 py-1.5 text-sm text-text-main"
            placeholder="0.00"
          />
          <p className="mt-1 text-[10px] text-text-muted">
            {formatResetHint(status?.weeklyResetAtIso ?? null, t)}
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-xs text-error">{error}</p>}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading || !payload}
          className="inline-flex items-center gap-1.5 rounded-control bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-[14px]">
            {saving ? "hourglass_empty" : "save"}
          </span>
          {saving ? t("saving") : t("saveQuota")}
        </button>
      </div>
    </Card>
  );
}
