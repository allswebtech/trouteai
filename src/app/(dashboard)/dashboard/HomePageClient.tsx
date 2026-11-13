"use client";

import { useTranslations } from "next-intl";

import { useState, useEffect, useMemo, useCallback, useRef, Suspense } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { CardSkeleton, Button, Modal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, NOAUTH_PROVIDERS, OAUTH_PROVIDERS } from "@/shared/constants/providers";
import { useDisplayBaseUrl } from "@/shared/hooks";
import {
  isProviderConnectionConnected,
  isProviderConnectionErrored,
} from "@/shared/utils/providerConnectionStatus";
import { useNotificationStore } from "@/store/notificationStore";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { getProviderDisplayLabel } from "@/shared/utils/providerDisplayLabel";
import { HomeProviderTopologySection } from "./HomeProviderTopologySection";
import { shouldShowProviderTopologyOnHome } from "./homeAppearance";
import { ConnectAppCard } from "./home-start/ConnectAppCard";
import { GetStartedCard } from "./home-start/GetStartedCard";
import { EMPTY_SETUP_STATUS, fetchHomeSetupStatus } from "./home-start/setupStatus";

const ProviderQuotaWidget = dynamic(() => import("../home/ProviderQuotaWidget"), { ssr: false });

type HomePageClientProps = {
  machineId?: string;
};

type ProviderSummaryItem = {
  id: string;
  provider: {
    id: string;
    name: string;
    color?: string;
    textIcon?: string;
    alias?: string;
  };
  total: number;
  connected: number;
  errors: number;
  modelCount: number;
  authType: "free" | "oauth" | "apikey" | string;
};

type ProviderMetricSummary = {
  totalRequests?: number;
  totalSuccesses?: number;
  successRate?: number;
  avgLatencyMs?: number;
  lastRequestAt?: string | null;
  lastErrorAt?: string | null;
  lastStatus?: number | null;
  lastErrorStatus?: number | null;
};

type ProviderModelSummary = {
  fullModel: string;
  alias?: string;
  model?: string;
};

const PROVIDER_ALIAS_TO_ID = new Map(
  Object.entries(AI_PROVIDERS)
    .flatMap(([providerId, providerInfo]) =>
      providerInfo.alias ? [[providerInfo.alias.toLowerCase(), providerId]] : []
    )
    .filter((entry): entry is [string, string] => entry.length === 2)
);

function normalizeProviderId(providerId?: string | null): string {
  const normalized = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
  if (!normalized) return "";
  return AI_PROVIDERS[normalized] ? normalized : PROVIDER_ALIAS_TO_ID.get(normalized) || normalized;
}

// The "Get started" checklist and "Connect your app" card live in ./home-start/ — this
// file is size-frozen.

export default function HomePageClient({ machineId }: HomePageClientProps) {
  const router = useRouter();
  const t = useTranslations("home");
  const tp = useTranslations("providers");
  const [providerConnections, setProviderConnections] = useState([]);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const displayBaseUrl = useDisplayBaseUrl();
  const [setupStatus, setSetupStatus] = useState(EMPTY_SETUP_STATUS);
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [providerMetrics, setProviderMetrics] = useState<Record<string, ProviderMetricSummary>>({});
  const [providerTopology, setProviderTopology] = useState({ lastProvider: "", errorProvider: "" });
  const [providerNodes, setProviderNodes] = useState<
    Array<{ id?: string; prefix?: string; name?: string }>
  >([]);

  // The live in-flight request feed for the Provider Topology pulse animation is owned by
  // <HomeProviderTopologySection>, which subscribes to it (gated by the `enabled` prop)
  // only when the topology is actually shown. HomePageClient must NOT open its own
  // unconditional live socket: the binding here was unused (ReferenceError in prod)
  // and the socket opened even when topology was hidden.

  // Appearance settings for home page pinning
  const [pinProviderQuotaToHome, setPinProviderQuotaToHome] = useState(false);
  const [showQuickStartOnHome, setShowQuickStartOnHome] = useState(true); // default on
  // Default hidden until appearance settings load, so the live-WS
  // topology connection is never opened before we know the user wants it.
  const [showProviderTopologyOnHome, setShowProviderTopologyOnHome] = useState(false);
  const [autoRefreshProviderQuota, setAutoRefreshProviderQuota] = useState(false);
  const [autoRefreshProviderQuotaInterval, setAutoRefreshProviderQuotaInterval] = useState(180);
  const [appearanceSettingsLoaded, setAppearanceSettingsLoaded] = useState(false);

  useEffect(() => {
    // Fetch the pin settings (lightweight)
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (data) {
          if (typeof data.pinProviderQuotaToHome === "boolean") {
            setPinProviderQuotaToHome(data.pinProviderQuotaToHome);
          }
          if (typeof data.showQuickStartOnHome === "boolean") {
            setShowQuickStartOnHome(data.showQuickStartOnHome);
          }
          // Regression fix: the topology card defaults ON (matches the
          // AppearanceTab toggle's `!== false`). Honoring only an explicit boolean
          // left the card hidden whenever the setting was never persisted
          // (undefined), silently removing it for most installs. The live-WS
          // connection is still gated by `appearanceSettingsLoaded` in the data
          // effect, so it is never opened before settings load.
          setShowProviderTopologyOnHome(
            shouldShowProviderTopologyOnHome(data.showProviderTopologyOnHome)
          );
          if (typeof data.autoRefreshProviderQuota === "boolean") {
            setAutoRefreshProviderQuota(data.autoRefreshProviderQuota);
          }
          if (typeof data.autoRefreshProviderQuotaInterval === "number") {
            setAutoRefreshProviderQuotaInterval(data.autoRefreshProviderQuotaInterval);
          }
        }
      })
      .catch(() => {
        /* ignore — defaults stay */
      })
      .finally(() => {
        setAppearanceSettingsLoaded(true);
      });
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const [provRes, modelsRes, setup] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/models"),
        fetchHomeSetupStatus(),
      ]);
      setSetupStatus(setup);
      if (provRes.ok) {
        const provData = await provRes.json();
        setProviderConnections(provData.connections || []);
      }
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        setModels(modelsData.models || []);
      }
    } catch (e) {
      console.log("Error fetching data:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fetch provider nodes for display labels (compat providers)
  useEffect(() => {
    fetch("/api/provider-nodes")
      .then((r) => (r.ok ? r.json() : { nodes: [] }))
      .then((d) => setProviderNodes(d.nodes || []))
      .catch(() => {});
  }, []);

  // The topology card is only shown once a provider is connected (an empty map is just a
  // large blank box), so don't poll its activity before then either.
  const hasProviderConnections = providerConnections.length > 0;
  const showTopology = showProviderTopologyOnHome && hasProviderConnections;

  useEffect(() => {
    if (!appearanceSettingsLoaded || !showTopology) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const loadTopologyActivity = async () => {
      const currentController = new AbortController();
      controller = currentController;
      try {
        const metricsRes = await fetch("/api/provider-metrics", {
          cache: "no-store",
          signal: currentController.signal,
        });
        if (metricsRes.ok) {
          const data = await metricsRes.json();
          if (!cancelled) {
            setProviderMetrics(data.metrics || {});
            setProviderTopology({
              lastProvider: normalizeProviderId(data.topology?.lastProvider),
              errorProvider: normalizeProviderId(data.topology?.errorProvider),
            });
          }
        }
      } catch (error) {
        const isAbortError = error instanceof DOMException && error.name === "AbortError";
        if (!cancelled && !isAbortError) {
          console.error("Failed to load topology activity:", error);
        }
      } finally {
        if (controller === currentController) {
          controller = null;
        }
        if (!cancelled) {
          timeoutId = setTimeout(loadTopologyActivity, 3000);
        }
      }
    };

    loadTopologyActivity();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      controller?.abort();
    };
  }, [appearanceSettingsLoaded, showTopology]);

  // Check for unhealthy API keys and show notification (once per session)
  const notifiedUnhealthyKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    const checkApiKeyHealth = () => {
      const newUnhealthyKeys = new Set<string>();
      const unhealthyProviderIds = new Set<string>();
      const unhealthyConnections: string[] = [];
      let firstUnhealthyProviderId: string | null = null;
      let hasWarning = false;

      for (const conn of providerConnections) {
        const health = conn.providerSpecificData?.apiKeyHealth as
          | Record<
              string,
              {
                status: "active" | "warning" | "invalid";
                failures: number;
                lastFailure: string | null;
              }
            >
          | undefined;
        if (!health) continue;

        // Defense-in-depth: skip stale extra_N health entries whose index
        // is out of range of the current extraApiKeys list.
        // The backend cleans this up on PATCH, but existing stale data from
        // before the fix or other code paths could still have orphan entries.
        const extras: string[] = conn.providerSpecificData?.extraApiKeys ?? [];
        const extraKeyCount = Array.isArray(extras) ? extras.length : 0;

        const unhealthyKeys = Object.entries(health).filter(([keyId, h]) => {
          if (h.status !== "invalid" && h.status !== "warning") return false;
          // extra_N entries: only flag if the index is still within bounds
          if (keyId.startsWith("extra_")) {
            const idx = Number.parseInt(keyId.slice(6), 10);
            if (Number.isNaN(idx) || idx >= extraKeyCount) return false;
          }
          return true;
        });

        if (unhealthyKeys.length > 0) {
          for (const [, h] of unhealthyKeys) {
            if (h.status === "warning") hasWarning = true;
            break;
          }
          for (const [keyId] of unhealthyKeys) {
            newUnhealthyKeys.add(`${conn.id}:${keyId}`);
          }
          firstUnhealthyProviderId ??= conn.provider;
          unhealthyConnections.push(conn.name || conn.id);
          unhealthyProviderIds.add(conn.provider);
        }
      }

      // Only notify for newly unhealthy keys (not already notified)
      const hasNewUnhealthy = Array.from(newUnhealthyKeys).some(
        (k) => !notifiedUnhealthyKeys.current.has(k)
      );
      if (hasNewUnhealthy) {
        const navigateTo =
          newUnhealthyKeys.size === 1 && firstUnhealthyProviderId
            ? `/dashboard/providers/${firstUnhealthyProviderId}`
            : `/dashboard/providers?search=${encodeURIComponent(Array.from(unhealthyProviderIds).join(" "))}`;

        const notificationType = hasWarning ? "warning" : "error";

        useNotificationStore.getState().addNotification({
          type: notificationType,
          message: tp(hasWarning ? "apiKeyWarningAlert" : "apiKeyInvalidAlert", {
            count: newUnhealthyKeys.size,
            connections: unhealthyConnections.join(", "),
          }),
          title: tp(hasWarning ? "apiKeyWarningAlertTitle" : "apiKeyInvalidAlertTitle"),
          duration: 10000,
          onClick: () => router.push(navigateTo),
        });
        // Mark all current unhealthy keys as notified
        newUnhealthyKeys.forEach((k) => notifiedUnhealthyKeys.current.add(k));
      }
    };

    if (providerConnections.length > 0) {
      checkApiKeyHealth();
    }
  }, [providerConnections, t, tp, router]);

  const providerStats = useMemo(() => {
    return Object.entries(AI_PROVIDERS).map(([providerId, providerInfo]) => {
      const connections = providerConnections.filter((conn) => conn.provider === providerId);
      const connected = connections.filter((connection) =>
        isProviderConnectionConnected(connection)
      ).length;
      const errors = connections.filter((connection) =>
        isProviderConnectionErrored(connection)
      ).length;

      const providerKeys = new Set([providerId, providerInfo.alias].filter(Boolean));
      const providerModels = models.filter((m) => providerKeys.has(m.provider));

      const authType = NOAUTH_PROVIDERS[providerId]
        ? "no-auth"
        : OAUTH_PROVIDERS[providerId]
          ? "oauth"
          : "apikey";

      return {
        id: providerId,
        provider: providerInfo,
        total: connections.length,
        connected,
        errors,
        modelCount: providerModels.length,
        authType,
      };
    });
  }, [providerConnections, models]);

  const selectedProviderModels = useMemo(() => {
    if (!selectedProvider) return [];
    const providerKeys = new Set(
      [selectedProvider.id, selectedProvider.provider?.alias].filter(Boolean)
    );
    return models.filter((m) => providerKeys.has(m.provider));
  }, [selectedProvider, models]);

  const topologyProviders = useMemo(() => {
    type ProviderHealth = "active" | "error" | "idle";
    const byProvider = new Map<
      string,
      { id: string; provider: string; name?: string; status: ProviderHealth }
    >();
    const providerConfig = AI_PROVIDERS as Record<string, { name?: string }>;

    // Connection-health per provider, so the topology node reflects "what is connected"
    // at rest (green healthy / red error) instead of going blank between requests. A
    // provider with ≥1 healthy connection is "active"; if none are healthy but some are
    // errored it is "error"; otherwise "idle". Live/recent traffic still overrides this.
    const healthByProvider = new Map<string, ProviderHealth>();
    for (const stat of providerStats) {
      const canonical = normalizeProviderId(stat.id);
      if (!canonical) continue;
      healthByProvider.set(
        canonical,
        stat.connected > 0 ? "active" : stat.errors > 0 ? "error" : "idle"
      );
    }

    const addProvider = (providerId?: string | null, name?: string) => {
      const rawProviderId = typeof providerId === "string" ? providerId.trim() : "";
      if (!rawProviderId) return;

      const canonicalProviderId = normalizeProviderId(rawProviderId);
      if (!canonicalProviderId || byProvider.has(canonicalProviderId)) return;

      const resolvedName =
        getProviderDisplayLabel(rawProviderId, providerNodes) ||
        name ||
        providerConfig[canonicalProviderId]?.name ||
        rawProviderId;

      byProvider.set(canonicalProviderId, {
        id: canonicalProviderId,
        provider: canonicalProviderId,
        name: resolvedName,
        status: healthByProvider.get(canonicalProviderId) ?? "idle",
      });
    };

    providerStats
      .filter((provider) => provider.total > 0)
      .forEach((provider) => addProvider(provider.id, provider.provider.name));
    Object.keys(providerMetrics).forEach((provider) => addProvider(provider));

    return Array.from(byProvider.values());
  }, [providerStats, providerMetrics, providerNodes]);

  const { lastProvider, errorProvider } = providerTopology;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {pinProviderQuotaToHome && (
        <Suspense fallback={<CardSkeleton />}>
          <ProviderQuotaWidget
            autoRefreshInterval={autoRefreshProviderQuota ? autoRefreshProviderQuotaInterval : 0}
          />
        </Suspense>
      )}

      {/* Get started checklist (Appearance setting "showQuickStartOnHome", default on) */}
      {showQuickStartOnHome && (
        <GetStartedCard
          providerCount={providerConnections.length}
          comboCount={setupStatus.comboCount}
          keyCount={setupStatus.keyCount}
        />
      )}

      <ConnectAppCard apiBaseUrl={`${displayBaseUrl}/v1`} comboName={setupStatus.comboName} />

      {showTopology && (
        <HomeProviderTopologySection
          providers={topologyProviders}
          lastProvider={lastProvider}
          errorProvider={errorProvider}
          enabled={showTopology}
        />
      )}

      {/* Provider Models Modal */}
      {selectedProvider && (
        <ProviderModelsModal
          provider={selectedProvider}
          models={selectedProviderModels}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

function ProviderOverviewCard({
  item,
  metrics,
  onClick,
}: {
  item: ProviderSummaryItem;
  metrics?: ProviderMetricSummary;
  onClick: () => void;
}) {
  const t = useTranslations("home");
  const tc = useTranslations("common");

  const statusVariant =
    item.errors > 0 ? "text-error" : item.connected > 0 ? "text-success" : "text-text-muted";

  const authTypeConfig = {
    "no-auth": { color: "bg-text-muted", label: "No Auth" },
    free: { color: "bg-success", label: tc("free") },
    oauth: { color: "bg-primary", label: t("oauthLabel") },
    apikey: { color: "bg-warning", label: t("apiKeyLabel") },
  };
  const authInfo = authTypeConfig[item.authType] || authTypeConfig.apikey;

  return (
    <button
      onClick={onClick}
      className="w-full cursor-pointer rounded-card border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <div className="flex items-center gap-2.5">
        <div
          className="size-8 rounded-control flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${item.provider.color || "#888"}15` }}
        >
          <ProviderIcon providerId={item.provider.id} size={26} type="color" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold truncate">{item.provider.name}</p>
            <span
              className={`size-2 rounded-full ${authInfo.color} shrink-0`}
              title={authInfo.label}
            />
          </div>
          <p className={`text-xs ${statusVariant}`}>
            {item.total === 0
              ? tc("notConfigured")
              : t("activeError", { active: item.connected, errors: item.errors })}
          </p>
          {metrics && metrics.totalRequests > 0 && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-text-muted">
                <span className="text-success tabular-nums">{metrics.totalSuccesses}</span>/
                {t("requestsShort", { count: metrics.totalRequests })}
              </span>
              <span className="text-[10px] text-text-muted tabular-nums">
                {metrics.successRate}%
              </span>
              <span className="text-[10px] text-text-muted tabular-nums">
                ~{metrics.avgLatencyMs}ms
              </span>
            </div>
          )}
        </div>

        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-text-main tabular-nums">{item.modelCount}</p>
          <p className="text-[10px] text-text-muted">{tc("models")}</p>
        </div>
      </div>
    </button>
  );
}

function ProviderModelsModal({
  provider,
  models,
  onClose,
}: {
  provider: ProviderSummaryItem;
  models: ProviderModelSummary[];
  onClose: () => void;
}) {
  const [copiedModel, setCopiedModel] = useState(null);
  const notify = useNotificationStore();
  const router = useRouter();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const ts = useTranslations("sidebar");

  const navigateTo = (path) => {
    onClose();
    router.push(path);
  };

  const handleCopy = async (text) => {
    await copyToClipboard(text);
    setCopiedModel(text);
    notify.success(t("copiedModel", { model: text }));
    setTimeout(() => setCopiedModel(null), 2000);
  };

  return (
    <Modal
      isOpen={true}
      title={t("providerModelsTitle", { provider: provider.provider.name })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        {/* Summary */}
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span className="material-symbols-outlined text-[16px]">token</span>
          {models.length === 1
            ? t("modelAvailable", { count: models.length })
            : t("modelsAvailable", { count: models.length })}
          {provider.total > 0 && (
            <span className="ml-auto text-xs text-success">
              ●{" "}
              {provider.connected === 1
                ? t("connectionsActive", { count: provider.connected })
                : t("connectionsActivePlural", { count: provider.connected })}
            </span>
          )}
        </div>

        {models.length === 0 ? (
          <div className="text-center py-6">
            <span className="material-symbols-outlined text-[32px] text-text-muted mb-2">
              search_off
            </span>
            <p className="text-sm text-text-muted">{t("noModelsAvailable")}</p>
            <p className="text-xs text-text-muted mt-1">
              {t("configureFirst", { providers: ts("providers") })}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
            {models.map((m) => (
              <div
                key={m.fullModel}
                className="group flex min-h-10 py-1.5 items-center justify-between rounded-control px-3 transition-colors hover:bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-text-main truncate">{m.fullModel}</p>
                  {m.alias !== m.model && (
                    <p className="text-[10px] text-text-muted">
                      {t("aliasLabel")}: {m.alias}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => handleCopy(m.fullModel)}
                  className="ml-2 shrink-0 rounded-control p-1.5 text-text-muted opacity-0 transition-colors hover:bg-bg hover:text-text-main focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 group-hover:opacity-100"
                  title={t("copyModelName")}
                >
                  <span className="material-symbols-outlined text-[14px]">
                    {copiedModel === m.fullModel ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-2 border-t border-border">
          <Button
            variant="secondary"
            fullWidth
            size="sm"
            onClick={() => navigateTo(`/dashboard/providers/${provider.id}`)}
            className="flex-1"
          >
            <span className="material-symbols-outlined text-[14px] mr-1">settings</span>
            {t("configureProvider")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {tc("close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
