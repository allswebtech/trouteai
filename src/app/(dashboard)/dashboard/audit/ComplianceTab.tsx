"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Card, EmptyState } from "@/shared/components";

type AuditEntry = {
  id: number;
  timestamp: string;
  action: string;
  actor: string;
  target?: string | null;
  details?: unknown;
  metadata?: unknown;
  ip_address?: string | null;
  ip?: string | null;
  resourceType?: string | null;
  status?: string | null;
  requestId?: string | null;
};

type Severity = "info" | "warning" | "critical";

const PAGE_SIZE = 50;

function getSeverity(entry: AuditEntry): Severity {
  const action = entry.action.toLowerCase();
  const status = (entry.status || "").toLowerCase();

  if (
    status === "error" ||
    status === "failed" ||
    status === "blocked" ||
    action.includes("blocked") ||
    action.includes("denied") ||
    action.includes("violation") ||
    action.includes("delete") ||
    action.includes("remove")
  ) {
    return "critical";
  }

  if (status === "warning" || action.includes("warning") || action.includes("validate")) {
    return "warning";
  }

  return "info";
}

function formatJson(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatLocalDate(value: string) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function ComplianceTab() {
  const t = useTranslations("compliance");
  const tc = useTranslations("common");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventType, setEventType] = useState("");
  const [actor, setActor] = useState("");
  const [severity, setSeverity] = useState<"all" | Severity>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  // Pure UI: actor and date range live behind one "Filters" toggle.
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const hiddenFilterCount = [actor, from, to].filter(Boolean).length;

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (actor) params.set("actor", actor);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      if (eventType) params.set("action", eventType);
      if (from) params.set("from", from);
      if (to) params.set("to", to);

      const response = await fetch(`/api/compliance/audit-log?${params.toString()}`);
      const data = await response.json().catch(() => []);
      if (!response.ok) {
        throw new Error(data.error || t("failedFetch"));
      }

      setEntries(Array.isArray(data) ? data : []);
      const total = Number(response.headers.get("x-total-count") || "0");
      setTotalCount(Number.isFinite(total) ? total : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("failedFetch"));
    } finally {
      setLoading(false);
    }
  }, [actor, eventType, from, offset, t, to]);

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  const visibleEntries = useMemo(() => {
    if (severity === "all") return entries;
    return entries.filter((entry) => getSeverity(entry) === severity);
  }, [entries, severity]);

  const eventTypes = useMemo(() => {
    return Array.from(new Set(entries.map((entry) => entry.action).filter(Boolean))).sort();
  }, [entries]);

  const actors = useMemo(() => {
    return Array.from(new Set(entries.map((entry) => entry.actor).filter(Boolean))).sort();
  }, [entries]);

  const canGoNext = offset + PAGE_SIZE < totalCount;

  const resetFilters = () => {
    setEventType("");
    setActor("");
    setSeverity("all");
    setFrom("");
    setTo("");
    setOffset(0);
  };

  const exportVisibleEntries = () => {
    const payload = JSON.stringify(visibleEntries, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trouteai-compliance-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const severityClass = (value: Severity) => {
    if (value === "critical") return "border-error/30 bg-error/10 text-error";
    if (value === "warning") return "border-warning/30 bg-warning/10 text-warning";
    return "border-border bg-surface-2 text-text-muted";
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-text-main">{t("title")}</h2>
            <p className="mt-1 text-sm text-text-muted">{t("description")}</p>
            <p className="mt-2 text-xs text-text-muted">
              {t("showing", { count: visibleEntries.length, total: totalCount })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void fetchEntries()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-control border border-border bg-surface px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-surface-2 disabled:opacity-40"
            >
              <span
                className={`material-symbols-outlined text-[16px] ${loading ? "animate-spin" : ""}`}
              >
                refresh
              </span>
              {t("refresh")}
            </button>
            <button
              onClick={exportVisibleEntries}
              disabled={visibleEntries.length === 0}
              className="inline-flex items-center gap-2 rounded-control bg-primary px-3 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[16px]">download</span>
              {t("export")}
            </button>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className="space-y-1">
            <span className="text-xs font-medium text-text-muted">{t("eventType")}</span>
            <input
              list="compliance-event-types"
              value={eventType}
              onChange={(event) => {
                setOffset(0);
                setEventType(event.target.value);
              }}
              placeholder={t("eventTypePlaceholder")}
              className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <datalist id="compliance-event-types">
              {eventTypes.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium text-text-muted">{t("severity")}</span>
            <select
              value={severity}
              onChange={(event) => {
                setOffset(0);
                setSeverity(event.target.value as "all" | Severity);
              }}
              className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="all">{t("allSeverities")}</option>
              <option value="info">{t("info")}</option>
              <option value="warning">{t("warning")}</option>
              <option value="critical">{t("critical")}</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setShowMoreFilters((v) => !v)}
              aria-expanded={showMoreFilters}
              aria-controls={showMoreFilters ? "compliance-more-filters" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-control border px-3 py-2 text-sm font-medium transition-colors ${
                showMoreFilters || hiddenFilterCount > 0
                  ? "border-primary/30 bg-primary/10 text-primary-text"
                  : "border-border bg-surface text-text-main hover:bg-surface-2"
              }`}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                tune
              </span>
              {tc("filters")}
              {hiddenFilterCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-on-primary tabular-nums">
                  {hiddenFilterCount}
                </span>
              )}
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {showMoreFilters ? "expand_less" : "expand_more"}
              </span>
            </button>
            <button
              onClick={resetFilters}
              className="whitespace-nowrap rounded-control border border-border bg-surface px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-surface-2"
            >
              {t("clearFilters")}
            </button>
          </div>
        </div>
        {showMoreFilters && (
          <div
            id="compliance-more-filters"
            className="mt-3 grid gap-3 border-t border-border pt-3 md:grid-cols-3"
          >
            <label className="space-y-1">
              <span className="text-xs font-medium text-text-muted">{t("actor")}</span>
              <input
                list="compliance-actors"
                value={actor}
                onChange={(event) => {
                  setOffset(0);
                  setActor(event.target.value);
                }}
                placeholder={t("actorPlaceholder")}
                className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <datalist id="compliance-actors">
                {actors.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-text-muted">{t("from")}</span>
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => {
                  setOffset(0);
                  setFrom(event.target.value);
                }}
                className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-text-muted">{t("to")}</span>
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => {
                  setOffset(0);
                  setTo(event.target.value);
                }}
                className="w-full rounded-control border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
          </div>
        )}
      </Card>

      {error && (
        <div className="rounded-control border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {error}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-text-muted">{t("loading")}</div>
        ) : visibleEntries.length === 0 ? (
          <EmptyState icon="policy" title={t("noEvents")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-xs text-text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">{t("timestamp")}</th>
                  <th className="px-4 py-3 font-medium">{t("eventType")}</th>
                  <th className="px-4 py-3 font-medium">{t("severity")}</th>
                  <th className="px-4 py-3 font-medium">{t("sourceIp")}</th>
                  <th className="px-4 py-3 font-medium">{t("userOrKey")}</th>
                  <th className="px-4 py-3 font-medium">{t("action")}</th>
                  <th className="px-4 py-3 font-medium">{t("result")}</th>
                  <th className="px-4 py-3 text-right font-medium">{t("details")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleEntries.map((entry) => {
                  const entrySeverity = getSeverity(entry);
                  return (
                    <tr key={entry.id} className="transition-colors hover:bg-surface-2/50">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-muted">
                        {formatLocalDate(entry.timestamp)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block rounded-control border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text-main">
                          {t.has(`eventTypes.${entry.action}`)
                            ? t(`eventTypes.${entry.action}`)
                            : entry.action}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${severityClass(entrySeverity)}`}
                        >
                          {t(entrySeverity)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-muted">
                        {entry.ip_address || entry.ip || t("notAvailable")}
                      </td>
                      <td className="px-4 py-3 text-text-main">{entry.actor || t("system")}</td>
                      <td
                        className="max-w-[220px] truncate px-4 py-3 text-text-muted"
                        title={entry.target || entry.resourceType || undefined}
                      >
                        {entry.target || entry.resourceType || t("notAvailable")}
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        {entry.status || t("notAvailable")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setSelectedEntry(entry)}
                          className="whitespace-nowrap rounded-control border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-main transition-colors hover:bg-surface-2"
                        >
                          {t("viewDetails")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
          disabled={offset === 0 || loading}
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          {t("previous")}
        </button>
        <button
          onClick={() => setOffset((current) => current + PAGE_SIZE)}
          disabled={!canGoNext || loading}
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm font-medium text-text-main transition-colors hover:bg-surface-2 disabled:opacity-40"
        >
          {t("next")}
        </button>
      </div>

      {selectedEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            aria-label={t("closeDetails")}
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setSelectedEntry(null)}
          />
          <div className="relative w-full max-w-3xl rounded-card border border-border bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-border p-4">
              <h3 className="text-sm font-semibold text-text-main">{t("details")}</h3>
              <button
                onClick={() => setSelectedEntry(null)}
                className="rounded-control p-2 text-text-muted hover:bg-surface-2 hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>
            <pre className="max-h-[70vh] overflow-auto p-4 text-xs text-text-main">
              {formatJson(selectedEntry)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
