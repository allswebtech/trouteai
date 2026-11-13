"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { matchesSearch } from "@/shared/utils/turkishText";
import FeatureFlagCard from "./FeatureFlagCard";

// Type for flag data from API
interface FlagData {
  key: string;
  label: string;
  description: string;
  category: "security" | "network" | "policies" | "runtime" | "cli" | "health";
  type: "boolean" | "enum";
  enumValues: string[] | null;
  defaultValue: string;
  effectiveValue: string;
  source: "db" | "env" | "default";
  requiresRestart: boolean;
  warningLevel?: "info" | "caution" | "danger";
}

interface Summary {
  total: number;
  active: number;
  inactive: number;
  overriddenByDb: number;
  overriddenByEnv: number;
}

interface FlagUpdateResult {
  effectiveValue: string;
  source: FlagData["source"];
  previousValue: string;
  previousSource: FlagData["source"];
  requiresRestart: boolean;
}

const ACTIVE_VALUES = new Set(["true", "1", "yes"]);

function isActiveFlagValue(value: string): boolean {
  return ACTIVE_VALUES.has(value);
}

const CATEGORIES = [
  { value: "all", labelKey: "all" },
  { value: "security", labelKey: "security" },
  { value: "network", labelKey: "network" },
  { value: "policies", labelKey: "policies" },
  { value: "runtime", labelKey: "runtime" },
  { value: "cli", labelKey: "cli" },
  { value: "health", labelKey: "health" },
  // Synthetic "category" that filters by requiresRestart=true regardless of
  // real category — surfaces flags that need a process restart to take effect.
  { value: "__restart", labelKey: "requiresRestart" },
];

export default function FeatureFlagsGrid() {
  const t = useTranslations("featureFlags");
  const [flags, setFlags] = useState<FlagData[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [resettingAll, setResettingAll] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Set of flag keys whose DB override was changed in this session without
  // a subsequent restart. Used to surface the restart banner.
  const [pendingRestartKeys, setPendingRestartKeys] = useState<Set<string>>(new Set());
  const [restarting, setRestarting] = useState(false);
  const [showRestartConfirm, setShowRestartConfirm] = useState(false);

  const loadFlags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/feature-flags");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFlags(data.flags);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFlags(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFlags]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const applyFlagResult = useCallback((key: string, result: FlagUpdateResult) => {
    const wasActive = isActiveFlagValue(result.previousValue);
    const isNowActive = isActiveFlagValue(result.effectiveValue);
    const wasDb = result.previousSource === "db";
    const isNowDb = result.source === "db";
    const wasEnv = result.previousSource === "env";
    const isNowEnv = result.source === "env";

    setFlags((prev) =>
      prev.map((f) =>
        f.key === key ? { ...f, effectiveValue: result.effectiveValue, source: result.source } : f
      )
    );
    setSummary((s) =>
      s
        ? {
            ...s,
            active: s.active + (isNowActive ? 1 : 0) - (wasActive ? 1 : 0),
            inactive: s.inactive + (isNowActive ? 0 : 1) - (wasActive ? 0 : 1),
            overriddenByDb: s.overriddenByDb + (isNowDb ? 1 : 0) - (wasDb ? 1 : 0),
            overriddenByEnv: s.overriddenByEnv + (isNowEnv ? 1 : 0) - (wasEnv ? 1 : 0),
          }
        : s
    );
  }, []);

  const filteredFlags = useMemo(() => {
    return flags
      .filter((f) => {
        if (category === "all") return true;
        if (category === "__restart") return f.requiresRestart;
        return f.category === category;
      })
      .filter(
        (f) =>
          debouncedSearch === "" ||
          matchesSearch(f.key, debouncedSearch) ||
          matchesSearch(f.description, debouncedSearch) ||
          (t.has(`definitions.${f.key}.description`) &&
            matchesSearch(t(`definitions.${f.key}.description`), debouncedSearch))
      );
  }, [flags, debouncedSearch, category, t]);

  const handleToggle = useCallback(
    async (key: string, newValue: string) => {
      setSavingKeys((prev) => new Set(prev).add(key));
      try {
        const res = await fetch("/api/settings/feature-flags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value: newValue }),
        });
        if (!res.ok) {
          setError(t("updateFailedHttp", { status: res.status }));
          return;
        }
        const result = (await res.json()) as FlagUpdateResult;
        applyFlagResult(key, result);
        if (result.requiresRestart) {
          setPendingRestartKeys((prev) => new Set(prev).add(key));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("updateFailed"));
      } finally {
        setSavingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [applyFlagResult, t]
  );

  const handleReset = useCallback(
    async (key: string) => {
      setSavingKeys((prev) => new Set(prev).add(key));
      try {
        const res = await fetch("/api/settings/feature-flags", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }), // no value = remove override
        });
        if (!res.ok) {
          setError(t("updateFailedHttp", { status: res.status }));
          return;
        }
        const result = (await res.json()) as FlagUpdateResult;
        applyFlagResult(key, result);
        if (result.requiresRestart) {
          setPendingRestartKeys((prev) => new Set(prev).add(key));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t("updateFailed"));
      } finally {
        setSavingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [applyFlagResult, t]
  );

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const res = await fetch("/api/restart", { method: "POST" });
      if (!res.ok) {
        setError(t("restartFailedHttp", { status: res.status }));
        setShowRestartConfirm(false);
        setRestarting(false);
        return;
      }
      // Server is going down — wait for it to come back, then reload.
      const stillUp = async () => {
        try {
          const r = await fetch("/api/health/ping", { cache: "no-store" });
          return r.ok;
        } catch {
          return false;
        }
      };
      const waitDown = setInterval(async () => {
        if (!(await stillUp())) {
          clearInterval(waitDown);
          const waitUp = setInterval(async () => {
            if (await stillUp()) {
              clearInterval(waitUp);
              setPendingRestartKeys(new Set());
              window.location.reload();
            }
          }, 1000);
        }
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restartFailed"));
      setShowRestartConfirm(false);
      setRestarting(false);
    }
  }, [t]);

  const handleResetAll = useCallback(async () => {
    setResettingAll(true);
    try {
      const res = await fetch("/api/settings/feature-flags", { method: "DELETE" });
      if (!res.ok) {
        setError(t("resetOverridesFailedHttp", { status: res.status }));
        setShowResetConfirm(false);
        return;
      }
      await loadFlags();
      setShowResetConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("resetOverridesFailed"));
      setShowResetConfirm(false);
    } finally {
      setResettingAll(false);
    }
  }, [loadFlags, t]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-main">{t("title")}</h1>
          {summary && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-text-main tabular-nums">
                {t("activeCount", { count: summary.active })}
              </span>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted tabular-nums">
                {t("inactiveCount", { count: summary.inactive })}
              </span>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted tabular-nums">
                {t("dbOverrideCount", { count: summary.overriddenByDb })}
              </span>
            </div>
          )}
        </div>

        {/* Search + Filter */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {/* Search input with search icon */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-2.5 top-2 text-sm text-text-muted">
              search
            </span>
            <input
              type="text"
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-control border border-border bg-surface py-1.5 pl-8 pr-4 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 sm:w-64"
            />
          </div>

          {/* Category filter */}
          <select
            value={category}
            aria-label={t("categoryLabel", {
              category: t(
                `categories.${CATEGORIES.find((c) => c.value === category)?.labelKey ?? "all"}`
              ),
            })}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 sm:w-auto"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat.value} value={cat.value} className="bg-card text-text-primary">
                {t(`categories.${cat.labelKey}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Pending-restart banner — shown when at least one requiresRestart flag
          was toggled in this session. */}
      {pendingRestartKeys.size > 0 && (
        <div className="rounded-card border border-warning/30 bg-warning/10 p-4 dark:border-warning/40">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-warning">restart_alt</span>
              <div>
                <p className="text-sm font-medium text-warning">
                  {t("restartRequiredCount", { count: pendingRestartKeys.size })}
                </p>
                <p className="mt-0.5 text-xs text-warning">{t("restartRequiredDescription")}</p>
              </div>
            </div>
            {!showRestartConfirm ? (
              <button
                onClick={() => setShowRestartConfirm(true)}
                className="shrink-0 rounded-control border border-warning/30 bg-transparent px-4 py-2 text-sm font-medium text-warning transition-colors hover:bg-warning/10"
              >
                {t("restartServer")}
              </button>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowRestartConfirm(false)}
                  className="text-sm text-warning hover:text-warning"
                  disabled={restarting}
                >
                  {t("cancel")}
                </button>
                <button
                  onClick={handleRestart}
                  disabled={restarting}
                  className="rounded-control border border-warning/40 bg-warning/15 px-4 py-2 text-sm font-medium text-warning transition-colors hover:bg-warning/25 disabled:opacity-50"
                >
                  {restarting ? t("restarting") : t("confirmRestart")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Explanation banner for the synthetic "Requires Restart" view */}
      {category === "__restart" && (
        <div className="rounded-card border border-primary/30 bg-primary/10 p-3 text-sm text-primary-text">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-primary-text">info</span>
            <p>
              {t.rich("restartViewDescription", { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div
          className="grid gap-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}
        >
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-card bg-surface-2" />
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="flex items-center justify-between rounded-card border border-error/30 bg-error/10 p-4">
          <p className="text-sm text-error">{error}</p>
          <button
            onClick={loadFlags}
            className="text-sm font-medium text-error underline hover:no-underline"
          >
            {t("retry")}
          </button>
        </div>
      )}

      {/* Grid */}
      {!loading && !error && (
        <>
          {filteredFlags.length === 0 ? (
            <div className="py-16 text-center text-text-muted">
              <span className="material-symbols-outlined text-4xl">search_off</span>
              <p className="mt-2 text-sm">{t("noSearchResults")}</p>
            </div>
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))" }}
            >
              {filteredFlags.map((flag) => (
                <FeatureFlagCard
                  key={flag.key}
                  flag={{
                    ...flag,
                    label: t.has(`definitions.${flag.key}.label`)
                      ? t(`definitions.${flag.key}.label`)
                      : flag.label,
                    description: t.has(`definitions.${flag.key}.description`)
                      ? t(`definitions.${flag.key}.description`)
                      : flag.description,
                  }}
                  onToggle={handleToggle}
                  onReset={handleReset}
                  saving={savingKeys.has(flag.key)}
                />
              ))}
            </div>
          )}

          {/* Reset All button */}
          {summary && summary.overriddenByDb > 0 && (
            <div className="flex justify-end border-t border-border pt-4">
              {!showResetConfirm ? (
                <button
                  onClick={() => setShowResetConfirm(true)}
                  className="rounded-control border border-error/30 bg-transparent px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error/10"
                >
                  {t("resetAllOverrides")}
                </button>
              ) : (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-text-muted">
                    {t("confirmResetOverrides", { count: summary.overriddenByDb })}
                  </p>
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    className="text-sm text-text-muted hover:text-text-primary"
                  >
                    {t("cancel")}
                  </button>
                  <button
                    onClick={handleResetAll}
                    disabled={resettingAll}
                    className="rounded-control border border-error/40 bg-error/15 px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error/25 disabled:opacity-50"
                  >
                    {resettingAll ? t("resetting") : t("confirmReset")}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
