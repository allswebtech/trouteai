import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The command token: a random secret in the data folder that proves a call to the management
 * API comes from the `trouteai` command of the person who runs this TRouteAI (`trouteai key create`).
 * Only the owner of the data folder can read it, so another user or another program's account
 * on the same computer cannot use it. The server creates it at start when it is missing; the
 * command reads it from the same data folder.
 *
 * Windows: the mode bits below are not a permission system there. Node maps them to the
 * read-only flag only, and who may read the file is decided by the folder's access list. The
 * default data folder is in the user's own profile, which only that user and administrators can
 * read, so the file is as private as that folder. A DATA_DIR in a shared place must be protected
 * by its own access list. The mode check is skipped on Windows for that reason.
 */
export const CLI_TOKEN_FILE = "cli-token";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CHECK_MODE = process.platform !== "win32";

export function cliTokenPath(dataDir) {
  return path.join(dataDir, CLI_TOKEN_FILE);
}

/** Why a file cannot be trusted as the token, or null when it can. */
function untrustedReason(stat) {
  if (!stat.isFile()) return "is not a plain file";
  if (!CHECK_MODE) return null;
  if ((stat.mode & 0o077) !== 0) return "can be read or changed by other users";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return "belongs to another user";
  }
  return null;
}

function writeNewToken(filePath) {
  const token = randomBytes(32).toString("hex");
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.unlinkSync(tmp);
  } catch {}
  // Created with mode 0600 from the start (a umask can only remove bits), then moved into place
  // in one step, so the file is never readable by others, not even for a moment.
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, filePath);
  return token;
}

/**
 * Make sure the token file exists and only its owner can read it. A missing file is created; a
 * file that others can read, that belongs to another user, or that holds no valid token is
 * replaced by a new one (and one warning line says so). Returns the token.
 */
export function ensureCliTokenFile(dataDir, { warn = (message) => console.warn(message) } = {}) {
  const filePath = cliTokenPath(dataDir);
  let stat = null;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!stat) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return writeNewToken(filePath);
  }
  let reason = untrustedReason(stat);
  if (!reason) {
    try {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (TOKEN_PATTERN.test(content)) return content;
      reason = "holds no valid token";
    } catch {
      reason = "cannot be read";
    }
  }
  const token = writeNewToken(filePath);
  warn(`[WARN] The command token ${filePath} ${reason}; it was replaced by a new one (mode 0600).`);
  return token;
}

/** The token, or null when the file is missing, unreadable, readable by others or damaged. */
export function readCliToken(dataDir) {
  const filePath = cliTokenPath(dataDir);
  try {
    if (untrustedReason(fs.lstatSync(filePath))) return null;
    const content = fs.readFileSync(filePath, "utf8").trim();
    return TOKEN_PATTERN.test(content) ? content : null;
  } catch {
    return null;
  }
}

/** True when the file exists at all, usable or not (so a message can tell the two apart). */
export function cliTokenFileExists(dataDir) {
  try {
    fs.lstatSync(cliTokenPath(dataDir));
    return true;
  } catch {
    return false;
  }
}
