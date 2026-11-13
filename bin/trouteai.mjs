#!/usr/bin/env node
// TRouteAI command line (installed with `npm install -g trouteai`).
//   trouteai                        start TRouteAI (dashboard + API)
//   trouteai config                 show the settings file and its values
//   trouteai config set KEY VALUE   change a setting
//   trouteai reset-password         set a new dashboard password
//   trouteai update                 update to the latest version from npm
//   trouteai uninstall              remove TRouteAI (asks before deleting your data)
// Settings live in DATA_DIR/.env (default ~/.trouteai/.env). Priority: command-line
// options > environment variables > settings file > built-in defaults.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import util from "node:util";

import { getDefaultDataDir } from "./cli/data-dir.mjs";
import { ensureExternalLinks } from "../scripts/build/buildExternals.mjs";
import { envHasExplicitHeapFlag, resolveMaxOldSpaceMb } from "../scripts/build/runtime-env.mjs";
import { parseEnvFile } from "../scripts/build/sync-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const DEFAULT_PORT = 20017;
const DEFAULT_HOST = "0.0.0.0";
const RECOMMENDED_NODE_MAJOR = 26;
const SECRET_KEY = /PASSWORD|SECRET|TOKEN|PRIVATE|(^|_)KEY$/;

const SETTINGS_TEMPLATE = `# TRouteAI settings
# Change a value, save this file, then restart TRouteAI.
# Or use the command: trouteai config set KEY VALUE

# Port for the dashboard and the API (1-65535).
PORT=${DEFAULT_PORT}

# Who can connect: 0.0.0.0 = this computer and your network, 127.0.0.1 = only this computer.
HOST=${DEFAULT_HOST}

# Password for the first dashboard login (at least 8 characters).
# Empty = a random password is saved to initial-admin-password.txt in this folder.
# Later changes: dashboard Settings, or the command "trouteai reset-password".
INITIAL_PASSWORD=

# true = apps must send an API key created in the dashboard (recommended).
REQUIRE_API_KEY=true

# Your public address when TRouteAI runs behind a domain, for example https://ai.example.com
NEXT_PUBLIC_BASE_URL=

# ── Optional ─────────────────────────────────────────────────────────────────
# Always mark the login cookie as secure. HTTPS is usually detected automatically.
# AUTH_COOKIE_SECURE=true
# Credit line in the sidebar and on the login page. Empty = hidden.
# BRAND_CREDIT="Your credit line"
# BRAND_CREDIT_URL=https://your-website.example

# The terminal shows only warnings and errors. info or debug shows more (or: trouteai --verbose).
# APP_LOG_LEVEL=info

# Server memory limit in MB (default: 35% of RAM, 512 to 4096). Raise it if the log shows "JavaScript heap out of memory".
# TROUTEAI_MAX_HEAP_MB=1024

# Secret keys are created automatically in server.env (same folder). Keep both files private.
`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const red = paint("31");
const yellow = paint("33");

function fail(message) {
  console.error(`\n  ${red("✖")} ${message}\n`);
  process.exit(1);
}

function checkNodeVersion() {
  const [major, minor, patch] = process.versions.node.split(".").map((n) => Number(n) || 0);
  const tooOld = major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 2)));
  if (tooOld) {
    fail(
      `TRouteAI needs Node.js 22.22.2 or newer (Node.js ${RECOMMENDED_NODE_MAJOR} is recommended).\n` +
        `    This computer has Node.js ${process.versions.node}. Download: https://nodejs.org`
    );
  }
  if (major === RECOMMENDED_NODE_MAJOR) return null;
  if (major === 23 || major > RECOMMENDED_NODE_MAJOR) {
    return `Node.js ${process.versions.node} is not tested with TRouteAI. Node.js ${RECOMMENDED_NODE_MAJOR} is recommended.`;
  }
  return `Tip: Node.js ${RECOMMENDED_NODE_MAJOR} is recommended (this computer has ${process.versions.node}).`;
}

function printHelp() {
  console.log(`
${bold(`TRouteAI ${VERSION}`)} - self-hosted AI router

Usage:
  trouteai [options]               Start TRouteAI
  trouteai config                  Show your settings
  trouteai config set KEY VALUE    Change a setting ("" as VALUE clears it)
  trouteai reset-password          Set a new dashboard password
  trouteai update                  Update to the latest version
  trouteai uninstall               Remove TRouteAI (your data is kept unless you say yes)

Options:
  -p, --port <number>    Port for the dashboard and the API (default ${DEFAULT_PORT})
      --host <address>   Address to listen on (default ${DEFAULT_HOST} = this computer and your network)
      --data-dir <dir>   Folder for settings and data (default ~/.trouteai)
      --verbose          Show all log messages in the terminal (default: warnings and errors)
  -v, --version          Show the version
  -h, --help             Show this help

Settings file: <data folder>/.env
Command-line options win over environment variables, which win over the settings file.
Memory limit: TROUTEAI_MAX_HEAP_MB (default 35% of RAM, 512-4096 MB); raise it on "JavaScript heap out of memory".

Examples:
  trouteai --port 20018
  trouteai config set PORT 20018
  trouteai config set HOST 127.0.0.1

`);
}

function parseCli(argv) {
  return util.parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      "data-dir": { type: "string" },
      "password-stdin": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveDataDir(flagValue) {
  const configured = flagValue?.trim() || process.env.DATA_DIR?.trim();
  return configured ? path.resolve(expandHome(configured)) : getDefaultDataDir();
}

function parsePort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function ensureSettingsFile(settingsFile) {
  if (fs.existsSync(settingsFile)) return false;
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settingsFile, SETTINGS_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    fail(`Could not create the settings file ${settingsFile}: ${error.message}`);
  }
  return true;
}

/** Load the settings file into process.env without overriding real environment variables. */
function loadSettingsIntoEnv(settingsFile) {
  const values = parseEnvFile(settingsFile);
  for (const [key, value] of values) {
    if (key !== "DATA_DIR" && value !== "" && !process.env[key]) process.env[key] = value;
  }
  return values;
}

function displayHost(host) {
  if (["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host)) return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function probePort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve(error.code || "ERROR"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

function hasBuild() {
  return fs.existsSync(path.join(ROOT, ".build", "next", "BUILD_ID"));
}

async function startServer(options, dataDir, settingsFile, nodeNote) {
  // Some shells (csh/tcsh) export HOST as the machine name; that is not a listen address.
  if (process.env.HOST && process.env.HOST === os.hostname()) delete process.env.HOST;

  const created = ensureSettingsFile(settingsFile);
  loadSettingsIntoEnv(settingsFile);

  if (options.port !== undefined) {
    const port = parsePort(options.port);
    if (!port) fail(`Invalid port "${options.port}". Use a number from 1 to 65535.`);
    process.env.PORT = process.env.DASHBOARD_PORT = process.env.API_PORT = String(port);
  }
  if (options.verbose && !process.env.APP_LOG_LEVEL) process.env.APP_LOG_LEVEL = "info";
  if (options.host !== undefined) {
    if (!options.host.trim()) fail("--host needs an address, for example 127.0.0.1");
    process.env.HOST = options.host.trim();
  }

  const portSetting = process.env.DASHBOARD_PORT || process.env.PORT || String(DEFAULT_PORT);
  const port = parsePort(portSetting);
  if (!port) {
    fail(`Invalid PORT "${portSetting}" (from ${settingsFile} or the environment). Use 1-65535.`);
  }
  const host = process.env.HOST || DEFAULT_HOST;

  if (!hasBuild()) {
    fail(
      "This TRouteAI copy has no production build (.build/next).\n" +
        "    Reinstall it: npm install -g trouteai  (in a project checkout: npm run build)"
    );
  }
  const links = ensureExternalLinks(ROOT);
  for (const message of links.failed) console.warn(`  ${yellow("⚠")} Could not link ${message}`);

  const portProblem = await probePort(port, host);
  if (portProblem === "EADDRINUSE") {
    fail(
      `Port ${port} is already in use. TRouteAI may already be running at http://localhost:${port}\n` +
        `    Use another port: trouteai --port ${port === 65535 ? port - 1 : port + 1}`
    );
  }
  if (portProblem === "EACCES") fail(`No permission to use port ${port}. Pick a port above 1024.`);
  if (portProblem === "EADDRNOTAVAIL" || portProblem === "ENOTFOUND") {
    fail(`HOST "${host}" is not an address of this computer. Try 0.0.0.0 or 127.0.0.1.`);
  }

  const url = `http://${displayHost(host)}:${port}`;
  const network = ["0.0.0.0", "::"].includes(host) ? lanAddress() : null;
  const passwordFile = path.join(dataDir, "initial-admin-password.txt");
  const firstStart = !fs.existsSync(path.join(dataDir, "storage.sqlite"));
  const label = (text) => `  ${dim(text.padEnd(10))}`;
  const lines = ["", `  ${bold(`TRouteAI ${VERSION}`)}`, ""];
  lines.push(`${label("Dashboard")}${cyan(url)}`);
  if (network) lines.push(`${label("Network")}${cyan(`http://${network}:${port}`)}`);
  lines.push(`${label("API")}${cyan(`${url}/v1`)}`);
  if (fs.existsSync(passwordFile)) {
    lines.push(`${label("Password")}${passwordFile}`);
  } else if (firstStart) {
    lines.push(
      `${label("Password")}${process.env.INITIAL_PASSWORD ? "the INITIAL_PASSWORD you set" : `saved on first start to ${passwordFile}`}`
    );
  }
  lines.push(`${label("Settings")}${settingsFile}${created ? dim("  (new)") : ""}`);
  lines.push(`${label("Data")}${dataDir}`);
  if (nodeNote) lines.push("", `  ${yellow(nodeNote)}`);
  lines.push("", `  ${dim("Stop: Ctrl+C   ·   Help: trouteai --help")}`, "");
  console.log(lines.join("\n"));

  process.chdir(ROOT);
  process.title = "trouteai";
  checkForUpdateInBackground();
  const runNext = path.join(ROOT, "scripts", "dev", "run-next.mjs");
  process.argv = [process.argv[0], runNext, "start"];
  await import(pathToFileURL(runNext).href);
}

function formatSettingValue(key, value) {
  if (value === "") return dim("(empty)");
  return SECRET_KEY.test(key) && key !== "REQUIRE_API_KEY" ? "********" : value;
}

function showSettings(dataDir, settingsFile) {
  const created = ensureSettingsFile(settingsFile);
  const values = parseEnvFile(settingsFile);
  const width = Math.max(20, ...[...values.keys()].map((key) => key.length + 2));
  console.log(`\n  ${bold("TRouteAI settings")}${created ? dim("  (file created)") : ""}\n`);
  console.log(`  ${dim("File".padEnd(8))}${settingsFile}`);
  console.log(`  ${dim("Data".padEnd(8))}${dataDir}\n`);
  for (const [key, value] of values) {
    const envValue = process.env[key];
    const override =
      key !== "DATA_DIR" && envValue && envValue !== value
        ? yellow(`  (environment variable wins: ${formatSettingValue(key, envValue)})`)
        : "";
    console.log(`  ${key.padEnd(width)}${formatSettingValue(key, value)}${override}`);
  }
  console.log(`\n  Change a value:  ${cyan("trouteai config set PORT 20018")}`);
  console.log(`  Then restart TRouteAI.\n`);
}

function validateSetting(key, value) {
  if (key === "DATA_DIR") {
    return "DATA_DIR is the folder of this file. Use --data-dir or the DATA_DIR environment variable.";
  }
  if (/[\r\n]/.test(value)) return "The value cannot contain line breaks.";
  if (value === "") return null;
  if (key === "PORT" && !parsePort(value)) return "PORT must be a number from 1 to 65535.";
  if (key === "HOST" && /\s/.test(value))
    return "HOST must be an address such as 0.0.0.0 or 127.0.0.1.";
  if (key === "INITIAL_PASSWORD" && value.length < 8) {
    return "INITIAL_PASSWORD needs at least 8 characters.";
  }
  if (key === "REQUIRE_API_KEY" && !["true", "false"].includes(value)) {
    return "REQUIRE_API_KEY must be true or false.";
  }
  if (key === "NEXT_PUBLIC_BASE_URL" && !/^https?:\/\/[^\s/]+/.test(value)) {
    return "NEXT_PUBLIC_BASE_URL must start with http:// or https://, for example https://ai.example.com";
  }
  return null;
}

function serializeValue(value) {
  if (/^[A-Za-z0-9_./:@,+-]*$/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return null;
}

function setSetting(settingsFile, rawKey, valueParts) {
  if (!rawKey || valueParts.length === 0) {
    fail("Usage: trouteai config set KEY VALUE   (example: trouteai config set PORT 20018)");
  }
  const key = rawKey.toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail(`"${rawKey}" is not a valid setting name.`);
  const value = valueParts.join(" ").trim();
  const problem = validateSetting(key, value);
  if (problem) fail(problem);
  const serialized = serializeValue(value);
  if (serialized === null) fail("The value cannot contain both ' and \" characters.");

  ensureSettingsFile(settingsFile);
  const lines = fs.readFileSync(settingsFile, "utf8").split(/\r?\n/);
  const active = new RegExp(`^\\s*${key}\\s*=`);
  const commented = new RegExp(`^\\s*#\\s*${key}\\s*=`);
  let index = lines.findIndex((line) => active.test(line));
  if (index < 0) index = lines.findIndex((line) => commented.test(line));
  const entry = `${key}=${serialized}`;
  if (index >= 0) {
    lines[index] = entry;
  } else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(entry, "");
  }
  try {
    fs.writeFileSync(settingsFile, lines.join("\n"), "utf8");
    if (process.platform !== "win32") fs.chmodSync(settingsFile, 0o600);
  } catch (error) {
    fail(`Could not save ${settingsFile}: ${error.message}`);
  }
  console.log(`\n  ${cyan("✔")} Saved ${key}=${formatSettingValue(key, value)} in ${settingsFile}`);
  console.log("    Restart TRouteAI to apply it.\n");
}

function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** npm that belongs to the Node.js running TRouteAI (same global folder), else npm on PATH. */
function findNpm() {
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const besideNode = path.join(path.dirname(process.execPath), name);
  return fs.existsSync(besideNode) ? besideNode : name;
}

// Hosting panels (SixPanel sets SIXPANEL_SLOT) start every version from its own release
// folder, so a version changes with a deploy there, never in place.
const ON_PANEL = Boolean(process.env.SIXPANEL_SLOT);

async function update(settingsFile) {
  if (ON_PANEL) {
    console.log(
      `\n  TRouteAI ${VERSION} runs on SixPanel. To update, deploy the website again on its Deploys page.\n`
    );
    return;
  }
  let latest;
  try {
    const response = await fetch("https://registry.npmjs.org/trouteai/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`npm answered HTTP ${response.status}`);
    latest = String((await response.json()).version || "");
  } catch (error) {
    fail(
      `Could not check for updates: ${error.message}\n    Check your internet connection and try again.`
    );
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(latest))
    fail(`npm returned an invalid version "${latest}".`);
  if (compareVersions(latest, VERSION) <= 0) {
    console.log(`\n  ${cyan("✔")} TRouteAI ${VERSION} is the latest version.\n`);
    return;
  }
  assertNpmInstall();

  // Replacing the files of a running server breaks pages it has not loaded yet.
  await assertNotRunning(settingsFile, "trouteai update");

  console.log(`\n  ${bold("TRouteAI")} ${VERSION} → ${bold(latest)}\n`);
  const result = await runNpmInstall(`trouteai@${latest}`);
  if (result.code !== 0) {
    console.error(result.output.trim().split("\n").slice(-15).join("\n"));
    fail(`The update did not finish. Try it by hand: ${INSTALL_COMMAND}`);
  }
  console.log(`  ${cyan("✔")} Updated to ${latest} in ${formatDuration(result.seconds)}`);
  console.log(`    Start it with: ${cyan("trouteai")}\n`);
}

async function assertNotRunning(settingsFile, retryCommand) {
  if (fs.existsSync(settingsFile)) loadSettingsIntoEnv(settingsFile);
  const port = parsePort(process.env.DASHBOARD_PORT || process.env.PORT) || DEFAULT_PORT;
  if ((await probePort(port, process.env.HOST || DEFAULT_HOST)) === "EADDRINUSE") {
    fail(
      `TRouteAI seems to be running on port ${port}. Stop it first (Ctrl+C in its terminal),\n` +
        `    then run: ${retryCommand}`
    );
  }
}

function assertNpmInstall() {
  if (!ROOT.split(path.sep).includes("node_modules")) {
    fail(
      `This TRouteAI copy (${ROOT}) was not installed with npm.\n` +
        "    In a project folder, update with: git pull && npm install && npm run build"
    );
  }
}

async function askYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function uninstall(dataDir, settingsFile) {
  assertNpmInstall();
  await assertNotRunning(settingsFile, "trouteai uninstall");
  const deleteData =
    fs.existsSync(dataDir) &&
    (await askYesNo(
      `\n  Also delete your settings and data in ${dataDir}?\n  This removes providers, API keys and logs for good. Type y to delete [y/N]: `
    ));
  console.log(`\n  ${bold("Removing TRouteAI")} ${VERSION}\n`);
  const result = await runNpm(["uninstall", "-g", "trouteai"], "Removing files");
  if (result.code !== 0) {
    console.error(result.output.trim().split("\n").slice(-15).join("\n"));
    fail("Uninstall did not finish. Try it by hand: npm uninstall -g trouteai");
  }
  console.log(`  ${cyan("✔")} TRouteAI is removed (${formatDuration(result.seconds)})`);
  if (deleteData) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`  ${cyan("✔")} Deleted ${dataDir}\n`);
  } else if (fs.existsSync(dataDir)) {
    console.log(`    Your settings and data are still in ${dataDir}`);
    console.log("    Install again any time and they are used again.\n");
  }
}

/** One line when npm has a newer version; never blocks or fails the start. */
function checkForUpdateInBackground() {
  if (
    ON_PANEL ||
    !process.stdout.isTTY ||
    /^(0|false|no)$/i.test(process.env.TROUTEAI_UPDATE_CHECK || "")
  ) {
    return;
  }
  fetch("https://registry.npmjs.org/trouteai/latest", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const latest = String(data?.version || "");
      if (/^\d+\.\d+\.\d+$/.test(latest) && compareVersions(latest, VERSION) > 0) {
        process.stdout.write(
          `  ${yellow("↑")} TRouteAI ${latest} is available (you have ${VERSION}). Update: ${cyan("trouteai update")}\n`
        );
      }
    })
    .catch(() => {});
}

const INSTALL_COMMAND =
  "npm install -g trouteai --allow-scripts=tls-client-node,koffi --loglevel=error";

function formatDuration(seconds) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * npm install -g with a live progress line instead of npm's own output. npm warnings are
 * hidden; the two native helpers (TLS client for the web-session providers) may run their
 * install scripts, which npm 11+ otherwise asks about.
 */
function runNpmInstall(spec) {
  const args = ["install", "-g", spec, "--allow-scripts=tls-client-node,koffi", "--prefer-online"];
  return runNpm(args, "Checking packages", "Downloading packages");
}

function runNpm(npmArgs, firstStep, countStep) {
  const npm = findNpm();
  const args = [...npmArgs, "--no-audit", "--no-fund", "--no-progress", "--loglevel=http"];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(npm, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    let packages = 0;
    const onData = (chunk) => {
      const text = String(chunk);
      output += text;
      packages += (text.match(/http fetch GET 200 \S+\.tgz/g) || []).length;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let frame = 0;
    const draw = () => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const step = packages > 0 && countStep ? `${countStep}: ${packages}` : firstStep;
      process.stdout.write(
        `\r  ${cyan(frames[frame++ % frames.length])} ${step}  ${dim(formatDuration(seconds))}   `
      );
    };
    const timer = process.stdout.isTTY ? setInterval(draw, 120) : null;
    if (!timer) console.log(`  ${firstStep}...`);
    child.on("error", (error) => {
      output += String(error?.message || error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearInterval(timer);
        process.stdout.write("\r\x1b[2K");
      }
      resolve({ code: code ?? 1, output, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

/**
 * Start a child Node.js with --max-old-space-size (default 35% of RAM, 512-4096 MB, TROUTEAI_MAX_HEAP_MB
 * overrides) and wait for it. The child does the port check, banner and server; this
 * process only forwards signals and passes on the exit code. Resolves false (start in
 * this process instead) when a heap flag is already set or the child cannot be started.
 */
function runWithHeapCap(dataDirFlag) {
  if (process.env.__TROUTEAI_HEAP_CHILD) return Promise.resolve(false);
  // The settings file is read here (environment wins) so `trouteai config set` works too.
  let fileValues = new Map();
  try {
    fileValues = parseEnvFile(path.join(resolveDataDir(dataDirFlag), ".env"));
  } catch {}
  const pick = (key) => process.env[key] || fileValues.get(key) || "";
  // Skip only when a heap flag really reached V8 at launch (CLI flag or exported NODE_OPTIONS).
  const heapFlagSet =
    process.execArgv.some((arg) => arg.startsWith("--max-old-space-size")) ||
    envHasExplicitHeapFlag(process.env);
  if (heapFlagSet) return Promise.resolve(false);

  // NODE_OPTIONS from the settings file only takes effect at launch, so pass it to the child.
  const childEnv = { ...process.env, __TROUTEAI_HEAP_CHILD: "1" };
  const fileNodeOptions = fileValues.get("NODE_OPTIONS");
  if (!process.env.NODE_OPTIONS && fileNodeOptions) childEnv.NODE_OPTIONS = fileNodeOptions;
  // A CLI flag would override the user's NODE_OPTIONS heap value, so add it only when absent.
  // Default: 35% of RAM, between 512 MB and 4 GB (below 512 MB long streams can run out).
  // A memory limit (systemd MemoryMax, a container) is smaller than the host RAM: size from it.
  const limitBytes =
    typeof process.constrainedMemory === "function" ? Number(process.constrainedMemory()) : 0;
  const totalBytes = limitBytes > 0 && limitBytes < os.totalmem() ? limitBytes : os.totalmem();
  const totalMb = Math.floor(totalBytes / 1048576);
  const defaultHeapMb =
    Number.isFinite(totalMb) && totalMb > 0
      ? Math.min(4096, Math.max(512, Math.floor(totalMb * 0.35)))
      : 512;
  const heapMb = resolveMaxOldSpaceMb(pick("TROUTEAI_MAX_HEAP_MB"), defaultHeapMb);
  const heapArgs = envHasExplicitHeapFlag(childEnv) ? [] : [`--max-old-space-size=${heapMb}`];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [...heapArgs, ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
        { stdio: "inherit", env: childEnv }
      );
    } catch {
      resolve(false);
      return;
    }
    let started = false;
    const forward = (signal) => {
      // Ctrl+C reaches the child too (same process group); a repeat signal is harmless.
      // On Windows kill() terminates at once (no drain), so only keep the parent alive.
      if (process.platform === "win32") return;
      if (started && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {}
      }
    };
    const signals =
      process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) process.on(signal, forward);
    child.once("spawn", () => {
      started = true;
      process.title = "trouteai";
      resolve(true);
    });
    child.once("error", () => {
      if (started) return;
      for (const signal of signals) process.off(signal, forward);
      resolve(false);
    });
    child.once("exit", (code, signal) => {
      if (!started) return;
      const signalNumber = signal ? os.constants.signals[signal] : undefined;
      process.exit(code ?? (signalNumber ? 128 + signalNumber : 1));
    });
  });
}

async function resetPassword() {
  await import(pathToFileURL(path.join(ROOT, "bin", "reset-password.mjs")).href);
}

async function main() {
  const nodeNote = checkNodeVersion();
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    const unknown =
      error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && error.message.match(/'([^']+)'/)?.[1];
    fail(
      `${unknown ? `Unknown option "${unknown}".` : error.message}\n    Run "trouteai --help" to see the options.`
    );
  }
  const { values: options, positionals } = parsed;
  if (options.version) {
    console.log(VERSION);
    return;
  }
  const command = positionals[0] || "start";
  if (options.help || command === "help") {
    printHelp();
    return;
  }

  // The heap cap only works as a launch flag, so the start path re-runs itself once with it.
  if (command === "start" && positionals.length <= 1 && (await runWithHeapCap(options["data-dir"])))
    return;

  const dataDir = resolveDataDir(options["data-dir"]);
  process.env.DATA_DIR = dataDir;
  const settingsFile = path.join(dataDir, ".env");

  if (command === "start" && positionals.length <= 1) {
    await startServer(options, dataDir, settingsFile, nodeNote);
  } else if (command === "config" && positionals.length === 1) {
    showSettings(dataDir, settingsFile);
  } else if (command === "config" && positionals[1] === "set") {
    setSetting(settingsFile, positionals[2], positionals.slice(3));
  } else if (command === "update" && positionals.length === 1) {
    await update(settingsFile);
  } else if (command === "uninstall" && positionals.length === 1) {
    await uninstall(dataDir, settingsFile);
  } else if (command === "reset-password" && positionals.length === 1) {
    await resetPassword();
  } else {
    fail(`Unknown command "${positionals.join(" ")}". Run "trouteai --help".`);
  }
}

await main();
