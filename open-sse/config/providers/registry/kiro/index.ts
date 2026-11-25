import type { RegistryEntry } from "../../shared.ts";
import { getKiroServiceHeaders } from "../../shared.ts";

export const kiroProvider: RegistryEntry = {
  id: "kiro",
  alias: "kr",
  format: "kiro",
  executor: "kiro",
  baseUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  authType: "oauth",
  authHeader: "bearer",
  defaultContextLength: 200000,
  headers: getKiroServiceHeaders(),
  oauth: {
    tokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    authUrl: "https://prod.us-east-1.auth.desktop.kiro.dev",
  },
  // Model IDs must match Kiro's real upstream catalog exactly — an unknown id
  // makes Kiro return `400 "Invalid model. Please select a different model"`.
  // Fabricated ids (auto-kiro, claude-opus-4.x, claude-fable-5, claude-sonnet-4.6)
  // were removed after live validation: its Sonnet is 4.5 (not 4.6), and there is
  // no "auto" model id (it was sent verbatim and 400'd). claude-sonnet-5 is a real
  // Kiro model but plan-gated per account — kept so entitled accounts can use it.
  // Opus 5 / 5.5 come from Kiro's live catalog (not static entries here); they and
  // claude-sonnet-5 accept the adaptive-thinking envelope (adaptiveThinking.ts).
  models: [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsVision: true,
    },
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsVision: true,
    },
    {
      id: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsVision: true,
    },
    // Text-only models: Kiro's model list declares only TEXT input for them, so an image request
    // is refused by name instead of reaching a model that cannot see it. Their limits and
    // capabilities are the ones models.dev lists for the same models on Amazon Bedrock, which
    // serves Kiro; the native vendor APIs give other numbers, so they are set here.
    {
      id: "deepseek-3.2",
      name: "DeepSeek V3.2",
      contextLength: 163840,
      maxOutputTokens: 81920,
      toolCalling: true,
      supportsReasoning: true,
      supportsVision: false,
    },
    {
      id: "minimax-m2.5",
      name: "MiniMax M2.5",
      contextLength: 196608,
      maxOutputTokens: 98304,
      toolCalling: true,
      supportsReasoning: true,
      supportsVision: false,
    },
    {
      id: "minimax-m2.1",
      name: "MiniMax M2.1",
      contextLength: 196608,
      maxOutputTokens: 131072,
      toolCalling: true,
      supportsReasoning: true,
      supportsVision: false,
    },
    {
      id: "glm-5",
      name: "GLM-5",
      contextLength: 202752,
      maxOutputTokens: 131072,
      toolCalling: true,
      supportsReasoning: true,
      supportsVision: false,
    },
    {
      id: "qwen3-coder-next",
      name: "Qwen3 Coder Next",
      contextLength: 262144,
      maxOutputTokens: 65536,
      toolCalling: true,
      supportsReasoning: false,
      supportsVision: false,
    },
    // Kiro's first OpenAI-family models (kiro.dev/changelog/models, 2026-07-14):
    // three tiers — Sol (flagship), Terra (balanced mid-tier), Luna (fastest/
    // cheapest). They started with a 272k context window; Kiro raised all three to
    // 1M (kiro.dev/changelog/models/gpt-5-6-1m-context-window).
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsVision: true,
    },
    {
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      contextLength: 1000000,
      maxOutputTokens: 128000,
      supportsVision: true,
    },
  ],
};
