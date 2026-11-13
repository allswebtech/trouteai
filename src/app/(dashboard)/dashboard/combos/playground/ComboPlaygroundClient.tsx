"use client";

import Link from "next/link";
import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";

// ── Types ────────────────────────────────────────────────────────────────────

interface TargetSimulation {
  provider: string;
  model: string;
  strategy: string;
  rank: number;
  estimatedCost: number;
  estimatedLatencyMs: number;
  status: "available" | "no_quota" | "degraded" | "error" | "unknown";
  maxTokens?: number;
  contextWindow?: number;
}

interface SimulateResponse {
  comboId?: string;
  comboName: string;
  strategy: string;
  targets: TargetSimulation[];
  totalEstimatedCost: number;
  totalEstimatedLatencyMs: number;
  warnings: string[];
  errors: string[];
}

interface Combo {
  id: string;
  name: string;
  strategy: string;
  targets: string;
  isActive: boolean;
}

// ── Status helpers ───────────────────────────────────────────────────────────

function StatusTag({ status }: { status: TargetSimulation["status"] }) {
  const t = useTranslations("combos");
  const map: Record<
    TargetSimulation["status"],
    { labelKey: string; variant: "success" | "error" | "warning" | "info" }
  > = {
    available: { labelKey: "playgroundStatusAvailable", variant: "success" },
    no_quota: { labelKey: "playgroundStatusNoQuota", variant: "error" },
    degraded: { labelKey: "playgroundStatusDegraded", variant: "warning" },
    error: { labelKey: "playgroundStatusError", variant: "error" },
    unknown: { labelKey: "playgroundStatusUnknown", variant: "info" },
  };
  return (
    <Badge variant={map[status].variant} size="sm">
      {t(map[status].labelKey)}
    </Badge>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ComboPlaygroundClient() {
  const t = useTranslations("combos");
  const [combos, setCombos] = useState<Combo[]>([]);
  const [selectedComboId, setSelectedComboId] = useState("");
  const [promptTokens, setPromptTokens] = useState(500);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimulateResponse | null>(null);

  // Fetch combos on mount
  useEffect(() => {
    fetch("/api/combos")
      .then((r) => r.json())
      .then((data) => {
        const list: Combo[] = Array.isArray(data) ? data : (data?.combos ?? data?.data ?? []);
        setCombos(list);
        if (list.length > 0) setSelectedComboId(list[0].id);
      })
      .catch(() => {});
  }, []);

  const simulate = useCallback(async () => {
    if (!selectedComboId) return;
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/playground/simulate-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comboId: selectedComboId,
          promptTokens,
        }),
      });
      const data = await res.json();
      if (res.ok) setResult(data);
      else setResult(data);
    } catch {
      setResult({
        comboName: t("playgroundStatusError"),
        strategy: "-",
        targets: [],
        totalEstimatedCost: 0,
        totalEstimatedLatencyMs: 0,
        warnings: [],
        errors: [t("playgroundNetworkError")],
      });
    } finally {
      setLoading(false);
    }
  }, [selectedComboId, promptTokens, t]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-main">
            {t("playgroundTitle")}
          </h1>
          <p className="text-sm text-text-muted mt-1">{t("playgroundDescription")}</p>
        </div>
      </div>

      {/* Configuration Panel */}
      <Card padding="none">
        <div className="p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-main">{t("playgroundConfiguration")}</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Combo Selector */}
            <div>
              <label
                htmlFor="combo-playground-select"
                className="block text-sm font-medium text-text-main mb-1"
              >
                Combo
              </label>
              <select
                id="combo-playground-select"
                className="w-full h-9 border border-border rounded-control px-3 bg-surface text-sm text-text-main focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                value={selectedComboId}
                onChange={(e) => setSelectedComboId(e.target.value)}
              >
                {combos.length === 0 && (
                  <option value="">{t("playgroundNoCombosConfigured")}</option>
                )}
                {combos.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.strategy}, {c.isActive ? t("active") : t("inactive")})
                  </option>
                ))}
              </select>
            </div>

            {/* Prompt Tokens */}
            <div>
              <label
                htmlFor="combo-playground-tokens"
                className="block text-sm font-medium text-text-main mb-1"
              >
                {t("playgroundEstimatedPromptTokens")}:{" "}
                <strong className="font-semibold tabular-nums">{promptTokens}</strong>
              </label>
              <input
                id="combo-playground-tokens"
                type="range"
                min={100}
                max={100000}
                step={100}
                value={promptTokens}
                onChange={(e) => setPromptTokens(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-text-muted tabular-nums mt-1">
                <span>100</span>
                <span>100K</span>
              </div>
            </div>
          </div>

          <Button onClick={simulate} disabled={loading || combos.length === 0}>
            {loading ? t("playgroundSimulating") : t("playgroundSimulateRoute")}
          </Button>
        </div>
      </Card>

      {/* Results */}
      {result && (
        <>
          {/* Combo Overview */}
          {/* Summary tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-card border border-border bg-surface p-4 min-w-0">
              <div className="text-xs font-medium text-text-muted">{t("playgroundStrategy")}</div>
              <div
                className="mt-1 text-2xl font-semibold tracking-tight text-text-main truncate"
                title={result.strategy}
              >
                {result.strategy}
              </div>
            </div>
            <div className="rounded-card border border-border bg-surface p-4 min-w-0">
              <div className="text-xs font-medium text-text-muted">
                {t("playgroundEstimatedCost")}
              </div>
              <div
                className="mt-1 text-2xl font-semibold tracking-tight text-text-main tabular-nums truncate"
                title={`$${result.totalEstimatedCost.toFixed(6)}`}
              >
                ${result.totalEstimatedCost.toFixed(6)}
              </div>
            </div>
            <div className="rounded-card border border-border bg-surface p-4 min-w-0">
              <div className="text-xs font-medium text-text-muted">
                {t("playgroundEstimatedLatency")}
              </div>
              <div
                className="mt-1 text-2xl font-semibold tracking-tight text-text-main tabular-nums truncate"
                title={`${result.totalEstimatedLatencyMs.toFixed(0)}ms`}
              >
                {result.totalEstimatedLatencyMs.toFixed(0)}ms
              </div>
            </div>
          </div>

          <Card padding="none">
            <div className="p-5 space-y-3">
              <h2 className="text-sm font-semibold text-text-main">{t("playgroundRoutingPath")}</h2>

              {/* Visual Cascade */}
              <div className="space-y-0">
                {result.targets.map((target, i) => (
                  <div key={i}>
                    {/* Arrow between targets */}
                    {i > 0 && (
                      <div className="flex justify-center py-1">
                        <div className="flex flex-col items-center text-text-muted">
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 14l-7 7m0 0l-7-7m7 7V3"
                            />
                          </svg>
                          {result.strategy === "priority" && (
                            <span className="text-[11px]">{t("playgroundFallback")}</span>
                          )}
                          {result.strategy === "weighted" && (
                            <span className="text-[11px] tabular-nums">
                              {t("playgroundWeight", { value: target.rank })}
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Target Card */}
                    <div
                      className={`border rounded-control p-3 bg-surface ${
                        target.status === "error" || target.status === "no_quota"
                          ? "border-error/30"
                          : "border-border"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex items-center justify-center size-6 shrink-0 rounded-full bg-surface-2 text-text-muted text-xs font-semibold tabular-nums">
                            {target.rank}
                          </div>
                          <div className="min-w-0">
                            <div
                              className="font-medium text-sm text-text-main truncate"
                              title={target.provider}
                            >
                              {target.provider}
                            </div>
                            <div
                              className="text-xs text-text-muted font-mono truncate"
                              title={target.model}
                            >
                              {target.model}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <StatusTag status={target.status} />
                          <span className="text-xs text-text-main tabular-nums">
                            ${target.estimatedCost.toFixed(6)}
                          </span>
                          <span className="text-xs text-text-main tabular-nums">
                            {target.estimatedLatencyMs}ms
                          </span>
                          {target.contextWindow && (
                            <span className="text-xs text-text-muted tabular-nums">
                              {(target.contextWindow / 1000).toFixed(0)}K ctx
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Warnings & Errors */}
          {result.warnings.length > 0 && (
            <Card padding="none">
              <div className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-warning">
                  {t("playgroundWarningCount", { count: result.warnings.length })}
                </h3>
                {result.warnings.map((w, i) => (
                  <p key={i} className="text-sm text-text-muted flex items-start gap-2">
                    <span
                      className="material-symbols-outlined text-[16px] text-warning mt-0.5 shrink-0"
                      aria-hidden="true"
                    >
                      warning
                    </span>
                    {w}
                  </p>
                ))}
              </div>
            </Card>
          )}

          {result.errors.length > 0 && (
            <Card padding="none">
              <div className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-error">
                  {t("playgroundErrorCount", { count: result.errors.length })}
                </h3>
                {result.errors.map((e, i) => (
                  <p key={i} className="text-sm text-error flex items-start gap-2">
                    <span
                      className="material-symbols-outlined text-[16px] mt-0.5 shrink-0"
                      aria-hidden="true"
                    >
                      block
                    </span>
                    {e}
                  </p>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {/* Empty State */}
      {!result && combos.length > 0 && (
        <Card padding="none">
          <div className="p-8 text-center">
            <p className="text-sm text-text-muted">
              {t.rich("playgroundEmptyHint", {
                strong: (chunks) => (
                  <strong className="font-medium text-text-main">{chunks}</strong>
                ),
              })}
            </p>
          </div>
        </Card>
      )}

      {combos.length === 0 && (
        <Card padding="none">
          <div className="p-8 text-center">
            <p className="text-sm text-text-muted">
              {t("playgroundNoCombosYet")}{" "}
              <Link href="/dashboard/combos" className="text-primary-text hover:underline">
                {t("playgroundCreateFirst")}
              </Link>
              .
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
