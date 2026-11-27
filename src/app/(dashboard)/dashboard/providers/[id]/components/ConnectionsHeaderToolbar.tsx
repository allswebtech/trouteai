"use client";

import { Button } from "@/shared/components";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

export type ConnectionsHeaderToolbarProps = {
  providerId: string;
  providerInfo: any; // resolveDashboardProviderInfo result
  isCompatible: boolean;
  isCommandCode: boolean;
  isOAuth: boolean;
  providerSupportsPat: boolean;
  connections: any[]; // ConnectionRowConnection[]
  batchTesting: boolean;
  batchRetesting: boolean;
  retestingId: string | null;
  proxyConfig: any;
  reorderingByAvailability: boolean;
  handleReorderByAvailability: () => void | Promise<void>;
  // from useProviderSettings
  preferClaudeCodeForUnprefixedClaudeModels: boolean;
  claudeRoutingSettingsLoaded: boolean;
  claudeRoutingSettingsLoadError: string | null;
  savingClaudeRoutingPreference: boolean;
  handleToggleClaudeRoutingPreference: () => void;
  loadClaudeRoutingSettings: () => Promise<void>;
  codexGlobalServiceMode: string;
  codexGlobalServiceModeOptions: Array<{ value: string; label: string }>;
  codexSettingsLoaded: boolean;
  codexSettingsLoadError: string | null;
  savingCodexGlobalServiceMode: boolean;
  handleChangeCodexGlobalServiceMode: (mode: any) => void;
  loadCodexSettings: () => Promise<void>;
  // Modal triggers
  onSetProxyTarget: (target: { level: string; id: string; label: string }) => void;
  handleDistributeProxies: () => void;
  handleBatchTestAll: () => void;
  gateConnectionFlow: (callback: () => void) => void;
  openApiKeyAddFlow: () => void;
  openPrimaryAddFlow: () => void;
  openExternalLinkFlow: () => void;
  handleOpenCommandCodeConnect: () => void;
  commandCodeAuthState: { phase: string };
  onOpenOAuthModal: () => void;
  onOpenCodexCliGuide: () => void;
  onOpenImportCodex: () => void;
  onOpenImportClaude: () => void;
  onOpenImportGemini: () => void;
  onOpenImportGrokCli: () => void;
  t: ProviderMessageTranslator;
};

export default function ConnectionsHeaderToolbar({
  providerId,
  providerInfo,
  isCompatible,
  isCommandCode,
  isOAuth,
  providerSupportsPat,
  connections,
  batchTesting,
  batchRetesting,
  retestingId,
  proxyConfig,
  reorderingByAvailability,
  handleReorderByAvailability,
  preferClaudeCodeForUnprefixedClaudeModels,
  claudeRoutingSettingsLoaded,
  claudeRoutingSettingsLoadError,
  savingClaudeRoutingPreference,
  handleToggleClaudeRoutingPreference,
  loadClaudeRoutingSettings,
  codexGlobalServiceMode,
  codexGlobalServiceModeOptions,
  codexSettingsLoaded,
  codexSettingsLoadError,
  savingCodexGlobalServiceMode,
  handleChangeCodexGlobalServiceMode,
  loadCodexSettings,
  onSetProxyTarget,
  handleDistributeProxies,
  handleBatchTestAll,
  gateConnectionFlow,
  openApiKeyAddFlow,
  openPrimaryAddFlow,
  openExternalLinkFlow,
  handleOpenCommandCodeConnect,
  commandCodeAuthState,
  onOpenOAuthModal,
  onOpenCodexCliGuide,
  onOpenImportCodex,
  onOpenImportClaude,
  onOpenImportGemini,
  onOpenImportGrokCli,
  t,
}: ConnectionsHeaderToolbarProps) {
type ToolbarProps = Pick<
  ConnectionsHeaderToolbarProps,
  | "providerId"
  | "isCompatible"
  | "isCommandCode"
  | "providerSupportsPat"
  | "connections"
  | "gateConnectionFlow"
  | "openApiKeyAddFlow"
  | "openPrimaryAddFlow"
  | "handleOpenCommandCodeConnect"
  | "commandCodeAuthState"
  | "t"
>;

/** The head of the accounts card: its name and the one Add account button. */
export default function ConnectionsHeaderToolbar({
  providerId,
  isCompatible,
  isCommandCode,
  providerSupportsPat,
  connections,
  gateConnectionFlow,
  openApiKeyAddFlow,
  openPrimaryAddFlow,
  handleOpenCommandCodeConnect,
  commandCodeAuthState,
  t,
}: ToolbarProps) {
  const addLabel = providerSupportsPat
    ? providerText(t, "addPat", "Add PAT")
    : providerText(t, "addAccount", "Add account");
  const connecting =
    isCommandCode &&
    (commandCodeAuthState.phase === "starting" ||
      commandCodeAuthState.phase === "polling" ||
      commandCodeAuthState.phase === "applying");
  // A compatible provider's later accounts are added from its own card.
  const showAdd = !isCompatible || connections.length === 0;
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{providerText(t, "accountsTitle", "Accounts")}</h2>
      {showAdd && (
        <Button
          size="sm"
          icon="add"
          loading={connecting}
          onClick={() =>
            gateConnectionFlow(
              isCompatible
                ? openApiKeyAddFlow
                : isCommandCode
                  ? handleOpenCommandCodeConnect
                  : openPrimaryAddFlow
            )
          }
        >
          {addLabel}
        </Button>
      )}
    </div>
  );
}
