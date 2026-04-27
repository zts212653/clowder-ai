#!/usr/bin/env bash
set -euo pipefail

# launchd wrapper for periodic thread export sync.
#
# Usage:
#   ./scripts/thread-exports-autosave.sh install
#   ./scripts/thread-exports-autosave.sh run
#   ./scripts/thread-exports-autosave.sh status
#   ./scripts/thread-exports-autosave.sh uninstall

ACTION="${1:-status}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/thread-exports-sync.sh"
EXPORT_SCRIPT="$SCRIPT_DIR/export-threads-from-redis.mjs"

INTERVAL_MINUTES="${THREAD_EXPORT_SYNC_INTERVAL_MINUTES:-120}"
LABEL="${THREAD_EXPORT_AUTOSAVE_LABEL:-com.catcafe.thread.exports.sync}"
EXPORT_REDIS_URL="${THREAD_EXPORT_REDIS_URL:-${REDIS_URL:-redis://127.0.0.1:6399}}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/.cat-cafe/logs"
OUT_LOG="$LOG_DIR/$LABEL.out.log"
ERR_LOG="$LOG_DIR/$LABEL.err.log"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
TARGET="${DOMAIN}/${LABEL}"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[thread-autosave] missing command: $cmd" >&2
    exit 127
  fi
}

need_tools() {
  need_cmd launchctl
  need_cmd /bin/bash
  need_cmd node
  if [[ ! -x "$SYNC_SCRIPT" ]]; then
    echo "[thread-autosave] missing script: $SYNC_SCRIPT" >&2
    exit 1
  fi
  if [[ ! -f "$EXPORT_SCRIPT" ]]; then
    echo "[thread-autosave] missing script: $EXPORT_SCRIPT" >&2
    exit 1
  fi
}

ensure_dirs() {
  mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
}

is_loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

write_plist() {
  local interval_seconds
  interval_seconds=$((INTERVAL_MINUTES * 60))
  if [[ "$interval_seconds" -lt 60 ]]; then
    echo "[thread-autosave] interval too small: $INTERVAL_MINUTES minutes" >&2
    exit 2
  fi

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/thread-exports-autosave.sh</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>THREAD_EXPORT_REDIS_URL</key>
    <string>${EXPORT_REDIS_URL}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${interval_seconds}</integer>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
EOF
}

install_job() {
  need_tools
  ensure_dirs
  write_plist

  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  launchctl enable "$TARGET" >/dev/null 2>&1 || true
  launchctl kickstart -k "$TARGET" >/dev/null 2>&1 || true

  echo "[thread-autosave] installed: $PLIST_PATH"
  echo "[thread-autosave] interval: ${INTERVAL_MINUTES} minutes"
  status || true
}

uninstall_job() {
  need_tools
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  echo "[thread-autosave] uninstalled: $LABEL"
}

status() {
  need_tools
  echo "[thread-autosave] label:    $LABEL"
  echo "[thread-autosave] plist:    $PLIST_PATH"
  echo "[thread-autosave] interval: ${INTERVAL_MINUTES} minutes"
  echo "[thread-autosave] redis:    ${EXPORT_REDIS_URL}"
  if is_loaded; then
    echo "[thread-autosave] launchd:  loaded"
  else
    echo "[thread-autosave] launchd:  not loaded"
  fi
  "$SYNC_SCRIPT" status
}

case "$ACTION" in
  install)
    install_job
    ;;
  run)
    need_tools
    node "$EXPORT_SCRIPT" --redis-url "$EXPORT_REDIS_URL"
    "$SYNC_SCRIPT" sync
    ;;
  status)
    status
    ;;
  uninstall)
    uninstall_job
    ;;
  *)
    echo "Usage: ./scripts/thread-exports-autosave.sh <install|run|status|uninstall>" >&2
    exit 2
    ;;
esac
