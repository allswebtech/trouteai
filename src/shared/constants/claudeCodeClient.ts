/**
 * Wire-version data of the Claude Code client the gateway presents on the subscription path.
 *
 * Keep this leaf dependency-free so server executors, compatibility bridges, and
 * client-facing identity presets can share one source of truth.
 *
 * The four values below (version, build revision, SDK package version, runtime version) are
 * ONE set: the client-identity values the gateway presents on the subscription path, all four
 * from one build of the client. Change them only together, to the four values of one other
 * client build: a mix of values that no client build sends is a fingerprint of its own.
 *
 * The version alone can be overridden, without any network lookup, in this order:
 *   1. the dashboard setting `claudeCodeClientVersion` (noted by the executor from settings);
 *   2. the environment variable TROUTEAI_CLAUDE_CODE_VERSION;
 *   3. the pin below.
 * An override changes the version only (user agent and billing line); the build revision, the
 * SDK package version and the runtime version stay those of the pinned set.
 */
export const CLAUDE_CODE_CLIENT_VERSION = "2.1.319";
export const CLAUDE_CODE_CLIENT_BUILD_REVISION = "250";
export const CLAUDE_CODE_CLIENT_BILLING_VERSION = `${CLAUDE_CODE_CLIENT_VERSION}.${CLAUDE_CODE_CLIENT_BUILD_REVISION}`;
export const CLAUDE_CODE_SDK_PACKAGE_VERSION = "0.128.0";
export const CLAUDE_CODE_RUNTIME_VERSION = "v26.12.1";

export const CLAUDE_CODE_VERSION_ENV = "TROUTEAI_CLAUDE_CODE_VERSION";
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,5}$/;

export type ClaudeCodeEntrypoint = "cli" | "sdk-cli";

let settingVersion: string | null = null;

function validVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

/** Record the dashboard setting (an empty or invalid value clears it). */
export function noteClaudeCodeClientVersionSetting(value: unknown): void {
  settingVersion = validVersion(value);
}

/** The client version presented upstream: setting, then environment, then the pin. */
export function getClaudeCodeClientVersion(): string {
  return (
    settingVersion ||
    validVersion(
      typeof process === "undefined" ? undefined : process.env?.[CLAUDE_CODE_VERSION_ENV]
    ) ||
    CLAUDE_CODE_CLIENT_VERSION
  );
}

/** `cc_version=` of the billing line: the presented version and the build revision. */
export function getClaudeCodeClientBillingVersion(): string {
  return `${getClaudeCodeClientVersion()}.${CLAUDE_CODE_CLIENT_BUILD_REVISION}`;
}

export function getClaudeCodeUserAgent(entrypoint: ClaudeCodeEntrypoint): string {
  return `claude-cli/${getClaudeCodeClientVersion()} (external, ${entrypoint})`;
}
