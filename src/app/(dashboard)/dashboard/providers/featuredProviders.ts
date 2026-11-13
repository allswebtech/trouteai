import { AI_PROVIDERS } from "@/shared/constants/providers";

/**
 * Presentation-only provider lists for the providers dashboard
 * (`/dashboard/providers`) and the onboarding wizard (`/dashboard/providers/new`).
 *
 * Scope guard: this is a UI ordering concern ONLY. It must never be imported by
 * routing/fallback code (`open-sse/config/providerRegistry.ts`,
 * `open-sse/config/providers/*`) — the order defined here has zero effect on
 * combo routing, Auto-Combo scoring, or fallback/account selection.
 */

/**
 * "Popular providers", in display order. Shown as the quick-start grid at the top
 * of the providers page and listed first in the onboarding wizard.
 *
 * Ids must match `AI_PROVIDERS` keys exactly: Google is "gemini" and local Ollama
 * is "ollama-local" (alias "ollama"). `getPopularProviderIds()` drops any id that
 * is missing from the catalog, so a removed provider can never render a broken card.
 */
export const POPULAR_PROVIDER_IDS: readonly string[] = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "deepseek",
  "groq",
  "mistral",
  "xai",
  "together",
  "fireworks",
  "perplexity",
  "ollama-local",
];

/**
 * One-line, plain-language description per popular provider: an i18n key in the
 * "providers" namespace plus the English fallback used until it is translated.
 */
export const POPULAR_PROVIDER_DESCRIPTIONS: Readonly<
  Record<string, { key: string; fallback: string }>
> = {
  openai: {
    key: "popularDescOpenai",
    fallback: "The makers of ChatGPT. GPT models for chat, images and voice.",
  },
  anthropic: {
    key: "popularDescAnthropic",
    fallback: "The makers of Claude. Great for writing, coding and long documents.",
  },
  gemini: {
    key: "popularDescGemini",
    fallback: "Google's Gemini models. Has a free tier to get started.",
  },
  openrouter: {
    key: "popularDescOpenrouter",
    fallback: "One API key for hundreds of models from many companies.",
  },
  deepseek: {
    key: "popularDescDeepseek",
    fallback: "Low-cost models that are good at reasoning and code.",
  },
  groq: {
    key: "popularDescGroq",
    fallback: "Very fast answers from open models like Llama.",
  },
  mistral: {
    key: "popularDescMistral",
    fallback: "Fast, efficient models from a European AI lab.",
  },
  xai: {
    key: "popularDescXai",
    fallback: "Grok models from xAI.",
  },
  together: {
    key: "popularDescTogether",
    fallback: "Run popular open-source models in the cloud.",
  },
  fireworks: {
    key: "popularDescFireworks",
    fallback: "Fast cloud hosting for open-source models.",
  },
  perplexity: {
    key: "popularDescPerplexity",
    fallback: "Answers that search the web as they go.",
  },
  "ollama-local": {
    key: "popularDescOllama",
    fallback: "Run models on your own computer. No API key needed.",
  },
};

/** Popular provider ids that exist in the provider catalog, in display order. */
export function getPopularProviderIds(): string[] {
  return POPULAR_PROVIDER_IDS.filter((id) => id in AI_PROVIDERS);
}

const POPULAR_PROVIDER_RANK: ReadonlyMap<string, number> = new Map(
  POPULAR_PROVIDER_IDS.map((id, index) => [id, index])
);

/** Display position of a popular provider (0 = first), or -1 when it is not popular. */
export function getPopularProviderRank(providerId: string | null | undefined): number {
  if (typeof providerId !== "string") return -1;
  return POPULAR_PROVIDER_RANK.get(providerId) ?? -1;
}
