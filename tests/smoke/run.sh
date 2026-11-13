#!/bin/sh
# One-command smoke test for TRouteAI (`npm test`). Uses a throwaway data folder, so the
# default data folder (~/.trouteai) is never touched.
#
#   sh tests/smoke/run.sh             test the project build (node app.cjs; run `npm run build` first)
#   sh tests/smoke/run.sh trouteai    test an installed npm package (the `trouteai` command)
#
# It starts mock-upstream.mjs (a fake OpenAI-compatible provider), starts TRouteAI with a
# temporary data folder and a known password, runs e2e.mjs, and stops both. For the project
# build it then runs the Claude Code -> Kiro checks that need no account and no network
# (tests/checks/*.mts and kiro-mock.sh against a fake Kiro); SMOKE_SKIP_KIRO=1 skips them.
#
# Env: SMOKE_PORT (default 8799), SMOKE_MOCK_PORT (default 20997)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${SMOKE_PORT:-8799}
MOCK_PORT=${SMOKE_MOCK_PORT:-20997}
PASSWORD="Smoke-Test-Pass-123"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-smoke.XXXXXX")
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
  rm -rf "$DATA"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

node "$HERE/mock-upstream.mjs" "$MOCK_PORT" > "$DATA/mock.log" 2>&1 &
MOCK_PID=$!

cd "$APP_DIR" || exit 1
if [ $# -eq 0 ]; then set -- node app.cjs; fi
# Environment variables win over the project .env and over the CLI settings file.
DATA_DIR="$DATA" PORT="$PORT" INITIAL_PASSWORD="$PASSWORD" "$@" > "$LOG" 2>&1 &
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
grep "listening on" "$LOG"

PAGES=$(cd "$APP_DIR/src/app/(dashboard)" && find . -name page.tsx | sed 's#^\./##; s#/page.tsx$##; s#^#/#' | grep -v '\[' | sort | paste -sd, -)
PAGES="$PAGES" node "$HERE/e2e.mjs" "http://127.0.0.1:$PORT" "$PASSWORD" "http://127.0.0.1:$MOCK_PORT/v1"
STATUS=$?

ERRORS=$(grep -nE "Error: |FATAL|Cannot find (module|package)" "$LOG" | head -5)
if [ -n "$ERRORS" ]; then
  echo "App log errors:"
  echo "$ERRORS"
fi
# The server is not needed any more; stop it before the next server starts.
stop_app

# Project build only (not an installed package): the Claude Code -> Kiro checks that need no
# account and no network. SMOKE_SKIP_KIRO=1 skips them.
if [ "$1" = "node" ] && [ "${SMOKE_SKIP_KIRO:-0}" != "1" ]; then
  echo
  echo "Claude Code -> Kiro checks (no network):"
  KIRO_FAILED=0
  sh "$APP_DIR/tests/checks/run.sh" check-kiro-refusal.mts check-count-tokens.mts \
    check-kiro-usage.mts check-claude-display.mts check-web-search.mts || KIRO_FAILED=1
  OUT=$(sh "$HERE/kiro-mock.sh" 2>&1)
  KIRO_MOCK_CODE=$?
  PASSES=$(printf "%s\n" "$OUT" | grep -c "^PASS")
  FAILS=$(printf "%s\n" "$OUT" | grep -c "^FAIL")
  echo "  Messages API conformance through the server, fake Kiro: $PASSES passed, $FAILS failed"
  if [ "$FAILS" -gt 0 ]; then
    printf "%s\n" "$OUT" | grep "^FAIL" | head -5
    KIRO_FAILED=1
  elif [ "$PASSES" -eq 0 ] || [ "$KIRO_MOCK_CODE" -ne 0 ]; then
    printf "%s\n" "$OUT" | tail -10
    KIRO_FAILED=1
  fi
  [ "$KIRO_FAILED" -ne 0 ] && STATUS=1
fi
exit $STATUS
