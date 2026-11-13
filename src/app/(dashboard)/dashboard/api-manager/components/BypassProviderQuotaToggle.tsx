"use client";

import { useTranslations } from "next-intl";

/**
 * "Bypass provider quota cutoffs" toggle for the API Key permissions modal.
 * Extracted out of ApiManagerPageClient.tsx (to keep that file small)
 * following the same pattern as
 * UsageLimitSettings.tsx — pure UI move, no behavior change.
 */
export function BypassProviderQuotaToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const tc = useTranslations("common");
  const t = useTranslations("apiManager");

  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-lg border border-warning/20 bg-warning/5">
      <div className="flex flex-col gap-1 pr-2">
        <p className="text-sm font-medium text-text-main">{t("bypassProviderQuota")}</p>
        <p className="text-xs text-text-muted">{t("bypassProviderQuotaDescription")}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={onToggle}
        className={`inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${
          enabled
            ? "bg-warning/15 text-warning border border-warning/30"
            : "bg-surface-2 text-text-muted border border-border"
        }`}
      >
        <span className="material-symbols-outlined text-[14px]">alt_route</span>
        {enabled ? tc("enabled") : tc("disabled")}
      </button>
    </div>
  );
}
