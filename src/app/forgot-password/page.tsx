"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/shared/components";

function ResetMethod({
  icon,
  title,
  description,
  command,
  hint,
}: {
  icon: string;
  title: string;
  description: string;
  command: string;
  hint: string;
}) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-primary-text">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
            {icon}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="mb-1 text-sm font-semibold text-text-main">{title}</h2>
          <p className="mb-3 text-sm text-text-muted">{description}</p>
          <div className="mb-3 flex items-center gap-2 overflow-x-auto rounded-control border border-zinc-800 bg-zinc-950 px-3 py-2.5 font-mono text-sm text-zinc-100">
            <span className="select-none text-zinc-500" aria-hidden="true">
              $
            </span>
            <code>{command}</code>
          </div>
          <p className="text-xs text-text-muted">{hint}</p>
        </div>
      </div>
    </Card>
  );
}

/**
 * Forgot Password Page — the admin password can only be reset on the machine that runs
 * TRouteAI: `trouteai reset-password` (an npm install) or, on SixPanel, the website's
 * Terminal with `DATA_DIR=.trouteai-data npm exec --no -- trouteai reset-password` (a website there has no global command).
 */
export default function ForgotPasswordPage() {
  const t = useTranslations("auth");

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-on-primary">
            <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
              alt_route
            </span>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-text-main">
              {t("resetPassword")}
            </h1>
            <p className="mt-1 text-sm text-text-muted">{t("resetDescription")}</p>
          </div>
        </div>

        <div className="mb-6 flex flex-col gap-3">
          <ResetMethod
            icon="terminal"
            title={t("methodCliTitle")}
            description={t("methodCliDescription")}
            command="trouteai reset-password"
            hint={t("methodCliHint")}
          />
          <ResetMethod
            icon="dns"
            title={t("methodPanelTitle")}
            description={t("methodPanelDescription")}
            command="DATA_DIR=.trouteai-data npm exec --no -- trouteai reset-password"
            hint={t("methodPanelHint")}
          />
        </div>

        <div className="text-center">
          <Link
            href="/login"
            className="inline-flex items-center gap-1 rounded-sm text-sm text-text-muted transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <span
              className="material-symbols-outlined text-[16px] rtl:rotate-180"
              aria-hidden="true"
            >
              arrow_back
            </span>
            {t("backToLogin")}
          </Link>
        </div>
      </div>
    </div>
  );
}
