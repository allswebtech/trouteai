"use client";

import { cn } from "@/shared/utils/cn";

const variants = {
  default: "bg-surface-2 text-text-muted",
  primary: "bg-primary/10 text-primary-text",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  error: "bg-error/10 text-error",
  info: "bg-info/10 text-info",
};

const sizes = {
  sm: "h-[18px] px-1.5 text-[10px]",
  md: "h-5 px-2 text-[11px]",
  lg: "h-6 px-2.5 text-xs",
};

interface BadgeProps {
  children?: React.ReactNode;
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  dot?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap leading-none",
        variants[variant],
        sizes[size],
        className
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            variant === "success" && "bg-success",
            variant === "warning" && "bg-warning",
            variant === "error" && "bg-error",
            variant === "info" && "bg-info",
            variant === "primary" && "bg-primary",
            variant === "default" && "bg-text-muted"
          )}
        />
      )}
      {icon && (
        <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
