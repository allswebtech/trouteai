// Adds a few FAKE provider connections and API keys to the temporary data folder of an idle
// test (DATA_DIR and STORAGE_ENCRYPTION_KEY come from the calling script). The kinds are the
// ones background jobs act on: OAuth accounts with a refresh token, API-key providers, and an
// OpenRouter connection (its model catalog is fetched at start). Nothing here is a real account.
//
// IDLE_SEED_EXPIRING=1: one more Kiro account, never used, whose sign-in expires in 3 minutes
// (an idle server must not renew it). IDLE_SEED_PROXY=1: a proxy on a host that does not exist
// (the proxy health check would test it through the network).
// IDLE_SEED_ONLY=kiro,openai seeds only those providers (to find which one a cost belongs to).
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { createProxy } from "../../src/lib/db/proxies.ts";

const inMinutes = (m: number) => new Date(Date.now() + m * 60 * 1000).toISOString();

const connections = [
  {
    provider: "kiro",
    authType: "oauth",
    name: "idle-kiro",
    accessToken: "trouteai-fake-kiro-access",
    refreshToken: "trouteai-fake-kiro-refresh",
    expiresAt: inMinutes(50),
    providerSpecificData: { authMethod: "idc", region: "us-east-1" },
  },
  {
    provider: "claude",
    authType: "oauth",
    name: "idle-claude",
    accessToken: "trouteai-fake-claude-access",
    refreshToken: "trouteai-fake-claude-refresh",
    expiresAt: inMinutes(50),
  },
  { provider: "openai", authType: "apikey", name: "idle-openai", apiKey: "sk-trouteai-fake-openai" },
  {
    provider: "openrouter",
    authType: "apikey",
    name: "idle-openrouter",
    apiKey: "sk-or-trouteai-fake",
  },
];
if (process.env.IDLE_SEED_EXPIRING === "1") {
  connections.push({
    provider: "kiro",
    authType: "oauth",
    name: "idle-kiro-expiring",
    accessToken: "trouteai-fake-kiro-access-2",
    refreshToken: "trouteai-fake-kiro-refresh-2",
    expiresAt: inMinutes(3),
    providerSpecificData: { authMethod: "idc", region: "us-east-1" },
  });
}

const only = (process.env.IDLE_SEED_ONLY || "").split(",").filter(Boolean);
for (const c of connections) {
  if (only.length > 0 && !only.includes(c.provider)) continue;
  await createProviderConnection({ ...c, testStatus: "active", isActive: true });
}
for (const name of ["idle-key-1", "idle-key-2"]) {
  await createApiKey(name, "trouteai-idle-test-machine");
}
if (process.env.IDLE_SEED_PROXY === "1") {
  await createProxy({ name: "idle-proxy", type: "http", host: "proxy.trouteai.invalid", port: 8080 });
}
console.log(`SEEDED=${connections.length}`);
