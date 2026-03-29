#!/bin/zsh
# Cat Café Desktop — Bootstrap Script
# Starts API + Web servers, manages process lifecycle.
# Usage: bootstrap.sh [project-root]

set -euo pipefail

# Resolve project root
if [ -n "${1:-}" ]; then
  PROJECT_ROOT="$1"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_ROOT="$SCRIPT_DIR/../../.."
fi
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
  echo "ERROR: Cannot find project root at $PROJECT_ROOT" >&2
  exit 1
fi

# Environment — isolated from runtime (3003/3004/6399)
export MEMORY_STORE=1
export REDIS_URL=""
unset REDIS_URL
export API_SERVER_PORT="${API_SERVER_PORT:-13004}"
export API_SERVER_HOST="${API_SERVER_HOST:-127.0.0.1}"
export FRONTEND_PORT="${FRONTEND_PORT:-13003}"
export PORT="$FRONTEND_PORT"
export NEXT_PUBLIC_API_URL="http://localhost:${API_SERVER_PORT}"

API_PID=""
WEB_PID=""

cleanup() {
  echo "[desktop] Shutting down servers..."
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "[desktop] Shutdown complete."
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP EXIT

echo "[desktop] Project root: $PROJECT_ROOT"
echo "[desktop] Starting API on :${API_SERVER_PORT}, Web on :${FRONTEND_PORT}"
echo "[desktop] Storage mode: memory (no Redis)"

# Start API server
(cd "$PROJECT_ROOT/packages/api" && exec node dist/index.js) &
API_PID=$!
echo "[desktop] API PID: $API_PID"

# Start Web server
(cd "$PROJECT_ROOT/packages/web" && exec npx next start -p "$FRONTEND_PORT") &
WEB_PID=$!
echo "[desktop] Web PID: $WEB_PID"

# Wait for either to exit
wait "$API_PID" "$WEB_PID" 2>/dev/null || true

echo "[desktop] A server process exited unexpectedly" >&2
cleanup
