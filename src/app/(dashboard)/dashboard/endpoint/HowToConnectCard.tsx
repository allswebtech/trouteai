"use client";

import { useId, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Card } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

type HowToConnectCardProps = {
  /** OpenAI-compatible base URL that already ends in `/v1` (e.g. `https://host/v1`). */
  apiBaseUrl: string;
};

type ExampleTabId = "curl" | "python" | "javascript" | "anthropic" | "claude";

// Language / tool names stay as-is; only the descriptive Anthropic label is translatable.
const EXAMPLE_TABS: ReadonlyArray<{ id: ExampleTabId; label: string; labelKey?: string }> = [
  { id: "curl", label: "curl" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "anthropic", label: "Anthropic-compatible apps", labelKey: "howToConnectTabAnthropic" },
  { id: "claude", label: "Claude Code" },
];

const API_KEY_PLACEHOLDER = "YOUR_API_KEY";
const MODEL_PLACEHOLDER = "your-combo";
const API_KEYS_PAGE_HREF = "/dashboard/api-manager";

// Code snippets are intentionally not translated.
function buildExamples(apiBase: string): Record<ExampleTabId, string> {
  return {
    curl: [
      `curl ${apiBase}/chat/completions \\`,
      `  -H "Authorization: Bearer ${API_KEY_PLACEHOLDER}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model": "${MODEL_PLACEHOLDER}", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    ].join("\n"),
    python: [
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${apiBase}", api_key="${API_KEY_PLACEHOLDER}")`,
      "response = client.chat.completions.create(",
      `    model="${MODEL_PLACEHOLDER}",`,
      `    messages=[{"role": "user", "content": "Hello!"}],`,
      ")",
      "print(response.choices[0].message.content)",
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      `const client = new OpenAI({ baseURL: "${apiBase}", apiKey: "${API_KEY_PLACEHOLDER}" });`,
      "const response = await client.chat.completions.create({",
      `  model: "${MODEL_PLACEHOLDER}",`,
      '  messages: [{ role: "user", content: "Hello!" }],',
      "});",
      "console.log(response.choices[0].message.content);",
    ].join("\n"),
    anthropic: [
      `curl ${apiBase}/messages \\`,
      `  -H "x-api-key: ${API_KEY_PLACEHOLDER}" \\`,
      `  -H "anthropic-version: 2023-06-01" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model": "${MODEL_PLACEHOLDER}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello!"}]}'`,
    ].join("\n"),
    // Claude Code appends /v1/messages itself, so its base URL must not end in /v1.
    claude: [
      `export ANTHROPIC_BASE_URL="${apiBase.replace(/\/v1$/, "")}"`,
      `export ANTHROPIC_AUTH_TOKEN="${API_KEY_PLACEHOLDER}"`,
      `export ANTHROPIC_MODEL="${MODEL_PLACEHOLDER}"`,
      // Without this Claude Code's /model picker shows Anthropic's own list, not TRouteAI's.
      "export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
      "claude",
    ].join("\n"),
  };
}

type CopyButtonProps = {
  isCopied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  className?: string;
};

function CopyButton({
  isCopied,
  onCopy,
  copyLabel,
  copiedLabel,
  variant = "secondary",
  size = "sm",
  className,
}: Readonly<CopyButtonProps>) {
  return (
    <Button
      variant={variant}
      size={size}
      icon={isCopied ? "check" : "content_copy"}
      onClick={onCopy}
      className={cn("shrink-0", className)}
    >
      <span aria-live="polite">{isCopied ? copiedLabel : copyLabel}</span>
    </Button>
  );
}

export default function HowToConnectCard({ apiBaseUrl }: Readonly<HowToConnectCardProps>) {
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  const { copied, copy } = useCopyToClipboard();
  const [activeTab, setActiveTab] = useState<ExampleTabId>("curl");
  const idPrefix = useId();

  const tr = (key: string, fallback: string) =>
    typeof t.has === "function" && t.has(key) ? t(key) : fallback;
  const trc = (key: string, fallback: string) =>
    typeof tc.has === "function" && tc.has(key) ? tc(key) : fallback;

  const copyLabel = trc("copy", "Copy");
  const copiedLabel = trc("copied", "Copied!");

  // The prop already ends in /v1; only strip a trailing slash so paths are never doubled.
  const apiBase = apiBaseUrl.replace(/\/+$/, "");
  const examples = buildExamples(apiBase);
  const anthropicUrl = `${apiBase}/messages`;
  const anthropicHeader = `x-api-key: ${API_KEY_PLACEHOLDER}`;

  const renderApiKeysLink = (chunks: ReactNode) => (
    <Link
      href={API_KEYS_PAGE_HREF}
      prefetch={false}
      className="font-medium text-primary-text underline underline-offset-2 hover:opacity-80"
    >
      {chunks}
    </Link>
  );
  const apiKeyStepText =
    typeof t.has === "function" && t.has("howToConnectStepApiKeyText") ? (
      t.rich("howToConnectStepApiKeyText", { link: renderApiKeysLink })
    ) : (
      <>Create one on the {renderApiKeysLink("API Keys page")} and paste it as the key.</>
    );

  const tabId = (id: ExampleTabId) => `${idPrefix}-tab-${id}`;
  const panelId = `${idPrefix}-panel`;
  const examplesHeadingId = `${idPrefix}-examples-heading`;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % EXAMPLE_TABS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + EXAMPLE_TABS.length) % EXAMPLE_TABS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = EXAMPLE_TABS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = EXAMPLE_TABS[nextIndex];
    setActiveTab(nextTab.id);
    document.getElementById(tabId(nextTab.id))?.focus();
  };

  const renderCodeBlock = (code: string, copyId: string) => (
    <div className="relative">
      <pre className="font-mono text-xs leading-relaxed text-text-main whitespace-pre overflow-x-auto rounded-control border border-border bg-bg-subtle p-3 pt-11">
        <code>{code}</code>
      </pre>
      <CopyButton
        isCopied={copied === copyId}
        onCopy={() => void copy(code, copyId)}
        copyLabel={copyLabel}
        copiedLabel={copiedLabel}
        className="absolute right-2 top-2"
      />
    </div>
  );

  const renderCopyRow = (label: string, value: string, copyId: string) => (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <span className="text-xs font-medium text-text-muted sm:w-16 sm:shrink-0">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-bg-subtle px-3 py-1.5 font-mono text-xs text-text-main">
        {value}
      </code>
      <CopyButton
        isCopied={copied === copyId}
        onCopy={() => void copy(value, copyId)}
        copyLabel={copyLabel}
        copiedLabel={copiedLabel}
      />
    </div>
  );

  const steps: ReadonlyArray<{ key: string; title: string; body: ReactNode }> = [
    {
      key: "base-url",
      title: tr("baseUrl", "Base URL"),
      body: (
        <>
          <p>
            {tr(
              "howToConnectStepBaseUrlText",
              'Paste this address into your app\'s "Base URL" (or "API base") setting.'
            )}
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-control border border-border bg-bg-subtle px-3 py-2 font-mono text-sm text-text-main">
              {apiBase}
            </code>
            <CopyButton
              isCopied={copied === "howto_base_url"}
              onCopy={() => void copy(apiBase, "howto_base_url")}
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
              variant="primary"
              size="md"
            />
          </div>
        </>
      ),
    },
    {
      key: "api-key",
      title: tr("apiKeyLabel", "API key"),
      body: <p>{apiKeyStepText}</p>,
    },
    {
      key: "model",
      title: tr("howToConnectStepModelTitle", "Model"),
      body: (
        <p>
          {tr(
            "howToConnectStepModelText",
            "Type the name of one of your combos (or any model id) as the model."
          )}
        </p>
      ),
    },
  ];

  return (
    <Card>
      <div className="mb-5 flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary/10">
          <span
            className="material-symbols-outlined text-[22px] text-primary-text"
            aria-hidden="true"
          >
            rocket_launch
          </span>
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-main">
            {tr("howToConnectTitle", "How to connect")}
          </h2>
          <p className="text-sm text-text-muted">
            {tr(
              "howToConnectIntro",
              "Any app that works with OpenAI can use TRouteAI. You only need three things:"
            )}
          </p>
        </div>
      </div>

      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3">
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary-text"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 text-sm text-text-muted">
              <p className="font-semibold text-text-main">{step.title}</p>
              {step.body}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-6 border-t border-border pt-5">
        <h3 id={examplesHeadingId} className="mb-3 text-sm font-semibold text-text-main">
          {tr("howToConnectExamplesTitle", "Code examples (optional)")}
        </h3>

        <div
          role="tablist"
          aria-labelledby={examplesHeadingId}
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          {EXAMPLE_TABS.map((tab, index) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={tabId(tab.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={cn(
                  "h-8 rounded-control px-3 text-xs font-medium transition-colors",
                  selected
                    ? "bg-primary/10 text-primary-text"
                    : "text-text-muted hover:bg-bg-subtle hover:text-text-main"
                )}
              >
                {tab.labelKey ? tr(tab.labelKey, tab.label) : tab.label}
              </button>
            );
          })}
        </div>

        <div id={panelId} role="tabpanel" aria-labelledby={tabId(activeTab)}>
          {activeTab === "anthropic" ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">
                {tr(
                  "howToConnectAnthropicNote",
                  "For apps that speak the Anthropic (Claude) format, send requests to this URL with the header x-api-key."
                )}
              </p>
              {renderCopyRow(
                tr("howToConnectAnthropicUrlLabel", "URL"),
                anthropicUrl,
                "howto_anthropic_url"
              )}
              {renderCopyRow(
                tr("howToConnectAnthropicHeaderLabel", "Header"),
                anthropicHeader,
                "howto_anthropic_header"
              )}
              {renderCodeBlock(examples.anthropic, "howto_code_anthropic")}
            </div>
          ) : (
            renderCodeBlock(examples[activeTab], `howto_code_${activeTab}`)
          )}
        </div>

        <p className="mt-3 text-xs text-text-muted">
          {tr(
            "howToConnectReplaceHint",
            "Replace YOUR_API_KEY with your key and your-combo with your combo name."
          )}
        </p>
      </div>
    </Card>
  );
}
