import type { ProviderPluginManifestEntry } from "@trouteai/open-sse/config/providerPluginManifest.ts";

export const SERVICE_BACKEND_PLUGIN_IDS = ["cliproxyapi"] as const;

export type ServiceBackendPluginId = (typeof SERVICE_BACKEND_PLUGIN_IDS)[number];

export const SERVICE_BACKEND_EXPOSURE_TOOL_BY_PLUGIN_ID: Record<
  ServiceBackendPluginId,
  "cliproxy"
> = {
  cliproxyapi: "cliproxy",
};

export const SERVICE_BACKEND_MANIFEST_TEMPLATE: Record<
  ServiceBackendPluginId,
  Pick<
    ProviderPluginManifestEntry,
    "format" | "executor" | "auth" | "endpoints" | "capabilities" | "passthroughModels" | "sidecar"
  >
> = {
  cliproxyapi: {
    format: "openai",
    executor: "default",
    auth: { type: "none", header: "authorization" },
    endpoints: { modelsUrl: "/v1/models" },
    capabilities: ["passthrough-models"],
    passthroughModels: true,
    sidecar: { eligible: false, reasons: ["runtime provider"] },
  },
};

export function getServiceToolFromPluginId(pluginId: string): "cliproxy" | undefined {
  return SERVICE_BACKEND_EXPOSURE_TOOL_BY_PLUGIN_ID[
    pluginId as keyof typeof SERVICE_BACKEND_EXPOSURE_TOOL_BY_PLUGIN_ID
  ];
}

const SERVICE_BACKEND_PLUGIN_ID_SET = new Set<string>(SERVICE_BACKEND_PLUGIN_IDS);

export function isServiceBackendPluginId(pluginId: string): pluginId is ServiceBackendPluginId {
  return SERVICE_BACKEND_PLUGIN_ID_SET.has(pluginId);
}
