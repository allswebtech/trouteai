#!/bin/sh
# Every offline test suite (`npm run test:all`): the smoke test (`npm test`), the context-size
# and usage-limit routing suites, the status-code contract suite, the model list suite, what
# programs around the gateway rely on (fit), the idle check, the load playback, and the in-process checks that the
# smoke test does not run.
# Needs `npm run build` first. No account, no network beyond localhost, throwaway data folders.
# Runs the suites one after the other and exits non-zero when any of them failed.
#
#   sh tests/all.sh                        every suite: smoke, context, quota, status, answers,
#                                          models, fit, idle, load, checks
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

[ $# -eq 0 ] && set -- smoke context quota status answers models fit idle load checks
for s in "$@"; do
  case "$s" in
    smoke) suite smoke sh "$HERE/smoke/run.sh" ;;
    context) suite context sh "$HERE/smoke/context.sh" ;;
    quota) suite quota sh "$HERE/smoke/quota.sh" ;;
    status) suite status sh "$HERE/smoke/status.sh" ;;
    answers) suite answers sh "$HERE/smoke/answers.sh" ;;
    models) suite models sh "$HERE/smoke/models.sh" ;;
    fit) suite fit sh "$HERE/smoke/fit.sh" ;;
    idle) suite idle sh "$HERE/smoke/idle.sh" ;;
    load) suite load sh "$HERE/smoke/load.sh" ;;
    # the checks the smoke test does not run already
    checks) suite checks sh "$HERE/checks/run.sh" check-context-overflow.mts \
      check-quota-windows.mts check-kiro-identity.mts check-kiro-effort.mts \
      check-stream-flag.mts check-kiro-wire.mts \
      check-status-mapping.mts check-claude-upstream.mts check-claude-fixes.mts \
      check-claude-reference.mts check-vision.mts check-answer-model.mts \
      check-models-catalog.mts check-swaps.mts check-combo-status.mts \
      check-cache-pass.mts check-fair-queue.mts check-cost-view.mts \
      check-new-conversations.mts check-high-load.mts check-key-priority.mts ;;
    *) echo "unknown suite: $s (smoke, context, quota, status, answers, models, fit, idle, load, checks)"; exit 2 ;;
  esac
done

echo
if [ -n "$FAILED" ]; then
  echo "FAILED:$FAILED"
  exit 1
fi
echo "All suites passed."
