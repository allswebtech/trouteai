// The command token (x-trouteai-cli-token), checked in-process: the random secret in
// DATA_DIR/cli-token is the only thing accepted, by the authz pipeline policy and by the
// route-level management check alike, only from this computer and never through a proxy; the
// old token derived from the machine id is refused; the file is created with mode 0600 and a
// file others can read is replaced; TROUTEAI_DISABLE_CLI_TOKEN=true refuses everything.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-cli-token.mts
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// An admin password is "configured", so a management call without a valid credential is refused.
process.env.INITIAL_PASSWORD = "Check-Pass-123";
process.env.TROUTEAI_PEER_STAMP_TOKEN = randomUUID();
delete process.env.TROUTEAI_DISABLE_CLI_TOKEN;

const { ensureCliTokenFile, readCliToken, cliTokenPath } =
  await import("../../scripts/dev/cli-token-file.mjs");
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const { classifyRoute } = await import("../../src/server/authz/classify.ts");
const { isCliTokenAuthValid } = await import("../../src/lib/middleware/cliTokenAuth.ts");
const { requireManagementAuth } = await import("../../src/lib/api/requireManagementAuth.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const warnings: string[] = [];
const quiet = (message: string) => warnings.push(message);
const mode = (file: string) => fs.statSync(file).mode & 0o777;
const posix = process.platform !== "win32";

// ── The file ────────────────────────────────────────────────────────────────
const dataDir = process.env.DATA_DIR as string;
const secret = ensureCliTokenFile(dataDir, { warn: quiet });
const file = cliTokenPath(dataDir);
check("the server makes a 32-byte hex secret", /^[0-9a-f]{64}$/.test(secret));
if (posix) check("the file has mode 0600", mode(file) === 0o600, mode(file).toString(8));
check(
  "a second start keeps the same secret",
  ensureCliTokenFile(dataDir, { warn: quiet }) === secret
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trouteai-cli-token-"));
const scratchToken = ensureCliTokenFile(scratch, { warn: quiet });
if (posix) {
  const scratchFile = cliTokenPath(scratch);
  fs.chmodSync(scratchFile, 0o644);
  check("a file others can read is not used", readCliToken(scratch) === null);
  warnings.length = 0;
  const repaired = ensureCliTokenFile(scratch, { warn: quiet });
  check(
    "a file others can read is replaced by a new secret with mode 0600, and one warning says so",
    mode(scratchFile) === 0o600 &&
      repaired !== scratchToken &&
      readCliToken(scratch) === repaired &&
      warnings.length === 1,
    `${mode(scratchFile).toString(8)}, ${warnings.length} warning(s)`
  );
} else {
  console.log("SKIP  mode checks (Windows has no POSIX file modes)");
}
fs.writeFileSync(cliTokenPath(scratch), "not a token\n", { mode: 0o600 });
check(
  "a damaged file is replaced",
  /^[0-9a-f]{64}$/.test(ensureCliTokenFile(scratch, { warn: quiet }))
);
fs.rmSync(scratch, { recursive: true, force: true });

// ── The old token derived from the machine id ───────────────────────────────
function machineIdRaw(): string {
  for (const candidate of ["/var/lib/dbus/machine-id", "/etc/machine-id"]) {
    try {
      const value = fs.readFileSync(candidate, "utf8").split("\n")[0].trim().toLowerCase();
      if (value) return value;
    } catch {}
  }
  return os.hostname().toLowerCase();
}
const raw = machineIdRaw();
const salt = "trouteai-cli-auth-v1";
const oldTokens = [
  createHmac("sha256", raw).update(salt).digest("hex"),
  createHash("sha256")
    .update(createHash("sha256").update(raw).digest("hex") + salt)
    .digest("hex")
    .substring(0, 32),
];

// ── The pipeline policy ─────────────────────────────────────────────────────
const stampToken = process.env.TROUTEAI_PEER_STAMP_TOKEN;
function pipelineRequest(token: string, peer = "127.0.0.1", extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trouteai-cli-token": token,
      "x-trouteai-peer-ip": `${stampToken}|${peer}`,
      "x-trouteai-via-proxy": `${stampToken}|${extra["x-forwarded-for"] ? "1" : "0"}`,
      ...extra,
    },
  });
}
async function pipelineAccepts(request: Request): Promise<boolean> {
  const outcome = await managementPolicy.evaluate({
    request,
    classification: classifyRoute("/api/keys", "POST"),
    requestId: "check",
  });
  return outcome.allow === true && outcome.subject?.label === "local-cli-token";
}

check(
  "pipeline: the file secret from this computer is accepted",
  await pipelineAccepts(pipelineRequest(secret))
);
check(
  "pipeline: the file secret over IPv6 loopback is accepted",
  await pipelineAccepts(pipelineRequest(secret, "::1"))
);
const pipelineOld = await Promise.all(oldTokens.map((t) => pipelineAccepts(pipelineRequest(t))));
check(
  "pipeline: the old machine-id tokens are refused",
  pipelineOld.every((ok) => !ok)
);
check(
  "pipeline: the file secret from another address is refused",
  !(await pipelineAccepts(pipelineRequest(secret, "192.168.1.20")))
);
const forwarded: Array<Record<string, string>> = [
  { "x-forwarded-for": "203.0.113.9" },
  { "x-real-ip": "203.0.113.9" },
  { "cf-connecting-ip": "203.0.113.9" },
  { forwarded: "for=203.0.113.9" },
];
const pipelineForwarded = await Promise.all(
  forwarded.map((extra) => pipelineAccepts(pipelineRequest(secret, "127.0.0.1", extra)))
);
check(
  "pipeline: the file secret with forwarding headers is refused",
  pipelineForwarded.every((ok) => !ok),
  pipelineForwarded.join(",")
);
check(
  "pipeline: a wrong secret of the right length is refused",
  !(await pipelineAccepts(pipelineRequest("0".repeat(64))))
);

// ── The route-level management check ────────────────────────────────────────
function routeRequest(token: string, locality = "loopback", extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/api/keys", {
    method: "POST",
    headers: {
      "x-trouteai-cli-token": token,
      "x-trouteai-peer-locality": locality,
      // Next.js adds this to every request before a route handler runs.
      "x-forwarded-for": "127.0.0.1",
      ...extra,
    },
  });
}
check(
  "route: the file secret from this computer is accepted",
  await isCliTokenAuthValid(routeRequest(secret))
);
check(
  "management route: the file secret opens it",
  (await requireManagementAuth(routeRequest(secret))) === null
);
const routeOld = await Promise.all(oldTokens.map((t) => isCliTokenAuthValid(routeRequest(t))));
check(
  "route: the old machine-id tokens are refused",
  routeOld.every((ok) => !ok)
);
const managementOld = await Promise.all(
  oldTokens.map(async (t) => (await requireManagementAuth(routeRequest(t)))?.status ?? 200)
);
check(
  "management route: the old machine-id tokens are refused",
  managementOld.every((status) => status === 401 || status === 403),
  managementOld.join(",")
);
check(
  "route: the file secret from another address is refused",
  !(await isCliTokenAuthValid(routeRequest(secret, "remote"))) &&
    !(await isCliTokenAuthValid(routeRequest(secret, "lan")))
);
const routeForwarded = await Promise.all(
  [{ "x-real-ip": "203.0.113.9" }, { "cf-connecting-ip": "203.0.113.9" }].map((extra) =>
    isCliTokenAuthValid(routeRequest(secret, "loopback", extra))
  )
);
check(
  "route: the file secret with forwarding headers is refused",
  routeForwarded.every((ok) => !ok)
);

// ── The switch ──────────────────────────────────────────────────────────────
process.env.TROUTEAI_DISABLE_CLI_TOKEN = "true";
check(
  "TROUTEAI_DISABLE_CLI_TOKEN=true: the pipeline refuses the file secret",
  !(await pipelineAccepts(pipelineRequest(secret)))
);
check(
  "TROUTEAI_DISABLE_CLI_TOKEN=true: the management route refuses it",
  !(await isCliTokenAuthValid(routeRequest(secret))) &&
    (await requireManagementAuth(routeRequest(secret))) !== null
);
delete process.env.TROUTEAI_DISABLE_CLI_TOKEN;

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
