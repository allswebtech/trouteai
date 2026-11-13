import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { revokeAllDashboardSessions } from "@/server/auth/dashboardSession";
import {
  hasManagementPasswordConfigured,
  hashManagementPassword,
} from "@/lib/auth/managementPassword";
import { isAuthenticated, isTrustedLoopbackRequest } from "@/shared/utils/apiAuth";
import { getNodeRuntimeSupport } from "@/shared/utils/nodeRuntimeSupport.ts";
import { getBrandCredit } from "@/lib/branding";
import { updateRequireLoginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

// Node.js compatibility check — reflect the supported secure runtime floors used by CLI/CI.
function getNodeCompatibility() {
  // Public endpoint: expose only the boolean, never the exact runtime version.
  const { nodeCompatible } = getNodeRuntimeSupport();
  return { nodeCompatible };
}

function hasConfiguredPassword(settings: Record<string, unknown>) {
  return hasManagementPasswordConfigured(settings);
}

function isBootstrapSecurityWindow(settings: Record<string, unknown>) {
  return !hasConfiguredPassword(settings);
}

export async function GET() {
  const nodeInfo = getNodeCompatibility();
  // Public on purpose: the optional credit line is shown on the login page.
  const brandCredit = getBrandCredit();
  try {
    const settings = await getSettings();
    const requireLogin = settings.requireLogin !== false;
    const hasPassword = hasManagementPasswordConfigured(settings);
    const setupComplete = !!settings.setupComplete;
    const oidcEnabled = !!settings.oidcEnabled;
    return NextResponse.json({
      requireLogin,
      hasPassword,
      setupComplete,
      oidcEnabled,
      brandCredit,
      ...nodeInfo,
    });
  } catch (error) {
    console.error("[API] Error fetching require-login settings:", error);
    return NextResponse.json(
      {
        requireLogin: true,
        hasPassword: true,
        setupComplete: true,
        oidcEnabled: false,
        brandCredit,
        ...nodeInfo,
      },
      { status: 200 }
    );
  }
}

/**
 * POST /api/settings/require-login — Set password and/or toggle requireLogin.
 * Unauthenticated writes are only allowed during the initial bootstrap window.
 */
export async function POST(request: Request) {
  const settings = await getSettings();
  if (isBootstrapSecurityWindow(settings)) {
    // First-password setup is only allowed from the machine itself.
    if (!isTrustedLoopbackRequest(request)) {
      return NextResponse.json(
        { error: "Set INITIAL_PASSWORD in the .env file and restart the app, then sign in." },
        { status: 403 }
      );
    }
  } else if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  } else if (settings.setupComplete === true) {
    // After onboarding, password/login changes need re-auth via PATCH /api/settings.
    return NextResponse.json(
      {
        error: "Use Settings > Security to change login settings",
        code: "USE_SECURITY_SETTINGS",
      },
      { status: 403 }
    );
  }

  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(updateRequireLoginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body = validation.data;
    const { requireLogin, password } = body;

    const updates: Record<string, any> = {};

    if (typeof requireLogin === "boolean") {
      updates.requireLogin = requireLogin;
    }

    if (password) {
      const hashedPassword = await hashManagementPassword(password);
      updates.password = hashedPassword;
    }

    await updateSettings(updates);
    if (password) {
      // A new password signs out every other browser (same rule as PATCH /api/settings).
      try {
        revokeAllDashboardSessions();
      } catch (error) {
        console.error("[API] Failed to revoke dashboard sessions:", error);
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API] Error updating require-login settings:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update settings" },
      { status: 500 }
    );
  }
}
