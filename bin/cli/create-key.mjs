// `trouteai key create NAME`: make an API key without the dashboard and print it once.
//
// The key is made by the running TRouteAI itself, through the same route the dashboard uses
// (POST /api/keys), so it gets the same validation, storage and backup. The command proves who
// it is with the command token, a random secret the server keeps in DATA_DIR/cli-token that only
// the owner of the data folder can read (scripts/dev/cli-token-file.mjs). The server accepts it
// only from this computer and not through a proxy (src/lib/cliToken.ts). Nothing is written to
// the database from here, so the command never races the server or an unmigrated schema.
import path from "node:path";

import { normalizeBasePath } from "../../scripts/build/normalizeBasePath.mjs";
import { parseEnvFile } from "../../scripts/build/sync-env.mjs";
import {
  cliTokenFileExists,
  cliTokenPath,
  readCliToken,
} from "../../scripts/dev/cli-token-file.mjs";
import { resolveListenHosts } from "../../scripts/dev/listen-hosts.mjs";

const DEFAULT_PORT = 20017;
const CLI_TOKEN_HEADER = "x-trouteai-cli-token";

function fail(message) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

function parsePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function setting(fileValues, key) {
  return process.env[key]?.trim() || fileValues.get(key)?.trim() || "";
}

export async function createKeyCommand(dataDir, rawName, portOption) {
  const name = String(rawName ?? "").trim();
  if (!name) fail('Usage: trouteai key create NAME   (example: trouteai key create "my laptop")');
  if (name.length > 200) fail("The name can have at most 200 characters.");
  if (/[\r\n]/.test(name)) fail("The name cannot contain line breaks.");

  let fileValues = new Map();
  try {
    fileValues = parseEnvFile(path.join(dataDir, ".env"));
  } catch {}
  const portText =
    String(portOption ?? "").trim() ||
    setting(fileValues, "DASHBOARD_PORT") ||
    setting(fileValues, "PORT");
  const port = portText ? parsePort(portText) : DEFAULT_PORT;
  if (!port) fail(`Invalid PORT "${portText}". Use a number from 1 to 65535.`);

  const listen = resolveListenHosts(setting(fileValues, "HOST"));
  if (!listen.loopbackOnly && !listen.everyInterface) {
    fail(
      `TRouteAI listens only on ${listen.primary}, not on this computer's loopback address.\n` +
        "    Create the key in the dashboard, or let TRouteAI listen on 127.0.0.1 too."
    );
  }
  const host = listen.everyInterface ? "127.0.0.1" : listen.primary;
  const hostInUrl = host.includes(":") ? `[${host}]` : host;
  const basePath = normalizeBasePath(setting(fileValues, "TROUTEAI_BASE_PATH"));
  const base = `http://${hostInUrl}:${port}${basePath}`;

  const token = readCliToken(dataDir);
  if (!token) {
    const file = cliTokenPath(dataDir);
    fail(
      (cliTokenFileExists(dataDir)
        ? `The command token ${file} cannot be used (it must be readable by you and nobody else).\n`
        : `There is no command token in ${dataDir}.\n`) +
        "    TRouteAI creates it when it starts. Start TRouteAI as the same user with the same data folder\n" +
        "    (--data-dir or DATA_DIR), then run this command again."
    );
  }

  let response;
  try {
    response = await fetch(`${base}/api/keys`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", [CLI_TOKEN_HEADER]: token },
      body: JSON.stringify({ name }),
    });
  } catch {
    fail(
      `TRouteAI is not running at ${base} (data folder ${dataDir}).\n` +
        "    Start it first (trouteai), then run this command again."
    );
  }

  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (response.status === 401 || response.status === 403) {
    fail(
      "TRouteAI refused the command (HTTP " +
        response.status +
        "). It accepts the command only from this computer, from the user who started it with\n" +
        `    the same data folder (${dataDir}), and not when TROUTEAI_DISABLE_CLI_TOKEN=true.\n` +
        "    Create the key in the dashboard instead (API Keys)."
    );
  }
  if (response.status !== 201 || typeof body?.key !== "string") {
    const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
    fail(
      `TRouteAI could not create the key (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`
    );
  }

  // The key alone on stdout, so a script can read it; the note goes to stderr.
  process.stderr.write(
    `\n  Key "${body.name}" created. It is shown only now: copy it to your app.\n\n`
  );
  process.stdout.write(`${body.key}\n`);
}
