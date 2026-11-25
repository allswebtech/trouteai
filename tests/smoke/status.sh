#!/bin/sh
# Status-code contract test: mock Claude-style upstream + TRouteAI with a throwaway data folder,
# run status-e2e.mjs, clean up. A short upstream time-out (6 s, longer than the executor's
# two 2 s retries of a 429) lets the time-out case finish fast.
#
#   sh tests/smoke/status.sh          test the project build (node app.cjs; run npm run build first)
#
# Env: STATUS_PORT (default 21160), STATUS_MOCK_PORT (default 21161)
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${STATUS_PORT:-21160}
MOCK_PORT=${STATUS_MOCK_PORT:-21161}
PASSWORD="Status-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-status.XXXXXX")
APP_PID=""
MOCK_PID=""

cleanup() {
  if [ -n "$APP_PID" ]; then
    kill -INT "$APP_PID" 2>/dev/null
    n=0
    while kill -0 "$APP_PID" 2>/dev/null && [ "$n" -lt 30 ]; do
      sleep 0.5
      n=$((n + 1))
    done
    kill -KILL "$APP_PID" 2>/dev/null
  fi
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  if [ -n "${STATUS_KEEP_LOG:-}" ] && [ -f "$DATA/app.log" ]; then cp "$DATA/app.log" "$STATUS_KEEP_LOG"; fi
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for p in "$PORT" "$MOCK_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is already in use; set STATUS_PORT / STATUS_MOCK_PORT to free ports."; exit 1
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

cd "$APP_DIR" || exit 1
DATA_DIR="$DATA" PORT="$PORT" INITIAL_PASSWORD="$PASSWORD" FETCH_TIMEOUT_MS=6000 \
  node app.cjs > "$DATA/app.log" 2>&1 &
APP_PID=$!
waited=0
until grep -q "listening on" "$DATA/app.log" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 90 ] || ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "TRouteAI did not start:"; tail -30 "$DATA/app.log"; exit 1
  fi
  sleep 1
done

node "$HERE/status-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT"
S=$?
ERRORS=$(grep -nE "FATAL|Cannot find (module|package)" "$DATA/app.log" | head -5)
[ -n "$ERRORS" ] && { echo "App log errors:"; echo "$ERRORS"; S=1; }
exit $S
