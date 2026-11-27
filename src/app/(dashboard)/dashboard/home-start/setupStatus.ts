import type { ListedModel } from "./homeConnect";

// Data for the Home "Connect a coding tool" card. Uses the existing API only (GET /api/combos,
// GET /api/keys, GET /v1/models).

export type HomeSetupStatus = {
  comboCount: number;
  keyCount: number;
  /** Name of the first combo (prefers a visible one), used as the model to copy. */
  comboName: string | null;
  /** What the gateway lists at /v1/models (what can be served now). */
  listed: ListedModel[];
};

export const EMPTY_SETUP_STATUS: HomeSetupStatus = { comboCount: 0, keyCount: 0,
  comboName: null,
  listed: [],
};

type JsonRecord = Record<string, unknown>;

async function readJson(res: Response): Promise<JsonRecord | null> {
  if (!res.ok) return null;
  try {
    const data: unknown = await res.json();
    return data && typeof data === "object" ? (data as JsonRecord) : null;
  } catch {
    return null;
  }
}

function countFrom(total: unknown, fallback: number): number {
  return typeof total === "number" && Number.isFinite(total) ? total : fallback;
}

/** Loads combo and API key counts. Never throws: a failed request counts as 0. */
export async function fetchHomeSetupStatus(): Promise<HomeSetupStatus> {
  const [combosData, keysData, listData] = await Promise.all([
    fetch("/api/combos?limit=50").then(readJson, () => null),
    fetch("/api/keys?limit=1").then(readJson, () => null),
    fetch("/v1/models").then(readJson, () => null),
  ]);
  const listed: ListedModel[] = (
    Array.isArray(listData?.data) ? (listData.data as JsonRecord[]) : []
  ).flatMap((m) =>
    typeof m?.id === "string" && typeof m?.owned_by === "string"
      ? [{ id: m.id, ownedBy: m.owned_by }]
      : []
  );

  const combos = Array.isArray(combosData?.combos) ? (combosData.combos as JsonRecord[]) : [];
  const keys = Array.isArray(keysData?.keys) ? keysData.keys : [];
  const named = combos.filter((combo) => typeof combo?.name === "string" && combo.name !== "");
  const firstCombo = named.find((combo) => !combo.isHidden) ?? named[0];

  return {
    comboCount: countFrom(combosData?.total, combos.length),
    keyCount: countFrom(keysData?.total, keys.length),
    comboName: firstCombo ? (firstCombo.name as string) : null,
    listed,
  };
}
