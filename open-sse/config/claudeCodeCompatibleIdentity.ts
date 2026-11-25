import {
  CLAUDE_CODE_CLIENT_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CLAUDE_CODE_SDK_PACKAGE_VERSION,
  getClaudeCodeUserAgent,
} from "@/shared/constants/claudeCodeClient";

export const CLAUDE_CODE_COMPATIBLE_VERSION = CLAUDE_CODE_CLIENT_VERSION;
export const CLAUDE_CODE_COMPATIBLE_USER_AGENT = getClaudeCodeUserAgent("sdk-cli");
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_PACKAGE_VERSION = CLAUDE_CODE_SDK_PACKAGE_VERSION;
export const CLAUDE_CODE_COMPATIBLE_STAINLESS_RUNTIME_VERSION = CLAUDE_CODE_RUNTIME_VERSION;
// Models whose 1M window is native (no long-context beta).
const CONTEXT_1M_NATIVE_MODELS = [
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-haiku-5-5",
];

export function modelHasNativeContext1m(model: string | null | undefined): boolean {
  const normalizedModel = String(model || "")
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, "");

  return CONTEXT_1M_NATIVE_MODELS.some(
    (supported) => normalizedModel === supported || normalizedModel.startsWith(`${supported}-`)
  );
}
