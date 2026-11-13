export type ServerLifecyclePhase = "starting" | "ready" | "stopping";

declare global {
  var __trouteaiServerLifecycle: ServerLifecyclePhase | undefined;
}

export function getServerLifecyclePhase(): ServerLifecyclePhase {
  return globalThis.__trouteaiServerLifecycle ?? "starting";
}

export function markServerStarting(): void {
  globalThis.__trouteaiServerLifecycle = "starting";
}

export function markServerReady(): void {
  if (getServerLifecyclePhase() !== "stopping") {
    globalThis.__trouteaiServerLifecycle = "ready";
  }
}

export function markServerStopping(): void {
  globalThis.__trouteaiServerLifecycle = "stopping";
}
