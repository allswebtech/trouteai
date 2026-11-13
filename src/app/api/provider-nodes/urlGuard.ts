import { NextResponse } from "next/server";
import {
  OutboundUrlGuardError,
  parseAndValidateNonMetadataUrl,
  parseAndValidatePublicUrl,
  parseOutboundUrl,
} from "@/shared/network/outboundUrlGuard";
import { getProviderValidationGuard } from "@/shared/network/outboundUrlGuardPolicy";
import { getProviderNodes } from "@/models";

function guardProviderNodeBaseUrl(baseUrl: string): void {
  const guard = getProviderValidationGuard();
  if (guard === "none") {
    parseOutboundUrl(baseUrl);
    return;
  }
  if (guard === "block-metadata") {
    parseAndValidateNonMetadataUrl(baseUrl);
    return;
  }
  parseAndValidatePublicUrl(baseUrl);
}

// Model routing resolves "<prefix>/model" to the first node with that prefix, so two nodes
// sharing a prefix would silently shadow each other.
export async function duplicatePrefixResponse(
  prefix: string,
  excludeId?: string
): Promise<NextResponse | null> {
  const wanted = prefix.trim();
  if (!wanted) return null;
  const nodes = (await getProviderNodes()) as Array<{ id?: string; prefix?: string | null }>;
  const clash = nodes.some((node) => node.id !== excludeId && node.prefix === wanted);
  if (!clash) return null;
  return NextResponse.json(
    {
      error: {
        message: "Invalid request",
        details: [{ field: "prefix", message: "This prefix is already used by another provider" }],
      },
    },
    { status: 409 }
  );
}

export function validateProviderNodeBaseUrl(baseUrl: string): NextResponse | null {
  try {
    guardProviderNodeBaseUrl(baseUrl);
    return null;
  } catch (error) {
    const message =
      error instanceof OutboundUrlGuardError
        ? error.code === "OUTBOUND_URL_INVALID"
          ? "Invalid provider base URL format"
          : error.message
        : "Invalid provider base URL";
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "baseUrl", message }],
        },
      },
      { status: 400 }
    );
  }
}
