"use client";
import { pickDisplayValue } from "@/shared/utils/maskEmail";

type BatchTestResultsModalProps = {
  batchTestResults: {
    error?: any;
    results?: Array<{
      connectionId?: string;
      connectionName?: string;
      valid?: boolean;
      latencyMs?: number;
      diagnosis?: { type?: string };
    }>;
    summary?: {
      passed: number;
      failed: number;
      total: number;
    };
  } | null;
  providerInfo: any;
  providerId: string;
  emailsVisible: boolean;
  onClose: () => void;
  t: any;
};

export default function BatchTestResultsModal({
  batchTestResults,
  providerInfo,
  providerId,
  emailsVisible,
  onClose,
  t,
}: BatchTestResultsModalProps) {
  if (!batchTestResults) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-bg-primary border border-border rounded-card w-full max-w-[600px] max-h-[80vh] overflow-y-auto shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-border bg-bg-primary/95 backdrop-blur-sm rounded-t-xl">
          <h3 className="font-semibold">{t("testResults")}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
            aria-label={t("close")}
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="p-5">
          {batchTestResults.error &&
          (!batchTestResults.results || batchTestResults.results.length === 0) ? (
            <div className="text-center py-6">
              <span className="material-symbols-outlined text-error text-[32px] mb-2 block">
                error
              </span>
              <p className="text-sm text-error">{String(batchTestResults.error)}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {batchTestResults.summary && (
                <div className="flex items-center gap-3 text-xs mb-1">
                  <span className="text-text-muted">{providerInfo?.name || providerId}</span>
                  <span className="px-2 py-0.5 rounded bg-success/15 text-success font-medium">
                    {t("passedCount", { count: batchTestResults.summary.passed })}
                  </span>
                  {batchTestResults.summary.failed > 0 && (
                    <span className="px-2 py-0.5 rounded bg-error/15 text-error font-medium">
                      {t("failedCount", { count: batchTestResults.summary.failed })}
                    </span>
                  )}
                  <span className="text-text-muted ml-auto">
                    {t("testedCount", { count: batchTestResults.summary.total })}
                  </span>
                </div>
              )}
              {(batchTestResults.results || []).map((r: any, i: number) => (
                <div
                  key={r.connectionId || i}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-surface-2"
                >
                  <span
                    className={`material-symbols-outlined text-[16px] ${
                      r.valid ? "text-success" : "text-error"
                    }`}
                  >
                    {r.valid ? "check_circle" : "error"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">
                      {pickDisplayValue([r.connectionName], emailsVisible, r.connectionName)}
                    </span>
                  </div>
                  {r.latencyMs !== undefined && (
                    <span className="text-text-muted font-mono tabular-nums">
                      {t("millisecondsAbbr", { value: r.latencyMs })}
                    </span>
                  )}
                  <span
                    className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                      r.valid ? "bg-success/15 text-success" : "bg-error/15 text-error"
                    }`}
                  >
                    {r.valid ? t("okShort") : r.diagnosis?.type || t("errorShort")}
                  </span>
                </div>
              ))}
              {(!batchTestResults.results || batchTestResults.results.length === 0) && (
                <div className="text-center py-4 text-text-muted text-sm">
                  {t("noActiveConnectionsInGroup")}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
