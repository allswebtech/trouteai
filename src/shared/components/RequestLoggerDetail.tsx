"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { PROVIDER_COLORS, getProtocolColor } from "@/shared/constants/colors";
import {
  LOG_STATUS_NEUTRAL_CLASS,
  getCacheSourceMeta,
  getStatusBadgeClass,
} from "./logTableStyles";
import { formatDuration, formatApiKeyLabel, maskAccount } from "@/shared/utils/formatting";
import { formatErrorForDisplay } from "@/shared/utils/formatting";

// ─── Payload Code Block ─────────────────────────────────────────────────────

function PayloadSection({ title, json, onCopy, collapsible = true, defaultOpen = true }) {
  const t = useTranslations("requestLoggerDetail");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  const handleCopy = async () => {
    const success = await onCopy();
    if (success !== false) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-text-main">{title}</h3>
          {collapsible && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
              aria-label={open ? t("collapseSection", { title }) : t("expandSection", { title })}
            >
              <span className="material-symbols-outlined text-[16px]">
                {open ? "expand_less" : "expand_more"}
              </span>
            </button>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
          aria-label={t("copySection", { title })}
        >
          <span className="material-symbols-outlined text-[14px]">
            {copied ? "check" : "content_copy"}
          </span>
          {copied ? t("copied") : t("copy")}
        </button>
      </div>
      {open && (
        <pre className="p-4 rounded-card bg-black/5 dark:bg-black/30 border border-border overflow-x-auto text-xs font-mono text-text-main max-h-150 overflow-y-auto leading-relaxed whitespace-pre-wrap break-words">
          {json}
        </pre>
      )}
    </div>
  );
}

// ─── Stream section + Detail Modal ───────────────────────────────────────────────────────────

function StreamSection({ title, json, onCopy }) {
  const t = useTranslations("requestLoggerDetail");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const [autoscroll, setAutoscroll] = useState(() => {
    try {
      const v = localStorage.getItem("pref:stream:autoscroll");
      return v == null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const ref = useRef(null);

  const handleCopy = async () => {
    const success = await onCopy();
    if (success !== false) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    if (!autoscroll || !open) return;
    const el = ref.current;
    if (!el) return;
    // scroll on next animation frame to avoid layout thrash
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {}
    });
  }, [json, autoscroll, open]);

  const toggleAutoscroll = () => {
    const next = !autoscroll;
    setAutoscroll(next);
    try {
      localStorage.setItem("pref:stream:autoscroll", next ? "1" : "0");
    } catch {}
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-text-main">{title}</h3>
          <button
            onClick={() => setOpen((v) => !v)}
            className="p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
            aria-label={open ? t("collapseSection", { title }) : t("expandSection", { title })}
          >
            <span className="material-symbols-outlined text-[16px]">
              {open ? "expand_less" : "expand_more"}
            </span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleAutoscroll}
            title={autoscroll ? t("autoscrollOn") : t("autoscrollOff")}
            aria-label={autoscroll ? t("autoscrollOn") : t("autoscrollOff")}
            className={`p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors ${autoscroll ? "text-primary-text" : ""}`}
            aria-pressed={autoscroll}
          >
            <span className="material-symbols-outlined text-[18px]">vertical_align_bottom</span>
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
            aria-label={t("copySection", { title })}
          >
            <span className="material-symbols-outlined text-[14px]">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
      </div>
      {open && (
        <div
          ref={ref}
          className="p-4 rounded-card bg-black/5 dark:bg-black/30 border border-border overflow-x-auto text-xs font-mono text-text-main max-h-150 overflow-y-auto leading-relaxed whitespace-pre-wrap break-words"
        >
          {json}
        </div>
      )}
    </div>
  );
}

// ─── Detail Modal ───────────────────────────────────────────────────────────

type StreamChunks = Record<string, string | string[]>;

function getCodexAccountRotation(detail) {
  const sources = [detail?.requestBody, detail?.responseBody];

  for (const source of sources) {
    const meta = source?._trouteai;
    const rotation = meta?.codexAccountRotation;
    if (
      rotation &&
      typeof rotation.initialConnectionId === "string" &&
      typeof rotation.finalConnectionId === "string" &&
      rotation.initialConnectionId !== rotation.finalConnectionId
    ) {
      return rotation;
    }
  }

  return null;
}

function formatConnectionId(value) {
  if (typeof value !== "string" || value.length === 0) return "-";
  return value.length > 8 ? `${value.slice(0, 8)}...` : value;
}

export default function RequestLoggerDetail({
  log,
  detail,
  loading,
  debugEnabled,
  emailsVisible = false,
  onClose,
  onCopy,
  onPrevious,
  onNext,
  relatedLogs = [],
  onSelectRelated,
}) {
  const t = useTranslations("requestLoggerDetail");
  // Close on Escape key
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", handler);
    return () => globalThis.removeEventListener("keydown", handler);
  }, [onClose]);

  const protocolKey = log.sourceFormat || log.provider;
  const protocol = getProtocolColor(protocolKey, log.provider);
  const providerLabel =
    log.providerDisplay ||
    PROVIDER_COLORS[log.provider]?.label ||
    (log.provider || "-").toUpperCase();

  const [unblocking, setUnblocking] = useState(false);
  const [cleared, setCleared] = useState(false);

  // This component has formatErrorForDisplay for structured error objects, but the
  // combo/cooldown checks below went straight to the raw field and call
  // .toLowerCase() on it — which throws the moment `error` is an object. Same helper,
  // same normalization, one source of truth.
  const errorText = formatErrorForDisplay(detail?.error || log.error) ?? "";
  const isCombo503 =
    log.status === 503 && errorText.toLowerCase().includes("all targets exhausted");
  const isModelCooldown = !isCombo503 && errorText.toLowerCase().includes("cooling down");

  const [unblockAllBusy, setUnblockAllBusy] = useState(false);

  const handleUnblockModel = async () => {
    if (!log.provider || !log.model) return;
    setUnblocking(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: log.provider, model: log.model }),
      });
      if (res.ok) setCleared(true);
    } catch {
      /* ignore */
    } finally {
      setUnblocking(false);
    }
  };

  const handleUnblockAll = async () => {
    setUnblockAllBusy(true);
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (res.ok) setCleared(true);
    } catch {
      /* ignore */
    } finally {
      setUnblockAllBusy(false);
    }
  };

  const providerStatus = detail?.pipelinePayloads?.providerResponse?.status;
  const hasStatusDiscrepancy = providerStatus && providerStatus !== log.status;

  const formatDate = (iso) => {
    if (iso == null) return "\u2014";
    try {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return "\u2014";
      return (
        d.toLocaleDateString("pt-BR") + ", " + d.toLocaleTimeString("en-US", { hour12: false })
      );
    } catch {
      return "\u2014";
    }
  };

  const toPrettyJson = (payload) => {
    if (payload === null || payload === undefined) return null;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  };

  const pipelinePayloads = detail?.pipelinePayloads || null;
  const payloadSections = pipelinePayloads
    ? [
        ["clientRawRequest", t("sectionClientRawRequest")],
        ["clientRequest", t("sectionClientRequest")],
        ["openaiRequest", t("sectionOpenaiRequest")],
        ["providerRequest", t("sectionProviderRequest")],
        ["providerResponse", t("sectionProviderResponse")],
        ["clientResponse", t("sectionClientResponse")],
        ["error", t("sectionPipelineError")],
      ]
        .map(([key, title]) => ({
          key,
          title,
          json: toPrettyJson(pipelinePayloads[key]),
        }))
        .filter((section) => section.json)
    : [];
  const requestJson = detail?.requestBody ? toPrettyJson(detail.requestBody) : null;
  const responseJson = detail?.responseBody ? toPrettyJson(detail.responseBody) : null;
  const streamChunks = (() => {
    if (!debugEnabled || !detail?.pipelinePayloads?.streamChunks) return null;
    let chunks: StreamChunks = detail.pipelinePayloads.streamChunks;
    if (typeof chunks === "string") {
      try {
        chunks = JSON.parse(chunks);
      } catch {
        return null;
      }
    }
    if (chunks && typeof chunks === "object") return chunks;
    return null;
  })();
  const detailIssue =
    detail?.detailState === "missing"
      ? t("detailMissing")
      : detail?.detailState === "corrupt"
        ? t("detailCorrupt")
        : null;
  const tokenStats = {
    totalIn: detail?.tokens?.in ?? log.tokens?.in ?? null,
    totalOut: detail?.tokens?.out ?? log.tokens?.out ?? null,
    cacheRead: detail?.tokens?.cacheRead ?? log.tokens?.cacheRead,
    cacheWrite: detail?.tokens?.cacheWrite ?? log.tokens?.cacheWrite,
    reasoning: detail?.tokens?.reasoning ?? log.tokens?.reasoning,
    compressed: detail?.tokens?.compressed ?? log.tokens?.compressed,
  };

  const formatTokenValue = (value) => (value != null ? value.toLocaleString() : "N/A");

  const cacheSource = detail?.cacheSource || log.cacheSource || "upstream";
  const cacheSourceLabel = cacheSource === "semantic" ? t("cacheSemantic") : t("cacheUpstream");
  const cacheSourceClassName = getCacheSourceMeta(cacheSource).className;
  const accountLabel = maskAccount(detail?.account || log.account, emailsVisible);
  const codexAccountRotation = getCodexAccountRotation(detail);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("dialogLabel")}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-bg-primary border border-border rounded-card w-full max-w-225 max-h-[90vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-border bg-bg-primary/95 backdrop-blur-sm rounded-t-xl">
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                {log.active ? (
                  <span className="inline-flex items-center gap-1.5 rounded-control border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
                    <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  </span>
                ) : log.status === 0 ? (
                  <span className="inline-block rounded-control border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
                    {t("completed")}
                  </span>
                ) : (
                  <span
                    className={`inline-block rounded-control border px-2.5 py-1 text-xs font-medium tabular-nums ${getStatusBadgeClass(log.status)}`}
                  >
                    {log.status}
                  </span>
                )}
                {hasStatusDiscrepancy && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-bg-subtle border border-border text-text-muted">
                    {t("upstreamStatus", { status: providerStatus })}
                  </span>
                )}
                {log.method && (
                  <span className="text-lg font-semibold text-text-main">{log.method}</span>
                )}
              </div>
              {hasStatusDiscrepancy && (
                <span className="text-[10px] text-warning font-medium mt-0.5">
                  {t("statusDiscrepancy", { status: log.status, providerStatus })}
                </span>
              )}
            </div>
            <span className="text-text-muted font-mono text-sm self-center ml-2">{log.path}</span>
            {log.id && (
              <span className="text-[10px] text-text-muted font-mono self-center ml-2 px-1.5 py-0.5 rounded bg-bg-subtle border border-border/40 select-all">
                {log.id}
              </span>
            )}
            {log.correlationId && (
              <span
                className="text-[10px] text-text-muted font-mono self-center ml-2 px-1.5 py-0.5 rounded bg-bg-subtle border border-border/40 select-all"
                title={t("correlationId")}
              >
                {t("cid", { id: log.correlationId })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onPrevious}
              disabled={!onPrevious}
              className="p-1.5 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors disabled:opacity-30 disabled:pointer-events-none"
              aria-label={t("previousRequest")}
            >
              <span className="material-symbols-outlined text-[18px]">chevron_left</span>
            </button>
            <button
              onClick={onNext}
              disabled={!onNext}
              className="p-1.5 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors disabled:opacity-30 disabled:pointer-events-none"
              aria-label={t("nextRequest")}
            >
              <span className="material-symbols-outlined text-[18px]">chevron_right</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
              aria-label={t("closeDetail")}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-6">
          {/* Metadata Grid */}
          {log.active ? (
            <div className="flex flex-wrap gap-4 p-4 bg-bg-subtle rounded-card border border-border">
              <div className="min-w-[140px] flex-1">
                <div className="text-xs font-medium text-text-muted mb-1">{t("startedAt")}</div>
                <div className="text-sm font-medium">{formatDate(log.timestamp)}</div>
              </div>
              <div className="min-w-[100px] flex-1">
                <div className="text-xs font-medium text-text-muted mb-1">{t("duration")}</div>
                <div className="text-sm font-medium">{formatDuration(log.duration)}</div>
              </div>
              <div className="min-w-[140px] flex-1">
                <div className="text-xs font-medium text-text-muted mb-1">{t("model")}</div>
                <div className="text-sm font-medium text-text-main font-mono break-all">
                  {log.model}
                </div>
              </div>
              <div className="min-w-[120px] flex-1">
                <div className="text-xs font-medium text-text-muted mb-1">{t("provider")}</div>
                <span className="inline-block px-2.5 py-1 rounded-control border border-border bg-surface text-[11px] font-medium text-text-main">
                  {providerLabel}
                </span>
              </div>
              <div className="min-w-[120px] flex-1">
                <div className="text-xs font-medium text-text-muted mb-1">{t("account")}</div>
                <div className="text-sm font-medium">{accountLabel}</div>
              </div>
            </div>
          ) : (
            <div
              className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-bg-subtle rounded-card border border-border"
              data-testid="request-log-metadata-grid"
            >
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("startedAt")}</div>
                <div className="text-sm font-medium">
                  {(() => {
                    try {
                      const ts = new Date(log.timestamp).getTime();
                      if (!Number.isFinite(ts)) return "\u2014";
                      return formatDate(new Date(ts - (log.duration || 0)).toISOString());
                    } catch {
                      return "\u2014";
                    }
                  })()}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("endedAt")}</div>
                <div className="text-sm font-medium">{formatDate(log.timestamp)}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("duration")}</div>
                <div className="text-sm font-medium">{formatDuration(log.duration)}</div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("input")}</div>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="token-group-input"
                >
                  <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                    {t("totalIn")}: {formatTokenValue(tokenStats.totalIn)}
                  </span>
                  <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                    {t("cacheRead")}: {formatTokenValue(tokenStats.cacheRead)}
                  </span>
                  <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                    {t("cacheWrite")}: {formatTokenValue(tokenStats.cacheWrite)}
                  </span>
                  {tokenStats.compressed != null &&
                    tokenStats.compressed > 0 &&
                    (() => {
                      const fromTokens = tokenStats.compressed + Math.max(0, tokenStats.totalIn);
                      const saved = Math.min(tokenStats.compressed, fromTokens);
                      const pct =
                        fromTokens > 0
                          ? Math.max(0, Math.min(100, Math.round((saved / fromTokens) * 100)))
                          : 100;
                      return (
                        <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                          {t("compressed")}: {fromTokens.toLocaleString()} →{" "}
                          {Math.max(0, tokenStats.totalIn).toLocaleString()} (
                          {t("percentSaved", { pct })})
                        </span>
                      );
                    })()}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("output")}</div>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="token-group-output"
                >
                  <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                    {t("totalOut")}: {formatTokenValue(tokenStats.totalOut)}
                  </span>
                  <span className="px-2 py-0.5 rounded-control border border-border bg-surface text-xs font-medium text-text-main tabular-nums">
                    {t("reasoning")}: {formatTokenValue(tokenStats.reasoning)}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("model")}</div>
                <div className="text-sm font-medium text-text-main font-mono break-all">
                  {log.model}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">
                  {t("requestedModel")}
                </div>
                <div
                  className={`text-sm font-medium font-mono ${
                    (detail?.requestedModel || log.requestedModel) &&
                    (detail?.requestedModel || log.requestedModel) !== log.model
                      ? "text-warning"
                      : "text-text-muted"
                  }`}
                >
                  {detail?.requestedModel || log.requestedModel || "\u2014"}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("provider")}</div>
                <span className="inline-block px-2.5 py-1 rounded-control border border-border bg-surface text-[11px] font-medium text-text-main">
                  {providerLabel}
                </span>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("reqProtocol")}</div>
                <span className="inline-block px-2.5 py-1 rounded-control border border-border bg-surface text-[11px] font-medium text-text-muted">
                  {protocol.label}
                </span>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">
                  {t("cacheSourceLabel")}
                </div>
                <span
                  className={`inline-block px-2.5 py-1 rounded text-[11px] font-medium ${cacheSourceClassName}`}
                >
                  {cacheSourceLabel}
                </span>
              </div>
              {(detail?.modelPinned || log.modelPinned) && (
                <div>
                  <div className="text-xs font-medium text-text-muted mb-1">
                    {t("modelPinning")}
                  </div>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-primary/10 text-primary-text border border-primary/30">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M4.5 2A1.5 1.5 0 003 3.5v1.9l-1.4 2.8A.5.5 0 002 9h4v4.5a.5.5 0 00.5.5h3a.5.5 0 00.5-.5V9h4a.5.5 0 00.44-.73L13 5.4V3.5A1.5 1.5 0 0011.5 2h-7z" />
                    </svg>
                    {t("pinningActive")}
                  </span>
                </div>
              )}
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("account")}</div>
                <div className="text-sm font-medium">{accountLabel}</div>
                {codexAccountRotation && (
                  <div
                    className="mt-1 text-[10px] text-warning font-mono"
                    title={`${codexAccountRotation.initialConnectionId} -> ${codexAccountRotation.finalConnectionId}`}
                  >
                    {t("rotated")}: {formatConnectionId(codexAccountRotation.initialConnectionId)}{" "}
                    -&gt; {formatConnectionId(codexAccountRotation.finalConnectionId)}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("apiKey")}</div>
                <div
                  className="text-sm font-medium"
                  title={
                    detail?.apiKeyName ||
                    detail?.apiKeyId ||
                    log.apiKeyName ||
                    log.apiKeyId ||
                    t("noApiKey")
                  }
                >
                  {formatApiKeyLabel(
                    detail?.apiKeyName || log.apiKeyName,
                    detail?.apiKeyId || log.apiKeyId
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium text-text-muted mb-1">{t("combo")}</div>
                {detail?.comboName || log.comboName ? (
                  <span className="inline-block px-2.5 py-1 rounded-full text-[11px] font-medium bg-primary/10 text-primary-text border border-primary/30">
                    {detail?.comboName || log.comboName}
                  </span>
                ) : (
                  <div className="text-sm text-text-muted">\u2014</div>
                )}
              </div>
            </div>
          )}

          {/* Error Message */}
          {(detail?.error || log.error) && (
            <div className="p-4 rounded-card bg-error/10 border border-error/30">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm font-semibold text-error">{t("error")}</div>
                {isCombo503 && !cleared && (
                  <button
                    onClick={handleUnblockAll}
                    disabled={unblockAllBusy}
                    className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg
                      bg-warning/10 border border-warning/30 text-warning
                      hover:bg-warning/15 hover:border-warning/50
                      dark:text-warning transition-all duration-200
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <rect x="3" y="6" width="10" height="8" rx="1" />
                      <path d="M5 6V4a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1" />
                      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
                    </svg>
                    {unblockAllBusy ? "..." : t("unblockAll")}
                  </button>
                )}
                {isCombo503 && cleared && (
                  <span className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg bg-success/10 border border-success/30 text-success">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="4 8 7 11 12 4" />
                    </svg>
                    {t("cleared")}
                  </span>
                )}
                {isModelCooldown && !cleared && (
                  <button
                    onClick={handleUnblockModel}
                    disabled={unblocking}
                    className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg
                      bg-warning/10 border border-warning/30 text-warning
                      hover:bg-warning/15 hover:border-warning/50
                      dark:text-warning transition-all duration-200
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <rect x="3" y="6" width="10" height="8" rx="1" />
                      <path d="M5 6V4a3 3 0 0 1 3-3h0a3 3 0 0 1 3 3v1" />
                      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
                    </svg>
                    {unblocking ? "..." : t("unblock")}
                  </button>
                )}
                {isModelCooldown && cleared && (
                  <span className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg bg-success/10 border border-success/30 text-success">
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="4 8 7 11 12 4" />
                    </svg>
                    {t("cleared")}
                  </span>
                )}
              </div>
              <div className="text-sm text-error font-mono whitespace-pre-wrap break-words">
                {formatErrorForDisplay(detail?.error || log.error)}
              </div>
            </div>
          )}

          {/* Related Requests (same correlation ID) */}
          {relatedLogs.length > 1 && (
            <div className="p-4 rounded-card bg-bg-subtle border border-border">
              <div className="text-sm font-semibold text-text-main mb-2">
                {t("relatedRequests", { count: relatedLogs.length })}
              </div>
              <div className="flex flex-col gap-1">
                {[...relatedLogs]
                  .sort((a, b) => {
                    const aStart = new Date(a.timestamp).getTime() - (a.duration || 0);
                    const bStart = new Date(b.timestamp).getTime() - (b.duration || 0);
                    return aStart - bStart;
                  })
                  .map((r) => {
                    const rStatusClass = r.active
                      ? LOG_STATUS_NEUTRAL_CLASS
                      : getStatusBadgeClass(r.status);
                    const isCurrent = r.id === log.id;
                    const startTime = new Date(new Date(r.timestamp).getTime() - (r.duration || 0));
                    return (
                      <button
                        key={r.id}
                        onClick={() => !isCurrent && onSelectRelated?.(r)}
                        disabled={isCurrent}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${
                          isCurrent
                            ? "bg-primary/10 border border-primary/30 cursor-default"
                            : "hover:bg-bg-hover cursor-pointer"
                        }`}
                      >
                        <span
                          className={`inline-block min-w-[28px] rounded-control border px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums ${rStatusClass}`}
                        >
                          {r.status || "..."}
                        </span>
                        <span className="font-mono text-text-muted">{r.id}</span>
                        <span className="text-text-muted">{r.model}</span>
                        <span className="text-text-muted text-[10px]">
                          {startTime.toLocaleTimeString("en-US", { hour12: false })}
                        </span>
                        <span className="text-text-muted ml-auto">
                          {formatDuration(r.duration)}
                        </span>
                        {isCurrent && (
                          <span className="text-[11px] text-primary-text font-bold ml-1">
                            {t("current")}
                          </span>
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {detailIssue && (
            <div className="p-4 rounded-card bg-warning/10 border border-warning/30">
              <div className="text-sm font-semibold text-warning mb-1">{t("detailStatus")}</div>
              <div className="text-sm text-warning">{detailIssue}</div>
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center text-text-muted animate-pulse">
              {t("loadingDetails")}
            </div>
          ) : (
            <>
              {streamChunks && streamChunks.provider && (
                <StreamSection
                  title={t("providerEventStream")}
                  json={
                    Array.isArray(streamChunks.provider)
                      ? streamChunks.provider.join("")
                      : String(streamChunks.provider)
                  }
                  onCopy={() =>
                    onCopy(
                      Array.isArray(streamChunks.provider)
                        ? streamChunks.provider.join("")
                        : String(streamChunks.provider)
                    )
                  }
                />
              )}

              {streamChunks && streamChunks.client && (
                <StreamSection
                  title={t("clientEventStream")}
                  json={
                    Array.isArray(streamChunks.client)
                      ? streamChunks.client.join("")
                      : String(streamChunks.client)
                  }
                  onCopy={() =>
                    onCopy(
                      Array.isArray(streamChunks.client)
                        ? streamChunks.client.join("")
                        : String(streamChunks.client)
                    )
                  }
                />
              )}

              {streamChunks &&
                streamChunks.openai &&
                !streamChunks.provider &&
                !streamChunks.client && (
                  <StreamSection
                    title={t("eventStream")}
                    json={
                      Array.isArray(streamChunks.openai)
                        ? streamChunks.openai.join("")
                        : String(streamChunks.openai)
                    }
                    onCopy={() =>
                      onCopy(
                        Array.isArray(streamChunks.openai)
                          ? streamChunks.openai.join("")
                          : String(streamChunks.openai)
                      )
                    }
                  />
                )}

              {payloadSections.length > 0 &&
                payloadSections.map((section) => (
                  <PayloadSection
                    key={section.key}
                    title={section.title}
                    json={section.json}
                    onCopy={() => onCopy(section.json)}
                  />
                ))}

              {payloadSections.length === 0 && responseJson && (
                <PayloadSection
                  title={t("responsePayloadLegacy")}
                  json={responseJson}
                  onCopy={() => onCopy(responseJson)}
                />
              )}

              {payloadSections.length === 0 && requestJson && (
                <PayloadSection
                  title={t("requestPayloadLegacy")}
                  json={requestJson}
                  onCopy={() => onCopy(requestJson)}
                />
              )}

              {payloadSections.length === 0 && !requestJson && !responseJson && !loading && (
                <div className="p-6 text-center text-text-muted">
                  <span className="material-symbols-outlined text-[32px] mb-2 block opacity-40">
                    info
                  </span>
                  <p className="text-sm">{t("noPayload")}</p>
                  <p className="text-xs mt-1">{t("noPayloadHint")}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
