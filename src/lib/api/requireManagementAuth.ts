import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { isCliTokenAuthValid } from "@/lib/middleware/cliTokenAuth";
import {
  MANAGE_SCOPE,
  hasManageScope as hasManageScopeShared,
} from "@/shared/constants/managementScopes";

export { MANAGE_SCOPE };

/**
 * Check whether any of the supplied scopes authorizes management API access.
 *
 * Re-exported here for backwards compatibility with existing callers. The
 * canonical definition lives in `@/shared/constants/managementScopes`.
 */
export function hasManageScope(scopes: string[] = []): boolean {
  return hasManageScopeShared(scopes);
}

interface RequireManagementAuthOptions {
  alwaysRequireAuth?: boolean;
  invalidApiKeyStatus?: 401 | 403;
}

function invalidManagementTokenResponse(options: RequireManagementAuthOptions): Response {
  const status = options.invalidApiKeyStatus ?? 403;
  return createErrorResponse({
    status,
    message: status === 401 ? "Invalid API key" : "Invalid management token",
    type: "invalid_request",
  });
}

export async function requireManagementAuth(
  request: Request,
  options: RequireManagementAuthOptions = {}
): Promise<Response | null> {
  if (!options.alwaysRequireAuth && !(await isAuthRequired(request))) {
    return null;
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return null;
  }

  // CLI machine-id token allows localhost CLI access without an explicit API key.
  if (await isCliTokenAuthValid(request)) {
    return null;
  }

  // Management auth never honours a URL-borne credential (header-only) — a token
  // in the path/query must not authenticate a management route.
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (apiKey) {
    let meta: Awaited<ReturnType<typeof getApiKeyMetadata>>;
    try {
      if (!(await isValidApiKey(apiKey))) {
        return invalidManagementTokenResponse(options);
      }
      meta = await getApiKeyMetadata(apiKey);
    } catch {
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    }

    if (meta && hasManageScope(meta.scopes)) return null;

    return createErrorResponse({
      status: 403,
      message: "API key lacks 'manage' scope. Enable it in the API Keys dashboard.",
      type: "invalid_request",
    });
  }

  return createErrorResponse({
    status: 401,
    message: "Authentication required",
    type: "invalid_request",
  });
}
