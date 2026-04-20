#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

port_in_use() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:${port}" >/dev/null 2>&1; then
    return 0
  fi

  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR > 1 { found = 1; exit } END { exit found ? 0 : 1 }'; then
    return 0
  fi

  if command -v nc >/dev/null 2>&1 && {
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z localhost "$port" >/dev/null 2>&1
  }; then
    return 0
  fi

  if (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 || (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1; then
    return 0
  fi

  return 1
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
