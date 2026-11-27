"use client";

// ConnectionRow (and its local helpers CooldownTimer, inferErrorType,
// getStatusPresentation) moved out of ProviderDetailPageClient.tsx.

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/shared/components";
import { pickDisplayValue } from "@/shared/utils/maskEmail";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";
import { isClaudeExtraUsageBlockEnabled } from "@/lib/providers/claudeExtraUsage";
import { shouldShowConnectionLastError } from "./connectionRowHelpers";
import {
  getCodexEffectiveServiceTier,
  type CodexGlobalServiceMode,
} from "@/lib/providers/codexFastTier";
import { normalizeCodexLimitPolicy, providerText, ERROR_TYPE_LABELS } from "../providerPageHelpers";
import { getCodexPlanLabel } from "../codexPlanLabel";
import ProviderQuotaVisibilityToggle from "./ProviderQuotaVisibilityToggle";

// ---------------------------------------------------------------------------
// Types (exported so the client can reference them without re-importing)
// ---------------------------------------------------------------------------

export interface ConnectionRowConnection {
  id?: string;
  provider?: string;
  name?: string;
  email?: string;
  displayName?: string;
  rateLimitedUntil?: string;
  rateLimitProtection?: boolean;
  testStatus?: string;
  isActive?: boolean;
  priority?: number;
  lastError?: string;
  lastErrorType?: string;
  lastErrorSource?: string;
  errorCode?: string | number;
  globalPriority?: number;
  providerSpecificData?: Record<string, unknown>;
  expiresAt?: string;
  tokenExpiresAt?: string;
  maxConcurrent?: number | null;
  authType?: string;
  proxyEnabled?: boolean;
  perKeyProxyEnabled?: boolean;
  quotaVisible?: boolean;
}

export interface ConnectionRowProps {
  connection: ConnectionRowConnection;
  isOAuth: boolean;
  isClaude?: boolean;
  isCodex?: boolean;
  codexGlobalServiceMode?: CodexGlobalServiceMode;
  isFirst: boolean;
  isLast: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggleActive: (isActive?: boolean) => void | Promise<void>;
  onToggleRateLimit: (enabled?: boolean) => void;
  onToggleQuotaVisibility?: (visible: boolean) => void;
  onToggleClaudeExtraUsage?: (enabled?: boolean) => void;
  onToggleCodex5h?: (enabled?: boolean) => void;
  onToggleCodexWeekly?: (enabled?: boolean) => void;
  isCcCompatible?: boolean;
  cliproxyapiEnabled?: boolean;
  onToggleCliproxyapiMode?: (enabled?: boolean) => void;
  onRetest: () => void;
  isRetesting?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onReauth?: () => void;
  onProxy?: () => void;
  hasProxy?: boolean;
  proxySource?: string;
  proxyHost?: string;
  proxyName?: string | null;
  proxyEnabled?: boolean;
  perKeyProxyEnabled?: boolean;
  onToggleProxyEnabled?: (enabled: boolean) => void;
  onTogglePerKeyProxyEnabled?: (enabled: boolean) => void;
  onRefreshToken?: () => void;
  isRefreshing?: boolean;
  onApplyCodexAuthLocal?: () => void;
  isApplyingCodexAuthLocal?: boolean;
  onExportCodexAuthFile?: () => void;
  isExportingCodexAuthFile?: boolean;
  onApplyClaudeAuthLocal?: () => void;
  isApplyingClaudeAuthLocal?: boolean;
  onExportClaudeAuthFile?: () => void;
  isExportingClaudeAuthFile?: boolean;
}

// ---------------------------------------------------------------------------
// CooldownTimerProps (local — only used below)
// ---------------------------------------------------------------------------

interface CooldownTimerProps {
  until: string | number | Date;
}

// ---------------------------------------------------------------------------
// CooldownTimer
// ---------------------------------------------------------------------------

function CooldownTimer({ until }: CooldownTimerProps) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const updateRemaining = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining("");
        return;
      }
      const secs = Math.floor(diff / 1000);
      if (secs < 60) {
        setRemaining(`${secs}s`);
      } else if (secs < 3600) {
        setRemaining(`${Math.floor(secs / 60)}m ${secs % 60}s`);
      } else {
        const hrs = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        setRemaining(`${hrs}h ${mins}m`);
      }
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 1000);
    return () => clearInterval(interval);
  }, [until]);

  if (!remaining) return null;

  return <span className="text-xs text-warning font-mono tabular-nums">⏱ {remaining}</span>;
}

// ---------------------------------------------------------------------------
// inferErrorType
// ---------------------------------------------------------------------------

function inferErrorType(connection: ConnectionRowConnection, isCooldown: boolean): string | null {
  if (isCooldown) return "upstream_rate_limited";
  if (connection.testStatus === "banned") return "banned";
  if (connection.testStatus === "credits_exhausted") return "credits_exhausted";
  if (connection.lastErrorType) return connection.lastErrorType;

  const code = Number(connection.errorCode);
  if (code === 401 || code === 403) return "upstream_auth_error";
  if (code === 429) return "upstream_rate_limited";
  if (code >= 500) return "upstream_unavailable";

  const msg = (connection.lastError || "").toLowerCase();
  if (!msg) return null;
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed") ||
    msg.includes("healthcheck")
  )
    return "runtime_error";
  if (msg.includes("refresh failed")) return "token_refresh_failed";
  if (msg.includes("token expired") || msg.includes("expired")) return "token_expired";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("access denied") ||
    msg.includes("unauthorized")
  )
    return "upstream_auth_error";
  if (
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("too many requests") ||
    msg.includes("429")
  )
    return "upstream_rate_limited";
  if (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econn") ||
    msg.includes("enotfound")
  )
    return "network_error";
  if (msg.includes("not supported")) return "unsupported";
  return "upstream_error";
}

// ---------------------------------------------------------------------------
// getStatusPresentation
// ---------------------------------------------------------------------------

type TFn = (key: string, values?: Record<string, unknown>) => string;

function getStatusPresentation(
  connection: ConnectionRowConnection,
  effectiveStatus: string | undefined,
  isCooldown: boolean,
  t: TFn
) {
  if (connection.isActive === false) {
    return {
      statusVariant: "default",
      statusLabel: t("statusDisabled"),
      errorType: null,
      errorBadge: null,
      errorTextClass: "text-text-muted",
    };
  }

  // A new account nobody has tested yet is not a failure: the list above counts it as working.
  if (
    effectiveStatus === "active" ||
    effectiveStatus === "success" ||
    effectiveStatus === "unknown" ||
    !effectiveStatus
  ) {
    return {
      statusVariant: "success",
      statusLabel: t("statusConnected"),
      errorType: null,
      errorBadge: null,
      errorTextClass: "text-text-muted",
    };
  }

  const errorType = inferErrorType(connection, isCooldown);
  const errorBadge = errorType ? ERROR_TYPE_LABELS[errorType] || null : null;

  if (errorType === "runtime_error") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusRuntimeIssue"),
      errorType,
      errorBadge,
      errorTextClass: "text-warning",
    };
  }

  if (errorType === "account_deactivated") {
    return {
      statusVariant: "error",
      statusLabel: t("statusDeactivated", "Deactivated"),
      errorType,
      errorBadge,
      errorTextClass: "text-error font-bold",
    };
  }

  if (
    errorType === "upstream_auth_error" ||
    errorType === "auth_missing" ||
    errorType === "token_refresh_failed" ||
    errorType === "token_expired"
  ) {
    return {
      statusVariant: "error",
      statusLabel: t("statusAuthFailed"),
      errorType,
      errorBadge,
      errorTextClass: "text-error",
    };
  }

  if (errorType === "upstream_rate_limited") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusRateLimited"),
      errorType,
      errorBadge,
      errorTextClass: "text-warning",
    };
  }

  if (errorType === "network_error") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusNetworkIssue"),
      errorType,
      errorBadge,
      errorTextClass: "text-warning",
    };
  }

  if (errorType === "unsupported") {
    return {
      statusVariant: "default",
      statusLabel: t("statusTestUnsupported"),
      errorType,
      errorBadge,
      errorTextClass: "text-text-muted",
    };
  }

  if (errorType === "banned") {
    return {
      statusVariant: "error",
      statusLabel: t("statusBanned", "Banned (403)"),
      errorType,
      errorBadge,
      errorTextClass: "text-error font-bold",
    };
  }

  if (errorType === "credits_exhausted") {
    return {
      statusVariant: "warning",
      statusLabel: t("statusCreditsExhausted", "Out of Credits"),
      errorType,
      errorBadge,
      errorTextClass: "text-warning",
    };
  }

  const fallbackStatusMap: Record<string, string> = {
    unavailable: t("statusUnavailable"),
    failed: t("statusFailed"),
    error: t("statusError"),
  };

  return {
    statusVariant: "error",
    statusLabel: fallbackStatusMap[effectiveStatus ?? ""] || effectiveStatus || t("statusError"),
    errorType,
    errorBadge,
    errorTextClass: "text-error",
  };
}

// ---------------------------------------------------------------------------
// ConnectionRow
// ---------------------------------------------------------------------------

export default function ConnectionRow({
  connection,
  isOAuth,
  isClaude,
  isCodex,
  codexGlobalServiceMode,
  isCcCompatible,
  cliproxyapiEnabled,
  isFirst,
  isLast,
  isSelected,
  onToggleSelect,
  onMoveUp,
  onMoveDown,
  onToggleActive,
  onToggleRateLimit,
  onToggleQuotaVisibility,
  onToggleClaudeExtraUsage,
  onToggleCodex5h,
  onToggleCodexWeekly,
  onToggleCliproxyapiMode,
  onRetest,
  isRetesting,
  onEdit,
  onDelete,
  onReauth,
  onProxy,
  hasProxy,
  proxySource,
  proxyHost,
  proxyName,
  onRefreshToken,
  isRefreshing,
  onApplyCodexAuthLocal,
  isApplyingCodexAuthLocal,
  onExportCodexAuthFile,
  isExportingCodexAuthFile,
  onApplyClaudeAuthLocal,
  isApplyingClaudeAuthLocal,
  onExportClaudeAuthFile,
  isExportingClaudeAuthFile,
  perKeyProxyEnabled,
  onTogglePerKeyProxyEnabled,
  proxyEnabled,
  onToggleProxyEnabled,
}: ConnectionRowProps) {
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const emailsVisible = useEmailPrivacyStore((s) => s.emailsVisible);
  const displayName = isOAuth
    ? pickDisplayValue(
        [connection.name, connection.email, connection.displayName],
        emailsVisible,
        t("oauthAccount")
      )
    : connection.name;
  const applyCodexAuthLabel =
    typeof t.has === "function" && t.has("applyCodexAuthLocal")
      ? t("applyCodexAuthLocal")
      : "Apply auth";
  const exportCodexAuthLabel =
    typeof t.has === "function" && t.has("exportCodexAuthFile")
      ? t("exportCodexAuthFile")
      : "Export auth";
  const applyClaudeAuthLabel =
    typeof t.has === "function" && t.has("applyClaudeAuthLocal")
      ? t("applyClaudeAuthLocal")
      : "Apply auth";
  const exportClaudeAuthLabel =
    typeof t.has === "function" && t.has("exportClaudeAuthFile")
      ? t("exportClaudeAuthFile")
      : "Export auth";
  // Use useState + useEffect for impure Date.now() to avoid calling during render
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCooldown, setIsCooldown] = useState(false);
  // Token expiry status — lazy init avoids calling Date.now() during render;
  // updates every 30s via interval only (no sync setState in effect body).
  // Prefer tokenExpiresAt (updated on each refresh) over expiresAt (original grant date).
  const effectiveExpiresAt = connection.tokenExpiresAt || connection.expiresAt;
  const getTokenMinsLeft = () => {
    if (!isOAuth || !effectiveExpiresAt) return null;
    const expiresMs = new Date(effectiveExpiresAt).getTime();
    return Math.floor((expiresMs - Date.now()) / 60000);
  };
  const [tokenMinsLeft, setTokenMinsLeft] = useState<number | null>(getTokenMinsLeft);

  useEffect(() => {
    if (!isOAuth || !effectiveExpiresAt) return;
    const update = () => {
      const expiresMs = new Date(effectiveExpiresAt).getTime();
      setTokenMinsLeft(Math.floor((expiresMs - Date.now()) / 60000));
    };
    update();
    const iv = setInterval(update, 30000);
    return () => clearInterval(iv);
  }, [isOAuth, effectiveExpiresAt]);

  useEffect(() => {
    const checkCooldown = () => {
      const cooldown =
        connection.rateLimitedUntil && new Date(connection.rateLimitedUntil).getTime() > Date.now();
      setIsCooldown(!!cooldown);
    };

    checkCooldown();
    // Update every second while in cooldown
    const interval = connection.rateLimitedUntil ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connection.rateLimitedUntil]);

  // Determine effective status (override unavailable if cooldown expired)
  const effectiveStatus =
    connection.testStatus === "unavailable" && !isCooldown
      ? "active" // Cooldown expired → treat as active
      : connection.testStatus;

  const statusPresentation = getStatusPresentation(connection, effectiveStatus, isCooldown, t);
  const rateLimitEnabled = !!connection.rateLimitProtection;
  const quotaVisible = connection.quotaVisible !== false;
  const codexPolicy =
    connection.providerSpecificData &&
    typeof connection.providerSpecificData === "object" &&
    connection.providerSpecificData.codexLimitPolicy &&
    typeof connection.providerSpecificData.codexLimitPolicy === "object"
      ? connection.providerSpecificData.codexLimitPolicy
      : {};
  const normalizedCodexPolicy = normalizeCodexLimitPolicy(codexPolicy);
  const codex5hEnabled = normalizedCodexPolicy.use5h;
  const codexWeeklyEnabled = normalizedCodexPolicy.useWeekly;
  const codexServiceTier = isCodex
    ? getCodexEffectiveServiceTier(
        connection.providerSpecificData,
        codexGlobalServiceMode ?? "none"
      )
    : "default";
  const codexServiceTierIsGlobal =
    isCodex && codexGlobalServiceMode !== undefined && codexGlobalServiceMode !== "none";
  const codexServiceTierBadge =
    codexServiceTier === "priority"
      ? {
          label: providerText(t, "codexTierFastLabel", "Fast"),
          icon: "bolt",
          className: "bg-info/15 text-info",
          title: codexServiceTierIsGlobal
            ? providerText(
                t,
                "providerDetailGlobalPriorityActive",
                "Global Codex priority service tier is active"
              )
            : providerText(
                t,
                "providerDetailConnectionPriorityActive",
                "Codex priority service tier is active for this connection"
              ),
        }
      : codexServiceTier === "flex"
        ? {
            label: providerText(t, "codexTierFlexLabel", "Flex"),
            icon: "speed",
            className: "bg-info/10 text-info",
            title: codexServiceTierIsGlobal
              ? providerText(
                  t,
                  "providerDetailGlobalFlexActive",
                  "Global Codex flex service tier is active"
                )
              : providerText(
                  t,
                  "providerDetailConnectionFlexActive",
                  "Codex flex service tier is active for this connection"
                ),
          }
        : null;
  const claudeBlockExtraUsageEnabled = isClaude
    ? isClaudeExtraUsageBlockEnabled("claude", connection.providerSpecificData)
    : false;
  const codexPlanLabel = getCodexPlanLabel(!!isCodex, connection.providerSpecificData);
  const cliproxyapiDeepMode = !!cliproxyapiEnabled;

  const act =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-bg-subtle px-3 text-xs font-medium text-text-main transition-colors hover:bg-surface-2 disabled:opacity-50";
  const off = "bg-surface-2 text-text-muted hover:text-text-main hover:bg-border";
  const chip = "inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-medium transition-colors";
  const isActive = connection.isActive ?? true;

  return (
    <div
      className={`group flex flex-col gap-2 rounded-lg p-3 transition-colors hover:bg-surface-2 ${connection.isActive === false ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-3">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            aria-label={displayName}
            className="size-4 shrink-0 cursor-pointer rounded border-border text-primary focus:ring-primary/30"
          />
        )}
        <span className="material-symbols-outlined shrink-0 text-base text-text-muted">
          {isOAuth ? "lock" : "key"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-normal text-sm font-medium [overflow-wrap:normal]" title={displayName}>
            <span className="block truncate">{displayName}</span>
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant={statusPresentation.statusVariant as any} size="sm" dot>
              {statusPresentation.statusLabel}
            </Badge>
            {codexPlanLabel && (
              <Badge variant="primary" size="sm" className="capitalize">
                {codexPlanLabel}
              </Badge>
            )}
            {/* The red "Token Expired" badge is terminal-only: providers that refresh their own
               token lapse every hour without being broken, so only testStatus "expired" paints red. */}
            {tokenMinsLeft !== null &&
              (tokenMinsLeft < 0 ? (
                connection.testStatus === "expired" ? (
                  <span
                    className="inline-flex items-center gap-0.5 rounded bg-error/15 px-1.5 py-0.5 text-xs font-medium text-error"
                    title={t("tokenExpiredTitle", { date: effectiveExpiresAt })}
                  >
                    <span className="material-symbols-outlined text-[11px]">error</span>
                    {t("tokenExpiredBadge")}
                  </span>
                ) : null
              ) : tokenMinsLeft < 30 ? (
                <span
                  className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-xs font-medium text-warning"
                  title={t("tokenExpiresSoonTitle", { minutes: tokenMinsLeft })}
                >
                  <span className="material-symbols-outlined text-[11px]">warning</span>
                  {`~${tokenMinsLeft}m`}
                </span>
              ) : null)}
            {isCooldown && connection.isActive !== false && (
              <CooldownTimer until={connection.rateLimitedUntil!} />
            )}
            {statusPresentation.errorBadge && connection.isActive !== false && (
              <Badge variant={statusPresentation.errorBadge.variant} size="sm">
                {t(statusPresentation.errorBadge.labelKey)}
              </Badge>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-label={providerText(t, "accountMoreActions", "More actions")}
          title={providerText(t, "accountMoreActions", "More actions")}
          className="flex size-10 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
        >
          <span className="material-symbols-outlined text-[22px]" aria-hidden="true">
            more_horiz
          </span>
        </button>
      </div>

      {shouldShowConnectionLastError(connection) && (
        <p
          className={`line-clamp-2 text-xs ${statusPresentation.errorTextClass}`}
          title={connection.lastError}
        >
          {connection.lastError}
        </p>
      )}

      {menuOpen && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={act}
              disabled={connection.isActive === false || isRetesting}
              onClick={onRetest}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {isRetesting ? "sync" : "play_arrow"}
              </span>
              {providerText(t, "accountTest", "Test")}
            </button>
            <button type="button" className={act} onClick={onEdit}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                edit
              </span>
              {t("edit")}
            </button>
            <button type="button" className={act} onClick={() => onToggleActive(!isActive)}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {isActive ? "toggle_off" : "toggle_on"}
              </span>
              {isActive
                ? providerText(t, "accountTurnOff", "Turn off")
                : providerText(t, "accountTurnOn", "Turn on")}
            </button>
            <button
              type="button"
              className={`${act} !text-error hover:!bg-error/10`}
              onClick={onDelete}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                delete
              </span>
              {providerText(t, "accountRemove", "Remove")}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted">#{connection.priority}</span>
            {connection.globalPriority && (
              <span className="text-xs text-text-muted">
                {t("autoPriority", { priority: connection.globalPriority })}
              </span>
            )}
            <button
              type="button"
              onClick={onMoveUp}
              disabled={isFirst}
              aria-label={tc("moveUp")}
              title={tc("moveUp")}
              className={`${chip} ${off} disabled:opacity-40`}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                keyboard_arrow_up
              </span>
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast}
              aria-label={tc("moveDown")}
              title={tc("moveDown")}
              className={`${chip} ${off} disabled:opacity-40`}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                keyboard_arrow_down
              </span>
            </button>
            {connection.maxConcurrent != null && connection.maxConcurrent > 0 && (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-text-muted"
                title={t("accountConcurrencyCapLabel")}
              >
                <span className="material-symbols-outlined text-[11px]">dynamic_feed</span>
                {connection.maxConcurrent}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onToggleRateLimit(!rateLimitEnabled)}
              className={`${chip} ${rateLimitEnabled ? "bg-success/15 text-success hover:bg-success/25" : off}`}
              title={
                rateLimitEnabled ? t("disableRateLimitProtection") : t("enableRateLimitProtection")
              }
            >
              <span className="material-symbols-outlined text-[13px]">shield</span>
              {rateLimitEnabled ? t("rateLimitProtected") : t("rateLimitUnprotected")}
            </button>
            {onToggleQuotaVisibility && (
              <ProviderQuotaVisibilityToggle
                visible={quotaVisible}
                onToggle={onToggleQuotaVisibility}
              />
            )}
            {isClaude && (
              <button
                type="button"
                onClick={() => onToggleClaudeExtraUsage?.(!claudeBlockExtraUsageEnabled)}
                className={`${chip} ${!claudeBlockExtraUsageEnabled ? "bg-warning/15 text-warning hover:bg-warning/25" : off}`}
                title={t("claudeExtraUsageToggleTitle")}
              >
                <span className="material-symbols-outlined text-[13px]">payments</span>
                {t("claudeExtraUsageShort")}{" "}
                {!claudeBlockExtraUsageEnabled ? t("toggleOnShort") : t("toggleOffShort")}
              </button>
            )}
            {isCcCompatible && (
              <button
                type="button"
                onClick={() => onToggleCliproxyapiMode?.(!cliproxyapiDeepMode)}
                className={`${chip} ${cliproxyapiDeepMode ? "bg-primary/15 text-primary-text hover:bg-primary/25" : off}`}
                title={cliproxyapiDeepMode ? t("cpaModeEnabledTitle") : t("cpaModeDisabledTitle")}
              >
                <span className="material-symbols-outlined text-[13px]">swap_horiz</span>
                CPA {cliproxyapiDeepMode ? t("toggleOnShort") : t("toggleOffShort")}
              </button>
            )}
            {isCodex && (
              <>
                {codexServiceTierBadge && (
                  <span
                    className={`${chip} ${codexServiceTierBadge.className}`}
                    title={codexServiceTierBadge.title}
                  >
                    <span className="material-symbols-outlined text-[13px]">
                      {codexServiceTierBadge.icon}
                    </span>
                    {codexServiceTierBadge.label}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onToggleCodex5h?.(!codex5hEnabled)}
                  className={`${chip} ${codex5hEnabled ? "bg-primary/15 text-primary-text hover:bg-primary/25" : off}`}
                  title={t("codex5hToggleTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">timer</span>
                  5h {codex5hEnabled ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
                <button
                  type="button"
                  onClick={() => onToggleCodexWeekly?.(!codexWeeklyEnabled)}
                  className={`${chip} ${codexWeeklyEnabled ? "bg-primary/15 text-primary-text hover:bg-primary/25" : off}`}
                  title={t("codexWeeklyToggleTitle")}
                >
                  <span className="material-symbols-outlined text-[13px]">date_range</span>
                  {t("weeklyShort")} {codexWeeklyEnabled ? t("toggleOnShort") : t("toggleOffShort")}
                </button>
              </>
            )}
            {onToggleProxyEnabled && (
              <button
                type="button"
                onClick={() => onToggleProxyEnabled(!proxyEnabled)}
                aria-label={proxyEnabled ? t("proxyEnabledTitle") : t("proxyDisabledTitle")}
                className={`${chip} ${proxyEnabled ? "bg-success/15 text-success hover:bg-success/25" : off}`}
                title={proxyEnabled ? t("proxyEnabledTitle") : t("proxyDisabledTitle")}
              >
                <span className="material-symbols-outlined text-[13px]">vpn_lock</span>
                {proxyEnabled ? t("proxyOn") : t("proxyOff")}
              </button>
            )}
            {onTogglePerKeyProxyEnabled && (
              <button
                type="button"
                onClick={() => onTogglePerKeyProxyEnabled(!perKeyProxyEnabled)}
                aria-label={
                  perKeyProxyEnabled ? t("perKeyProxyEnabledTitle") : t("perKeyProxyDisabledTitle")
                }
                className={`${chip} ${perKeyProxyEnabled ? "bg-primary/15 text-primary-text hover:bg-primary/25" : off}`}
                title={
                  perKeyProxyEnabled ? t("perKeyProxyEnabledTitle") : t("perKeyProxyDisabledTitle")
                }
              >
                <span className="material-symbols-outlined text-[13px]">key</span>
                {t("perKeyProxyOn")} {perKeyProxyEnabled ? t("toggleOnShort") : t("toggleOffShort")}
              </button>
            )}
            {hasProxy &&
              (() => {
                const colorClass =
                  proxySource === "global"
                    ? "bg-success/15 text-success"
                    : proxySource === "provider"
                      ? "bg-warning/15 text-warning"
                      : "bg-primary/15 text-primary-text";
                const label =
                  proxySource === "global"
                    ? t("proxySourceGlobal")
                    : proxySource === "provider"
                      ? t("proxySourceProvider")
                      : t("proxySourceKey");
                return (
                  <span
                    className={`${chip} ${colorClass}`}
                    title={t("proxyConfiguredBySource", {
                      source: label,
                      host: proxyHost || t("configured"),
                    })}
                  >
                    <span className="material-symbols-outlined text-[13px]">vpn_lock</span>
                    {proxyName || proxyHost || t("proxy")}
                  </span>
                );
              })()}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onReauth && (
              <button type="button" className={`${act} !text-warning`} onClick={onReauth}>
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  passkey
                </span>
                {t("reauthenticateConnection")}
              </button>
            )}
            <button type="button" className={act} onClick={onProxy}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                vpn_lock
              </span>
              {t("proxyConfig")}
            </button>
            {onRefreshToken && (
              <button
                type="button"
                className={`${act} !text-warning`}
                disabled={connection.isActive === false || isRefreshing}
                onClick={onRefreshToken}
                title={t("refreshOauthTokenTitle")}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  token
                </span>
                {t("tokenShort")}
              </button>
            )}
            {isCodex && onApplyCodexAuthLocal && (
              <button
                type="button"
                className={`${act} !text-success`}
                disabled={isApplyingCodexAuthLocal}
                onClick={onApplyCodexAuthLocal}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  download_done
                </span>
                {applyCodexAuthLabel}
              </button>
            )}
            {isCodex && onExportCodexAuthFile && (
              <button
                type="button"
                className={`${act} !text-info`}
                disabled={isExportingCodexAuthFile}
                onClick={onExportCodexAuthFile}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  download
                </span>
                {exportCodexAuthLabel}
              </button>
            )}
            {isClaude && onApplyClaudeAuthLocal && (
              <button
                type="button"
                className={`${act} !text-success`}
                disabled={isApplyingClaudeAuthLocal}
                onClick={onApplyClaudeAuthLocal}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  install_desktop
                </span>
                {applyClaudeAuthLabel}
              </button>
            )}
            {isClaude && onExportClaudeAuthFile && (
              <button
                type="button"
                className={`${act} !text-info`}
                disabled={isExportingClaudeAuthFile}
                onClick={onExportClaudeAuthFile}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  download
                </span>
                {exportClaudeAuthLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
