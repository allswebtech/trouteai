// Pure helpers for the Home "Connect a coding tool" card.
import { isProviderConnectionErrored } from "@/shared/utils/providerConnectionStatus";

/** Name of the key that Make a key creates on Home. */
export const CODING_TOOL_KEY_NAME = "Coding tool";

type ModelLike = { provider?: string; fullModel?: string };

/**
 * The model name to copy: the first visible combo's name, else provider/model of the first
 * model of the first account that has one. Null when there is nothing to copy yet.
 * `aliases` maps a provider id to the short id its models are listed under.
 */
export function pickHomeModel(
  comboName: string | null,
  connections: Array<{ provider?: string }>,
  models: ModelLike[],
  aliases: Record<string, string | undefined>
): string | null {
  if (comboName) return comboName;
  for (const connection of connections) {
    const id = connection.provider;
    if (!id) continue;
    const keys = new Set([id, aliases[id]].filter(Boolean));
    const model = models.find((m) => m.provider && keys.has(m.provider) && m.fullModel);
    if (model?.fullModel) return model.fullModel;
  }
  return null;
}

/** How many accounts are failing (switched-off accounts do not count). */
export function countNeedsAttention(
  connections: Array<{ isActive?: boolean | null; testStatus?: string | null }>
): number {
  return connections.filter((connection) => isProviderConnectionErrored(connection)).length;
}
