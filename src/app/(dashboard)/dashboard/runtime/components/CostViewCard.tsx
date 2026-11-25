"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Card from "@/shared/components/Card";

type Window = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheShare: number | null;
  noCacheFigures: boolean;
};

type CostPayload = {
  accounts?: Array<{
    connectionId: string;
    provider: string;
    name: string;
    inFlight: number;
    waiting: number;
    slots: number | null;
    limitedUntil: string | null;
    requestsToday: number;
    inputTokensToday: number;
    outputTokensToday: number;
  }>;
  keys?: Array<{ apiKeyId: string | null; apiKeyName: string | null; today: Window; week: Window }>;
};

const REFRESH_MS = 5000;
const fmt = (n: number) => new Intl.NumberFormat().format(n);

function WindowCell({ w, t }: { w: Window; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="text-xs">
      <div className="tabular-nums text-text-main">{t("costRequests", { count: fmt(w.requests) })}</div>
      <div className="tabular-nums text-text-muted">
        {t("costTokensInOut", { input: fmt(w.inputTokens), output: fmt(w.outputTokens) })}
      </div>
      <div className={w.noCacheFigures ? "text-warning" : "text-text-muted"}>
        {w.noCacheFigures
          ? t("costNoCacheFigures")
          : t("costCacheShare", { percent: `${Math.round((w.cacheShare ?? 0) * 100)} %` })}
      </div>
    </div>
  );
}

export default function CostViewCard() {
  const t = useTranslations("runtime");
  const [data, setData] = useState<CostPayload | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage/live", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    // The first load runs from a callback, not the effect body (react-hooks/set-state-in-effect).
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  const accounts = data?.accounts ?? [];
  const keys = data?.keys ?? [];

  return (
    <Card padding="md">
      <div className="flex items-start gap-2">
        <span className="material-symbols-outlined text-[18px] text-text-muted mt-px">payments</span>
        <div>
          <h2 className="text-sm font-semibold text-text-main leading-tight">{t("costTitle")}</h2>
          <p className="text-xs text-text-muted mt-0.5">{t("costSubtitle")}</p>
        </div>
      </div>
      {error && <p className="mt-3 text-xs text-error">{t("costLoadFailed")}</p>}

      <h3 className="mt-4 text-xs font-semibold text-text-muted uppercase">{t("costAccounts")}</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">{t("costAccount")}</th>
              <th className="py-1 pr-3 font-medium">{t("costInFlight")}</th>
              <th className="py-1 pr-3 font-medium">{t("costWaiting")}</th>
              <th className="py-1 pr-3 font-medium">{t("costLimitedUntil")}</th>
              <th className="py-1 pr-3 font-medium">{t("costRequestsToday")}</th>
              <th className="py-1 font-medium">{t("costTokensToday")}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.connectionId} className="border-t border-border">
                <td className="py-1 pr-3 text-text-main">
                  {a.name} <span className="text-text-muted">({a.provider})</span>
                </td>
                <td className="py-1 pr-3 tabular-nums">
                  {a.inFlight}
                  {a.slots ? ` / ${a.slots}` : ""}
                </td>
                <td className="py-1 pr-3 tabular-nums">{a.waiting}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {a.limitedUntil ? new Date(a.limitedUntil).toLocaleTimeString() : "—"}
                </td>
                <td className="py-1 pr-3 tabular-nums">{fmt(a.requestsToday)}</td>
                <td className="py-1 tabular-nums">
                  {fmt(a.inputTokensToday)} / {fmt(a.outputTokensToday)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-4 text-xs font-semibold text-text-muted uppercase">{t("costKeys")}</h3>
      {keys.length === 0 ? (
        <p className="mt-2 text-xs text-text-muted">{t("costNone")}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">{t("costKey")}</th>
                <th className="py-1 pr-3 font-medium">{t("costToday")}</th>
                <th className="py-1 font-medium">{t("costWeek")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.apiKeyId ?? "none"} className="border-t border-border align-top">
                  <td className="py-1 pr-3 text-text-main">{k.apiKeyName || k.apiKeyId || t("costNoKey")}</td>
                  <td className="py-1 pr-3">
                    <WindowCell w={k.today} t={t} />
                  </td>
                  <td className="py-1">
                    <WindowCell w={k.week} t={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
