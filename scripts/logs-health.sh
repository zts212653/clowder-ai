#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

LOG_LEVEL_VALUE="${LOG_LEVEL:-info}"

declare -a LABELS=("audit" "forensics" "runtime" "process")
declare -a PATHS=(
  "$PROJECT_DIR/data/audit-logs"
  "$PROJECT_DIR/data/cli-raw-internal-archive"
  "$PROJECT_DIR/data/logs/api"
  "$PROJECT_DIR/data/logs/process"
)
declare -a RETENTION_DAYS=(90 7 14 7)

du_kb() {
  local target="$1"
  if [ ! -d "$target" ]; then
    echo 0
    return 0
  fi
  du -sk "$target" | awk '{print $1}'
}

old_file_count() {
  local target="$1"
  local days="$2"
  if [ ! -d "$target" ]; then
    echo 0
    return 0
  fi
  find "$target" -type f -mtime +"$days" | wc -l | tr -d ' '
}

error_like_count() {
  local target="$1"
  local rg_output
  local rg_status
  if [ ! -d "$target" ]; then
    echo 0
    return 0
  fi
  if rg_output="$(rg -i -c 'error|fatal|panic|uncaught' "$target" 2>/dev/null)"; then
    printf '%s\n' "$rg_output" | awk -F: '{sum += $NF} END {print sum + 0}'
    return 0
  else
    rg_status=$?
  fi

  if [ "$rg_status" -eq 1 ]; then
    echo 0
    return 0
  fi

  return "$rg_status"
}

VIOLATIONS=0

echo "Log Health"
echo "=========="
echo "LOG_LEVEL: $LOG_LEVEL_VALUE"
echo ""

for idx in "${!LABELS[@]}"; do
  label="${LABELS[$idx]}"
  target="${PATHS[$idx]}"
  keep_days="${RETENTION_DAYS[$idx]}"
  size_kb=$(du_kb "$target")
  stale_count=$(old_file_count "$target" "$keep_days")
  error_count=$(error_like_count "$target")
  status="ok"

  if [ ! -d "$target" ]; then
    status="missing"
  elif [ "$stale_count" -gt 0 ]; then
    status="retention-violation"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi

  printf '[%s] %s\n' "$status" "$label"
  echo "  path:      $target"
  echo "  size_kb:   $size_kb"
  echo "  retention: ${keep_days}d"
  echo "  stale:     $stale_count"
  echo "  errors:    $error_count"
  echo ""
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "logs-health detected $VIOLATIONS retention violation(s)." >&2
  exit 1
fi
