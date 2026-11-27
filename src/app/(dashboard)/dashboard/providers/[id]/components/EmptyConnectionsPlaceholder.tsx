"use client";

import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface CommandCodeAuthState {
  phase: string;
  [key: string]: unknown;
}

interface EmptyConnectionsPlaceholderProps {
  isOAuth: boolean;
  isCompatible: boolean;
  isCommandCode: boolean;
  providerId: string;
  providerSupportsPat: boolean;
  commandCodeAuthState: CommandCodeAuthState;
  gateConnectionFlow: (callback: () => void) => void;
  openApiKeyAddFlow: () => void;
  openPrimaryAddFlow: () => void;
  handleOpenCommandCodeConnect: () => void;
  onOpenOAuthModal: () => void;
  onOpenImportCodex: () => void;
  onOpenImportClaude: () => void;
  onOpenImportGemini: () => void;
  onOpenImportGrokCli: () => void;
  t: ProviderMessageTranslator;
}

/** The empty state is one line: Add account is in the head of the card, imports are in Options. */
export default function EmptyConnectionsPlaceholder({
  isOAuth,
  t,
}: EmptyConnectionsPlaceholderProps) {
  return (
    <div className="py-8 text-center">
      <div className="mb-3 inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <span className="material-symbols-outlined text-[24px]">{isOAuth ? "lock" : "key"}</span>
      </div>
      <p className="mb-1 font-medium text-text-main">{t("noConnectionsYet")}</p>
    </div>
  );
}
