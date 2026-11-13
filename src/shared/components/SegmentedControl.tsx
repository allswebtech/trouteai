"use client";

import { cn } from "@/shared/utils/cn";

interface SegmentedOption {
  value: string;
  label: string;
  icon?: string;
}

interface SegmentedControlProps {
  options?: SegmentedOption[];
  value?: string;
  onChange?: (value: string) => void;
  size?: "sm" | "md" | "lg";
  className?: string;
  "aria-label"?: string;
}

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps) {
  const sizes = {
    sm: "h-6 px-2.5 text-xs",
    md: "h-7 px-3 text-sm",
    lg: "h-9 px-4 text-sm",
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 p-0.5 rounded-control",
        "bg-surface-2 border border-border",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md font-medium whitespace-nowrap transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
            sizes[size],
            value === option.value
              ? "bg-surface text-text-main shadow-soft dark:bg-white/10"
              : "text-text-muted hover:text-text-main",
            option.icon && "flex items-center"
          )}
        >
          {option.icon && (
            <span className="material-symbols-outlined text-[16px] me-1.5" aria-hidden="true">
              {option.icon}
            </span>
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
