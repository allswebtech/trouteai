"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/shared/utils/cn";

// Same look as the primary/secondary variants of the shared <Button>, but rendered as a real
// <Link> so navigation stays a link (a <button> inside an <a> is invalid HTML).
const VARIANTS = {
  primary: "bg-primary text-on-primary hover:bg-primary-hover",
  secondary: "bg-surface border border-border text-text-main hover:bg-surface-2",
};

const SIZES = {
  sm: "h-7 px-2.5 text-xs",
  md: "h-8 px-3 text-sm",
};

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  icon?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    >
      {icon && (
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </Link>
  );
}
