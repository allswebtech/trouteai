#!/bin/sh
# Every offline test suite (`npm run test:all`): the smoke test (`npm test`), the context-size
# and usage-limit routing suites, and the in-process checks that the smoke test does not run.
# Needs `npm run build` first. No account, no network beyond localhost, throwaway data folders.
# Runs the suites one after the other and exits non-zero when any of them failed.
#
#   sh tests/all.sh                        smoke, context, quota, checks
#   sh tests/all.sh context quota checks   only the named suites
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
FAILED=""

suite() {
  name=$1
  shift
  echo
  echo "=== $name"
  if "$@"; then
    echo "=== $name: passed"
  else
    echo "=== $name: FAILED"
    FAILED="$FAILED $name"
  fi
}

[ $# -eq 0 ] && set -- smoke context quota checks
for s in "$@"; do
  case "$s" in
    smoke) suite smoke sh "$HERE/smoke/run.sh" ;;
    context) suite context sh "$HERE/smoke/context.sh" ;;
    quota) suite quota sh "$HERE/smoke/quota.sh" ;;
    # the checks the smoke test does not run already
    checks) suite checks sh "$HERE/checks/run.sh" check-context-overflow.mts \
      check-quota-windows.mts check-kiro-identity.mts check-kiro-effort.mts ;;
    *) echo "unknown suite: $s (smoke, context, quota, checks)"; exit 2 ;;
  esac
done

echo
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "All suites passed."
