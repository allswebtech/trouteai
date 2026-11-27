// Pure helpers for the Home "Connect a coding tool" card.
import { isProviderConnectionErrored } from "@/shared/utils/providerConnectionStatus";

/** Name of the key that Make a key creates on Home. */
export const CODING_TOOL_KEY_NAME = "Coding tool";

export type ListedModel = { id: string; ownedBy: string };

/**
 * The model name to copy: the first visible combo's name, else the first provider/model of
 * the first account that has one. `listed` is what GET /v1/models serves now (only names that
 * work); it also holds ready-made combos and providers that need no account, so a name counts
 * only when it belongs to one of the person's accounts. Null when there is nothing to copy.
 */
export function pickHomeModel(
  comboName: string | null,
  connections: Array<{ provider?: string }>,
  listed: ListedModel[]
): string | null {
  if (comboName) return comboName;
  for (const connection of connections) {
    if (!connection.provider) continue;
    const model = listed.find((m) => m.ownedBy === connection.provider && m.id.includes("/"));
    if (model) return model.id;
  }
  return null;
}

/** How many accounts are failing (switched-off accounts do not count). */
export function countNeedsAttention(
  connections: Array<{ isActive?: boolean | null; testStatus?: string | null }>
): number {
  return connections.filter((connection) => isProviderConnectionErrored(connection)).length;
}
