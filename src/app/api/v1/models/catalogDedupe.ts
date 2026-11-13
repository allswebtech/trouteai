/**
 * Final exact-duplicate-id guard for `GET /v1/models`.
 *
 * OpenAI-compatible clients key models by `id`, so the same id appearing twice in the
 * `data` array breaks pickers and lookups. The catalog builder pushes entries from several
 * independent sources (static registry, synced provider models, combos, custom models,
 * specialty audio/video/moderation registries), each with its own local "already pushed?"
 * guard — so a model produced by two different sources can still slip through as an
 * exact-duplicate id.
 *
 * Historical bug: the guard keyed only by `(id, type, subtype)`. A generic untyped row
 * and a typed specialty row for the same public id therefore both survived (e.g.
 * `openai/whisper-1`, `veo-free/veo`). OpenAI-compatible clients still key only by `id`.
 *
 * Rules:
 * - keep the first entry per listing identity `(id, type, subtype)`
 * - when a non-chat specialty row exists for an id, drop untyped/generic chat siblings
 * - preserve intentional multi-surface pairs (audio transcription vs speech)
 * - never mutate account/connection/credential fields (this pass only drops whole rows)
 *
 * Pure (no DB / no I/O). Order-preserving. Independent of MODELS_CATALOG_PREFIX_MODE.
 */

interface CatalogModelEntry {
  id?: unknown;
  type?: unknown;
  subtype?: unknown;
  [key: string]: unknown;
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

const isNonChatSpecialtyType = (type: string): boolean => {
  if (!type || type === "chat") return false;
  return true;
};

const isGenericChatLike = (model: CatalogModelEntry): boolean => {
  const type = asStr(model.type);
  return !type || type === "chat";
};

const listingKey = (model: CatalogModelEntry): string =>
  `${model.id as string}\u0000${asStr(model.type)}\u0000${asStr(model.subtype)}`;

/**
 * Drop exact duplicate listing identities, and suppress false generic chat siblings
 * when a typed non-chat specialty row exists for the same public id.
 */
export function dedupeExactCatalogIds<T extends CatalogModelEntry>(models: T[]): T[] {
  if (!Array.isArray(models) || models.length < 2) return models;

  const specialtyIds = new Set<string>();
  for (const model of models) {
    if (typeof model?.id !== "string" || model.id.length === 0) continue;
    if (isNonChatSpecialtyType(asStr(model.type))) {
      specialtyIds.add(model.id);
    }
  }

  const seen = new Set<string>();
  const out: T[] = [];
  for (const model of models) {
    if (typeof model?.id !== "string" || model.id.length === 0) {
      out.push(model);
      continue;
    }

    // False generic/chat sibling of a typed specialty model — drop.
    if (specialtyIds.has(model.id) && isGenericChatLike(model)) {
      continue;
    }

    const key = listingKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}
