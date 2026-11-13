#!/bin/sh
# Usage-limit routing test: mock Claude-style upstream + TRouteAI with a throwaway data folder,
# run quota-e2e.mjs, restart TRouteAI on the same data, run the restart check, clean up.
#
#   sh tests/smoke/quota.sh           test the project build (node app.cjs; run npm run build first)
#
# Env: QUOTA_PORT (default 8815), QUOTA_MOCK_PORT (default 20998)
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${QUOTA_PORT:-8815}
MOCK_PORT=${QUOTA_MOCK_PORT:-20998}
PASSWORD="Quota-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-quota.XXXXXX")
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
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start_app() {
  cd "$APP_DIR" || exit 1
  : > "$DATA/app.log"
  DATA_DIR="$DATA" PORT="$PORT" INITIAL_PASSWORD="$PASSWORD" node app.cjs >> "$DATA/app.log" 2>&1 &
  APP_PID=$!
  waited=0
  until grep -q "listening on" "$DATA/app.log" 2>/dev/null; do
    waited=$((waited + 1))
    if [ "$waited" -gt 90 ] || ! kill -0 "$APP_PID" 2>/dev/null; then
      echo "TRouteAI did not start:"; tail -30 "$DATA/app.log"; exit 1
    fi
    sleep 1
  done
}

for p in "$PORT" "$MOCK_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is already in use; set QUOTA_PORT / QUOTA_MOCK_PORT to free ports."; exit 1
  fi
done

node "$HERE/mock-anthropic.mjs" "$MOCK_PORT" > "$DATA/mock.log" 2>&1 &
MOCK_PID=$!
waited=0
until grep -q "mock anthropic on" "$DATA/mock.log" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 20 ] || ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "Mock upstream did not start:"; cat "$DATA/mock.log"; exit 1
  fi
  sleep 0.5
done
start_app
node "$HERE/quota-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT" main "$DATA/state.json"
S1=$?
cp "$DATA/app.log" "$DATA/app-main.log"
stop_app
start_app
node "$HERE/quota-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT" after "$DATA/state.json"
S2=$?
if [ -n "${QUOTA_KEEP_LOG:-}" ]; then cp "$DATA/app-main.log" "$QUOTA_KEEP_LOG"; fi
ERRORS=$(grep -nE "Error: |FATAL|Cannot find (module|package)" "$DATA/app-main.log" "$DATA/app.log" | head -5)
[ -n "$ERRORS" ] && { echo "App log errors:"; echo "$ERRORS"; }
[ $S1 -eq 0 ] && [ $S2 -eq 0 ]
