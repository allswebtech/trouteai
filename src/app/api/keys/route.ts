import { NextResponse } from "next/server";
import { getApiKeys, getApiKeysCount, createApiKey, updateApiKeyPermissions } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { createKeySchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { isApiKeyRevealEnabled, maskStoredApiKey } from "@/lib/apiKeyExposure";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { normalizeSelfServiceScopesForCreate } from "@/shared/constants/selfServiceScopes";
import * as log from "@/sse/utils/logger";

function parsePagination(request: Request) {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const offsetValue = url.searchParams.get("offset");

  const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  const parsedOffset = offsetValue ? Number.parseInt(offsetValue, 10) : 0;

  const limit =
    Number.isInteger(parsedLimit) && parsedLimit && parsedLimit > 0 ? parsedLimit : null;
  const offset = Number.isInteger(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

  return { limit, offset };
}

// GET /api/keys - List API keys
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { limit, offset } = parsePagination(request);
    const dbLimit = limit ?? undefined;
    const total = getApiKeysCount();
    const keys = await getApiKeys(dbLimit, offset);
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskStoredApiKey(k.key),
    }));

    return NextResponse.json({
      keys: maskedKeys,
      total,
      allowKeyReveal: isApiKeyRevealEnabled(),
    });
  } catch (error) {
    log.error("keys", "Error fetching keys", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();

    // Zod validation
    const validation = validateBody(createKeySchema, body);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const {
      name,
      noLog,
      scopes,
      allowUsageCommand,
      usageLimitEnabled,
      dailyUsageLimitUsd,
      weeklyUsageLimitUsd,
      chaosModeEnabled,
    } = validation.data;

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const normalizedScopes = normalizeSelfServiceScopesForCreate(scopes);
    const apiKey = await createApiKey(name, machineId, normalizedScopes);
    if (
      noLog === true ||
      allowUsageCommand === true ||
      usageLimitEnabled === true ||
      dailyUsageLimitUsd !== undefined ||
      weeklyUsageLimitUsd !== undefined ||
      chaosModeEnabled === true
    ) {
      await updateApiKeyPermissions(apiKey.id, {
        ...(noLog === true && { noLog: true }),
        ...(allowUsageCommand === true && { allowUsageCommand: true }),
        ...(usageLimitEnabled === true && { usageLimitEnabled: true }),
        ...(dailyUsageLimitUsd !== undefined && { dailyUsageLimitUsd }),
        ...(weeklyUsageLimitUsd !== undefined && { weeklyUsageLimitUsd }),
        ...(chaosModeEnabled === true && { chaosModeEnabled: true }),
      });
    }

    return NextResponse.json(
      {
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        machineId: apiKey.machineId,
        noLog: noLog === true,
        allowUsageCommand: allowUsageCommand === true,
        usageLimitEnabled: usageLimitEnabled === true,
        dailyUsageLimitUsd: dailyUsageLimitUsd ?? null,
        weeklyUsageLimitUsd: weeklyUsageLimitUsd ?? null,
        chaosModeEnabled: chaosModeEnabled === true,
        streamDefaultMode: "legacy",
      },
      { status: 201 }
    );
  } catch (error) {
    log.error("keys", "Error creating key", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
