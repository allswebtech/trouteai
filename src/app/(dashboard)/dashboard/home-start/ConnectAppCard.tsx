"use client";

import { useState } from "react";
import Link from "next/link";

import { Button, Card } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { CODING_TOOL_KEY_NAME } from "./homeConnect";
import { useHomeTr } from "./useHomeTr";

const INLINE_LINK = "font-medium text-primary-text hover:underline";
const CODE_BOX =
  "min-w-0 flex-1 truncate rounded-control border border-border bg-surface-2 px-3 py-2 font-mono text-[13px] text-text-main";

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
 * "Connect a coding tool" card on Home: the three values a coding tool needs (Address, Key,
 * Model), one link to the step-by-step page, and the curl test in a closed fold.
 */
export function ConnectAppCard({
  apiBaseUrl,
  model,
  keyCount,
  onKeyMade,
}: {
  apiBaseUrl: string;
  model: string | null;
  keyCount: number;
  onKeyMade: () => void;
}) {
  const { tr } = useHomeTr();
  const { copied, copy } = useCopyToClipboard();
  const [madeKey, setMadeKey] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const curlExample = buildCurlExample(apiBaseUrl, model || "provider/model");

  const copyLabel = tr("connectAppCopy", "Copy");
  const copiedLabel = tr("connectAppCopied", "Copied");
  const renderCopyButton = (id: string, text: string, ariaLabel: string) => (
    <Button
      variant="secondary"
      icon={copied === id ? "check" : "content_copy"}
      onClick={() => copy(text, id)}
      aria-label={ariaLabel}
      className="min-h-11 shrink-0"
    >
      {copied === id ? copiedLabel : copyLabel}
    </Button>
  );

  const makeKey = async () => {
    setMaking(true);
    setKeyError(false);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: CODING_TOOL_KEY_NAME }),
      });
      const data = res.ok ? await res.json() : null;
      if (typeof data?.key === "string") {
        setMadeKey(data.key);
        onKeyMade();
      } else {
        setKeyError(true);
      }
    } catch {
      setKeyError(true);
    } finally {
      setMaking(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-text-main">
          {tr("toolTitle", "Connect a coding tool")}
        </h2>

        <dl className="flex flex-col gap-4">
          <ConnectRow label={tr("toolAddress", "Address")}>
            <div className="flex items-center gap-2">
              <code className={CODE_BOX} title={apiBaseUrl}>
                {apiBaseUrl}
              </code>
              {renderCopyButton("base-url", apiBaseUrl, tr("toolCopyAddress", "Copy address"))}
            </div>
          </ConnectRow>

          <ConnectRow label={tr("toolKey", "Key")}>
            {madeKey ? (
              <div className="flex items-center gap-2">
                <code className={CODE_BOX}>{madeKey}</code>
                {renderCopyButton("key", madeKey, tr("toolCopyKey", "Copy key"))}
              </div>
            ) : keyCount > 0 ? (
              <Link
                href="/dashboard/api-manager"
                prefetch={false}
                className={`${INLINE_LINK} inline-flex min-h-11 items-center`}
              >
                {tr("toolUseKey", "Use a key from Keys")}
              </Link>
            ) : (
              <div className="flex flex-col items-start gap-1">
                <Button
                  variant="secondary"
                  icon="key"
                  onClick={makeKey}
                  disabled={making}
                  className="min-h-11"
                >
                  {tr("toolMakeKey", "Make a key")}
                </Button>
                {keyError && (
                  <p role="alert" className="text-sm text-error">
                    {tr("toolKeyFailed", "Could not make a key.")}
                  </p>
                )}
              </div>
            )}
          </ConnectRow>

          {model && (
            <ConnectRow label={tr("toolModel", "Model")}>
              <div className="flex items-center gap-2">
                <code className={CODE_BOX} title={model}>
                  {model}
                </code>
                {renderCopyButton("model", model, tr("toolCopyModel", "Copy model"))}
              </div>
            </ConnectRow>
          )}
        </dl>

        <Link
          href="/dashboard/endpoint"
          prefetch={false}
          className={`${INLINE_LINK} inline-flex min-h-11 items-center`}
        >
          {tr("toolSteps", "Steps for each app")}
        </Link>

        <details className="group border-t border-border pt-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-medium text-text-main">
            {tr("toolTerminal", "Try it in a terminal")}
            <span
              className="material-symbols-outlined text-[20px] text-text-muted transition-transform group-open:rotate-180"
              aria-hidden="true"
            >
              expand_more
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-control border border-border bg-surface-2 p-3 font-mono text-xs text-text-main">
              {curlExample}
            </pre>
            <div>
              {renderCopyButton("curl", curlExample, tr("connectAppCopyCommand", "Copy command"))}
            </div>
          </div>
        </details>
      </div>
    </Card>
  );
}

function ConnectRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[80px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
