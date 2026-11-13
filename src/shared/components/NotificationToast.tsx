"use client";

/**
 * NotificationToast — FASE-07 UX & Microinteractions
 *
 * Global toast notification component. Renders notifications from the
 * notificationStore as stacked toasts in the top-right corner.
 *
 * Usage: Add <NotificationToast /> to your root layout.
 */

import { useNotificationStore } from "@/store/notificationStore";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const ICONS = {
  success: "check_circle",
  error: "error",
  warning: "warning",
  info: "info",
};

/**
 * Coerce a toast title/message to a string. `message`/`title` are typed as
 * `string`, but callers occasionally pass a raw API error body (an object) —
 * rendering that object directly throws React #31 ("Objects are not valid as a
 * React child") and freezes the whole page. This keeps the toast resilient no
 * matter what a caller hands it.
 */
export function toToastText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Icon color per type (semantic tokens); the toast itself is a neutral surface.
const COLORS = {
  success: { icon: "text-success" },
  error: { icon: "text-error" },
  warning: { icon: "text-warning" },
  info: { icon: "text-info" },
};

function Toast({ notification, onDismiss }) {
  const t = useTranslations("common");
  const [isExiting, setIsExiting] = useState(false);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(() => onDismiss(notification.id), 200);
  };

  const color = COLORS[notification.type] || COLORS.info;
  return (
    <div
      role="alert"
      aria-live="polite"
      onClick={notification.onClick}
      className="flex w-[min(380px,calc(100vw-32px))] items-start gap-3 rounded-card border border-border bg-surface px-3.5 py-3 text-text-main shadow-elevated"
      style={{
        cursor: notification.onClick ? "pointer" : "default",
        animation: isExiting ? "toastOut 0.15s ease-in forwards" : "toastIn 0.2s ease-out forwards",
      }}
    >
      <span
        className={`material-symbols-outlined mt-px shrink-0 text-[18px] ${color.icon}`}
        aria-hidden="true"
      >
        {ICONS[notification.type] || ICONS.info}
      </span>
      <div className="min-w-0 flex-1">
        {notification.title && (
          <div className="mb-0.5 text-sm font-medium text-text-main">
            {toToastText(notification.title)}
          </div>
        )}
        <div className="break-words text-[13px] leading-snug text-text-muted">
          {toToastText(notification.message)}
        </div>
      </div>
      {notification.dismissible && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDismiss();
          }}
          aria-label={t("dismissNotification")}
          className="-me-1 -mt-0.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            close
          </span>
        </button>
      )}
    </div>
  );
}

export default function NotificationToast() {
  const { notifications, removeNotification } = useNotificationStore();

  if (notifications.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes toastOut {
          from { opacity: 1; transform: translateY(0); }
          to   { opacity: 0; transform: translateY(-4px); }
        }
      `}</style>
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: "fixed",
          top: "16px",
          insetInlineEnd: "16px",
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          pointerEvents: "none",
        }}
      >
        {notifications.map((n) => (
          <div key={n.id} style={{ pointerEvents: "auto" }}>
            <Toast notification={n} onDismiss={removeNotification} />
          </div>
        ))}
      </div>
    </>
  );
}
