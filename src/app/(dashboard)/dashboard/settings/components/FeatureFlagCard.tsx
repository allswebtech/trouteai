"use client";

import { useTranslations } from "next-intl";

interface FeatureFlagCardProps {
  flag: {
    key: string;
    label: string;
    description: string;
    category: "security" | "network" | "policies" | "runtime" | "cli" | "health";
    type: "boolean" | "enum";
    enumValues?: string[] | null;
    effectiveValue: string;
    source: "db" | "env" | "default";
    requiresRestart: boolean;
    warningLevel?: "info" | "caution" | "danger";
  };
  onToggle: (key: string, newValue: string) => void;
  onReset: (key: string) => void;
  saving?: boolean;
}

const CATEGORY_STYLES: Record<
  FeatureFlagCardProps["flag"]["category"],
  { bg: string; border: string; text: string }
> = {
  security: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
  network: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
  policies: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
  runtime: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
  cli: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
  health: { bg: "bg-surface-2", border: "border-border", text: "text-text-muted" },
};

const SOURCE_STYLES: Record<
  FeatureFlagCardProps["flag"]["source"],
  { bg: string; border: string; text: string; label: string }
> = {
  db: {
    bg: "bg-primary/10 dark:bg-primary/20",
    border: "border-primary/30",
    text: "text-primary-text",
    label: "DB",
  },
  env: {
    bg: "bg-warning/10 dark:bg-warning/20",
    border: "border-warning/30",
    text: "text-warning",
    label: "ENV",
  },
  default: {
    bg: "bg-surface-2",
    border: "border-border dark:border-border",
    text: "text-text-muted dark:text-text-muted",
    label: "DEF",
  },
};

function isEnabled(value: string): boolean {
  return value === "true" || value === "1" || value === "yes";
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-text-main"
      aria-hidden="true"
    />
  );
}

/**
 * `EXPOSE_CC_DISCOVERY_ALIASES` resolves with env-wins-over-db precedence (see
 * db/ccDiscoveryAliases.ts::getCcAliasGlobalState), the opposite of every other
 * flag — so a plain ENV badge could be misread as "toggle it off here" when the
 * environment variable is what is actually forcing it on. Renders nothing for
 * any other flag or source.
 */
function EnvPrecedenceWarning({
  flag,
  text,
}: {
  flag: FeatureFlagCardProps["flag"];
  text: string;
}) {
  if (flag.key !== "EXPOSE_CC_DISCOVERY_ALIASES" || flag.source !== "env") return null;
  return (
    <p className="mb-3 rounded border border-warning/30 bg-warning/10 px-2 py-1 text-xs text-warning">
      {text}
    </p>
  );
}

export default function FeatureFlagCard({
  flag,
  onToggle,
  onReset,
  saving = false,
}: FeatureFlagCardProps) {
  const t = useTranslations("featureFlags");
  const enabled = flag.type === "boolean" ? isEnabled(flag.effectiveValue) : false;
  const category = CATEGORY_STYLES[flag.category];
  const source = SOURCE_STYLES[flag.source];

  const cardBorder = "border-border";

  return (
    <div
      role="group"
      aria-label={flag.label}
      className={`rounded-card border bg-surface p-4 transition-colors duration-200 hover:border-text-muted/30 ${cardBorder}`}
    >
      {/* Top row: category badge + toggle/select */}
      <div className="flex items-center justify-between mb-3">
        <span
          aria-label={t("categoryLabel", { category: t(`categories.${flag.category}`) })}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${category.bg} ${category.border} ${category.text}`}
        >
          {t(`categories.${flag.category}`)}
        </span>

        <div className="flex items-center gap-2">
          {saving && <Spinner />}

          {flag.type === "boolean" ? (
            <button
              role="switch"
              aria-checked={enabled}
              aria-label={flag.label}
              disabled={saving}
              onClick={() => onToggle(flag.key, enabled ? "false" : "true")}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${
                enabled ? "bg-primary" : "bg-surface-2 border border-border"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
                aria-hidden="true"
              />
            </button>
          ) : (
            <select
              aria-label={flag.label}
              disabled={saving}
              value={flag.effectiveValue}
              onChange={(e) => onToggle(flag.key, e.target.value)}
              className="rounded-md border border-border bg-bg-subtle px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(flag.enumValues ?? []).map((val) => (
                <option key={val} value={val} className="bg-card text-text-primary">
                  {t.has(`enumValues.${val}`) ? t(`enumValues.${val}`) : val}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Flag key + warning icon */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="flex-1 truncate font-mono text-xs font-semibold text-text-primary">
          {flag.key}
        </span>

        {flag.warningLevel === "caution" && (
          <span className="text-sm text-warning" aria-label={t("caution")}>
            ⚠️
          </span>
        )}
        {flag.warningLevel === "danger" && (
          <span className="text-sm animate-pulse" aria-label={t("danger")}>
            🔴
          </span>
        )}
        {flag.requiresRestart && (
          <span
            className="rounded border border-border bg-surface-2 px-1 text-[10px] text-text-muted dark:bg-transparent"
            title={t("requiresRestart")}
            aria-label={t("requiresRestart")}
          >
            restart
          </span>
        )}
      </div>

      {/* Description */}
      <p className="mb-3 line-clamp-2 text-xs text-text-muted">{flag.description}</p>

      <EnvPrecedenceWarning flag={flag} text={t("ccDiscoveryAliasesEnvWarning")} />

      {/* Bottom row: source badge + reset button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-muted">{t("source")}:</span>
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-medium ${source.bg} ${source.border} ${source.text}`}
          >
            {source.label}
          </span>
        </div>

        {flag.source === "db" && (
          <button
            aria-label={t("resetFlag", { label: flag.label })}
            disabled={saving}
            onClick={() => onReset(flag.key)}
            className="inline-flex items-center gap-1 rounded text-xs text-text-muted transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
              refresh
            </span>
            {t("reset")}
          </button>
        )}
      </div>
    </div>
  );
}
