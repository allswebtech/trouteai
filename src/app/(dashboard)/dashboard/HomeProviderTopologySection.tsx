"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import { selectActiveRequests } from "../home/topologyUtils";
import { useHomeTr } from "./home-start/useHomeTr";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
  /** Connection-health base state, so the topology can colour a node at rest. */
  status?: "active" | "error" | "idle";
};

export function HomeProviderTopologySection({
  providers,
  lastProvider,
  errorProvider,
  enabled = true,
}: {
  providers: TopologyProvider[];
  lastProvider: string;
  errorProvider: string;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  const { tr } = useHomeTr();
  const tCommon = useTranslations("common");
  const tSettings = useTranslations("settings");
  const tAnalytics = useTranslations("analytics");
  // Gate the live-WS connection so it only opens while the topology
  // section is actually shown on the home page.
  const { activeRequests: liveActiveRequests } = useLiveRequests({ enabled });
  const activeRequests = selectActiveRequests(liveActiveRequests);
  const activeProviderCount = new Set(activeRequests.map(({ provider }) => provider)).size;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-text-main">
            {tr("providerMapTitle", "Live provider map")}
          </h2>
          <p className="text-xs text-text-muted">
            {tr("providerMapDesc", "Shows which providers are answering your apps right now.")}
          </p>
          <p className="text-xs text-text-muted tabular-nums">
            {t("activeError", { active: activeProviderCount, errors: errorProvider ? 1 : 0 })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" />
            {tCommon("active")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" />
            {tSettings("recent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-error" />
            {tAnalytics("modelStatusError")}
          </span>
        </div>
      </div>
      <ProviderTopology
        providers={providers}
        activeRequests={activeRequests}
        lastProvider={lastProvider}
        errorProvider={errorProvider}
      />
    </Card>
  );
}
