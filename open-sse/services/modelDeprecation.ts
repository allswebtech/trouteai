/**
 * Model Deprecation Auto-Forward — Feature 2
 *
 * Maps other spellings of a model to the id the provider uses, and (only when the user turns it
 * on) retired model ids to their successors.
 *
 * Supports both built-in aliases (static) and custom aliases (persisted via Settings API).
 */

// ── Built-in aliases ────────────────────────────────────────────────────────
// Two kinds, kept apart on purpose:
//
// SPELLINGS name the SAME model another way (a provider's own path, a short name for the
// provider's id, a dated id for its bare id). They are not a swap and always apply.
//
// SUCCESSORS answer a retired or older model's name with a DIFFERENT, newer model. That is a
// swap, so they apply only when the user turned on "answer retired model names with their
// successor" (setting `answerRetiredModelsWithSuccessor`). Off, the name goes to the provider as
// sent and the client gets the provider's real answer.
const BUILT_IN_SPELLINGS: Record<string, string> = {
  // OpenAI: the dated snapshot the bare name points to
  "gpt-3.5-turbo-0125": "gpt-3.5-turbo",

  // Kimi/Moonshot: Fireworks long-path and short names of the same models
  "accounts/fireworks/models/kimi-k2p5": "moonshotai/Kimi-K2.5",
  "fireworks/accounts/fireworks/models/kimi-k2p5": "moonshotai/Kimi-K2.5",
  "kimi-k2p5": "moonshotai/Kimi-K2.5",
  "accounts/fireworks/models/kimi-k2": "moonshotai/Kimi-K2",
  "fireworks/accounts/fireworks/models/kimi-k2": "moonshotai/Kimi-K2",
  "kimi-k2": "moonshotai/Kimi-K2",

  // Mistral short names for the provider's own "latest" ids
  "mistral-large": "mistral-large-latest",
  "mistral-small": "mistral-small-latest",
  codestral: "codestral-latest",

  // Llama short names for the provider ids of the same models
  "llama-3.3": "llama-3.3-70b-versatile",
  "llama-3-8b": "llama3-8b-8192",
};

const BUILT_IN_SUCCESSORS: Record<string, string> = {
  // Gemini legacy → current
  "gemini-pro": "gemini-2.5-pro",
  "gemini-pro-vision": "gemini-2.5-pro",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.0-pro": "gemini-2.5-pro",
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
  // a preview answered by the released model: not guaranteed to be the same weights
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
  "gemini-3-pro-high": "gemini-3.1-pro-high",
  "gemini-3-pro-low": "gemini-3.1-pro-low",
  // Retired free Gemma (was in the gemini-free pool) → current gemini-free model
  "gemma-4": "gemini-3.1-flash-lite",

  // Claude legacy → current
  "claude-3-opus-20240229": "claude-opus-4-20250514",
  "claude-3-sonnet-20240229": "claude-sonnet-4-20250514",
  "claude-3-haiku-20240307": "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-20250514",
  "claude-3-5-haiku-latest": "claude-3-5-sonnet-20241022",

  // OpenAI legacy → current (the preview snapshots are other models than gpt-4-turbo)
  "gpt-4-turbo-preview": "gpt-4-turbo",
  "gpt-4-0125-preview": "gpt-4-turbo",
  "gpt-4-1106-preview": "gpt-4-turbo",

  // codestral-2405 was retired; its successor is a newer release
  "codestral-2405": "codestral-2508",

  // Llama 3 70B answered by Llama 3.3 70B
  "llama-3-70b": "llama-3.3-70b-versatile",
};

// The switch lives on globalThis for the same reason as the custom aliases below: Next.js builds
// separate module graphs for the boot hook and the routes, and both must see one value.
const SUCCESSORS_GLOBAL_KEY = "__trouteai_retiredModelSuccessors__";
const _successorStore = globalThis as unknown as Record<string, boolean | undefined>;

/** Set from the stored setting `answerRetiredModelsWithSuccessor` (off when never stored). */
export function setRetiredModelSuccessorsEnabled(enabled: boolean): void {
  _successorStore[SUCCESSORS_GLOBAL_KEY] = enabled === true;
}

export function isRetiredModelSuccessorsEnabled(): boolean {
  return _successorStore[SUCCESSORS_GLOBAL_KEY] === true;
}

function activeBuiltInAliases(): Record<string, string> {
  return isRetiredModelSuccessorsEnabled()
    ? { ...BUILT_IN_SPELLINGS, ...BUILT_IN_SUCCESSORS }
    : { ...BUILT_IN_SPELLINGS };
}

// ── Custom Aliases (persisted via Settings API) ─────────────────────────────
//
// Backed by globalThis so the singleton store is shared across the SEPARATE webpack
// module graphs Next.js builds for `instrumentation.ts` (boot-time hydration via
// applyRuntimeSettings → setCustomAliases) and the app-route `GET /api/settings/model-aliases`.
// A plain module-level `let` is DUPLICATED per graph, so startup hydration lands on the
// instrumentation graph's copy while the API route reads an empty copy — the exact
// symptom once patched at the route layer. Migrating the store to globalThis fixes the
// root cause (both instances read/write one store), mirroring the pattern already
// applied to thinkingBudget.ts and backgroundTaskDetector.ts (and systemPrompt.ts).
const CUSTOM_ALIASES_GLOBAL_KEY = "__trouteai_customAliases__";
const _aliasStore = globalThis as unknown as Record<string, Record<string, string> | undefined>;

function customAliases(): Record<string, string> {
  if (!_aliasStore[CUSTOM_ALIASES_GLOBAL_KEY]) {
    _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY] = {};
  }
  return _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY]!;
}

/**
 * Set custom aliases (called from settings API or startup).
 */
export function setCustomAliases(aliases: Record<string, string>): void {
  _aliasStore[CUSTOM_ALIASES_GLOBAL_KEY] = { ...aliases };
}

/**
 * Get current custom aliases.
 */
export function getCustomAliases(): Record<string, string> {
  return { ...customAliases() };
}

/**
 * Get the full alias map (built-in + custom).
 * Custom aliases take precedence over built-in.
 */
export function getAllAliases(): Record<string, string> {
  return { ...activeBuiltInAliases(), ...customAliases() };
}

/**
 * Resolve a model alias to its current ID.
 * Custom aliases override built-in ones.
 *
 * @param {string} modelId - The model ID to resolve
 * @returns {string} The resolved model ID, or the original if not deprecated
 */
export function resolveModelAlias(modelId: string): string {
  return resolveModelAliasWithKind(modelId).model;
}

export type ModelAliasKind = "custom" | "successor" | "spelling" | null;

/**
 * Resolve an alias and say which kind answered: the user's own (`custom`), a built-in successor
 * (a different model, only when switched on), or a built-in spelling of the same model.
 */
export function resolveModelAliasWithKind(modelId: string): {
  model: string;
  kind: ModelAliasKind;
} {
  if (!modelId) return { model: modelId, kind: null };

  // Check custom aliases first (higher priority)
  const custom = customAliases();
  if (custom[modelId]) return { model: custom[modelId], kind: "custom" };

  if (Object.prototype.hasOwnProperty.call(BUILT_IN_SPELLINGS, modelId)) {
    return { model: BUILT_IN_SPELLINGS[modelId], kind: "spelling" };
  }
  if (
    isRetiredModelSuccessorsEnabled() &&
    Object.prototype.hasOwnProperty.call(BUILT_IN_SUCCESSORS, modelId)
  ) {
    return { model: BUILT_IN_SUCCESSORS[modelId], kind: "successor" };
  }

  return { model: modelId, kind: null };
}

/**
 * Get a deprecation notice if the model is deprecated.
 *
 * @param {string} modelId - The model ID to check
 * @returns {string | null} Deprecation message or null if not deprecated
 */
export function getDeprecationNotice(modelId: string): string | null {
  if (!modelId) return null;

  const resolved = resolveModelAlias(modelId);
  if (resolved === modelId) return null;

  return `Model "${modelId}" is deprecated. Forwarding to "${resolved}".`;
}

/**
 * Check if a model is deprecated.
 */
export function isDeprecated(modelId: string): boolean {
  return getDeprecationNotice(modelId) !== null;
}

/**
 * Add a custom alias.
 */
export function addCustomAlias(from: string, to: string): void {
  customAliases()[from] = to;
}

/**
 * Remove a custom alias.
 */
export function removeCustomAlias(from: string): boolean {
  const custom = customAliases();
  if (custom[from]) {
    delete custom[from];
    return true;
  }
  return false;
}

/**
 * Get the built-in aliases (read-only reference).
 */
export function getBuiltInAliases(): Record<string, string> {
  return activeBuiltInAliases();
}

/** The built-in successor entries, whether or not they are switched on. */
export function getBuiltInSuccessorAliases(): Record<string, string> {
  return { ...BUILT_IN_SUCCESSORS };
}
