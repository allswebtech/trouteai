"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useHomeTr } from "./home-start/useHomeTr";

const CODE_CLASS = "font-mono break-all bg-warning/15 px-1 rounded text-xs text-text-main";

/**
 * Shown when TRouteAI was started with auto-generated secrets (zero-config mode).
 * The banner is dismissable and persists only for the current session.
 */
export default function BootstrapBanner({ envFilePath }: { envFilePath?: string }) {
  const t = useTranslations("common");
  const { tr, trRich } = useHomeTr();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const path = envFilePath || "DATA_DIR/server.env";

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-card border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-text-main"
    >
      <span
        className="material-symbols-outlined text-[18px] text-warning shrink-0"
        aria-hidden="true"
      >
        key
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-text-main">
          {tr("bootstrapTitle", "Your security keys were created automatically")}
        </p>
        <p className="mt-0.5 text-text-muted">
          {trRich(
            "bootstrapBody",
            <>
              They are saved on this server in <code className={CODE_CLASS}>{path}</code>. Back up
              your data folder. It is needed to read your saved provider keys.
            </>,
            { path, code: (chunks) => <code className={CODE_CLASS}>{chunks}</code> }
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-warning/15 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        aria-label={t("bootstrapBannerDismiss")}
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          close
        </span>
      </button>
    </div>
  );
}
