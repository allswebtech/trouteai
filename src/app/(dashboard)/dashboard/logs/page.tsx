"use client";

import { useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ConfirmModal, RequestLoggerV2 } from "@/shared/components";
import UsageTabs, { UsageMoreFor } from "@/shared/components/UsageTabs";
import { useTranslations } from "next-intl";

const TIME_RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
];

type LogsTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

function logsText(
  t: LogsTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
) {
  if (typeof t.has !== "function" || !t.has(key)) return fallback;
  return values ? t(key, values) : t(key);
}

function LogsPageContent() {
  const searchParams = useSearchParams();
  // Read ONCE: freezing this value fixed the detail modal reopening on first close by freezing this
  // value, and a page rewrite regressed it by reading the live searchParams on
  // every render — the prop flips mid-session and re-fires the child's deep-link effect
  // exactly when the modal closes.
  const [initialId] = useState(() => searchParams.get("id"));

  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showCleanHistory, setShowCleanHistory] = useState(false);
  const [cleaningHistory, setCleaningHistory] = useState(false);
  const [cleanHistoryStatus, setCleanHistoryStatus] = useState<string | null>(null);
  const [requestLogKey, setRequestLogKey] = useState(0);
  const requestLoggerRef = useRef<any>(null);
  const t = useTranslations("logs") as LogsTranslator;

  async function handleExport(hours: number) {
    setExporting(true);
    setShowExport(false);
    try {
      const logType = "request-logs";
      const res = await fetch(`/api/logs/export?hours=${hours}&type=${logType}`);
      if (!res.ok) throw new Error(t("exportFailed"));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `trouteai-${logType}-${hours}h-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(t("exportFailed"), err);
    } finally {
      setExporting(false);
    }
  }

  async function handleCleanHistory() {
    setCleaningHistory(true);
    setShowCleanHistory(false);
    setCleanHistoryStatus(null);
    try {
      const res = await fetch("/api/settings/purge-request-history", { method: "POST" });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(
          data?.error || logsText(t, "cleanHistoryFailed", "Failed to clean log history.")
        );
      }

      const deleted = typeof data?.deleted === "number" ? data.deleted : 0;
      const deletedArtifacts =
        typeof data?.deletedArtifacts === "number" ? data.deletedArtifacts : 0;
      const deletedDetailedLogs =
        typeof data?.deletedDetailedLogs === "number" ? data.deletedDetailedLogs : 0;
      const successFallback = `Cleaned ${deleted} log entr${deleted === 1 ? "y" : "ies"}, ${deletedArtifacts} artifact${
        deletedArtifacts === 1 ? "" : "s"
      }, and ${deletedDetailedLogs} legacy detail row${deletedDetailedLogs === 1 ? "" : "s"}.`;
      setRequestLogKey((key) => key + 1);
      setCleanHistoryStatus(
        deleted || deletedArtifacts || deletedDetailedLogs
          ? logsText(t, "cleanHistorySuccess", successFallback, {
              deleted,
              deletedArtifacts,
              deletedDetailedLogs,
            })
          : logsText(t, "cleanHistoryEmpty", "No request log history was found.")
      );
    } catch (err) {
      console.error(logsText(t, "cleanHistoryFailed", "Failed to clean log history."), err);
      setCleanHistoryStatus(
        err instanceof Error
          ? err.message
          : logsText(t, "cleanHistoryFailed", "Failed to clean log history.")
      );
    } finally {
      setCleaningHistory(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <UsageTabs active="requests" />

      {cleanHistoryStatus && (
        <div className="flex-shrink-0 rounded-card border border-border bg-surface px-4 py-3 text-sm text-text-muted">
          {cleanHistoryStatus}
        </div>
      )}

      <div className="min-h-0">
        <RequestLoggerV2 key={requestLogKey} ref={requestLoggerRef} initialSelectedId={initialId} />
      </div>

      <UsageMoreFor tab="requests">
        <button
          id="export-logs-btn"
          type="button"
          onClick={() => setShowExport(!showExport)}
          disabled={exporting}
          aria-expanded={showExport}
          className="focus-ring flex min-h-11 items-center justify-between gap-2 px-4 text-start text-sm text-text-main hover:bg-surface-2 disabled:opacity-50"
        >
          {exporting ? t("exporting") : t("export")}
        </button>
        {showExport && (
          <div className="flex flex-col border-t border-border/50 bg-surface-2/40">
            {TIME_RANGES.map((range) => (
              <button
                key={range.hours}
                id={`export-${range.hours}h-btn`}
                type="button"
                onClick={() => handleExport(range.hours)}
                className="focus-ring flex min-h-11 items-center justify-between gap-3 px-6 text-start text-sm text-text-main hover:bg-surface-2"
              >
                <span>{t("lastNHours", { hours: range.label })}</span>
                <span className="text-xs text-text-muted">
                  {range.hours === 24 ? t("defaultRange") : ""}
                </span>
              </button>
            ))}
          </div>
        )}
        <button
          id="clean-log-history-btn"
          type="button"
          onClick={() => setShowCleanHistory(true)}
          disabled={cleaningHistory}
          className="focus-ring flex min-h-11 items-center px-4 text-start text-sm text-error hover:bg-error/10 disabled:opacity-50"
        >
          {logsText(t, "cleanHistoryButton", "Clean history")}
        </button>
      </UsageMoreFor>

      <ConfirmModal
        isOpen={showCleanHistory}
        onClose={() => setShowCleanHistory(false)}
        onConfirm={handleCleanHistory}
        title={logsText(t, "cleanHistoryTitle", "Clean log history?")}
        message={logsText(
          t,
          "cleanHistoryMessage",
          "This permanently clears all request log rows, legacy detail rows, and local artifact files under DATA_DIR/call_logs. The live page will refresh after cleanup."
        )}
        confirmText={logsText(t, "cleanHistoryConfirm", "Clean history")}
        cancelText={logsText(t, "cleanHistoryCancel", "Cancel")}
        loading={cleaningHistory}
      />
    </div>
  );
}

export default function LogsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12 text-text-muted text-sm">
          Loading logs...
        </div>
      }
    >
      <LogsPageContent />
    </Suspense>
  );
}
