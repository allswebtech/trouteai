"use client";

import { useTranslations } from "next-intl";

import { providerText } from "../providerPageHelpers";

interface ProviderQuotaVisibilityToggleProps {
  visible: boolean;
  onToggle: (visible: boolean) => void;
}

export default function ProviderQuotaVisibilityToggle({
  visible,
  onToggle,
}: ProviderQuotaVisibilityToggleProps) {
  const t = useTranslations("providers");
  const actionLabel = visible
    ? providerText(t, "hideConnectionFromProviderQuota", "Hide this account from Provider Quota")
    : providerText(t, "showConnectionInProviderQuota", "Show this account in Provider Quota");

  return (
    <>
      <button
        type="button"
        onClick={() => onToggle(!visible)}
        aria-pressed={visible}
        aria-label={actionLabel}
        className={`inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors ${
          visible
            ? "bg-info/15 text-info hover:bg-info/25"
            : "bg-surface-2 text-text-muted hover:text-text-main hover:bg-border"
        }`}
        title={actionLabel}
      >
        <span className="material-symbols-outlined text-[13px]">
          {visible ? "visibility" : "visibility_off"}
        </span>
        {providerText(t, "providerQuotaShort", "Quota")}
      </button>
    </>
  );
}
