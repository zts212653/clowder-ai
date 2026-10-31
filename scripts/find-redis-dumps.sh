#!/usr/bin/env bash
set -euo pipefail

# Find candidate Redis dump files from local paths and Time Machine backups.
# Read-only helper for recovery workflows.
#
# Usage:
#   ./scripts/find-redis-dumps.sh
#   ./scripts/find-redis-dumps.sh --max-depth 8

MAX_DEPTH=8
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-depth)
      if [[ $# -lt 2 ]]; then
        echo "[find-dumps] --max-depth needs a number" >&2
        exit 2
      fi
      MAX_DEPTH="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,14p' "$0"
      exit 0
      ;;
    *)
      echo "[find-dumps] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

declare -a ROOTS=(
  "$PWD"
  "$HOME/.cat-cafe"
  "/opt/homebrew/var/db/redis"
)

declare -a TM_ROOTS=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  TM_ROOTS+=("$line")
done < <(tmutil listbackups 2>/dev/null || true)

if [[ -d "/Volumes" ]]; then
  while IFS= read -r vol; do
    ROOTS+=("$vol")
  done < <(find /Volumes -maxdepth 3 -type d -name "Backups.backupdb" 2>/dev/null || true)
fi

for tm in "${TM_ROOTS[@]}"; do
  ROOTS+=("$tm")
done

declare -a dumps=()
TMP_FILE="$(mktemp -t cat-cafe-dumps.XXXXXX)"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT INT TERM

find_from_root() {
  local root="$1"
  [[ ! -e "$root" ]] && return 0
  find "$root" -maxdepth "$MAX_DEPTH" -type f \( -name "dump.rdb" -o -name "*.rdb" \) 2>/dev/null >> "$TMP_FILE" || true
}

for root in "${ROOTS[@]}"; do
  find_from_root "$root"
done

while IFS= read -r f; do
  [[ -n "$f" ]] && dumps+=("$f")
done < <(sort -u "$TMP_FILE")

if [[ "${#dumps[@]}" -eq 0 ]]; then
  echo "[find-dumps] no dump files found"
  exit 0
fi

echo "Found ${#dumps[@]} dump candidates:"
for f in "${dumps[@]}"; do
  if [[ -f "$f" ]]; then
    size="$(stat -f '%z' "$f" 2>/dev/null || echo 0)"
    mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$f" 2>/dev/null || echo 'unknown')"
    printf '  - %s bytes | %s | %s\n' "$size" "$mtime" "$f"
  fi
done
