"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { UsageAnalytics, CardSkeleton } from "@/shared/components";
import UsageTabs, { UsageMoreFor } from "@/shared/components/UsageTabs";
import CacheHealthTab from "./CacheHealthTab";
import ComboHealthTab from "./ComboHealthTab";
import ProviderUtilizationTab from "./ProviderUtilizationTab";
import RouteExplainabilityTab from "./RouteExplainabilityTab";
import DiversityScoreCard from "./components/DiversityScoreCard";

type AnalyticsTab = "overview" | "utilization" | "combo-health" | "cache-health" | "route-trace";

function normalizeTab(tab: string | null): AnalyticsTab {
  if (tab === "route-trace" || tab === "route-explain") return "route-trace";
  if (tab === "utilization" || tab === "combo-health" || tab === "cache-health") {
    return tab;
  }
  return "overview";
}

function AnalyticsPageContent() {
  const searchParams = useSearchParams();
  const activeTab = normalizeTab(searchParams.get("tab"));
  const [initialRequestId] = useState(searchParams.get("id") || "");

  useEffect(() => {
    if (searchParams.get("tab") !== "route-explain") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "route-trace");
    window.history.replaceState(null, "", url.toString());
  }, [searchParams]);

  return (
    <div className="flex flex-col gap-4">
      <UsageTabs active="overview" />

      <Suspense fallback={<CardSkeleton />}>
        {activeTab === "overview" ? (
          <>
            <UsageAnalytics moreCharts={<DiversityScoreCard />} />
            <UsageMoreFor tab="overview" />
          </>
        ) : null}
        {activeTab === "utilization" ? <ProviderUtilizationTab /> : null}
        {activeTab === "combo-health" ? <ComboHealthTab /> : null}
        {activeTab === "cache-health" ? <CacheHealthTab /> : null}
        {activeTab === "route-trace" ? (
          <RouteExplainabilityTab initialRequestId={initialRequestId} />
        ) : null}
      </Suspense>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <AnalyticsPageContent />
    </Suspense>
  );
}
