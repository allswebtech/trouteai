"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Card, Input, Modal, CardSkeleton } from "@/shared/components";
import Toggle from "@/shared/components/Toggle";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { isPublicDisplayBaseUrl, useDisplayBaseUrl } from "@/shared/hooks";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { getProviderDisplayName } from "@/lib/display/names";
import { useTranslations } from "next-intl";
import { useNotificationStore } from "@/store/notificationStore";
import HowToConnectCard from "./HowToConnectCard";

type TranslationValues = Record<string, string | number | boolean | Date>;

const ALL_ENDPOINTS_PANEL_ID = "endpoint-all-endpoints-panel";

type APIPageClientProps = {
  machineId: string;
};

type EndpointProviderSummary = {
  id: string;
  provider: {
    name: string;
    alias?: string;
  };
};

type EndpointModelSummary = {
  id: string;
  owned_by?: string;
  parent?: string;
  type?: string;
  custom?: boolean;
  root?: string;
};

type CopyHandler = (text: string, key?: string) => unknown;

function runEndpointBackgroundTask(taskName: string, task: () => Promise<unknown>) {
  void task().catch((error) => {
    console.log("Error running endpoint background task:", taskName, error);
  });
}

export default function APIPageClient({ machineId }: Readonly<APIPageClientProps>) {
  const [resolvedMachineId, setResolvedMachineId] = useState(machineId || "");
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  const [loading, setLoading] = useState(true);
  const [allModels, setAllModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(null); // provider models popup
  const [searchProviders, setSearchProviders] = useState<any[]>([]);
  const [localApiUrl, setLocalApiUrl] = useState("http://localhost:20017/v1");
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [customSystemPromptEnabled, setCustomSystemPromptEnabled] = useState(false);
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");
  const notify = useNotificationStore();
  // Prompt save state: last value the server accepted, newest value to save,
  // pending debounce timer, and a promise chain so PATCHes run one at a time in order.
  const savedPromptRef = useRef("");
  const latestPromptRef = useRef("");
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptChainRef = useRef<Promise<void>>(Promise.resolve());
  // The long per-endpoint model lists stay collapsed until the user asks for them.
  const [showAllEndpoints, setShowAllEndpoints] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const translateOrFallback = useCallback(
    (key: string, fallback: string, values?: TranslationValues) => {
      // Skip keys the locale files don't have yet, so next-intl doesn't log missing messages.
      if (typeof t.has === "function" && !t.has(key as never)) return fallback;
      try {
        const message = values ? t(key as never, values as never) : t(key as never);
        if (!message || message === key || message === `endpoint.${key}`) {
          return fallback;
        }
        return message;
      } catch {
        return fallback;
      }
    },
    [t]
  );

  const fetchSearchProviders = async () => {
    try {
      const res = await fetch("/api/search/providers");
      if (res.ok) {
        const data = await res.json();
        setSearchProviders(data.providers || []);
      }
    } catch {
      // Search endpoint may not be available
    }
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    setModelsError(false);
    try {
      const res = await fetch("/v1/models");
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.data || []);
      } else {
        setModelsError(true);
      }
    } catch (e) {
      console.log("Error fetching models:", e);
      setModelsError(true);
    } finally {
      setModelsLoading(false);
    }
  };

  // Categorize models by endpoint type
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const endpointData = useMemo(() => {
    const chat = allModels.filter((m) => !m.type && !m.parent);
    const embeddings = allModels.filter((m) => m.type === "embedding" && !m.parent);
    const images = allModels.filter((m) => m.type === "image" && !m.parent);
    const video = allModels.filter((m) => m.type === "video" && !m.parent);
    const rerank = allModels.filter((m) => m.type === "rerank" && !m.parent);
    const audioTranscription = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "transcription" && !m.parent
    );
    const audioSpeech = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "speech" && !m.parent
    );
    const moderation = allModels.filter((m) => m.type === "moderation" && !m.parent);
    const music = allModels.filter((m) => m.type === "music" && !m.parent);
    return {
      chat,
      embeddings,
      images,
      video,
      rerank,
      audioTranscription,
      audioSpeech,
      moderation,
      music,
    };
  }, [allModels]);

  const totalEndpointModelCount = useMemo(
    () => Object.values(endpointData).reduce((acc, models) => acc + models.length, 0),
    [endpointData]
  );

  const availableEndpointCount = useMemo(() => {
    const chatCount = endpointData.chat.length > 0 ? 4 : 0; // chat + responses + completions + messages
    const imageCount = endpointData.images.length > 0 ? 2 : 0; // image gen + image edits
    const otherMedia = [
      endpointData.embeddings,
      endpointData.audioTranscription,
      endpointData.audioSpeech,
      endpointData.music,
      endpointData.video,
    ].filter((m) => m.length > 0).length;
    const utilityFixed = 3; // batch + files + list models (always available)
    const modelUtility =
      (endpointData.rerank.length > 0 ? 1 : 0) + (endpointData.moderation.length > 0 ? 1 : 0);
    const searchCount = searchProviders.length > 0 ? 1 : 0;
    return chatCount + imageCount + otherMedia + utilityFixed + modelUtility + searchCount;
  }, [endpointData, searchProviders]);

  const settingsErrorMessage = async (res: Response) => {
    const data = await res.json().catch(() => ({}));
    const err = data?.error;
    if (typeof err === "string") return err;
    return err?.details?.[0]?.message || err?.message || tc("error");
  };

  const handleCustomSystemPromptEnabledChange = async (value: boolean) => {
    setCustomSystemPromptEnabled(value);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customSystemPromptEnabled: value }),
      });
      if (res.ok) return;
      notify.error(await settingsErrorMessage(res));
    } catch {
      notify.error(tc("error"));
    }
    setCustomSystemPromptEnabled(!value);
  };

  const sendLatestPrompt = async () => {
    const value = latestPromptRef.current;
    if (value === savedPromptRef.current) return;
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customSystemPrompt: value }),
      });
      if (res.ok) {
        savedPromptRef.current = value;
        return;
      }
      // A newer value is queued; let its save decide what the user sees.
      if (latestPromptRef.current !== value) return;
      notify.error(await settingsErrorMessage(res));
    } catch (error) {
      if (latestPromptRef.current !== value) return;
      console.log("Error saving custom system prompt:", error);
      notify.error(tc("error"));
    }
    latestPromptRef.current = savedPromptRef.current;
    setCustomSystemPrompt(savedPromptRef.current);
  };

  const saveCustomSystemPrompt = (value: string) => {
    if (promptTimerRef.current) {
      clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
    }
    latestPromptRef.current = value;
    promptChainRef.current = promptChainRef.current.then(sendLatestPrompt);
    return promptChainRef.current;
  };

  const handleCustomSystemPromptChange = (value: string) => {
    setCustomSystemPrompt(value);
    latestPromptRef.current = value;
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = setTimeout(() => void saveCustomSystemPrompt(value), 600);
  };

  // On unmount, send a save that is still waiting for the debounce (queued after
  // any in-flight save so the newest value lands last).
  useEffect(
    () => () => {
      if (!promptTimerRef.current) return;
      clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
      const value = latestPromptRef.current;
      if (value === savedPromptRef.current) return;
      void promptChainRef.current.then(() =>
        fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customSystemPrompt: value }),
          keepalive: true,
        }).catch(() => {})
      );
    },
    []
  );

  useEffect(() => {
    let mounted = true;

    const loadPage = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok && mounted) {
          const data = await res.json();
          if (data.machineId) setResolvedMachineId(data.machineId);
          setCustomSystemPromptEnabled(!!data.customSystemPromptEnabled);
          savedPromptRef.current = data.customSystemPrompt || "";
          latestPromptRef.current = savedPromptRef.current;
          setCustomSystemPrompt(savedPromptRef.current);
        }
      } catch (error) {
        console.log("Error loading endpoint settings:", error);
      }

      if (!mounted) return;
      setLoading(false);

      runEndpointBackgroundTask("models", fetchModels);
      runEndpointBackgroundTask("search-providers", fetchSearchProviders);
      runEndpointBackgroundTask("network-info", async () => {
        try {
          const res = await fetch("/api/network/info");
          if (res.ok) {
            const data = await res.json();
            if (mounted) {
              if (data.localUrl) setLocalApiUrl(data.localUrl);
              setLanUrls(data.lanUrls ?? []);
            }
          }
        } catch {
          // non-critical
        }
      });
    };

    void loadPage();

    return () => {
      mounted = false;
    };
  }, []);

  const displayBaseUrl = useDisplayBaseUrl();
  const displayApiUrl = `${displayBaseUrl}/v1`;
  const publicDisplayApiUrl = isPublicDisplayBaseUrl(displayBaseUrl) ? displayApiUrl : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = publicDisplayApiUrl ?? displayApiUrl;
  const activeUrls = [
    ...(publicDisplayApiUrl
      ? [{ label: t("tierPublic"), url: publicDisplayApiUrl, key: "active_public" }]
      : []),
    { label: t("activeLocal"), url: localApiUrl, key: "active_local" },
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex((other) => other.url === candidate.url) === index
  );

  let allEndpointsSummary: string;
  if (modelsLoading) {
    allEndpointsSummary = translateOrFallback("loadingModels", "Loading available models...");
  } else if (modelsError) {
    allEndpointsSummary = translateOrFallback("modelsLoadFailed", "Could not load the model list.");
  } else if (showAllEndpoints) {
    allEndpointsSummary = t("modelsAcrossEndpoints", {
      models: totalEndpointModelCount,
      endpoints: availableEndpointCount,
    });
  } else {
    allEndpointsSummary = translateOrFallback(
      "allEndpointsModelsAvailable",
      `${totalEndpointModelCount} ${totalEndpointModelCount === 1 ? "model" : "models"} available`,
      { count: totalEndpointModelCount }
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Start here: plain-language setup guide */}
      <HowToConnectCard apiBaseUrl={currentEndpoint} />

      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-text-muted mb-4">
          {translateOrFallback(
            "serverAddressesHint",
            "Addresses where this server can be reached. If you're not sure, use the Base URL above."
          )}
        </p>

        {/* Active URLs bar */}
        {activeUrls.length > 0 && (
          <div className="mb-4 rounded-card border border-border bg-surface p-3">
            <p className="text-[10px] font-semibold text-primary-text uppercase tracking-wider mb-2">
              {t("activeEndpoints")}
            </p>
            <div className="flex flex-col gap-1.5">
              {activeUrls.map(({ label, url, key }) => (
                <div key={key} className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                  <span className="text-xs text-text-muted min-w-20 shrink-0">{label}</span>
                  <code className="text-xs font-mono text-text-main flex-1 truncate min-w-0">
                    {url}
                  </code>
                  <button
                    onClick={() => void copy(url, key)}
                    aria-label={t("copyUrlTitle", { url })}
                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-control border border-border text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
                  >
                    <span className="material-symbols-outlined text-[12px]">
                      {copied === key ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connection rows */}
        <div className="flex flex-col">
          {/* Local Server */}
          <div className="flex items-center gap-3 py-3">
            <span className="material-symbols-outlined text-[18px] text-success shrink-0">
              computer
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1 flex-wrap">
                <span className="text-sm font-medium">{t("localServer")}</span>
                {resolvedMachineId && (
                  <span className="text-xs text-text-muted">· {resolvedMachineId.slice(0, 8)}</span>
                )}
                {lanUrls.map((url) => (
                  <button
                    key={url}
                    onClick={() => void copy(url, `lan_${url}`)}
                    title={t("copyUrlTitle", { url })}
                    className="inline-flex items-center gap-0.5 text-[10px] text-text-muted hover:text-text transition-colors"
                  >
                    <code className="font-mono">{url.replace(/^https?:\/\//, "")}</code>
                    <span className="material-symbols-outlined text-[10px] opacity-60">
                      {copied === `lan_${url}` ? "check" : "content_copy"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-success/10 border border-success/30 text-success shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              {t("statusRunning")}
            </span>
            <button
              onClick={() => void copy(localApiUrl, "endpoint_url")}
              className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border/70 text-text-muted hover:text-text hover:border-border transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">
                {copied === "endpoint_url" ? "check" : "content_copy"}
              </span>
              {copied === "endpoint_url" ? tc("copied") : tc("copy")}
            </button>
          </div>
        </div>

        {/* Custom System Prompt */}
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{t("customSystemPromptTitle")}</p>
            <p className="text-sm text-text-muted">{t("customSystemPromptDescription")}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {customSystemPromptEnabled && (
              <Input
                type="text"
                value={customSystemPrompt}
                onChange={(e) => handleCustomSystemPromptChange(e.target.value)}
                onBlur={(e) => void saveCustomSystemPrompt(e.target.value)}
                maxLength={10000}
                placeholder={t("customSystemPromptPlaceholder")}
                className="w-64 text-xs"
              />
            )}
            <Toggle
              checked={customSystemPromptEnabled}
              onChange={handleCustomSystemPromptEnabledChange}
              ariaLabel={t("customSystemPromptTitle")}
              size="sm"
            />
          </div>
        </div>
      </Card>

      {/* All endpoints & models (collapsed by default) */}
      <Card padding="none" className="overflow-hidden">
        <h2>
          <button
            type="button"
            onClick={() => setShowAllEndpoints((value) => !value)}
            aria-expanded={showAllEndpoints}
            aria-controls={ALL_ENDPOINTS_PANEL_ID}
            className="flex w-full items-center gap-3 p-6 text-left transition-colors hover:bg-bg-subtle"
          >
            <span
              className="material-symbols-outlined shrink-0 text-[22px] text-text-muted"
              aria-hidden="true"
            >
              apps
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold text-text-main">
                {translateOrFallback("allEndpointsTitle", "All endpoints & models")}
              </span>
              <span className="block text-sm font-normal text-text-muted">
                {translateOrFallback(
                  "allEndpointsSubtitle",
                  "Every API this server offers and the models available for each."
                )}
              </span>
              <span className="mt-1 block text-xs font-medium text-text-muted">
                {allEndpointsSummary}
              </span>
            </span>
            <span className="material-symbols-outlined shrink-0 text-text-muted" aria-hidden="true">
              {showAllEndpoints ? "expand_less" : "expand_more"}
            </span>
          </button>
        </h2>

        {modelsError && !modelsLoading && (
          <div className="flex items-center gap-3 border-t border-border px-6 py-3" role="alert">
            <p className="flex-1 text-sm text-text-muted">
              {translateOrFallback(
                "modelsLoadFailedHint",
                "The model list did not load. Check that the server is reachable and try again."
              )}
            </p>
            <button
              type="button"
              onClick={() => void fetchModels()}
              className="rounded-lg border border-border px-3 py-1 text-xs text-text-main hover:bg-bg-subtle"
            >
              {translateOrFallback("retry", "Retry")}
            </button>
          </div>
        )}

        <div id={ALL_ENDPOINTS_PANEL_ID}>
          {showAllEndpoints && (
            <div className="border-t border-border px-6 pt-5 pb-6">
              {/* Core APIs */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined text-sm text-primary-text">hub</span>
                  <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    {t("categoryCore") || "Core APIs"}
                  </h3>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  <EndpointCard
                    icon="chat"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("chatCompletions")}
                    path="/v1/chat/completions"
                    models={endpointData.chat}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="code"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("responses") || "Responses API"}
                    path="/v1/responses"
                    models={endpointData.chat}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="text_fields"
                    iconColor="text-warning"
                    iconBg="bg-warning/10"
                    title={t("completionsLegacy") || "Completions (Legacy)"}
                    path="/v1/completions"
                    models={endpointData.chat}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="psychology"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("messagesApi") || "Messages"}
                    path="/v1/messages"
                    models={null}
                    badge="Anthropic"
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                  />
                </div>
              </div>

              {/* Media & Multi-Modal */}
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined text-sm text-primary-text">
                    perm_media
                  </span>
                  <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    {t("categoryMedia") || "Media & Multi-Modal"}
                  </h3>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  <EndpointCard
                    icon="data_array"
                    iconColor="text-success"
                    iconBg="bg-success/10"
                    title={t("embeddings")}
                    path="/v1/embeddings"
                    models={endpointData.embeddings}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="image"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("imageGeneration")}
                    path="/v1/images/generations"
                    models={endpointData.images}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="edit_square"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("imageEdits") || "Image Edits"}
                    path="/v1/images/edits"
                    models={endpointData.images}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="mic"
                    iconColor="text-error"
                    iconBg="bg-error/10"
                    title={t("audioTranscription")}
                    path="/v1/audio/transcriptions"
                    models={endpointData.audioTranscription}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="record_voice_over"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("textToSpeech")}
                    path="/v1/audio/speech"
                    models={endpointData.audioSpeech}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="music_note"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("musicGeneration") || "Music Generation"}
                    path="/v1/music/generations"
                    models={endpointData.music}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="videocam"
                    iconColor="text-error"
                    iconBg="bg-error/10"
                    title={t("videoGeneration") || "Video Generation"}
                    path="/v1/videos/generations"
                    models={endpointData.video}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                </div>
              </div>

              {/* Search & Discovery */}
              {searchProviders.length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="material-symbols-outlined text-sm text-primary-text">
                      travel_explore
                    </span>
                    <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                      {t("categorySearch") || "Search & Discovery"}
                    </h3>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                    <EndpointCard
                      icon="search"
                      iconColor="text-primary-text"
                      iconBg="bg-primary/10"
                      title={t("webSearch") || "Web Search"}
                      path="/v1/search"
                      models={searchProviders.map((p) => ({
                        id: p.id,
                        owned_by: p.id,
                        type: "search",
                      }))}
                      copy={copy}
                      copied={copied}
                      baseUrl={currentEndpoint}
                    />
                  </div>
                </div>
              )}

              {/* Utility & Management */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="material-symbols-outlined text-sm text-warning">build</span>
                  <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    {t("categoryUtility") || "Utility & Management"}
                  </h3>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                  <EndpointCard
                    icon="sort"
                    iconColor="text-warning"
                    iconBg="bg-warning/10"
                    title={t("rerank")}
                    path="/v1/rerank"
                    models={endpointData.rerank}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="shield"
                    iconColor="text-warning"
                    iconBg="bg-warning/10"
                    title={t("moderations")}
                    path="/v1/moderations"
                    models={endpointData.moderation}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                    modelsLoading={modelsLoading}
                  />
                  <EndpointCard
                    icon="view_list"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("batchApi") || "Batch API"}
                    path="/v1/batches"
                    models={null}
                    badge="OpenAI"
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                  />
                  <EndpointCard
                    icon="folder"
                    iconColor="text-warning"
                    iconBg="bg-warning/10"
                    title={t("filesApi") || "Files API"}
                    path="/v1/files"
                    models={null}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                  />
                  <EndpointCard
                    icon="list"
                    iconColor="text-primary-text"
                    iconBg="bg-primary/10"
                    title={t("listModels") || "List Models"}
                    path="/v1/models"
                    models={null}
                    copy={copy}
                    copied={copied}
                    baseUrl={currentEndpoint}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Provider Models Popup */}
      {selectedProvider && (
        <ProviderModelsModal
          provider={selectedProvider}
          models={allModels}
          copy={copy}
          copied={copied}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

// -- Sub-component: Provider Models Modal ------------------------------------------

function ProviderModelsModal({
  provider,
  models,
  copy,
  copied,
  onClose,
}: Readonly<{
  provider: EndpointProviderSummary;
  models: EndpointModelSummary[];
  copy: CopyHandler;
  copied?: string | null;
  onClose: () => void;
}>) {
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  // Get provider alias for matching models
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const providerAlias = provider.provider.alias || provider.id;
  const providerModels = useMemo(() => {
    return models.filter(
      (m) => !m.parent && (m.owned_by === providerAlias || m.owned_by === provider.id)
    );
  }, [models, providerAlias, provider.id]);

  const chatModels = providerModels.filter((m) => !m.type);
  const embeddingModels = providerModels.filter((m) => m.type === "embedding");
  const imageModels = providerModels.filter((m) => m.type === "image");

  const renderModelGroup = (title, icon, groupModels) => {
    if (groupModels.length === 0) return null;
    return (
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm">{icon}</span>
          {title} ({groupModels.length})
        </h4>
        <div className="flex flex-col gap-1">
          {groupModels.map((m) => {
            const copyKey = `modal-${m.id}`;
            return (
              <div
                key={m.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface/60 group"
              >
                <code className="text-sm font-mono flex-1 truncate">{m.id}</code>
                {m.custom && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary-text">
                    {t("custom")}
                  </span>
                )}
                <button
                  onClick={() => copy(m.id, copyKey)}
                  className="p-1 hover:bg-sidebar rounded text-text-muted hover:text-primary-text opacity-0 group-hover:opacity-100 transition-opacity"
                  title={tc("copy")}
                  aria-label={tc("copy")}
                >
                  <span className="material-symbols-outlined text-sm">
                    {copied === copyKey ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("providerModelsTitle", { provider: provider.provider.name })}
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {providerModels.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">{t("noModelsForProvider")}</p>
        ) : (
          <>
            {renderModelGroup(t("chat"), "chat", chatModels)}
            {renderModelGroup(t("embedding"), "data_array", embeddingModels)}
            {renderModelGroup(t("image"), "image", imageModels)}
          </>
        )}
      </div>
    </Modal>
  );
}

// -- Sub-component: Endpoint Section ------------------------------------------

function EndpointCard({
  icon,
  iconColor,
  iconBg,
  title,
  path,
  models,
  copy,
  copied,
  baseUrl,
  badge,
  modelsLoading = false,
}: Readonly<{
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  path: string;
  models: EndpointModelSummary[] | null;
  copy: CopyHandler;
  copied?: string | null;
  baseUrl: string;
  badge?: string;
  modelsLoading?: boolean;
}>) {
  const t = useTranslations("endpoint");
  const copyId = `endpoint_${path}`;
  const fullUrl = `${baseUrl.replace(/\/v1$/, "")}${path}`;

  return (
    <div className="border border-border rounded-lg p-3 hover:bg-surface/30 transition-colors flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <div className={`flex items-center justify-center size-8 rounded-lg ${iconBg} shrink-0`}>
          <span className={`material-symbols-outlined text-base ${iconColor}`}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-xs leading-tight">{title}</span>
            {badge && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-text-muted font-medium uppercase tracking-wider leading-none">
                {badge}
              </span>
            )}
          </div>
          <span className="text-xs text-text-muted mt-0.5 block">
            {models === null
              ? "—"
              : modelsLoading
                ? "..."
                : t("modelsCount", { count: models.length })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-[10px] font-mono text-text-muted bg-surface-2 px-2 py-1 rounded-control truncate">
          {path}
        </code>
        <button
          onClick={() => void copy(fullUrl, copyId)}
          className="shrink-0 flex items-center justify-center size-6 rounded hover:bg-sidebar transition-colors"
          title={t("copyUrl")}
          aria-label={t("copyUrl")}
        >
          <span className="material-symbols-outlined text-[12px] text-text-muted">
            {copied === copyId ? "check" : "content_copy"}
          </span>
        </button>
      </div>
    </div>
  );
}

function EndpointSection({
  icon,
  iconColor,
  iconBg,
  title,
  path,
  description,
  models,
  expanded,
  onToggle,
  copy,
  copied,
  baseUrl,
  modelsLoading = false,
}: Readonly<{
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  path: string;
  description: string;
  models: EndpointModelSummary[];
  expanded: boolean;
  onToggle: () => void;
  copy: CopyHandler;
  copied?: string | null;
  baseUrl: string;
  modelsLoading?: boolean;
}>) {
  const t = useTranslations("endpoint");
  const grouped = useMemo(() => {
    const map = {};
    for (const m of models) {
      const owner = m.owned_by || "unknown";
      if (!map[owner]) map[owner] = [];
      map[owner].push(m);
    }
    return Object.entries(map).sort((a: any, b: any) => b[1].length - a[1].length);
  }, [models]);

  const resolveProvider = (id) => AI_PROVIDERS[id] || getProviderByAlias(id);
  const providerColor = (id) => resolveProvider(id)?.color || "#888";
  const providerName = (id) => getProviderDisplayName(id, resolveProvider(id));
  const copyId = `endpoint_${path}`;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header (always visible) */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 hover:bg-surface/50 transition-colors text-left"
      >
        <div className={`flex items-center justify-center size-10 rounded-lg ${iconBg} shrink-0`}>
          <span className={`material-symbols-outlined text-xl ${iconColor}`}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{title}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-text-muted font-medium">
              {modelsLoading ? "..." : t("modelsCount", { count: models.length })}
            </span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">{description}</p>
        </div>
        <span
          className={`material-symbols-outlined text-text-muted text-lg transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          expand_more
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-4 pb-4">
          {/* Endpoint path + copy */}
          <div className="flex items-center gap-2 mt-3 mb-3">
            <code className="flex-1 text-xs font-mono text-text-muted bg-surface-2 border border-border px-3 py-1.5 rounded-control truncate">
              {baseUrl.replace(/\/v1$/, "")}
              {path}
            </code>
            <button
              onClick={() => copy(`${baseUrl.replace(/\/v1$/, "")}${path}`, copyId)}
              aria-label={t("copyUrl")}
              className="p-1.5 hover:bg-surface rounded-lg text-text-muted hover:text-primary-text transition-colors shrink-0"
            >
              <span className="material-symbols-outlined text-[16px]">
                {copied === copyId ? "check" : "content_copy"}
              </span>
            </button>
          </div>

          {/* Models grouped by provider */}
          {modelsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/40 px-3 py-2 text-xs text-text-muted">
              <span className="material-symbols-outlined animate-spin text-sm">
                progress_activity
              </span>
              <span>{t("loadingModels")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {grouped.map(([providerId, providerModels]) => (
                <div key={providerId}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: providerColor(providerId) }}
                    />
                    <span className="text-xs font-semibold text-text-main">
                      {providerName(providerId)}
                    </span>
                    <span className="text-xs text-text-muted">
                      ({(providerModels as any).length})
                    </span>
                  </div>
                  <div className="ml-5 flex flex-wrap gap-1.5">
                    {(providerModels as any).map((m) => (
                      <span
                        key={m.id}
                        className="text-xs px-2 py-0.5 rounded-md bg-surface-2 text-text-muted font-mono"
                        title={m.id}
                      >
                        {m.root || m.id.split("/").pop()}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
