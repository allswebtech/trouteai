#!/usr/bin/env node
// Postinstall (best-effort, never fails the install):
//   1. Re-fetch the tls-client-node native binary if its own postinstall was skipped
//      (used by the chatgpt-web / claude-web / grok-web / perplexity-web providers).
//   2. Recreate the `.build/next/node_modules` links of the prebuilt npm package
//      (npm does not pack symlinks; see buildExternals.mjs).
//   3. Source checkout only: create `.env` from `.env.example` on first install (with
//      generated secrets). Skipped for `npm install -g trouteai`, whose settings live in
//      DATA_DIR/.env (default ~/.trouteai/.env) and are created by the `trouteai` command.
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureExternalLinks } from "./buildExternals.mjs";
import { fixTlsClientNodeBinary } from "./fixTlsClientNodeBinary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installedAsPackage =
  process.env.npm_config_global === "true" || ROOT.split(sep).includes("node_modules");

try {
  await fixTlsClientNodeBinary({ rootDir: ROOT });
} catch (err) {
  console.warn(`  ⚠  tls-client-node binary check skipped: ${err?.message || err}`);
}

try {
  const { failed } = ensureExternalLinks(ROOT);
  for (const message of failed) console.warn(`  ⚠  Could not link ${message}`);
} catch (err) {
  console.warn(`  ⚠  Build link check skipped: ${err?.message || err}`);
}

if (!installedAsPackage) {
  try {
    const { syncEnv } = await import("./sync-env.mjs");
    syncEnv({ rootDir: ROOT });
  } catch (err) {
    console.warn(`  ⚠  .env sync skipped: ${err?.message || err}`);
  }
}
