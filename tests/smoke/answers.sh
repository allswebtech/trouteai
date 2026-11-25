#!/bin/sh
# Answer naming test: mock Claude-style upstream + TRouteAI with a throwaway data folder, run
# answers-e2e.mjs, clean up.
#
#   sh tests/smoke/answers.sh         test the project build (node app.cjs; run npm run build first)
#
# Env: ANSWERS_PORT (default 21110), ANSWERS_MOCK_PORT (default 21111)
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${ANSWERS_PORT:-21110}
MOCK_PORT=${ANSWERS_MOCK_PORT:-21111}
PASSWORD="Answers-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-answers.XXXXXX")
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

for p in "$PORT" "$MOCK_PORT"; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $p is already in use; set ANSWERS_PORT / ANSWERS_MOCK_PORT to free ports."; exit 1
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
DATA_DIR="$DATA" PORT="$PORT" INITIAL_PASSWORD="$PASSWORD" node app.cjs > "$DATA/app.log" 2>&1 &
APP_PID=$!
waited=0
until grep -q "listening on" "$DATA/app.log" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 90 ] || ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "TRouteAI did not start:"; tail -30 "$DATA/app.log"; exit 1
  fi
  sleep 1
done

node "$HERE/answers-e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT"
STATUS=$?
if [ -n "${ANSWERS_KEEP_LOG:-}" ]; then cp "$DATA/app.log" "$ANSWERS_KEEP_LOG"; fi
ERRORS=$(grep -nE "Error: |FATAL|Cannot find (module|package)" "$DATA/app.log" | head -5)
[ -n "$ERRORS" ] && { echo "App log errors:"; echo "$ERRORS"; }
exit $STATUS
