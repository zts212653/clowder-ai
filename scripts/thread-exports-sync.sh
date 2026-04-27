#!/usr/bin/env bash
set -euo pipefail

# Sync downloaded thread markdown exports into:
# 1) Repo canonical directory
# 2) Offsite backup directory (iCloud by default when available)
#
# Usage:
#   ./scripts/thread-exports-sync.sh sync
#   ./scripts/thread-exports-sync.sh status

ACTION="${1:-status}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT_PRIMARY="${THREAD_EXPORT_SOURCE_ROOT:-$HOME/Downloads}"
LEGACY_SOURCE_ROOT="${THREAD_EXPORT_LEGACY_SOURCE_ROOT:-$PROJECT_DIR/docs/discussions}"
INCLUDE_LEGACY="${THREAD_EXPORT_INCLUDE_LEGACY:-1}"
REPO_DIR="${THREAD_EXPORT_REPO_DIR:-$PROJECT_DIR/docs/discussions/exported-threads}"

ICLOUD_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DEFAULT_OFFSITE_ROOT="$HOME/.cat-cafe/thread-exports"
if [[ -d "$ICLOUD_ROOT" ]]; then
  DEFAULT_OFFSITE_ROOT="$ICLOUD_ROOT/CatCafeThreadExports"
fi
OFFSITE_ROOT="${THREAD_EXPORT_OFFSITE_DIR:-$DEFAULT_OFFSITE_ROOT}"
KEEP_SNAPSHOTS="${THREAD_EXPORT_KEEP_SNAPSHOTS:-30}"

ensure_dirs() {
  mkdir -p "$SOURCE_ROOT_PRIMARY" "$REPO_DIR" "$OFFSITE_ROOT/latest" "$OFFSITE_ROOT/snapshots"
}

list_source_files() {
  {
    if [[ -d "$SOURCE_ROOT_PRIMARY" ]]; then
      find "$SOURCE_ROOT_PRIMARY" -maxdepth 1 -type f -name 'thread-thread_*.md' 2>/dev/null || true
    fi
    if [[ "$INCLUDE_LEGACY" == "1" && -d "$LEGACY_SOURCE_ROOT" ]]; then
      find "$LEGACY_SOURCE_ROOT" -type f -name 'thread-thread_*.md' ! -path "$REPO_DIR/*" 2>/dev/null || true
    fi
  } | awk '!seen[$0]++' | sort
}

list_repo_files() {
  find "$REPO_DIR" -type f -name 'thread-thread_*.md' | sort
}

sync_one_file() {
  local src="$1"
  local base canon
  base="$(basename "$src")"
  canon="$REPO_DIR/$base"

  if [[ "$src" != "$canon" ]]; then
    if [[ ! -f "$canon" ]] || ! cmp -s "$src" "$canon"; then
      cp -p "$src" "$canon"
    fi
  fi
}

prune_snapshots() {
  local keep="$1"
  local snapshots=()
  while IFS= read -r d; do
    snapshots+=("$d")
  done < <(find "$OFFSITE_ROOT/snapshots" -mindepth 1 -maxdepth 1 -type d | sort -r)

  if [[ "${#snapshots[@]}" -le "$keep" ]]; then
    return
  fi

  local i
  for ((i=keep; i<${#snapshots[@]}; i++)); do
    rm -rf "${snapshots[$i]}"
  done
}

sync_all() {
  ensure_dirs
  local src
  while IFS= read -r src; do
    sync_one_file "$src"
  done < <(list_source_files)

  local stamp snapshot manifest copied=0
  stamp="$(date '+%Y%m%d-%H%M%S')"
  snapshot="$OFFSITE_ROOT/snapshots/$stamp"
  manifest="$snapshot/manifest.txt"
  mkdir -p "$snapshot"

  : > "$manifest"
  local f base
  while IFS= read -r f; do
    base="$(basename "$f")"
    cp -p "$f" "$OFFSITE_ROOT/latest/$base"
    cp -p "$f" "$snapshot/$base"
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$snapshot/$base" >> "$manifest"
    else
      printf '%s\n' "$base" >> "$manifest"
    fi
    copied=$((copied + 1))
  done < <(list_repo_files)

  prune_snapshots "$KEEP_SNAPSHOTS"

  echo "[thread-exports] synced files: $copied"
  echo "[thread-exports] repo dir:     $REPO_DIR"
  echo "[thread-exports] offsite latest:$OFFSITE_ROOT/latest"
  echo "[thread-exports] snapshot:     $snapshot"
  echo "[thread-exports] manifest:     $manifest"
}

status() {
  ensure_dirs
  local src_count repo_count latest_count newest_snapshot
  src_count="$(list_source_files | wc -l | tr -d ' ')"
  repo_count="$(list_repo_files | wc -l | tr -d ' ')"
  latest_count="$(find "$OFFSITE_ROOT/latest" -type f -name 'thread-thread_*.md' | wc -l | tr -d ' ')"
  newest_snapshot="$(find "$OFFSITE_ROOT/snapshots" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1 || true)"
  echo "[thread-exports] inbox root:  $SOURCE_ROOT_PRIMARY"
  if [[ ! -r "$SOURCE_ROOT_PRIMARY" ]]; then
    echo "[thread-exports] inbox note: current process has no read permission to inbox path"
  fi
  if [[ "$INCLUDE_LEGACY" == "1" ]]; then
    echo "[thread-exports] legacy src:  $LEGACY_SOURCE_ROOT (enabled)"
  else
    echo "[thread-exports] legacy src:  disabled"
  fi
  echo "[thread-exports] repo dir:    $REPO_DIR"
  echo "[thread-exports] offsite:     $OFFSITE_ROOT"
  echo "[thread-exports] source files:$src_count"
  echo "[thread-exports] repo files:  $repo_count"
  echo "[thread-exports] latest files:$latest_count"
  if [[ -n "$newest_snapshot" ]]; then
    echo "[thread-exports] newest snapshot: $newest_snapshot"
  fi
}

case "$ACTION" in
  sync)
    sync_all
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: ./scripts/thread-exports-sync.sh <sync|status>" >&2
    exit 2
    ;;
esac
