// Pure helpers for the Home "Connect a coding tool" card.
import { isProviderConnectionErrored } from "@/shared/utils/providerConnectionStatus";

/** Name of the key that Make a key creates on Home. */
export const CODING_TOOL_KEY_NAME = "Coding tool";

/**
 * The model name to copy: the first visible combo's name, else the first provider/model the
 * gateway lists that is not a combo (the list is what GET /v1/models serves now, so it holds
 * only names that work). Null when there is nothing to copy yet.
 */
export function pickHomeModel(
  comboName: string | null,
  listedIds: string[],
  comboNames: string[]
): string | null {
  if (comboName) return comboName;
  const combos = new Set(comboNames);
  return listedIds.find((id) => id.includes("/") && !combos.has(id)) ?? null;
}

/** How many accounts are failing (switched-off accounts do not count). */
export function countNeedsAttention(
  connections: Array<{ isActive?: boolean | null; testStatus?: string | null }>
): number {
  return connections.filter((connection) => isProviderConnectionErrored(connection)).length;
}
