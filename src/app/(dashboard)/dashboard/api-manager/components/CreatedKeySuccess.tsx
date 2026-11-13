"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/components";
import { useDisplayBaseUrl } from "@/shared/hooks";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const CODE_BOX =
  "min-w-0 flex-1 rounded-control border border-border bg-bg-subtle px-3 py-2 font-mono text-sm text-text-main break-all select-all";

interface CreatedKeySuccessProps {
  /** Full API key returned by create/regenerate. */
  apiKey: string;
  /** True when the full key can be shown again later from the keys list. */
  canRevealLater: boolean;
  onDone: () => void;
}

/**
 * Body of the "Your API key is ready" modal (new and regenerated keys): the full key with a
 * copy button, a short safety note, and the values an app needs to connect.
 */
export default function CreatedKeySuccess({
  apiKey,
  canRevealLater,
  onDone,
}: CreatedKeySuccessProps) {
  const t = useTranslations("apiManager");
  const tr = (key: string, fallback: string) =>
    typeof t.has === "function" && t.has(key) ? t(key) : fallback;
  const { copied, copy } = useCopyToClipboard();
  const baseUrl = `${useDisplayBaseUrl()}/v1`;
  const authHeader = `Authorization: Bearer ${apiKey}`;

  const copyLabel = tr("createdKeyCopy", "Copy");
  const copiedLabel = tr("createdKeyCopied", "Copied");
  const renderCopyButton = (
    id: string,
    text: string,
    ariaLabel: string,
    size: "sm" | "md" = "sm"
  ) => (
    <Button
      variant="secondary"
      size={size}
      icon={copied === id ? "check" : "content_copy"}
      onClick={() => copy(text, id)}
      aria-label={ariaLabel}
      className="shrink-0"
    >
      {copied === id ? copiedLabel : copyLabel}
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-text-main">
          {tr("createdKeyYourKey", "Your API key")}
        </span>
        <div className="flex items-start gap-2">
          <code className={CODE_BOX}>{apiKey}</code>
          {renderCopyButton("created_key", apiKey, t("copyKey"), "md")}
        </div>
        <p className="flex items-start gap-1.5 text-sm text-text-muted">
          <span className="material-symbols-outlined text-[18px] text-warning" aria-hidden="true">
            info
          </span>
          <span>
            {tr("createdKeyKeepSafe", "Copy it now and keep it safe.")}
            {!canRevealLater && (
              <> {tr("createdKeyShownOnce", "You won't be able to see it again.")}</>
            )}
          </span>
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text-main">
            {tr("createdKeyHowToUse", "How to use it")}
          </h3>
          <p className="text-sm text-text-muted">
            {tr(
              "createdKeyHowToUseHint",
              "In your app, set the Base URL, paste this key, and use a combo name as the model."
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-muted">
            {tr("createdKeyBaseUrl", "Base URL")}
          </span>
          <div className="flex items-start gap-2">
            <code className={CODE_BOX}>{baseUrl}</code>
            {renderCopyButton(
              "created_base_url",
              baseUrl,
              tr("createdKeyCopyBaseUrl", "Copy Base URL")
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-muted">
            {tr("createdKeyAuthHeader", "Authorization header")}
          </span>
          <div className="flex items-start gap-2">
            <code className={CODE_BOX}>{authHeader}</code>
            {renderCopyButton(
              "created_auth_header",
              authHeader,
              tr("createdKeyCopyAuthHeader", "Copy Authorization header")
            )}
          </div>
        </div>

        {/* New tab, so following the link never closes this one-time view of the key. */}
        <Link
          href="/dashboard/endpoint"
          prefetch={false}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary-text hover:underline"
        >
          {tr("createdKeyMoreExamples", "More examples")}
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            open_in_new
          </span>
        </Link>
      </div>

      <Button onClick={onDone} fullWidth>
        {t("done")}
      </Button>
    </div>
  );
}
