// Adds a Kiro OAuth connection with a FAKE token to the temporary data folder used by
// tests/smoke/kiro-mock.sh (DATA_DIR and STORAGE_ENCRYPTION_KEY come from that script).
// Prints "CONN_ID=<id>" as the last line.
//
// KIRO_SEED_ACCOUNTS=1: two more fake accounts and a round-robin combo "kiro-accounts" that
// names each account as its own step, the first one "limited" (mock-kiro.mjs answers its
// token with 402 MONTHLY_REQUEST_COUNT, like an account at its monthly limit).
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createCombo } from "../../src/lib/db/combos.ts";

const info = (msg: string) => process.stderr.write(`${msg}\n`);

const expiresAt = new Date(Date.now() + 50 * 60 * 1000).toISOString();
const providerSpecificData: Record<string, unknown> = { authMethod: "idc", region: "us-east-1" };

const connection = (await createProviderConnection({
  provider: "kiro",
  authType: "oauth",
  name: "kiro-test",
  accessToken: "trouteai-fake-kiro-token",
  refreshToken: null,
  expiresAt,
  providerSpecificData,
  testStatus: "active",
  isActive: true,
})) as { id: string };

if (process.env.KIRO_SEED_ACCOUNTS === "1") {
  const ids: string[] = [];
  for (const name of ["limited", "second"]) {
    const c = (await createProviderConnection({
      provider: "kiro",
      authType: "oauth",
      name: `kiro-${name}`,
      accessToken: `trouteai-fake-kiro-token-${name}`,
      refreshToken: null,
      expiresAt,
      providerSpecificData,
      testStatus: "active",
      isActive: true,
    })) as { id: string };
    ids.push(c.id);
  }
  await createCombo({
    name: "kiro-accounts",
    strategy: "round-robin",
    models: ids.map((id, i) => ({
      id: `kiro-accounts-${i}`,
      kind: "model",
      model: "kiro/claude-sonnet-5",
      providerId: "kiro",
      connectionId: id,
      weight: 0,
    })),
  });
  info("seeded 2 pinned accounts and the combo kiro-accounts");
  // Image routing (vision-e2e.mjs): a text-only model first, then one that sees; and a combo of
  // text-only models only.
  const step = (model: string, i: number, combo: string) => ({
    id: `${combo}-${i}`,
    kind: "model",
    model,
    providerId: "kiro",
    weight: 0,
  });
  for (const [name, models] of [
    ["vision-mixed", ["kiro/deepseek-3.2", "kiro/claude-sonnet-5"]],
    ["vision-blind", ["kiro/deepseek-3.2", "kiro/glm-5"]],
  ] as const) {
    await createCombo({
      name,
      strategy: "priority",
      models: models.map((m, i) => step(m, i, name)),
    });
  }
}

console.log(`CONN_ID=${connection.id}`);
