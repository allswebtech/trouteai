#!/bin/sh
# The Restart button (POST /api/restart) must bring the gateway back when it is started with the
# `trouteai` command: same port, same parent process, a new server process (`sh tests/all.sh restart`).
# Without that parent the route must refuse with 409 and say where to restart. Needs `npm run build`.
# Throwaway data folder; no account, no network beyond localhost.
#
# Env: RESTART_PORT (default 21176)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${RESTART_PORT:-21176}
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-restart.XXXXXX")
APP_PID=""
cleanup() {
  [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null
  n=0
  while [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null && [ "$n" -lt 30 ]; do sleep 0.5; n=$((n + 1)); done
  [ -n "$APP_PID" ] && kill -KILL "$APP_PID" 2>/dev/null
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cd "$APP_DIR" || exit 1

fail() { echo "FAIL  $1"; exit 1; }
pass() { echo "PASS  $1"; }
health() { curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; }
wait_health() { # wait_health <seconds>
  n=0
  while [ "$n" -lt "$(($1 * 2))" ]; do
    [ "$(health)" = "200" ] && return 0
    sleep 0.5
    n=$((n + 1))
  done
  return 1
}
post_restart() {
  curl -s -o "$DATA/restart.body" -w '%{http_code}' --max-time 5 -X POST \
    -H "x-trouteai-cli-token: $(cat "$DATA/cli-token")" "http://127.0.0.1:$PORT/api/restart"
}

# 1. Started with the command: the restart brings it back.
INITIAL_PASSWORD="Restart-Test-Pass-123" node bin/trouteai.mjs --port "$PORT" --data-dir "$DATA" > "$DATA/app.log" 2>&1 &
APP_PID=$!
wait_health 60 || { tail -20 "$DATA/app.log"; fail "the server did not start"; }
CHILD1=$(pgrep -P "$APP_PID" | head -1)
[ -n "$CHILD1" ] || fail "the command has no server process under it"
pass "started, server process $CHILD1 under $APP_PID"
CODE=$(post_restart)
[ "$CODE" = "200" ] || fail "POST /api/restart answered $CODE"
pass "POST /api/restart answered 200"
n=0
while kill -0 "$CHILD1" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 0.5; n=$((n + 1)); done
kill -0 "$CHILD1" 2>/dev/null && fail "the old server process is still there"
wait_health 30 || { tail -20 "$DATA/app.log"; fail "/healthz did not answer again within 30 s"; }
kill -0 "$APP_PID" 2>/dev/null || fail "the parent is gone"
CHILD2=$(pgrep -P "$APP_PID" | head -1)
[ -n "$CHILD2" ] && [ "$CHILD2" != "$CHILD1" ] || fail "no new server process under the same parent"
pass "/healthz answers again on port $PORT, new server process $CHILD2, same parent $APP_PID"

# 2. A second restart works too.
CODE=$(post_restart)
[ "$CODE" = "200" ] || fail "the second POST /api/restart answered $CODE"
n=0
while kill -0 "$CHILD2" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 0.5; n=$((n + 1)); done
wait_health 30 || fail "/healthz did not answer after the second restart"
pass "a second restart works"

# 3. Ctrl+C / SIGTERM on the parent still stops everything and does not restart.
kill -TERM "$APP_PID"
n=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$n" -lt 40 ]; do sleep 0.5; n=$((n + 1)); done
kill -0 "$APP_PID" 2>/dev/null && fail "the command did not stop on SIGTERM"
APP_PID=""
sleep 1
[ "$(health)" = "200" ] && fail "the server answers after the command was stopped"
pass "stopping the command stops the server"
exit 0
