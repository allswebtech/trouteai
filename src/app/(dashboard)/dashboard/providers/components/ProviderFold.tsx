"use client";

import type { ReactNode } from "react";

interface ProviderFoldProps {
  title: string;
  /** Shown next to the title, for example how many models. */
  count?: number;
  children: ReactNode;
  testId?: string;
}

/** A fold that is closed when the page opens: one line, one press to see what is inside. */
export default function ProviderFold({ title, count, children, testId }: ProviderFoldProps) {
  return (
    <details className="group rounded-card border border-border bg-surface" data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-text-main [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {count !== undefined && <span className="ms-1.5 text-text-muted">({count})</span>}
        </span>
        <span
          className="material-symbols-outlined text-[20px] text-text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        >
          expand_more
        </span>
      </summary>
      <div className="flex flex-col gap-6 border-t border-border p-3">{children}</div>
    </details>
  );
}
