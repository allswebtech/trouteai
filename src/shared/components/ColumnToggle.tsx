"use client";

/**
 * ColumnToggle — Shared UI primitive (T-29)
 *
 * Dropdown menu for toggling table column visibility.
 * Used by RequestLoggerV2, ProxyLogger, etc.
 *
 * Usage:
 *   <ColumnToggle
 *     columns={[{ key: 'model', label: 'Model' }, ...]}
 *     visible={{ model: true, provider: false, ... }}
 *     onToggle={(key) => setVisible({...visible, [key]: !visible[key]})}
 *   />
 */

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

export default function ColumnToggle({ columns = [], visible = {}, onToggle }) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const panelId = useId();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Number of hidden columns, shown as a badge so users know the table is trimmed.
  const hiddenCount = columns.filter((col) => visible[col.key] === false).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={t("toggleColumns")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
          open || hiddenCount > 0
            ? "border-primary/30 bg-primary/10 text-primary-text"
            : "border-border bg-surface text-text-main hover:bg-surface-2"
        }`}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          view_column
        </span>
        {t("columns")}
        {hiddenCount > 0 && (
          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-on-primary">
            {hiddenCount}
          </span>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute end-0 top-full z-50 mt-1 max-h-[60vh] min-w-[180px] overflow-y-auto rounded-control border border-border bg-surface p-1 shadow-elevated"
        >
          {columns.map((col) => (
            <label
              key={col.key}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 ${
                (visible[col.key] ?? true) ? "text-text-main" : "text-text-muted"
              }`}
            >
              <input
                type="checkbox"
                checked={visible[col.key] ?? true}
                onChange={() => onToggle(col.key)}
                className="size-3.5 accent-[var(--color-primary)]"
              />
              <span className="truncate" title={col.label}>
                {col.label}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
