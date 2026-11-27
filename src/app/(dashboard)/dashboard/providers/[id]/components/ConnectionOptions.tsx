"use client";

import { Button, DistributeProxiesButton, Toggle } from "@/shared/components";
import { providerText } from "../providerPageHelpers";
import type { CodexGlobalServiceMode } from "@/lib/providers/codexFastTier";
import type { ConnectionsHeaderToolbarProps } from "./ConnectionsHeaderToolbar";

type ConnectionOptionsProps = Omit<
  ConnectionsHeaderToolbarProps,
  "openApiKeyAddFlow" | "openPrimaryAddFlow" | "handleOpenCommandCodeConnect" | "commandCodeAuthState"
> & {
  openApiKeyAddFlow: () => void;
};

/**
 * What used to crowd the head of the accounts card, now the body of the closed Options fold:
 * the provider proxy, distribute proxies, test all, reorder, and the import buttons.
 */
export default function ConnectionOptions({
  providerId,
  providerInfo,
  isCommandCode,
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
  openExternalLinkFlow,
  onOpenOAuthModal,
  onOpenImportCodex,
  onOpenImportClaude,
  onOpenImportGrokCli,
  t,
}: ConnectionOptionsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {providerId === "claude" && (
          <div
            className="inline-flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/5 px-2 py-1 text-xs font-medium text-text-muted"
            title={providerText(
              t,
              "preferClaudeCodeForUnprefixedClaudeModelsTooltip",
              "Route bare claude-* model IDs from Claude Code clients through the Claude Code account instead of asking for a provider prefix."
            )}
          >
            <span className="material-symbols-outlined text-[14px] text-warning">alt_route</span>
            <span>
              {providerText(
                t,
                "preferClaudeCodeForUnprefixedClaudeModelsLabel",
                "Claude Code default"
              )}
            </span>
            <Toggle
              size="sm"
              checked={preferClaudeCodeForUnprefixedClaudeModels}
              onChange={handleToggleClaudeRoutingPreference}
              disabled={savingClaudeRoutingPreference || !claudeRoutingSettingsLoaded}
              ariaLabel={providerText(
                t,
                "preferClaudeCodeForUnprefixedClaudeModelsAria",
                "Prefer Claude Code for unprefixed Claude models"
              )}
              title={
                preferClaudeCodeForUnprefixedClaudeModels
                  ? providerText(
                      t,
                      "preferClaudeCodeForUnprefixedClaudeModelsDisable",
                      "Disable Claude Code preference for bare claude-* model IDs"
                    )
                  : providerText(
                      t,
                      "preferClaudeCodeForUnprefixedClaudeModelsEnable",
                      "Enable Claude Code preference for bare claude-* model IDs"
                    )
              }
            />
            <span className="text-[11px] text-text-muted">
              {preferClaudeCodeForUnprefixedClaudeModels
                ? providerText(t, "toggleOnShort", "On")
                : providerText(t, "toggleOffShort", "Off")}
            </span>
            {claudeRoutingSettingsLoadError ? (
              <button
                type="button"
                onClick={() => void loadClaudeRoutingSettings()}
                className="rounded border border-warning/30 px-2 py-0.5 text-[11px] font-medium text-warning hover:bg-warning/10"
                title={claudeRoutingSettingsLoadError}
              >
                {providerText(t, "retry", "Retry")}
              </button>
            ) : null}
          </div>
        )}
        {providerId === "codex" && (
          <div
            className="inline-flex items-center gap-2 rounded-lg border border-info/20 bg-info/5 px-2 py-1 text-xs font-medium text-text-muted"
            title={providerText(
              t,
              "providerDetailServiceModeTooltip",
              "Set a global Codex service mode, or leave accounts on their individual service-tier setting."
            )}
          >
            <span>{providerText(t, "providerDetailServiceModeLabel", "Global service mode:")}</span>
            <select
              value={codexGlobalServiceMode}
              onChange={(event) =>
                handleChangeCodexGlobalServiceMode(event.target.value as CodexGlobalServiceMode)
              }
              disabled={savingCodexGlobalServiceMode || !codexSettingsLoaded}
              aria-label={providerText(t, "globalCodexServiceMode", "Global Codex service mode")}
              className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-text-main outline-none transition-colors focus:border-primary disabled:opacity-60"
            >
              {codexGlobalServiceModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {codexSettingsLoadError ? (
              <button
                type="button"
                onClick={() => void loadCodexSettings()}
                className="rounded border border-info/30 px-2 py-0.5 text-[11px] font-medium text-info hover:bg-info/10"
                title={codexSettingsLoadError}
              >
                {providerText(t, "retry", "Retry")}
              </button>
            ) : null}
          </div>
        )}
        {/* Provider-level proxy indicator/button */}
        <button
          onClick={() =>
            onSetProxyTarget({
              level: "provider",
              id: providerId,
              label: providerInfo?.name || providerId,
            })
          }
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all ${
            proxyConfig?.providers?.[providerId]
              ? "bg-warning/15 text-warning hover:bg-warning/25"
              : "bg-surface-2 text-text-muted hover:text-text-main hover:bg-border"
          }`}
          title={
            proxyConfig?.providers?.[providerId]
              ? t("providerProxyTitleConfigured", {
                  host: proxyConfig.providers[providerId].host || t("configured"),
                })
              : t("providerProxyConfigureHint")
          }
        >
          <span className="material-symbols-outlined text-[14px]">vpn_lock</span>
          {proxyConfig?.providers?.[providerId]
            ? proxyConfig.providers[providerId].host || t("providerProxy")
            : t("providerProxy")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {connections.length > 0 && (
          <DistributeProxiesButton
            onDistribute={async () => {
              await handleDistributeProxies();
            }}
            disabled={batchTesting || !!retestingId}
          />
        )}
        {connections.length > 1 && (
          <button
            onClick={handleBatchTestAll}
            disabled={batchTesting || batchRetesting || !!retestingId}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              batchTesting
                ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
            }`}
            title={t("testAll")}
            aria-label={t("testAll")}
          >
            <span className="material-symbols-outlined text-[14px]">
              {batchTesting ? "sync" : "play_arrow"}
            </span>
            {batchTesting ? t("testing") : t("testAll")}
          </button>
        )}
        {connections.length > 1 && (
          <Button
            size="sm"
            variant="secondary"
            icon="swap_vert"
            loading={reorderingByAvailability}
            disabled={batchTesting || !!retestingId}
            onClick={() => void handleReorderByAvailability()}
            title={providerText(
              t,
              "reorderByAvailabilityTitle",
              "Reorder connections by availability"
            )}
          >
            {providerText(t, "reorderByAvailability", "Reorder")}
          </Button>
        )}
        {(isCommandCode || providerId === "clinepass") && (
          <Button
            size="sm"
            variant="secondary"
            icon="add"
            onClick={() => gateConnectionFlow(openApiKeyAddFlow)}
          >
            {providerText(t, "manualApiKey", "Manual API key")}
          </Button>
        )}
        {providerId === "qoder" && (
          <Button size="sm" variant="secondary" onClick={() => gateConnectionFlow(onOpenOAuthModal)}>
            {providerText(t, "experimentalOauth", "Experimental OAuth")}
          </Button>
        )}
        {providerId === "codex" && (
          <>
            <Button
              size="sm"
              variant="secondary"
              icon="share"
              onClick={() => gateConnectionFlow(openExternalLinkFlow)}
            >
              {providerText(t, "codexExternalLinkButton", "External Codex link")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="upload_file"
              onClick={() => gateConnectionFlow(onOpenImportCodex)}
            >
              {providerText(t, "importCodexAuth", "Import auth")}
            </Button>
          </>
        )}
        {providerId === "claude" && (
          <Button
            size="sm"
            variant="secondary"
            icon="upload_file"
            onClick={() => gateConnectionFlow(onOpenImportClaude)}
          >
            {providerText(t, "importClaudeAuth", "Import auth")}
          </Button>
        )}
        {providerId === "grok-cli" && (
          <Button
            size="sm"
            variant="secondary"
            icon="upload_file"
            onClick={() => gateConnectionFlow(onOpenImportGrokCli)}
          >
            {providerText(t, "importGrokAuth", "Import auth")}
          </Button>
        )}
      </div>
    </div>
  );
}
