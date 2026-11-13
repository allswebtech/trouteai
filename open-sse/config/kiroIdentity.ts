import { createHash } from "node:crypto";

/**
 * The Kiro IDE identity sent to Kiro's backend (CodeWhisperer / Amazon Q runtime and the Kiro
 * auth service).
 *
 * Kiro reads the client version from the `KiroIDE-<version>-<machineId>` token in the
 * User-Agent header and answers old clients with 403 "This version of Kiro is no longer
 * supported. Please update to the latest version of Kiro to continue." Cut-offs announced by
 * Kiro: IDE < 0.11.133 since 2026-11-09, IDE 0.11.133 to 0.12.291 from 2027-01-15. Requests
 * without a KiroIDE token (the old `kiro-ide/1.0.0`) are refused the same way.
 *
 * The values match Kiro IDE 1.4.121 (released 2026-11-05, Electron 44.10.0, Node.js 24.22.1).
 * Its agent creates the CodeWhisperer clients with `customUserAgent: "KiroIDE <version>
 * <machineId>"`, which the AWS SDK writes as `KiroIDE-<version>-<machineId>` after its own
 * `aws-sdk-js/...` part. When Kiro announces a new cut-off, take these from the current IDE
 * build (`resources/app/package.json` and the kiro-agent extension bundle).
 */
export const KIRO_IDE_VERSION = "1.4.121";
/** `@aws/codewhisperer-streaming-client` (GenerateAssistantResponse). */
export const KIRO_STREAMING_SDK_VERSION = "1.0.39";
/** `@amzn/codewhisperer-runtime` (ListAvailableModels, GetUsageLimits, ListAvailableProfiles). */
export const KIRO_RUNTIME_SDK_VERSION = "1.0.0";
/** Node.js bundled with the Electron release Kiro IDE ships on. */
const KIRO_NODE_VERSION = "24.22.1";
const KIRO_OS = "win32";
const KIRO_OS_VERSION = "10.0.26200";

export type KiroSdkClient = "streaming" | "runtime";

const SDK_CLIENTS: Record<KiroSdkClient, { api: string; version: string; features: string }> = {
  streaming: {
    api: "codewhispererstreaming",
    version: KIRO_STREAMING_SDK_VERSION,
    features: "E",
  },
  runtime: { api: "codewhispererruntime", version: KIRO_RUNTIME_SDK_VERSION, features: "N,E" },
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Stable per-account machine id: 64 hex characters, the same shape Kiro IDE sends
 * (node-machine-id). Derived from the connection's OIDC client id or profile ARN so one
 * account keeps one id; the token is only a fallback for connections that have neither.
 */
export function getKiroMachineId(providerSpecificData?: unknown, tokenFallback?: unknown): string {
  const psd =
    providerSpecificData && typeof providerSpecificData === "object"
      ? (providerSpecificData as Record<string, unknown>)
      : {};
  const seed =
    nonEmpty(psd.clientId) ||
    nonEmpty(psd.profileArn) ||
    nonEmpty(tokenFallback) ||
    "kiro-anonymous";
  return createHash("sha256").update(seed).digest("hex");
}

/** `KiroIDE-<version>-<machineId>`: the token Kiro reads the client version from. */
export function getKiroIdeToken(machineId: string): string {
  return `KiroIDE-${KIRO_IDE_VERSION}-${machineId}`;
}

/**
 * Fixed Q Developer profiles Kiro IDE uses for logins that have no profile of their own
 * (kiro-agent `getFixedProfileArn`). Kiro asks current clients for a profileArn on every
 * runtime call (400 "profileArn is required for this request." / "Invalid profileArn.").
 */
export const KIRO_BUILDER_ID_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_SOCIAL_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";

/**
 * The profileArn to send when no request can be made to look it up: the connection's own
 * profile, else Kiro IDE's fixed profile for AWS Builder ID or Google/GitHub logins. Callers
 * that can make a request look up the account's real profile first (findKiroProfileArn in
 * services/kiroRegion.ts): accounts labelled Builder ID can have one, and the fixed profile is
 * then refused. Undefined for IAM Identity Center, organization and API-key connections without
 * a stored profile.
 */
export function resolveKiroProfileArn(providerSpecificData?: unknown): string | undefined {
  const psd =
    providerSpecificData && typeof providerSpecificData === "object"
      ? (providerSpecificData as Record<string, unknown>)
      : {};
  const own = nonEmpty(psd.profileArn);
  if (own) return own;
  const authMethod = (nonEmpty(psd.authMethod) || "").toLowerCase();
  const loginProvider = (nonEmpty(psd.provider) || "").toLowerCase();
  if (authMethod === "builder-id" || loginProvider === "builderid") {
    return KIRO_BUILDER_ID_PROFILE_ARN;
  }
  if (
    loginProvider === "google" ||
    loginProvider === "github" ||
    authMethod === "social" ||
    authMethod === "imported"
  ) {
    return KIRO_SOCIAL_PROFILE_ARN;
  }
  return undefined;
}

/**
 * User-Agent and X-Amz-User-Agent for a Kiro runtime call, in the form the IDE's AWS SDK
 * clients send them: `streaming` for GenerateAssistantResponse, `runtime` for the
 * CodeWhisperer runtime operations.
 */
export function getKiroUserAgentHeaders(
  client: KiroSdkClient,
  machineId: string
): { "User-Agent": string; "X-Amz-User-Agent": string } {
  const sdk = SDK_CLIENTS[client];
  const ideToken = getKiroIdeToken(machineId);
  return {
    "User-Agent":
      `aws-sdk-js/${sdk.version} ua/2.1 os/${KIRO_OS}#${KIRO_OS_VERSION} lang/js ` +
      `md/nodejs#${KIRO_NODE_VERSION} api/${sdk.api}#${sdk.version} m/${sdk.features} ${ideToken}`,
    "X-Amz-User-Agent": `aws-sdk-js/${sdk.version} ${ideToken}`,
  };
}
