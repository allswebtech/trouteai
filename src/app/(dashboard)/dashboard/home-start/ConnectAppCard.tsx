"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { Button, Card } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useHomeTr } from "./useHomeTr";

const INLINE_LINK = "font-medium text-primary-text hover:underline";
const CODE_BOX =
  "min-w-0 flex-1 truncate rounded-control border border-border bg-surface-2 px-3 py-1.5 font-mono text-[13px] text-text-main";

/** Copy-ready curl call against the OpenAI-compatible endpoint. */
export function buildCurlExample(apiBaseUrl: string, model: string): string {
  const body = JSON.stringify({
    model,
    stream: false,
    messages: [{ role: "user", content: "Hello" }],
  });
  // The body goes inside single quotes for the shell; escape any single quote in it.
  const quotedBody = `'${body.replaceAll("'", "'\\''")}'`;
  return `curl ${apiBaseUrl}/chat/completions -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d ${quotedBody}`;
}

/**
 * "Connect your app" card on Home: the three values an app needs (Base URL, API key,
 * model) plus a curl command to test the setup.
 */
export function ConnectAppCard({
  apiBaseUrl,
  comboName,
}: {
  apiBaseUrl: string;
  comboName: string | null;
}) {
  const { tr, trRich } = useHomeTr();
  const { copied, copy } = useCopyToClipboard();
  const curlExample = buildCurlExample(apiBaseUrl, comboName || "your-combo");

  const copyLabel = tr("connectAppCopy", "Copy");
  const copiedLabel = tr("connectAppCopied", "Copied");
  const renderCopyButton = (id: string, text: string, ariaLabel: string) => (
    <Button
      variant="secondary"
      size="sm"
      icon={copied === id ? "check" : "content_copy"}
      onClick={() => copy(text, id)}
      aria-label={ariaLabel}
      className="shrink-0"
    >
      {copied === id ? copiedLabel : copyLabel}
    </Button>
  );

  return (
    <Card>
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-sm font-semibold text-text-main">
            {tr("connectAppTitle", "Connect your app")}
          </h2>
          <p className="mt-0.5 text-sm text-text-muted">
            {tr(
              "connectAppDesc",
              "Enter these details in the settings of any app that works with OpenAI."
            )}
          </p>
        </div>

        <dl className="flex flex-col gap-4">
          <ConnectRow label={tr("connectAppBaseUrlLabel", "Base URL")}>
            <div className="flex items-center gap-2">
              <code className={CODE_BOX} title={apiBaseUrl}>
                {apiBaseUrl}
              </code>
              {renderCopyButton(
                "base-url",
                apiBaseUrl,
                tr("connectAppCopyBaseUrl", "Copy Base URL")
              )}
            </div>
          </ConnectRow>

          <ConnectRow label={tr("connectAppApiKeyLabel", "API key")}>
            <p className="text-sm text-text-muted sm:pt-1.5">
              {trRich(
                "connectAppApiKeyHint",
                <>
                  Create one in{" "}
                  <Link href="/dashboard/api-manager" prefetch={false} className={INLINE_LINK}>
                    API Keys
                  </Link>
                  .
                </>,
                {
                  link: (chunks) => (
                    <Link href="/dashboard/api-manager" prefetch={false} className={INLINE_LINK}>
                      {chunks}
                    </Link>
                  ),
                }
              )}
            </p>
          </ConnectRow>

          <ConnectRow label={tr("connectAppModelLabel", "Model")}>
            <p className="text-sm text-text-muted sm:pt-1.5">
              {trRich(
                "connectAppModelHint",
                <>
                  Your combo name, or any provider/model from the{" "}
                  <Link href="/dashboard/endpoint" prefetch={false} className={INLINE_LINK}>
                    Endpoint
                  </Link>{" "}
                  page.
                </>,
                {
                  link: (chunks) => (
                    <Link href="/dashboard/endpoint" prefetch={false} className={INLINE_LINK}>
                      {chunks}
                    </Link>
                  ),
                }
              )}
            </p>
            {comboName && (
              <div className="mt-2 flex items-center gap-2">
                <code className={CODE_BOX} title={comboName}>
                  {comboName}
                </code>
                {renderCopyButton("model", comboName, tr("connectAppCopyModel", "Copy model name"))}
              </div>
            )}
          </ConnectRow>
        </dl>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-main">
                {tr("connectAppTestTitle", "Test it")}
              </h3>
              <p className="text-xs text-text-muted">
                {tr(
                  "connectAppTestDesc",
                  "Replace YOUR_API_KEY with your key, then run this command in a terminal."
                )}
              </p>
            </div>
            {renderCopyButton("curl", curlExample, tr("connectAppCopyCommand", "Copy command"))}
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-control border border-border bg-surface-2 p-3 font-mono text-xs text-text-main">
            {curlExample}
          </pre>
        </div>
      </div>
    </Card>
  );
}

function ConnectRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:items-start sm:gap-4">
      <dt className="text-xs font-medium text-text-muted sm:pt-2">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
