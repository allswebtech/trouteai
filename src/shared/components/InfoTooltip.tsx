"use client";

import { cn } from "@/shared/utils/cn";

interface InfoTooltipProps {
  text: string;
  className?: string;
}

export default function InfoTooltip({ text, className }: InfoTooltipProps) {
  return (
    <span className={cn("relative inline-flex group", className)}>
      <span
        className="material-symbols-outlined text-[16px] text-text-muted cursor-help"
        aria-label={text}
      >
        info
      </span>
      <span
        role="tooltip"
        className={cn(
          "absolute bottom-full left-1/2 -translate-x-1/2 mb-2",
          "always-dark px-2 py-1 text-xs font-medium text-white bg-zinc-900 rounded-md shadow-elevated",
          "w-max max-w-[260px] whitespace-normal break-words pointer-events-none",
          "border border-white/10",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
          "z-50"
        )}
      >
        {text}
      </span>
    </span>
  );
}
