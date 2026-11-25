#!/bin/sh
# Idle check: starts the built server (node app.cjs) with a few fake providers, an API key and a
# fake proxy, sends it nothing for IDLE_WAIT_SECONDS (default 75) and then fails when a timer
# shorter than a minute is alive or a connection out of the machine was attempted. Then it calls
# /healthz (a health probe must not count as use) and one dashboard route (a real request must
# wake the paused jobs again). idle-probe.cjs records timers and blocks every outbound connection,
# so nothing leaves this machine. Needs `npm run build` first.
#
# Env: IDLE_PORT (default 8813), IDLE_WAIT_SECONDS (default 75), IDLE_KEEP_LOG (a file path)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${IDLE_PORT:-8813}
WAIT=${IDLE_WAIT_SECONDS:-75}
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-idle.XXXXXX")
LOG="$DATA/app.log"
PROBE="$DATA/probe.jsonl"
APP_PID=""

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
  [ -n "${IDLE_KEEP_LOG:-}" ] && cp "$LOG" "$IDLE_KEEP_LOG" 2>/dev/null
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

DATA_DIR="$DATA"
STORAGE_ENCRYPTION_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')
API_KEY_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
export DATA_DIR STORAGE_ENCRYPTION_KEY JWT_SECRET API_KEY_SECRET

cd "$APP_DIR" || exit 1
if ! IDLE_SEED_EXPIRING=1 IDLE_SEED_PROXY=1 npx --no-install tsx --tsconfig tsconfig.json \
  "$HERE/idle-seed.mts" > "$DATA/seed.log" 2>&1; then
  echo "FAIL  could not add the fake providers"
  grep -v '^\[' "$DATA/seed.log" | tail -5
  exit 1
fi

# The probe goes in through NODE_OPTIONS: as a command-line flag its "tests" path would make the
# server believe it runs under a test runner and switch its background jobs off.
PORT="$PORT" INITIAL_PASSWORD="Idle-Test-Pass-123" IDLE_PROBE_OUT="$PROBE" \
  NODE_OPTIONS="--require $HERE/idle-probe.cjs" node app.cjs > "$LOG" 2>&1 &
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

sample() {
  printf '{"label":"%s"}' "$1" > "$PROBE.cmd"
  kill -USR2 "$APP_PID"
  n=0
  until grep -q "\"label\":\"$1\"" "$PROBE" 2>/dev/null || [ "$n" -gt 20 ]; do
    sleep 0.5
    n=$((n + 1))
  done
}
get() {
  node -e 'fetch(process.argv[1]).then((r) => r.text()).catch(() => {})' "http://127.0.0.1:$PORT$1"
}

sleep "$WAIT"
sample idle
get /healthz
sleep 2
sample after-health
get /api/settings
sleep 3
sample after-request
stop_app

node "$HERE/idle-check.mjs" "$PROBE"
