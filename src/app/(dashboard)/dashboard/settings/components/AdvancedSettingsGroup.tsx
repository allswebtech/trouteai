"use client";

import { Children, useId, useState, type ReactNode } from "react";
import { cn } from "@/shared/utils/cn";

/**
 * Progressive-disclosure wrapper for long settings pages. Collapsed by default.
 * Children stay mounted while collapsed (only hidden), so their own data loading
 * and state behave exactly as before.
 */
export default function AdvancedSettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  // Number of sections inside, so the badge never drifts from the content.
  const count = Children.toArray(children).length;
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section className="rounded-card border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-start rounded-card",
          "hover:bg-surface-2/60 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        )}
      >
        <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden="true">
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-main">
          {title}
        </span>
        {count > 0 && (
          <span className="inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-[11px] font-medium tabular-nums text-text-muted">
            {count}
          </span>
        )}
      </button>
      <div id={panelId} hidden={!open} className="space-y-6 border-t border-border p-4">
        {children}
      </div>
    </section>
  );
}
