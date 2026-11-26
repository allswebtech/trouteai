#!/bin/sh
# What programs that start TRouteAI or sit in front of it rely on (`sh tests/all.sh fit`):
# the in-process checks (check-fit, check-cli-token, check-provider-catalog, check-login-link in
# tests/checks), then fit-e2e.mjs, which starts the
# `trouteai` command like a supervisor against a slow fake provider. Needs `npm run build` first.
# Throwaway data folders only; no account, no network beyond localhost.
#
# Env: FIT_PORT (default 21174), FIT_MOCK_PORT (default 21175)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$HERE/../.." && pwd) || exit 1
PORT=${FIT_PORT:-21174}
MOCK_PORT=${FIT_MOCK_PORT:-21175}
cd "$APP_DIR" || exit 1

STATUS=0
sh "$APP_DIR/tests/checks/run.sh" check-fit.mts check-cli-token.mts check-provider-catalog.mts check-login-link.mts || STATUS=1
node "$HERE/fit-e2e.mjs" "$PORT" "$MOCK_PORT" || STATUS=1
exit $STATUS
