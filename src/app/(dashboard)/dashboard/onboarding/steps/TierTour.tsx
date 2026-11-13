"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { TierFlowDiagram } from "../components/TierFlowDiagram";

type TierCardProps = {
  number: number;
  colorClass: string;
  label: string;
  description: string;
  examples: string[];
};

function TierCard({ number, colorClass, label, description, examples }: TierCardProps) {
  return (
    <div className={`rounded-card border bg-surface p-4 ${colorClass}`}>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-xl font-semibold tabular-nums">{number}</span>
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <p className="min-h-16 text-xs text-text-muted mb-3">{description}</p>
      <ul className="text-xs space-y-0.5 text-text-muted">
        {examples.map((e) => (
          <li key={e}>· {e}</li>
        ))}
      </ul>
    </div>
  );
}

export function TierTour() {
  const t = useTranslations("onboarding.tier");

  return (
    <div className="space-y-5">
      <TierFlowDiagram />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <TierCard
          number={1}
          colorClass="border-warning/40 [&>div>span:first-child]:text-warning"
          label={t("tier1.label")}
          description={t("tier1.description")}
          examples={["Claude Code", "Codex", "Copilot", "Cursor"]}
        />
        <TierCard
          number={2}
          colorClass="border-success/40 [&>div>span:first-child]:text-success"
          label={t("tier2.label")}
          description={t("tier2.description")}
          examples={["DeepSeek", "GLM", "MiniMax", "Qwen"]}
        />
        <TierCard
          number={3}
          colorClass="border-primary/40 [&>div>span:first-child]:text-primary-text"
          label={t("tier3.label")}
          description={t("tier3.description")}
          examples={["Kiro", "OpenCode", "Antigravity CLI", "Vertex"]}
        />
      </div>

      <p className="text-xs text-text-muted text-center">
        <Link href="/dashboard/providers/new" className="underline hover:text-text-main">
          {t("configure")}
        </Link>{" "}
        {t("afterSetup")}
      </p>
    </div>
  );
}
