"use client";

/**
 * ImportProgressModal
 *
 * Extracted from the inline Import Progress Modal JSX in ProviderDetailPageClient.
 * Pure presentational component driven entirely by props.
 *
 * Cycle-safe: no import from ProviderDetailPageClient.
 */

import { Modal } from "@/shared/components";
import type { ImportProgress } from "../hooks/useModelImportHandlers";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface ImportProgressModalProps {
  importProgress: ImportProgress;
  isOpen: boolean;
  onClose: () => void;
  t: ProviderMessageTranslator;
}

export default function ImportProgressModal({
  importProgress,
  isOpen,
  onClose,
  t,
}: ImportProgressModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("importingModelsTitle")}
      size="md"
      closeOnOverlay={false}
      showCloseButton={importProgress.phase === "done" || importProgress.phase === "error"}
    >
      <div className="flex flex-col gap-4">
        {/* Status text */}
        <div className="flex items-center gap-3">
          {importProgress.phase === "fetching" && (
            <span className="material-symbols-outlined text-primary animate-spin">
              progress_activity
            </span>
          )}
          {importProgress.phase === "importing" && (
            <span className="material-symbols-outlined text-primary animate-spin">
              progress_activity
            </span>
          )}
          {importProgress.phase === "done" && (
            <span className="material-symbols-outlined text-success">check_circle</span>
          )}
          {importProgress.phase === "error" && (
            <span className="material-symbols-outlined text-error">error</span>
          )}
          <span className="text-sm font-medium text-text-main">{importProgress.status}</span>
        </div>

        {/* Progress bar */}
        {(importProgress.phase === "importing" || importProgress.phase === "done") &&
          importProgress.total > 0 && (
            <div className="w-full">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-text-muted">
                  {importProgress.current} / {importProgress.total}
                </span>
                <span className="text-xs text-text-muted">
                  {Math.round((importProgress.current / importProgress.total) * 100)}%
                </span>
              </div>
              <div className="w-full h-2.5 bg-surface-2 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300 ease-out"
                  style={{
                    width: `${(importProgress.current / importProgress.total) * 100}%`,
                    background:
                      importProgress.phase === "done"
                        ? "var(--color-success)"
                        : "var(--color-primary)",
                  }}
                />
              </div>
            </div>
          )}

        {/* Fetching indeterminate bar */}
        {importProgress.phase === "fetching" && (
          <div className="w-full h-2.5 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full animate-pulse"
              style={{
                width: "60%",
                background: "var(--color-primary)",
              }}
            />
          </div>
        )}

        {/* Error message */}
        {importProgress.phase === "error" && importProgress.error && (
          <div className="p-3 rounded-lg bg-error/10 border border-error/20">
            <p className="text-sm text-error">{importProgress.error}</p>
          </div>
        )}

        {/* Log list */}
        {importProgress.logs.length > 0 && (
          <div className="max-h-48 overflow-y-auto rounded-lg bg-surface-2 p-3 border border-border">
            <div className="flex flex-col gap-1">
              {importProgress.logs.map((log, i) => (
                <p
                  key={i}
                  className={`text-xs font-mono ${
                    typeof log === "string" && log.startsWith("✓")
                      ? "text-success font-semibold"
                      : "text-text-muted"
                  }`}
                >
                  {log}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Close button */}
        {importProgress.phase === "done" && (
          <div className="flex justify-center">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity"
            >
              {t("close")}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
