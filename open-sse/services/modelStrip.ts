import { PROVIDER_ID_TO_ALIAS, getModelStripTypes } from "../config/providerModels.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function shouldStripPart(part: JsonRecord, stripTypes: Set<string>): boolean {
  const type = typeof part.type === "string" ? part.type : "";
  if (!type) return false;

  if (stripTypes.has(type)) return true;
  if (stripTypes.has("image") && (type === "image_url" || type === "image")) return true;
  if (stripTypes.has("audio") && (type === "input_audio" || type === "audio")) return true;
  return false;
}

/**
 * The content kinds of the request that the model's `strip` list says it cannot take, in the
 * order first met ("image", "audio" or the part type itself). The caller refuses the request
 * by name: content is never dropped silently, so a model never answers a question it was not
 * shown in full.
 */
export function findUnsupportedContentKinds(
  messages: unknown,
  stripTypes: readonly string[]
): string[] {
  if (!Array.isArray(messages) || stripTypes.length === 0) return [];
  const stripSet = new Set(stripTypes);
  const kinds: string[] = [];
  for (const message of messages) {
    const content = asRecord(message).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const record = asRecord(part);
      if (!shouldStripPart(record, stripSet)) continue;
      const type = String(record.type);
      const kind =
        type === "image_url" || type === "image"
          ? "image"
          : type === "input_audio" || type === "audio"
            ? "audio"
            : type;
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }
  return kinds;
}

/** The plain error for a request whose content the model cannot take. */
export function unsupportedContentMessage(model: string, kinds: readonly string[]): string {
  return `Model ${model} does not accept ${kinds.join(" or ")} content, and this request has it. Remove it or choose another model.`;
}

export function getStripTypesForProviderModel(providerId: string, modelId: string): string[] {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return getModelStripTypes(alias, modelId);
}
