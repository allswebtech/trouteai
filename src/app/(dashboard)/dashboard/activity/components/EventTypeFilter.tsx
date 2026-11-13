"use client";

import { useTranslations } from "next-intl";

export type EventCategory =
  "all" | "providers" | "combos" | "apikeys" | "settings" | "quota" | "auth" | "system";

interface EventTypeFilterProps {
  value: EventCategory;
  onChange: (category: EventCategory) => void;
}

const CATEGORIES: EventCategory[] = [
  "all",
  "providers",
  "combos",
  "apikeys",
  "settings",
  "quota",
  "auth",
  "system",
];

const CATEGORY_PREFIXES: Record<EventCategory, string[]> = {
  all: [],
  providers: ["provider."],
  combos: ["combo."],
  apikeys: ["apikey."],
  settings: ["setting."],
  quota: ["quota.", "budget."],
  auth: ["auth."],
  system: ["update.", "deploy.", "skill.", "cloud_agent.", "mcp.", "webhook."],
};

export function matchesCategory(action: string, category: EventCategory): boolean {
  if (category === "all") return true;
  const prefixes = CATEGORY_PREFIXES[category];
  return prefixes.some((prefix) => action.startsWith(prefix));
}

export default function EventTypeFilter({ value, onChange }: EventTypeFilterProps) {
  const t = useTranslations("activity");

  const labelKey: Record<EventCategory, string> = {
    all: "filterAll",
    providers: "filterProviders",
    combos: "filterCombos",
    apikeys: "filterApiKeys",
    settings: "filterSettings",
    quota: "filterQuota",
    auth: "filterAuth",
    system: "filterSystem",
  };

  return (
    <div
      className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5"
      role="group"
      aria-label={t("filterAria")}
    >
      {CATEGORIES.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => onChange(cat)}
          aria-pressed={value === cat}
          className={[
            "h-7 px-3 rounded-md text-sm font-medium whitespace-nowrap border transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            value === cat
              ? "bg-surface text-text-main border-border dark:bg-white/10"
              : "border-transparent text-text-muted hover:text-text-main",
          ].join(" ")}
        >
          {t(labelKey[cat])}
        </button>
      ))}
    </div>
  );
}
