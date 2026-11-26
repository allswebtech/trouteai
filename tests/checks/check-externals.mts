// Check that a release build needs no links made on the computer that runs it: the hashed alias
// names of the external packages are replaced by the package names in the build output, so a
// copy installed by one user starts for another. Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-externals.mts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXTERNALS_MANIFEST,
  ensureExternalLinks,
  inlineExternalAliases,
  writeExternalsManifest,
} from "../../scripts/build/buildExternals.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-externals-"));
const dist = path.join(root, ".build", "next");
fs.mkdirSync(path.join(root, "node_modules", "pino"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "@scope", "pkg"), { recursive: true });
fs.writeFileSync(path.join(root, "node_modules", "pino", "package.json"), '{"name":"pino"}');
fs.writeFileSync(path.join(root, "node_modules", "@scope", "pkg", "package.json"), "{}");
fs.mkdirSync(path.join(dist, "node_modules", "@scope"), { recursive: true });
fs.symlinkSync("../../../node_modules/pino", path.join(dist, "node_modules", "pino-0123abcd"));
fs.symlinkSync(
  "../../../../node_modules/@scope/pkg",
  path.join(dist, "node_modules", "@scope", "pkg-4567ef01")
);
fs.mkdirSync(path.join(dist, "server", "chunks"), { recursive: true });
const chunk = path.join(dist, "server", "chunks", "a.js");
fs.writeFileSync(
  chunk,
  'x("pino-0123abcd",()=>require("pino-0123abcd"));y(require("@scope/pkg-4567ef01"));' +
    'z("pino-0123abcdef")'
);
writeExternalsManifest(dist);

const done = inlineExternalAliases(dist);
const after = fs.readFileSync(chunk, "utf8");
check("the alias is replaced by the package name", after.includes('require("pino")'), after);
check("a scoped alias is replaced too", after.includes('require("@scope/pkg")'));
check("a longer name that only starts with an alias is left alone", after.includes("pino-0123abcdef"));
check("the replaced files are counted", done.files === 1, `${done.files}`);
const manifest = JSON.parse(fs.readFileSync(path.join(dist, EXTERNALS_MANIFEST), "utf8"));
check("the manifest lists no alias any more", Object.keys(manifest).length === 0);

// A copy with no link and a folder nobody can write to still has nothing to make.
fs.rmSync(path.join(dist, "node_modules"), { recursive: true, force: true });
fs.chmodSync(dist, 0o555);
const result = ensureExternalLinks(root);
fs.chmodSync(dist, 0o755);
check("a read-only copy has nothing to link and nothing failing", result.failed.length === 0);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
