#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ALPHA_SCRIPT="$SCRIPT_DIR/alpha-worktree.sh"

ALPHA_WEB_PORT="${CAT_CAFE_ALPHA_WEB_PORT:-3011}"
ALPHA_API_PORT="${CAT_CAFE_ALPHA_API_PORT:-3012}"
ALPHA_GATEWAY_PORT="${CAT_CAFE_ALPHA_GATEWAY_PORT:-4111}"
ALPHA_REDIS_PORT="${CAT_CAFE_ALPHA_REDIS_PORT:-6398}"

usage() {
  cat <<'EOF'
Usage: scripts/alpha-worktree.test.sh

Smoke-check a running alpha environment:
  - alpha-worktree status reports api_running=yes
  - API health endpoint responds on 3012
  - frontend responds on 3011
  - preview gateway proxies 3011 through 4111
  - Redis answers PING on 6398 (when redis-cli is available)
EOF
}

die() {
  echo "[alpha-worktree.test] ERROR: $*" >&2
  exit 1
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

[ -x "$ALPHA_SCRIPT" ] || die "alpha-worktree.sh is not executable: $ALPHA_SCRIPT"

STATUS_OUTPUT="$("$ALPHA_SCRIPT" status)"
echo "$STATUS_OUTPUT"

printf '%s\n' "$STATUS_OUTPUT" | grep -q '^api_running: yes$' \
  || die "alpha API is not running; start alpha first with 'pnpm alpha:start'"

curl -fsS "http://127.0.0.1:${ALPHA_API_PORT}/health" | grep -q '"status":"ok"' \
  || die "API health check failed on port ${ALPHA_API_PORT}"

curl -fsS -o /dev/null "http://127.0.0.1:${ALPHA_WEB_PORT}/" \
  || die "frontend did not respond on port ${ALPHA_WEB_PORT}"

curl -fsS -o /dev/null "http://127.0.0.1:${ALPHA_GATEWAY_PORT}/?__preview_port=${ALPHA_WEB_PORT}" \
  || die "preview gateway did not proxy frontend on port ${ALPHA_GATEWAY_PORT}"

if command -v redis-cli >/dev/null 2>&1; then
  [ "$(redis-cli -p "$ALPHA_REDIS_PORT" ping 2>/dev/null || true)" = "PONG" ] \
    || die "redis did not answer PING on port ${ALPHA_REDIS_PORT}"
fi

echo "[alpha-worktree.test] alpha stack healthy"
