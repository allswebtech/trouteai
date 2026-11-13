#!/usr/bin/env node
// Publish the current version to npm and push the release tag: `npm run release`
// (after `npm version patch`). Works from a terminal, from Claude Code's `!` prefix and from
// an AI agent, because it handles the three things that broke a release before:
//
// 1. Not logged in: npm answers a publish with "404 Not Found - PUT .../trouteai", which looks
//    like a missing package. This checks `npm whoami` first and runs the browser login.
// 2. No terminal: npm's web 2FA only waits for the browser when it runs in a terminal;
//    otherwise it stops with EOTP and prints a masked link (".../auth/cli/***") that 404s.
//    The publish runs inside a pseudo-terminal (`script`), and the real link is opened in
//    the browser automatically — just approve it there.
// 3. Order: the commit and the tag are pushed only after npm accepted the upload, so a failed
//    release pushes nothing.
//
// It refuses a dirty tree, a version that npm already has, and a version without its tag.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

const REGISTRY = "https://registry.npmjs.org/";
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const tag = `v${pkg.version}`;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}
function openInBrowser(url) {
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
  console.log(`\n→ Opened in your browser: ${url}\n  Approve it there; this waits for you.\n`);
}

// Runs an npm command in a pseudo-terminal so npm's browser flow waits, mirrors its output,
// and opens the first npmjs.com login / 2FA link it prints.
function npmInTerminal(args) {
  const command = ["npm", ...args];
  const [cmd, cmdArgs] =
    platform() === "darwin"
      ? ["script", ["-q", "/dev/null", ...command]]
      : platform() === "linux"
        ? ["script", ["-qec", command.join(" "), "/dev/null"]]
        : ["npm", args]; // Windows: no `script`; npm opens the browser itself in a console
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["inherit", "pipe", "pipe"] });
    let opened = false;
    let seen = "";
    const onData = (chunk) => {
      process.stdout.write(chunk);
      if (opened) return;
      seen = (seen + chunk.toString()).slice(-4000);
      const link = seen
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
        .match(/https:\/\/www\.npmjs\.com\/(?:login\?next=\/login\/cli|auth\/cli)\/[0-9a-f-]{36}/);
      if (link) {
        opened = true;
        openInBrowser(link[0]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve(code === 0));
  });
}

// ── checks ──────────────────────────────────────────────────────────────────
if (run("git", ["status", "--porcelain"]).out) fail("Commit or stash your changes first.");
if (!run("git", ["tag", "--points-at", "HEAD"]).out.split("\n").includes(tag)) {
  fail(`HEAD is not tagged ${tag}. Run \`npm version patch\` (or minor/major) first.`);
}
if (
  run("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--registry", REGISTRY]).out ===
  pkg.version
) {
  fail(
    `${pkg.name}@${pkg.version} is already on npm. Versions cannot be reused: run \`npm version patch\`.`
  );
}

const who = run("npm", ["whoami", "--registry", REGISTRY]);
if (who.ok) {
  console.log(`✓ npm: logged in as ${who.out}`);
} else {
  console.log("npm: not logged in — starting the browser login.");
  if (!(await npmInTerminal(["login", "--auth-type=web", "--registry", REGISTRY]))) {
    fail("npm login did not finish. Run `npm run release` again.");
  }
}

// ── publish (prepack makes the release build), then push ────────────────────
console.log(`\nPublishing ${pkg.name}@${pkg.version} (release build first, 2-3 minutes)...`);
if (!(await npmInTerminal(["publish", "--auth-type=web", "--registry", REGISTRY]))) {
  fail(
    "npm publish failed (nothing was pushed). If the upload never started, fix the error and run " +
      "`npm run release` again; if npm says the version exists, run `npm version patch` first."
  );
}
console.log(`\n✓ ${pkg.name}@${pkg.version} is on npm. Pushing the commit and ${tag}...`);
const push = run("git", ["push", "--follow-tags", "origin", "HEAD"]);
if (!push.ok) fail(`git push failed:\n${push.out}\nRun \`git push --follow-tags\` yourself.`);
console.log("✓ Pushed.\n");

console.log(
  "npm checks every new version before it can be installed (often 10 to 60 minutes). After\n" +
    "that, `npm install -g trouteai` and servers that install TRouteAI from npm get this version."
);
