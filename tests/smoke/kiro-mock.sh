#!/bin/sh
# The Anthropic Messages API conformance checks (anthropic-conformance.mjs) and the stream
# failure checks (kiro-stream-failures.mjs) through the whole TRouteAI server against a FAKE
# Kiro (mock-kiro.mjs), so no account and no network are needed. Run by run.sh; needs
# `npm run build`. Temporary data folder and ports.
#   sh tests/smoke/kiro-mock.sh
# Env: KIRO_MOCK_SMOKE_PORT (default 8796), KIRO_MOCK_PORT (default 20995),
#      KIRO_MOCK_KEEP_LOG=<file> keeps the server log,
#      KIRO_MOCK_CLAUDE_CODE=1 also runs an installed `claude` (Claude Code) through the server
#      with a temporary config folder (no login needed: it talks only to this server).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${KIRO_MOCK_SMOKE_PORT:-8796}
MOCK_PORT=${KIRO_MOCK_PORT:-20995}
PASSWORD="Kiro-Mock-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-kiromock.XXXXXX")
LOG="$DATA/app.log"
APP_PID=""
MOCK_PID=""

# Ctrl-C the server, give it up to 15 s to shut down, then kill it.
stop_app() {
  [ -n "$APP_PID" ] || return 0
  kill -INT "$APP_PID" 2>/dev/null
  n=0
  while kill -0 "$APP_PID" 2>/dev/null && [ "$n" -lt 30 ]; do
    sleep 0.5
    n=$((n + 1))
  done
  kill -KILL "$APP_PID" 2>/dev/null
  APP_PID=""
}
cleanup() {
  stop_app
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  # KIRO_MOCK_KEEP_LOG=<file>: keep the server log for debugging.
  [ -n "${KIRO_MOCK_KEEP_LOG:-}" ] && cp "$LOG" "$KIRO_MOCK_KEEP_LOG" 2>/dev/null
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

DATA_DIR="$DATA"
STORAGE_ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')
API_KEY_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
TROUTEAI_KIRO_RUNTIME_URL="http://127.0.0.1:$MOCK_PORT"
TROUTEAI_HEALTHCHECK_SKIP_PROVIDERS=kiro
export DATA_DIR STORAGE_ENCRYPTION_KEY JWT_SECRET API_KEY_SECRET TROUTEAI_KIRO_RUNTIME_URL TROUTEAI_HEALTHCHECK_SKIP_PROVIDERS

node "$HERE/mock-kiro.mjs" "$MOCK_PORT" > "$DATA/mock.log" 2>&1 &
MOCK_PID=$!

cd "$APP_DIR" || exit 1
CONN_ID=$(KIRO_SEED_ACCOUNTS=1 npx --no-install tsx --tsconfig tsconfig.json "$HERE/kiro-seed.mts" 2>"$DATA/seed.err" | grep '^CONN_ID=' | tail -1 | cut -d= -f2)
if [ -z "$CONN_ID" ]; then
  echo "FAIL  could not add the Kiro test connection"
  grep -v '^\[' "$DATA/seed.err"
  exit 1
fi

PORT="$PORT" INITIAL_PASSWORD="$PASSWORD" node app.cjs > "$LOG" 2>&1 &
APP_PID=$!
waited=0
until grep -q "listening on" "$LOG" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 90 ] || ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "TRouteAI did not start. Last log lines:"
    tail -30 "$LOG"
    exit 1
  fi
  sleep 1
done

# Admin login and a temporary API key, written as the key file the conformance script reads.
node --input-type=module -e '
import { writeFileSync } from "node:fs";
const [base, password, file] = process.argv.slice(1);
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ password }) });
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const key = await (await fetch(base + "/api/keys", { method: "POST", headers: { origin: base, cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "kiro-mock-key" }) })).json();
if (!key.key) { console.log("FAIL  could not create an API key"); process.exit(1); }
writeFileSync(file, `id ${key.id || "-"}\n${key.key}\n`, { mode: 0o600 });
' "http://127.0.0.1:$PORT" "$PASSWORD" "$DATA/key" || exit 1

node "$HERE/anthropic-conformance.mjs" "$DATA/key" "http://127.0.0.1:$PORT" kiro/claude-sonnet-5
STATUS=$?
node "$HERE/kiro-stream-failures.mjs" "$DATA/key" "http://127.0.0.1:$PORT" kiro/claude-sonnet-5 || STATUS=1
# KIRO_MOCK_CLAUDE_CODE=1: also real Claude Code (the installed `claude`) through the server; its
# first answer is cut off by the fake Kiro, so it must retry and print the full answer.
if [ "${KIRO_MOCK_CLAUDE_CODE:-0}" = "1" ] && command -v claude >/dev/null 2>&1; then
  CC=$(mktemp -d "${TMPDIR:-/tmp}/cc-kiromock.XXXXXX")
  mkdir -p "$CC/cfg" "$CC/proj"
  for MARK in CUTOFF MIDSTREAM-EXCEPTION; do
    OUT=$(cd "$CC/proj" && echo "Reply with the answer you get. MOCK-$MARK-cc$$" | CLAUDE_CONFIG_DIR="$CC/cfg" \
      ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" ANTHROPIC_AUTH_TOKEN="$(sed -n 2p "$DATA/key")" \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p --model kiro/claude-sonnet-5 2>&1 | tail -3)
    if printf "%s" "$OUT" | grep -q "RETRY-OK"; then
      echo "PASS  real Claude Code retried a $MARK answer and printed the full one"
    else
      echo "FAIL  real Claude Code after a $MARK answer: $OUT"
      STATUS=1
    fi
  done
  rm -rf "$CC"
fi
exit $STATUS
