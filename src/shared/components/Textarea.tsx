"use client";

import { cn } from "@/shared/utils/cn";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

/**
 * Textarea — token-driven multiline input mirroring the Input primitive (same border,
 * focus ring and control radius). Replaces ad-hoc raw `<textarea>` styling at call sites.
 */
export default function Textarea({ className, error = false, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "w-full py-2 px-3 text-sm text-text-main",
        "bg-surface border border-border rounded-control",
        "placeholder:text-text-muted",
        "focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none",
        "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        "text-[16px] sm:text-sm",
        error ? "border-error focus:border-error focus:ring-error/20" : "",
        className
      )}
      {...props}
    />
  );
}
