#!/bin/sh
# Runs in-process checks (tests/checks/check-*.mts) with tsx, each with its own throwaway
# DATA_DIR, and prints one summary line per check. No server, no network.
#
#   sh tests/checks/run.sh check-kiro-refusal.mts check-web-search.mts ...
#   sh tests/checks/run.sh                 every check in this folder
#
# A check fails when it prints a FAIL line, prints no PASS line, or exits non-zero.
# CHECKS_VERBOSE=1 prints the full output of every check.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
cd "$APP_DIR" || exit 1

if [ $# -eq 0 ]; then
  set -- $(cd "$HERE" && ls check-*.mts)
fi

FAILED=0
for check in "$@"; do
  CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/trouteai-check.XXXXXX")
  OUT=$(DATA_DIR="$CHECK_DIR" npx --no-install tsx --tsconfig tsconfig.json "$HERE/$check" 2>&1)
  CODE=$?
  rm -rf "$CHECK_DIR"
  PASSES=$(printf "%s\n" "$OUT" | grep -c "^PASS")
  FAILS=$(printf "%s\n" "$OUT" | grep -c "^FAIL")
  echo "  $check: $PASSES passed, $FAILS failed"
  [ "${CHECKS_VERBOSE:-0}" = "1" ] && printf "%s\n" "$OUT"
  if [ "$FAILS" -gt 0 ]; then
    printf "%s\n" "$OUT" | grep "^FAIL" | head -5
    FAILED=1
  elif [ "$PASSES" -eq 0 ] || [ "$CODE" -ne 0 ]; then
    echo "    exit code $CODE; last lines:"
    printf "%s\n" "$OUT" | tail -10
    FAILED=1
  fi
done
exit $FAILED
