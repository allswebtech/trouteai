export function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

/**
 * Resolve the V8 heap ceiling (MB) from TROUTEAI_MAX_HEAP_MB (bin/trouteai.mjs).
 * Clamped to [64, 16384]; invalid/unset → fallback.
 * @param {string | number | undefined | null} value
 * @param {number} [fallback]
 */
export function resolveMaxOldSpaceMb(value, fallback = 512) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 64 && parsed <= 16384 ? parsed : fallback;
}

const MAX_OLD_SPACE_FLAG = "--max-old-space-size";

/**
 * True when NODE_OPTIONS already has `--max-old-space-size`. bin/trouteai.mjs uses it
 * so a user-set heap value always wins over the default cap.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function envHasExplicitHeapFlag(env) {
  const sourceEnv = arguments.length === 0 ? process.env : env;
  return String(sourceEnv?.NODE_OPTIONS || "").includes(MAX_OLD_SPACE_FLAG);
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [fromEnv]
 *        Defaults to process.env. Pass bootstrap `merged` so project `.env` PORT applies before spawn.
 */
export function resolveRuntimePorts(fromEnv = process.env) {
  const basePort = parsePort(fromEnv.PORT || "20017", 20017);
  const apiPort = parsePort(fromEnv.API_PORT || String(basePort), basePort);
  const dashboardPort = parsePort(fromEnv.DASHBOARD_PORT || String(basePort), basePort);

  return { basePort, apiPort, dashboardPort };
}

export function withRuntimePortEnv(env, runtimePorts) {
  const { basePort, apiPort, dashboardPort } = runtimePorts;

  return {
    ...env,
    TROUTEAI_PORT: String(basePort),
    PORT: String(dashboardPort),
    DASHBOARD_PORT: String(dashboardPort),
    API_PORT: String(apiPort),
  };
}
