"use client";

import { useState } from "react";
import { cn } from "@/shared/utils/cn";

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export default function CollapsibleSection({
  title,
  description,
  count,
  defaultOpen = true,
  children,
  className,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn("border border-border rounded-card bg-surface", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center justify-between gap-3 w-full px-4 py-3 text-start",
          "hover:bg-surface-2/60 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          "rounded-t-card",
          !open && "rounded-b-card"
        )}
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-text-main truncate">{title}</span>
          {count != null && (
            <span className="inline-flex h-5 items-center px-2 text-[11px] font-medium tabular-nums rounded-full bg-surface-2 text-text-muted">
              {count}
            </span>
          )}
          {description && (
            <span className="text-xs text-text-muted truncate hidden sm:inline">{description}</span>
          )}
        </div>
        <span
          className="material-symbols-outlined text-[18px] text-text-muted transition-transform duration-200 shrink-0"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        >
          expand_more
        </span>
      </button>
      <div
        className={cn(
          "overflow-hidden transition-[max-height] duration-200 ease-in-out",
          open ? "max-h-[2000px]" : "max-h-0"
        )}
      >
        <div className="px-4 pb-4 pt-1">{children}</div>
      </div>
    </div>
  );
}
