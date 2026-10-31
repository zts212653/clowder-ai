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
REPO_DIR="${THREAD_EXPORT_REPO_DIR:-$PROJECT_DIR/.cat-cafe/thread-exports/repo}"

ICLOUD_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DEFAULT_OFFSITE_ROOT="$HOME/.cat-cafe/thread-exports"
if [[ -d "$ICLOUD_ROOT" ]]; then
  DEFAULT_OFFSITE_ROOT="$ICLOUD_ROOT/CatCafeThreadExports"
fi
OFFSITE_ROOT="${THREAD_EXPORT_OFFSITE_DIR:-$DEFAULT_OFFSITE_ROOT}"
KEEP_SNAPSHOTS="${THREAD_EXPORT_KEEP_SNAPSHOTS:-30}"
OFFSITE_STRICT="${THREAD_EXPORT_OFFSITE_STRICT:-0}"

ensure_dirs() {
  mkdir -p "$SOURCE_ROOT_PRIMARY" "$REPO_DIR"
  if ! mkdir -p "$OFFSITE_ROOT/latest" "$OFFSITE_ROOT/snapshots"; then
    thread_export_offsite_warn_or_fail "offsite dir unavailable: $OFFSITE_ROOT"
    OFFSITE_ROOT=""
  fi
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
  [[ -n "$OFFSITE_ROOT" ]] || return 0
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

thread_export_offsite_warn_or_fail() {
  local message="$1"
  echo "[thread-exports] warning: $message" >&2
  if [[ "$OFFSITE_STRICT" == "1" ]]; then
    exit 1
  fi
}

copy_offsite_file() {
  local src="$1"
  local base="$2"
  local snapshot="$3"
  local manifest="$4"
  if [[ -z "$OFFSITE_ROOT" ]]; then
    return 0
  fi

  local latest_target latest_tmp snapshot_target
  latest_target="$OFFSITE_ROOT/latest/$base"
  latest_tmp="${latest_target}.tmp.$$"
  snapshot_target="$snapshot/$base"

  if ! cp -p "$src" "$latest_tmp" || ! mv -f "$latest_tmp" "$latest_target"; then
    rm -f "$latest_tmp" 2>/dev/null || true
    thread_export_offsite_warn_or_fail "latest copy failed: $latest_target"
  fi

  if cp -p "$src" "$snapshot_target"; then
    if command -v shasum >/dev/null 2>&1; then
      shasum -a 256 "$snapshot_target" >> "$manifest"
    else
      printf '%s\n' "$base" >> "$manifest"
    fi
  else
    thread_export_offsite_warn_or_fail "snapshot copy failed: $snapshot_target"
  fi
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
  if [[ -n "$OFFSITE_ROOT" ]]; then
    if mkdir -p "$snapshot"; then
      if ! : > "$manifest"; then
        thread_export_offsite_warn_or_fail "manifest unavailable: $manifest"
        OFFSITE_ROOT=""
      fi
    else
      thread_export_offsite_warn_or_fail "snapshot dir unavailable: $snapshot"
      OFFSITE_ROOT=""
    fi
  fi

  local f base
  while IFS= read -r f; do
    base="$(basename "$f")"
    copy_offsite_file "$f" "$base" "$snapshot" "$manifest"
    copied=$((copied + 1))
  done < <(list_repo_files)

  prune_snapshots "$KEEP_SNAPSHOTS"

  echo "[thread-exports] synced files: $copied"
  echo "[thread-exports] repo dir:     $REPO_DIR"
  if [[ -n "$OFFSITE_ROOT" ]]; then
    echo "[thread-exports] offsite latest:$OFFSITE_ROOT/latest"
    echo "[thread-exports] snapshot:     $snapshot"
    echo "[thread-exports] manifest:     $manifest"
  else
    echo "[thread-exports] offsite latest:skipped"
  fi
}

status() {
  ensure_dirs
  local src_count repo_count latest_count newest_snapshot
  src_count="$(list_source_files | wc -l | tr -d ' ')"
  repo_count="$(list_repo_files | wc -l | tr -d ' ')"
  if [[ -n "$OFFSITE_ROOT" ]]; then
    latest_count="$(find "$OFFSITE_ROOT/latest" -type f -name 'thread-thread_*.md' | wc -l | tr -d ' ')"
    newest_snapshot="$(find "$OFFSITE_ROOT/snapshots" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1 || true)"
  else
    latest_count="0"
    newest_snapshot=""
  fi
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
