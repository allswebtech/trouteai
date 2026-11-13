"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";

export default function ThemeToggle({
  className,
  variant = "default",
}: {
  className?: any;
  variant?: string;
}) {
  const { toggleTheme, isDark } = useTheme();
  const t = useTranslations("header");
  const toggleLabel = isDark ? t("switchToLightMode") : t("switchToDarkMode");

  const variants = {
    default: cn(
      "flex size-8 items-center justify-center rounded-md",
      "text-text-muted hover:bg-surface-2 hover:text-text-main",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      "transition-colors"
    ),
    card: cn(
      "flex size-8 items-center justify-center rounded-md",
      "border border-border bg-surface",
      "text-text-muted hover:bg-surface-2 hover:text-text-main",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
      "transition-colors"
    ),
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(variants[variant], className)}
      aria-label={toggleLabel}
      title={toggleLabel}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        {isDark ? "light_mode" : "dark_mode"}
      </span>
    </button>
  );
}
