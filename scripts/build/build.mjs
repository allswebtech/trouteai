#!/usr/bin/env node
// Production build: `next build` (Turbopack by default) with a larger V8 heap.
// Output goes to `.build/next` (distDir in next.config.mjs); run it with `npm start`.
//
//   node scripts/build/build.mjs            normal build (`npm run build`)
//   node scripts/build/build.mjs --release  clean build for the npm package; `npm pack` and
//                                           `npm publish` run it through the `prepack` script.
//     --release ignores NEXT_PUBLIC_* / TROUTEAI_BASE_PATH values from local .env files (Next
//     would bake them into the bundles), builds against an empty temporary DATA_DIR, and
//     removes this machine's folder path from the build output.
//
// Env knobs:
//   TROUTEAI_BUILD_MEMORY_MB=6144  raise/lower the V8 heap for the build (default 4096)
//   TROUTEAI_BUILD_CPUS=1          build workers (default 1). Each worker is its own Node
//                                  process; measured on a 10-core Mac: 1 worker peaks at
//                                  2,056 MB in 61 s, the Next default (9) at 2,916 MB in 70 s.
//   TROUTEAI_BUILD_CACHE=1         keep Turbopack's build cache (off: panels build each
//                                  release in a new folder, so it only costs memory and time)
//   TROUTEAI_USE_TURBOPACK=0       use webpack instead of Turbopack (slower, not lower: 2,689 MB)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeExternalsManifest } from "./buildExternals.mjs";

const rootDir = process.cwd();
const release = process.argv.includes("--release");
const nextBin = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");
const distDir = path.join(rootDir, process.env.NEXT_DIST_DIR || ".build/next");
const env = { ...process.env, NODE_ENV: "production" };
if (!(Number(env.TROUTEAI_BUILD_CPUS) > 0)) env.TROUTEAI_BUILD_CPUS = "1";

if (!/--max-old-space-size/.test(env.NODE_OPTIONS || "")) {
  const heapMb = Number(process.env.TROUTEAI_BUILD_MEMORY_MB) || 4096;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --max-old-space-size=${heapMb}`.trim();
}

function readEnvKeys(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter(Boolean);
  } catch {
    return [];
  }
}

let releaseDataDir = null;
if (release) {
  // Next never overrides a variable that is already set, so an empty value hides the .env one.
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    for (const key of readEnvKeys(path.join(rootDir, file))) {
      const bakedIntoBuild = key.startsWith("NEXT_PUBLIC_") || key === "TROUTEAI_BASE_PATH";
      if (bakedIntoBuild && env[key] === undefined) env[key] = "";
    }
  }
  releaseDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-build-data-"));
  env.DATA_DIR = releaseDataDir;
}

// required-server-files.{json,js} store absolute folder paths; the server does not need them.
function stripBuildMachinePaths() {
  const escapedRoot = JSON.stringify(rootDir).slice(1, -1);
  for (const name of ["required-server-files.json", "required-server-files.js"]) {
    const filePath = path.join(distDir, name);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, content.split(escapedRoot).join("."), "utf8");
  }
}

const bundlerFlag = process.env.TROUTEAI_USE_TURBOPACK === "0" ? "--webpack" : "--turbopack";
const child = spawn(process.execPath, [nextBin, "build", bundlerFlag], { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (releaseDataDir) fs.rmSync(releaseDataDir, { recursive: true, force: true });
  if (signal || code !== 0) process.exit(signal ? 1 : (code ?? 1));
  try {
    writeExternalsManifest(distDir);
    if (release) stripBuildMachinePaths();
  } catch (error) {
    console.error("[build] Failed to finalize the build output:", error);
    process.exit(1);
  }
  process.exit(0);
});
