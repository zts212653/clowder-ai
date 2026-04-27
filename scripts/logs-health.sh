#!/usr/bin/env bash
# F130 Phase C: Log health check — disk usage, retention, anomaly count.
# Usage: pnpm logs:health
set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
# Runtime logger writes to process.cwd()/data/..., and start-dev.sh does
# `cd packages/api && pnpm run dev`, so runtime logs land under packages/api/data/.
# Process logs are redirected by start-dev.sh using $PROJECT_DIR/data/logs/process/.
# Audit and forensic logs also use the API cwd.
API_DATA_DIR="${1:-packages/api/data}"
PROJECT_DATA_DIR="${2:-data}"
RUNTIME_LOG_DIR="$API_DATA_DIR/logs/api"
PROCESS_LOG_DIR="$PROJECT_DATA_DIR/logs/process"
AUDIT_LOG_DIR="$API_DATA_DIR/audit-logs"
FORENSIC_DIR="$API_DATA_DIR/cli-raw-archive"

WARN_DISK_MB=500          # warn if any layer exceeds this
RUNTIME_RETENTION_DAYS=14
PROCESS_RETENTION_DAYS=7
AUDIT_RETENTION_DAYS=90
FORENSIC_RETENTION_DAYS=7

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

issues=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

dir_size_mb() {
  if [ -d "$1" ]; then
    du -sm "$1" 2>/dev/null | awk '{print $1}'
  else
    echo "0"
  fi
}

file_count() {
  if [ -d "$1" ]; then
    find "$1" -type f 2>/dev/null | wc -l | tr -d ' '
  else
    echo "0"
  fi
}

oldest_file_days() {
  if [ -d "$1" ] && [ "$(find "$1" -type f 2>/dev/null | head -1)" ]; then
    local oldest
    oldest=$(find "$1" -type f -exec stat -f '%m' {} \; 2>/dev/null | sort -n | head -1)
    if [ -n "$oldest" ]; then
      local now
      now=$(date +%s)
      echo $(( (now - oldest) / 86400 ))
    else
      echo "0"
    fi
  else
    echo "0"
  fi
}

check_layer() {
  local name="$1" dir="$2" retention="$3"
  local size files age

  if [ ! -d "$dir" ]; then
    printf "  %-14s ${DIM}%-30s${RESET} %s\n" "$name" "$dir" "— (not created yet)"
    return
  fi

  size=$(dir_size_mb "$dir")
  files=$(file_count "$dir")
  age=$(oldest_file_days "$dir")

  local size_status="${GREEN}✓${RESET}"
  if [ "$size" -gt "$WARN_DISK_MB" ]; then
    size_status="${RED}⚠ exceeds ${WARN_DISK_MB}MB${RESET}"
    issues=$((issues + 1))
  fi

  local age_status=""
  if [ "$age" -gt "$retention" ]; then
    age_status=" ${YELLOW}(oldest: ${age}d > ${retention}d retention)${RESET}"
    issues=$((issues + 1))
  fi

  printf "  %-14s %4s MB  %4s files  %s%s\n" \
    "$name" "$size" "$files" "$size_status" "$age_status"
}

# ─── Error rate ──────────────────────────────────────────────────────────────

check_error_rate() {
  local log_dir="$1"
  if [ ! -d "$log_dir" ]; then return; fi

  local log_file="$log_dir/api.log"
  if [ ! -f "$log_file" ]; then return; fi

  local one_hour_ago
  one_hour_ago=$(date -v-1H +%s 2>/dev/null || date -d '1 hour ago' +%s 2>/dev/null || echo "")
  if [ -z "$one_hour_ago" ]; then return; fi

  # Pino JSON lines have "time":<epoch_ms> and "level":50 = error.
  # Filter to lines whose timestamp falls within the last hour.
  local error_count=0
  local one_hour_ago_ms=$((one_hour_ago * 1000))
  error_count=$(awk -v cutoff="$one_hour_ago_ms" -F'"time":' '
    /"level":50/ && NF>1 {
      split($2, a, /[^0-9]/); ts=a[1]+0
      if (ts >= cutoff) count++
    }
    END { print count+0 }
  ' "$log_file" 2>/dev/null)

  if [ "$error_count" -gt 100 ]; then
    printf "\n  ${RED}⚠ High error rate: %s errors in last hour${RESET}\n" "$error_count"
    issues=$((issues + 1))
  elif [ "$error_count" -gt 0 ]; then
    printf "\n  ${DIM}Errors in last hour: %s${RESET}\n" "$error_count"
  fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

echo ""
echo "🐾 Cat Café Log Health Check (F130)"
echo "────────────────────────────────────"
echo ""
echo "  Layer          Size    Files  Status"
echo "  ─────          ────    ─────  ──────"

check_layer "Runtime"   "$RUNTIME_LOG_DIR"  "$RUNTIME_RETENTION_DAYS"
check_layer "Process"   "$PROCESS_LOG_DIR"  "$PROCESS_RETENTION_DAYS"
check_layer "Audit"     "$AUDIT_LOG_DIR"    "$AUDIT_RETENTION_DAYS"
check_layer "Forensics" "$FORENSIC_DIR"     "$FORENSIC_RETENTION_DAYS"

check_error_rate "$RUNTIME_LOG_DIR"

echo ""

# ─── Config summary ─────────────────────────────────────────────────────────

echo "  Config"
echo "  ──────"
printf "  LOG_LEVEL:     %s\n" "${LOG_LEVEL:-info (default)}"
printf "  Runtime dir:   %s\n" "$RUNTIME_LOG_DIR"
printf "  Process dir:   %s\n" "$PROCESS_LOG_DIR"
printf "  Audit dir:     %s\n" "$AUDIT_LOG_DIR"
printf "  Forensics dir: %s\n" "$FORENSIC_DIR"
echo ""

if [ "$issues" -gt 0 ]; then
  printf "  ${YELLOW}⚠ %d issue(s) found — check warnings above${RESET}\n" "$issues"
  echo ""
  exit 1
else
  printf "  ${GREEN}✓ All log layers healthy${RESET}\n"
  echo ""
  exit 0
fi
