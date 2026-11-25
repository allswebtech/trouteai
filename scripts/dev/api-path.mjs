/**
 * API clients (and the programs that put TRouteAI behind them) refuse redirects, and Next.js
 * answers a path with a trailing slash with a 308 to the path without it. For the API paths
 * the slash is dropped before Next.js sees the request, so `/v1/models/` is served as
 * `/v1/models` directly. Dashboard pages keep Next.js' own behaviour.
 */
const API_PREFIXES = [
  "/api",
  "/v1",
  "/v1beta",
  "/models",
  "/chat",
  "/responses",
  "/codex",
  "/anthropic",
  "/openai",
  "/healthz",
];

export function stripApiTrailingSlash(url, basePath = "") {
  if (typeof url !== "string" || url.length < 2) return url;
  const queryAt = url.indexOf("?");
  const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
  if (pathname === "/" || !pathname.endsWith("/")) return url;

  let rest = pathname;
  if (basePath) {
    if (!pathname.startsWith(`${basePath}/`)) return url;
    rest = pathname.slice(basePath.length);
  }
  const isApi = API_PREFIXES.some((prefix) => rest.startsWith(`${prefix}/`));
  if (!isApi) return url;

  const trimmed = pathname.replace(/\/+$/, "");
  if (!trimmed || trimmed === basePath) return url;
  return trimmed + (queryAt < 0 ? "" : url.slice(queryAt));
}
