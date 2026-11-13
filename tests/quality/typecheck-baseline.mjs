// TypeScript baseline gate (`npm run typecheck:baseline`). The code base still has old type
// errors; this runs `tsc --noEmit` and fails only when there are MORE errors than the committed
// baseline (typecheck-baseline.json), so new code cannot add any.
//
//   node tests/quality/typecheck-baseline.mjs            check against the baseline
//   node tests/quality/typecheck-baseline.mjs --update   write the current numbers as the baseline
//
// When the count rises, the files whose count rose are listed with their errors.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const baselineFile = join(here, "typecheck-baseline.json");
const update = process.argv.includes("--update");

const tsc = createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
const run = spawnSync(
  process.execPath,
  [tsc, "--noEmit", "-p", "tsconfig.json", "--incremental", "false"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }
);
const output = `${run.stdout || ""}${run.stderr || ""}`;
const errorLines = output.split("\n").filter((line) => /error TS\d+/.test(line));
const files = {};
for (const line of errorLines) {
  const file = /^(.+?)\(\d+,\d+\): error TS/.exec(line)?.[1] || "(no file)";
  files[file] = (files[file] || 0) + 1;
}
const total = errorLines.length;

if (run.error || (run.status !== 0 && total === 0)) {
  console.error("tsc did not run cleanly:");
  console.error(run.error?.message || output.slice(-2000));
  process.exit(2);
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselineFile, `${JSON.stringify({ errors: total, files: sorted }, null, 2)}\n`);
  console.log(
    `Baseline written: ${total} TypeScript errors in ${Object.keys(files).length} files.`
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
console.log(`TypeScript: ${total} errors (baseline ${baseline.errors}).`);

if (total > baseline.errors) {
  console.error(
    `\n${total - baseline.errors} new TypeScript error(s). Files with more errors than before:`
  );
  for (const [file, count] of Object.entries(files)) {
    const before = baseline.files?.[file] || 0;
    if (count <= before) continue;
    console.error(`\n${file}: ${before} -> ${count}`);
    for (const line of errorLines.filter((l) => l.startsWith(`${file}(`)))
      console.error(`  ${line}`);
  }
  process.exit(1);
}
if (total < baseline.errors) {
  console.log(
    `${baseline.errors - total} fewer than the baseline. Lock that in with: npm run typecheck:baseline -- --update`
  );
}
