// Re-exported here (rather than a separate import line in chat.ts, which
// should stay small) so both
// combo-failure-handling helpers chat.ts needs share a single import line.
export { isRequestScopedUpstreamFailure } from "@trouteai/open-sse/services/combo/comboPredicates.ts";

export async function getComboFailureLogError(
  response: Response,
  comboName: string
): Promise<string> {
  const fallback = `[${response.status}] Combo "${comboName}" failed`;
  try {
    const body = await response.clone().json();
    const message = body?.error?.message;
    return typeof message === "string" && message.trim()
      ? `[${response.status}] ${message.trim()}`
      : fallback;
  } catch {
    return fallback;
  }
}
