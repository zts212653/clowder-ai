#!/usr/bin/env bash
set -euo pipefail

# Personal Redis offsite backup manager (macOS launchd).
#
# Usage:
#   ./scripts/user-redis-autobackup.sh install
#   ./scripts/user-redis-autobackup.sh run
#   ./scripts/user-redis-autobackup.sh status
#   ./scripts/user-redis-autobackup.sh uninstall

ACTION="${1:-status}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
USER_REDIS_SCRIPT="${SCRIPT_DIR}/user-redis.sh"
PORT="${USER_REDIS_PORT:-6401}"
PROFILE="${USER_REDIS_PROFILE:-user}"
LOCAL_BACKUP_DIR="${USER_REDIS_BACKUP_DIR:-$HOME/.cat-cafe/redis-backups/${PROFILE}}"
ICLOUD_ROOT="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DEFAULT_OFFSITE_ROOT="$HOME/.cat-cafe/redis-offsite-backups"
if [[ -d "$ICLOUD_ROOT" ]]; then
  DEFAULT_OFFSITE_ROOT="$ICLOUD_ROOT/CatCafeRedisBackups"
fi
OFFSITE_DIR="${USER_REDIS_OFFSITE_DIR:-$DEFAULT_OFFSITE_ROOT/${PROFILE}}"
INTERVAL_MINUTES="${USER_REDIS_BACKUP_INTERVAL_MINUTES:-60}"
OFFSITE_KEEP="${USER_REDIS_OFFSITE_KEEP:-120}"
AGENT_LABEL="${USER_REDIS_BACKUP_AGENT_LABEL:-com.catcafe.redis.user.backup}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${AGENT_LABEL}.plist"
LOG_DIR="$HOME/.cat-cafe/logs"
OUT_LOG="${LOG_DIR}/${AGENT_LABEL}.out.log"
ERR_LOG="${LOG_DIR}/${AGENT_LABEL}.err.log"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"
TARGET="${DOMAIN}/${AGENT_LABEL}"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[autobackup] missing command: $cmd" >&2
    exit 127
  fi
}

need_tools() {
  need_cmd launchctl
  need_cmd redis-cli
  need_cmd cp
  need_cmd mkdir
  if [[ ! -x "$USER_REDIS_SCRIPT" ]]; then
    echo "[autobackup] missing script: $USER_REDIS_SCRIPT" >&2
    exit 1
  fi
}

ensure_dirs() {
  mkdir -p "$LOCAL_BACKUP_DIR" "$OFFSITE_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
}

latest_local_backup() {
  ls -1t "${LOCAL_BACKUP_DIR}/${PROFILE}"-*.rdb 2>/dev/null | head -n 1 || true
}

latest_offsite_backup() {
  ls -1t "${OFFSITE_DIR}/${PROFILE}-offsite-"*.rdb 2>/dev/null | head -n 1 || true
}

prune_offsite_backups() {
  local keep="$1"
  local files=()
  while IFS= read -r f; do
    files+=("$f")
  done < <(ls -1t "${OFFSITE_DIR}/${PROFILE}-offsite-"*.rdb 2>/dev/null || true)

  if [[ "${#files[@]}" -le "$keep" ]]; then
    return
  fi

  local i
  for ((i=keep; i<${#files[@]}; i++)); do
    /bin/rm -f "${files[$i]}"
  done
}

run_backup() {
  ensure_dirs
  "$USER_REDIS_SCRIPT" backup >/dev/null

  local source
  source="$(latest_local_backup)"
  if [[ -z "$source" || ! -f "$source" ]]; then
    echo "[autobackup] no local backup found in: $LOCAL_BACKUP_DIR" >&2
    exit 1
  fi

  local stamp target latest_target
  stamp="$(date '+%Y%m%d-%H%M%S')"
  target="${OFFSITE_DIR}/${PROFILE}-offsite-${stamp}.rdb"
  latest_target="${OFFSITE_DIR}/${PROFILE}-latest.rdb"
  cp -p "$source" "$target"
  cp -p "$source" "$latest_target"
  prune_offsite_backups "$OFFSITE_KEEP"

  echo "[autobackup] source:  $source"
  echo "[autobackup] copied:  $target"
  echo "[autobackup] latest:  $latest_target"
}

write_plist() {
  local interval_seconds
  interval_seconds=$((INTERVAL_MINUTES * 60))
  if [[ "$interval_seconds" -lt 60 ]]; then
    echo "[autobackup] interval too small: ${INTERVAL_MINUTES} minutes" >&2
    exit 2
  fi

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_DIR}/user-redis-autobackup.sh</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>USER_REDIS_PORT</key>
    <string>${PORT}</string>
    <key>USER_REDIS_PROFILE</key>
    <string>${PROFILE}</string>
    <key>USER_REDIS_BACKUP_DIR</key>
    <string>${LOCAL_BACKUP_DIR}</string>
    <key>USER_REDIS_OFFSITE_DIR</key>
    <string>${OFFSITE_DIR}</string>
    <key>USER_REDIS_OFFSITE_KEEP</key>
    <string>${OFFSITE_KEEP}</string>
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

is_loaded() {
  launchctl print "$TARGET" >/dev/null 2>&1
}

install_job() {
  need_tools
  ensure_dirs
  write_plist

  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
  launchctl enable "$TARGET" >/dev/null 2>&1 || true
  launchctl kickstart -k "$TARGET" >/dev/null 2>&1 || true

  echo "[autobackup] installed: $PLIST_PATH"
  echo "[autobackup] interval: ${INTERVAL_MINUTES} minutes"
  echo "[autobackup] offsite:  $OFFSITE_DIR"
  status || true
}

uninstall_job() {
  need_tools
  launchctl bootout "$TARGET" >/dev/null 2>&1 || true
  /bin/rm -f "$PLIST_PATH"
  echo "[autobackup] uninstalled: $AGENT_LABEL"
}

status() {
  need_tools
  echo "[autobackup] label:    $AGENT_LABEL"
  echo "[autobackup] plist:    $PLIST_PATH"
  echo "[autobackup] local:    $LOCAL_BACKUP_DIR"
  echo "[autobackup] offsite:  $OFFSITE_DIR"
  echo "[autobackup] interval: ${INTERVAL_MINUTES} minutes"
  if is_loaded; then
    echo "[autobackup] launchd:  loaded"
  else
    echo "[autobackup] launchd:  not loaded"
  fi
  local local_latest offsite_latest
  local_latest="$(latest_local_backup)"
  offsite_latest="$(latest_offsite_backup)"
  [[ -n "$local_latest" ]] && echo "[autobackup] latest local:   $local_latest"
  [[ -n "$offsite_latest" ]] && echo "[autobackup] latest offsite: $offsite_latest"
}

case "$ACTION" in
  install)
    install_job
    ;;
  run)
    need_tools
    run_backup
    ;;
  status)
    status
    ;;
  uninstall)
    uninstall_job
    ;;
  *)
    cat <<EOF
Usage: ./scripts/user-redis-autobackup.sh <install|run|status|uninstall>
EOF
    exit 2
    ;;
esac
