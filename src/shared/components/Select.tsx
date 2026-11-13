"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: React.ReactNode;
  options?: SelectOption[];
  placeholder?: string;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  selectClassName?: string;
}

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder,
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  id: externalId,
  children,
  ...props
}: SelectProps) {
  const t = useTranslations("common");
  const generatedId = useId();
  const selectId = externalId || generatedId;
  const errorId = error ? `${selectId}-error` : undefined;
  const hintId = hint && !error ? `${selectId}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={selectId} className="text-xs font-medium text-text-muted">
          {label}
          {required && (
            <span className="text-error ml-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full h-9 px-3 pe-9 text-sm text-text-main",
            "bg-surface border border-border rounded-control appearance-none cursor-pointer",
            "focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none",
            "transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            error ? "border-error focus:border-error focus:ring-error/20" : "",
            selectClassName
          )}
          {...props}
        >
          {!children && (placeholder ?? t("selectOption")) && (
            <option value="" disabled className="bg-surface text-text-muted">
              {placeholder ?? t("selectOption")}
            </option>
          )}
          {!children &&
            options.map((option) => (
              <option key={option.value} value={option.value} className="bg-surface text-text-main">
                {option.label}
              </option>
            ))}
          {children}
        </select>
        <div
          className="absolute inset-y-0 end-0 flex items-center pe-2.5 pointer-events-none text-text-muted"
          aria-hidden="true"
        >
          <span className="material-symbols-outlined text-[18px]">expand_more</span>
        </div>
      </div>
      {error && (
        <p id={errorId} className="text-xs text-error flex items-center gap-1" role="alert">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            error
          </span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
