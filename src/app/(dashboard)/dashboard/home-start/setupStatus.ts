// Data for the Home "Get started" checklist and "Connect your app" card. Uses the existing
// management API only (GET /api/combos -> { combos, total }, GET /api/keys -> { keys, total }).

export type HomeSetupStatus = {
  comboCount: number;
  keyCount: number;
  /** Name of the first combo (prefers a visible one), used in the curl example. */
  comboName: string | null;
};

export const EMPTY_SETUP_STATUS: HomeSetupStatus = { comboCount: 0, keyCount: 0, comboName: null };

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
  const [combosData, keysData] = await Promise.all([
    fetch("/api/combos?limit=50").then(readJson, () => null),
    fetch("/api/keys?limit=1").then(readJson, () => null),
  ]);

  const combos = Array.isArray(combosData?.combos) ? (combosData.combos as JsonRecord[]) : [];
  const keys = Array.isArray(keysData?.keys) ? keysData.keys : [];
  const named = combos.filter((combo) => typeof combo?.name === "string" && combo.name !== "");
  const firstCombo = named.find((combo) => !combo.isHidden) ?? named[0];

  return {
    comboCount: countFrom(combosData?.total, combos.length),
    keyCount: countFrom(keysData?.total, keys.length),
    comboName: firstCombo ? (firstCombo.name as string) : null,
  };
}
