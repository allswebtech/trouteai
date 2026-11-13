export type SkillHandler = (
  input: Record<string, unknown>,
  // provider/model: only the web_fetch builtin uses them to resolve a per-model fetch backend.
  context: { apiKeyId: string; sessionId: string; provider?: string; model?: string }
) => Promise<Record<string, unknown>>;
