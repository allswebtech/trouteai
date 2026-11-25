#!/bin/sh
# Load playback: mock-load.mjs (three accounts, a few slots each, one with its quota used up) +
# the built TRouteAI with a throwaway data folder, then load-e2e.mjs: 650 requests to one
# round-robin combo in about a minute. Fails when the gateway refuses while a slot is free,
# says "usage limit" while an account has quota, leaves out Retry-After, loads one account
# with more than 65 % or answers with another model name.
#
#   sh tests/smoke/load.sh        test the project build (node app.cjs; run npm run build first)
#
# Env: LOAD_PORT (default 8817), LOAD_MOCK_PORT (default 20994), LOAD_APP_DIR (default this
#      repository), LOAD_SECONDS (default 60), LOAD_SLOTS (default 3), LOAD_ANSWER_MS
#      (default 1500), LOAD_OUT (copy of the JSON summary), LOAD_KEEP_LOG (copy of the app log)
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "${LOAD_APP_DIR:-$HERE/../..}" && pwd) || exit 1
PORT=${LOAD_PORT:-8817}
MOCK_PORT=${LOAD_MOCK_PORT:-20994}
PASSWORD="Load-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-load.XXXXXX")
APP_PID=""
MOCK_PID=""

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
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for p in "$PORT" "$MOCK_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is already in use; set LOAD_PORT / LOAD_MOCK_PORT to free ports."; exit 1
  fi
done

node "$HERE/mock-load.mjs" "$MOCK_PORT" > "$DATA/mock.log" 2>&1 &
MOCK_PID=$!
waited=0
until grep -q "mock load on" "$DATA/mock.log" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 20 ] || ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "Mock upstream did not start:"; cat "$DATA/mock.log"; exit 1
  fi
  sleep 0.5
done

(cd "$APP_DIR" && DATA_DIR="$DATA" PORT="$PORT" API_PORT="$PORT" DASHBOARD_PORT="$PORT" \
  INITIAL_PASSWORD="$PASSWORD" exec node app.cjs) > "$DATA/app.log" 2>&1 &
APP_PID=$!
waited=0
until grep -q "listening on" "$DATA/app.log" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 90 ] || ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "TRouteAI did not start:"; tail -30 "$DATA/app.log"; exit 1
  fi
  sleep 1
done

node "$HERE/load-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT" \
  "$DATA/summary.json" "$DATA/app.log"
S=$?
[ -n "${LOAD_OUT:-}" ] && [ -f "$DATA/summary.json" ] && cp "$DATA/summary.json" "$LOAD_OUT"
[ -n "${LOAD_KEEP_LOG:-}" ] && cp "$DATA/app.log" "$LOAD_KEEP_LOG"
exit $S
