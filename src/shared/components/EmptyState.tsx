"use client";

import { useTranslations } from "next-intl";

/**
 * EmptyState — FASE-07 UX
 *
 * Reusable empty state component for dashboard sections when no data
 * is available. Provides visual feedback and optional action button.
 *
 * Usage:
 *   <EmptyState
 *     icon="dns"
 *     title="No providers yet"
 *     description="Add your first API provider to get started."
 *     actionLabel="Add Provider"
 *     onAction={() => router.push('/providers/add')}
 *   />
 */

interface EmptyStateProps {
  icon?: string;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: (() => void) | null;
}

export default function EmptyState({
  icon = "inbox",
  title,
  description = "",
  actionLabel = "",
  onAction = null,
}: EmptyStateProps) {
  const t = useTranslations("common");
  const resolvedTitle = title ?? t("nothingHere");
  const usesMaterialSymbol = /^[a-z][a-z0-9_]*$/.test(icon);
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center px-6 py-12 text-center">
      <div
        className="mb-4 flex size-10 items-center justify-center rounded-card border border-border bg-surface-2 text-text-muted text-[20px]"
        role="img"
        aria-hidden="true"
      >
        {usesMaterialSymbol ? (
          <span className="material-symbols-outlined text-[20px]">{icon}</span>
        ) : (
          icon
        )}
      </div>
      <h3 className="m-0 text-sm font-semibold text-text-main">{resolvedTitle}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-muted">{description}</p>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex h-8 items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
