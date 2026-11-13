#!/bin/sh
# Context-size test: mock Claude-style upstream + TRouteAI with a throwaway data folder,
# run context-e2e.mjs, clean up.
#
#   sh tests/smoke/context.sh         test the project build (node app.cjs; run npm run build first)
#
# Env: CONTEXT_PORT (default 8817), CONTEXT_MOCK_PORT (default 20996)
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${CONTEXT_PORT:-8817}
MOCK_PORT=${CONTEXT_MOCK_PORT:-20996}
PASSWORD="Context-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-context.XXXXXX")
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
    echo "Port $p is already in use; set CONTEXT_PORT / CONTEXT_MOCK_PORT to free ports."; exit 1
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
node "$HERE/context-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT"
S1=$?
if [ -n "${CONTEXT_KEEP_LOG:-}" ]; then cp "$DATA/app.log" "$CONTEXT_KEEP_LOG"; fi
ERRORS=$(grep -nE "Error: |FATAL|Cannot find (module|package)" "$DATA/app.log" | head -5)
[ -n "$ERRORS" ] && { echo "App log errors:"; echo "$ERRORS"; }
[ $S1 -eq 0 ]
