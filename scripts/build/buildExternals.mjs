// Turbopack production builds load server-external packages (pino, ws, zod, ...) through
// hashed aliases such as `.build/next/node_modules/pino-28069d5257187539`, which are
// symlinks into the real node_modules. npm does not pack symlinks, so the build writes the
// alias list to a manifest and an installed copy recreates the links (postinstall, and
// again when `trouteai` starts).
import fs from "node:fs";
import path from "node:path";

export const EXTERNALS_MANIFEST = "trouteai-externals.json";

function listAliasLinks(nodeModulesDir) {
  const links = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.isSymbolicLink()) {
      links.push({ alias: entry.name, linkPath: entryPath });
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) {
          links.push({
            alias: `${entry.name}/${scoped.name}`,
            linkPath: path.join(entryPath, scoped.name),
          });
        }
      }
    }
  }
  return links;
}

/** Record `alias -> package name` for every external link of a finished build. */
export function writeExternalsManifest(distDir) {
  const nodeModulesDir = path.join(distDir, "node_modules");
  const manifest = {};
  if (fs.existsSync(nodeModulesDir)) {
    for (const { alias, linkPath } of listAliasLinks(nodeModulesDir)) {
      const target = fs.readlinkSync(linkPath).split(path.sep).join("/");
      const marker = target.lastIndexOf("node_modules/");
      if (marker >= 0) manifest[alias] = target.slice(marker + "node_modules/".length);
    }
  }
  fs.writeFileSync(
    path.join(distDir, EXTERNALS_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifest;
}

function findPackageDir(packageName, fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...packageName.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Recreate missing external links from the manifest. Packages that are not installed
 * (optional ones such as `typescript`) are reported in `missing` and skipped.
 */
export function ensureExternalLinks(rootDir, distDir = path.join(rootDir, ".build", "next")) {
  const result = { created: 0, missing: [], failed: [] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distDir, EXTERNALS_MANIFEST), "utf8"));
  } catch {
    return result;
  }

  for (const [alias, packageName] of Object.entries(manifest)) {
    const linkPath = path.join(distDir, "node_modules", ...alias.split("/"));
    // existsSync follows the link, so a broken link counts as missing.
    if (fs.existsSync(linkPath)) continue;
    const target = findPackageDir(packageName, rootDir);
    if (!target) {
      result.missing.push(packageName);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.rmSync(linkPath, { force: true });
      // Junctions (Windows) need an absolute target; elsewhere a relative link survives moves.
      const linkTarget =
        process.platform === "win32" ? target : path.relative(path.dirname(linkPath), target);
      fs.symlinkSync(linkTarget, linkPath, "junction");
      result.created += 1;
    } catch (error) {
      result.failed.push(`${alias}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
