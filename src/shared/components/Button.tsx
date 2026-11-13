"use client";

import { cn } from "@/shared/utils/cn";

const variants = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  accent: "bg-primary text-on-primary hover:bg-primary-hover",
  secondary: "bg-surface border border-border text-text-main hover:bg-surface-2",
  outline: "bg-transparent border border-border text-text-main hover:bg-surface-2",
  ghost: "bg-transparent text-text-muted hover:bg-surface-2 hover:text-text-main",
  warning: "bg-amber-700 text-white hover:bg-amber-800",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

export type ButtonVariant = keyof typeof variants;

const sizes = {
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-control",
  md: "h-8 px-3 text-sm gap-1.5 rounded-control",
  lg: "h-10 px-4 text-sm gap-2 rounded-control",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: keyof typeof sizes;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
}

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center font-medium transition-colors duration-150 cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span
          className="material-symbols-outlined animate-spin text-[16px] pointer-events-none"
          aria-hidden="true"
        >
          progress_activity
        </span>
      ) : icon ? (
        <span
          className="material-symbols-outlined text-[16px] pointer-events-none"
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span
          className="material-symbols-outlined text-[16px] pointer-events-none"
          aria-hidden="true"
        >
          {iconRight}
        </span>
      )}
    </button>
  );
}
