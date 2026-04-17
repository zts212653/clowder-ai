#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

port_in_use() {
  local port="$1"
  lsof -ti "tcp:${port}" >/dev/null 2>&1
}

pick_review_ports() {
  local front api
  for front in 3201 3211 3221 3231 3241; do
    api=$((front + 1))
    if ! port_in_use "$front" && ! port_in_use "$api"; then
      echo "$front $api"
      return 0
    fi
  done
  return 1
}

if [[ -n "${FRONTEND_PORT:-}" && -n "${API_SERVER_PORT:-}" ]]; then
  REVIEW_FRONTEND_PORT="$FRONTEND_PORT"
  REVIEW_API_PORT="$API_SERVER_PORT"
else
  read -r REVIEW_FRONTEND_PORT REVIEW_API_PORT < <(pick_review_ports) || {
    echo "No free review port pair found in the 3201/3202 review range." >&2
    exit 1
  }
fi

if [[ "$PWD" != /tmp/cat-cafe-review/* ]]; then
  echo "⚠️  review:start is intended for /tmp/cat-cafe-review/... sandboxes; current cwd: $PWD"
fi

export FRONTEND_PORT="$REVIEW_FRONTEND_PORT"
export API_SERVER_PORT="$REVIEW_API_PORT"
export PREVIEW_GATEWAY_PORT="${PREVIEW_GATEWAY_PORT:-0}"

echo "Review sandbox: $PWD"
echo "Frontend port: $FRONTEND_PORT"
echo "API port:      $API_SERVER_PORT"
echo "Preview gate:  $PREVIEW_GATEWAY_PORT"
echo "Mode:          opensource + memory"

exec node ./scripts/start-entry.mjs dev:direct --profile=opensource --memory "$@"
