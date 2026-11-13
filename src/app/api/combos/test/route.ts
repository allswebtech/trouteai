import { NextResponse } from "next/server";
import { POST as postChatCompletion } from "@/app/api/v1/chat/completions/route";
import { handleValidatedEmbeddingRequestBody } from "@/app/api/v1/embeddings/route";
import { buildInternalChatRequest } from "@/lib/api/modelTestRunner";
import { buildComboTestRequestBody, extractComboTestResponseText } from "@/lib/combos/testHealth";
import { getComboByName, getCombos } from "@/lib/localDb";
import { resolveNestedComboTargets } from "@trouteai/open-sse/services/combo.ts";
import { testComboSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { sanitizeErrorMessage } from "@trouteai/open-sse/utils/error";

const COMBO_TEST_TIMEOUT_MS = 20000;

function buildComboTestResult(target, partial: { status?: string; [key: string]: unknown } = {}) {
  return {
    model: target.modelStr,
    provider: target.provider,
    stepId: target.stepId,
    executionKey: target.executionKey,
    connectionId: target.connectionId,
    label: target.label,
    ...partial,
  };
}

/**
 * Run one combo step in-process, the same way the provider page's model test does
 * (src/lib/api/modelTestRunner.ts). Calling our own /v1 over HTTP needed a client API
 * key, so with REQUIRE_API_KEY on and no key created every step failed with 401.
 * This route is already protected by management auth.
 */
async function runComboStep(
  modelStr: string,
  isEmbedding: boolean,
  connectionId: string | null | undefined
): Promise<Response> {
  const testBody = buildComboTestRequestBody(modelStr, isEmbedding);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("Timeout");
      error.name = "AbortError";
      reject(error);
    }, COMBO_TEST_TIMEOUT_MS);
  });
  const run = isEmbedding
    ? handleValidatedEmbeddingRequestBody(testBody as Record<string, unknown> & { model: string }, {
        connectionId: connectionId || undefined,
      })
    : postChatCompletion(
        buildInternalChatRequest(testBody, controller.signal, connectionId || undefined)
      );
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function testComboTarget(target) {
  const startTime = Date.now();
  try {
    // Combo entries with a malformed/missing modelStr surfaced
    // as `e.startsWith is not a function` / similar TypeError 500s. Coerce
    // defensively at the boundary so the test path returns a clean error
    // instead of crashing the request handler.
    const modelStr = typeof target?.modelStr === "string" ? target.modelStr : "";
    if (!modelStr) {
      return buildComboTestResult(target, {
        status: "error",
        error: "Combo step is missing a model id (modelStr). Re-save the combo to refresh it.",
        latencyMs: 0,
      });
    }
    const modelLower = modelStr.toLowerCase();
    const isEmbedding =
      modelLower.includes("embedding") ||
      modelLower.includes("bge-") ||
      modelLower.includes("text-embed");

    const res = await runComboStep(modelStr, isEmbedding, target.connectionId);
    const latencyMs = Date.now() - startTime;

    if (res.ok) {
      let responseBody = null;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = null;
      }

      const responseText = extractComboTestResponseText(responseBody);
      if (!responseText) {
        return buildComboTestResult(target, {
          status: "error",
          statusCode: res.status,
          error: "Provider returned HTTP 200 but no text content.",
          latencyMs,
        });
      }

      return buildComboTestResult(target, { status: "ok", latencyMs, responseText });
    }

    let errorMsg = "";
    try {
      const errBody = await res.json();
      errorMsg = errBody?.error?.message || errBody?.error || res.statusText;
    } catch {
      errorMsg = res.statusText;
    }

    return buildComboTestResult(target, {
      status: "error",
      statusCode: res.status,
      error: errorMsg,
      latencyMs,
    });
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return buildComboTestResult(target, {
      status: "error",
      error:
        error?.name === "AbortError"
          ? `Timeout (${COMBO_TEST_TIMEOUT_MS / 1000}s)`
          : sanitizeErrorMessage(error?.message),
      latencyMs,
    });
  }
}

/**
 * POST /api/combos/test - Quick test a combo
 * Sends a real chat completion request through each model in the combo
 * and only reports success when the model returns usable text content.
 */
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

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
    const validation = validateBody(testComboSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { comboName } = validation.data;

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: "Combo not found" }, { status: 404 });
    }

    const allCombos = await getCombos();
    const targets = resolveNestedComboTargets(combo, allCombos);

    if (targets.length === 0) {
      return NextResponse.json({ error: "Combo has no models" }, { status: 400 });
    }

    const results = await Promise.all(targets.map((target) => testComboTarget(target)));
    const resolvedResult = results.find((result) => result.status === "ok") || null;
    const resolvedBy = resolvedResult?.model || null;

    return NextResponse.json({
      comboName,
      strategy: combo.strategy || "priority",
      resolvedBy,
      resolvedByExecutionKey: resolvedResult?.executionKey || null,
      resolvedByTarget: resolvedResult
        ? {
            model: resolvedResult.model,
            provider: resolvedResult.provider,
            stepId: resolvedResult.stepId,
            executionKey: resolvedResult.executionKey,
            connectionId: resolvedResult.connectionId,
            label: resolvedResult.label,
          }
        : null,
      results,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.log("Error testing combo:", error);
    return NextResponse.json({ error: "Failed to test combo" }, { status: 500 });
  }
}
