"use client";

/**
 * Maintenance Banner — Phase 8.4
 *
 * Shows a warning banner at the top of the dashboard when the server
 * is restarting or in maintenance mode. Auto-dismisses when the server
 * comes back online.
 */

import { useState, useEffect } from "react";
import { useRef } from "react";
import { useTranslations } from "next-intl";

export default function MaintenanceBanner() {
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState("");
  const consecutiveFailuresRef = useRef(0);
  const dismissedUntilRecoveryRef = useRef(false);
  const t = useTranslations("common");

  useEffect(() => {
    const checkHealth = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort("Health check timeout"), 8000);
      try {
        // Use lightweight liveness probe (single SELECT 1) instead of the
        // heavy /api/monitoring/health observability endpoint. The heavy
        // endpoint can exceed the 8s client timeout under normal load
        // (e.g. Logs page 3s polling), causing false-positive banners.
        const res = await fetch("/api/health/ping", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (res.ok) {
          consecutiveFailuresRef.current = 0;
          dismissedUntilRecoveryRef.current = false;
          setShow(false);
          setMessage("");
        } else {
          consecutiveFailuresRef.current += 1;
          // Require at least 2 failed checks to avoid transient false positives.
          if (consecutiveFailuresRef.current >= 2 && !dismissedUntilRecoveryRef.current) {
            setShow(true);
            setMessage(t("maintenanceServerIssues"));
          }
        }
      } catch {
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= 2 && !dismissedUntilRecoveryRef.current) {
          setShow(true);
          setMessage(t("maintenanceServerUnreachable"));
        }
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Run immediately on mount, then every 10 seconds
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [t]);

  if (!show) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 border-b border-warning/20 bg-warning/10 px-4 py-2 sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="material-symbols-outlined shrink-0 text-[18px] text-warning"
          aria-hidden="true"
        >
          warning
        </span>
        <span className="text-sm text-text-main">{message}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          dismissedUntilRecoveryRef.current = true;
          setShow(false);
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-warning/10 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={t("close")}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          close
        </span>
      </button>
    </div>
  );
}
