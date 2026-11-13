const PUBLIC_API_ROUTE_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc/",
  // Client API: every handler enforces its own API-key auth (REQUIRE_API_KEY).
  "/api/v1/",
  // Public, ticket-gated Codex device-flow completion (validate + persist).
  // The handler enforces its own single-use ticket check; no dashboard auth.
  "/api/codex/connect/",
  // Terminal-friendly @@om-usage equivalent for CLI clients (Claude Code/Codex).
  // The handler enforces its own auth via extractUsageCommandApiKey/isValidApiKey
  // and the allowUsageCommand flag — it must not be gated by management auth.
  "/api/usage/om-usage",
];

const PUBLIC_READONLY_API_ROUTE_PREFIXES = ["/api/health/ping", "/api/settings/require-login"];

const PUBLIC_READONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const PUBLIC_CLOUD_API_ROUTES = [];

function pathMatchesExactRoute(pathname: string, routePath: string): boolean {
  return pathname === routePath || pathname === `${routePath}/`;
}

function isPublicCloudApiRoute(pathname: string, method: string): boolean {
  const normalizedMethod = String(method).toUpperCase();
  return PUBLIC_CLOUD_API_ROUTES.some(
    ({ path, methods }) => pathMatchesExactRoute(pathname, path) && methods.has(normalizedMethod)
  );
}

export function isPublicApiRoute(pathname: string, method = "GET"): boolean {
  if (isPublicCloudApiRoute(pathname, method)) {
    return true;
  }

  if (PUBLIC_API_ROUTE_PREFIXES.some((route) => pathname.startsWith(route))) {
    return true;
  }

  if (!PUBLIC_READONLY_METHODS.has(String(method).toUpperCase())) {
    return false;
  }

  return PUBLIC_READONLY_API_ROUTE_PREFIXES.some((route) => pathname.startsWith(route));
}

export { PUBLIC_API_ROUTE_PREFIXES, PUBLIC_READONLY_API_ROUTE_PREFIXES, PUBLIC_READONLY_METHODS };
