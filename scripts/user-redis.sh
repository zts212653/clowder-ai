#!/usr/bin/env bash
set -euo pipefail

# Personal Redis manager (separate from dev Redis).
#
# Usage:
#   ./scripts/user-redis.sh start
#   ./scripts/user-redis.sh stop
#   ./scripts/user-redis.sh status
#   ./scripts/user-redis.sh backup
#   ./scripts/user-redis.sh restore --source /path/to/dump.rdb
#
# Env overrides:
#   USER_REDIS_PORT (default: 6401)
#   USER_REDIS_PROFILE (default: user)
#   USER_REDIS_DATA_DIR (default: ~/.cat-cafe/redis-user)
#   USER_REDIS_BACKUP_DIR (default: ~/.cat-cafe/redis-backups/user)
#   USER_REDIS_DBFILE (default: dump.rdb)

ACTION="${1:-status}"
if [[ $# -gt 0 ]]; then
  shift
fi

PORT="${USER_REDIS_PORT:-6401}"
PROFILE="${USER_REDIS_PROFILE:-user}"
DATA_DIR="${USER_REDIS_DATA_DIR:-$HOME/.cat-cafe/redis-${PROFILE}}"
BACKUP_DIR="${USER_REDIS_BACKUP_DIR:-$HOME/.cat-cafe/redis-backups/${PROFILE}}"
DBFILE="${USER_REDIS_DBFILE:-dump.rdb}"
PIDFILE="${DATA_DIR}/redis-${PORT}.pid"
LOGFILE="${DATA_DIR}/redis-${PORT}.log"
URL="redis://127.0.0.1:${PORT}"

ensure_dirs() {
  mkdir -p "$DATA_DIR" "$BACKUP_DIR"
}

need_tools() {
  if ! command -v redis-cli >/dev/null 2>&1; then
    echo "[user-redis] redis-cli not found" >&2
    exit 127
  fi
  if ! command -v redis-server >/dev/null 2>&1; then
    echo "[user-redis] redis-server not found" >&2
    exit 127
  fi
}

is_running() {
  redis-cli -p "$PORT" ping >/dev/null 2>&1
}

backup_snapshot() {
  local reason="${1:-manual}"
  ensure_dirs

  local source=""
  if is_running; then
    redis-cli -p "$PORT" bgsave >/dev/null 2>&1 || true
    sleep 0.2
    local dir
    local dbfile
    dir="$(redis-cli -p "$PORT" config get dir 2>/dev/null | sed -n '2p' || true)"
    dbfile="$(redis-cli -p "$PORT" config get dbfilename 2>/dev/null | sed -n '2p' || true)"
    if [[ -n "$dir" && -n "$dbfile" ]]; then
      source="$dir/$dbfile"
    fi
  fi

  if [[ -z "$source" ]]; then
    source="$DATA_DIR/$DBFILE"
  fi

  if [[ ! -f "$source" ]]; then
    echo "[user-redis] no dump file found for snapshot"
    return 0
  fi

  local stamp
  stamp="$(date '+%Y%m%d-%H%M%S')"
  local target="${BACKUP_DIR}/${PROFILE}-${reason}-${stamp}.rdb"
  cp -p "$source" "$target"
  echo "[user-redis] snapshot saved: $target"
}

status() {
  if ! is_running; then
    echo "[user-redis] stopped (port $PORT)"
    echo "[user-redis] data dir: $DATA_DIR"
    echo "[user-redis] REDIS_URL=$URL"
    return 1
  fi

  local dir dbfile appendonly dbsize
  dir="$(redis-cli -p "$PORT" config get dir | sed -n '2p')"
  dbfile="$(redis-cli -p "$PORT" config get dbfilename | sed -n '2p')"
  appendonly="$(redis-cli -p "$PORT" config get appendonly | sed -n '2p')"
  dbsize="$(redis-cli -p "$PORT" dbsize)"
  echo "[user-redis] running"
  echo "  profile:    $PROFILE"
  echo "  port:       $PORT"
  echo "  dbsize:     $dbsize"
  echo "  dir:        $dir"
  echo "  dbfilename: $dbfile"
  echo "  appendonly: $appendonly"
  echo "  REDIS_URL:  $URL"
  return 0
}

start() {
  need_tools
  ensure_dirs

  if is_running; then
    echo "[user-redis] already running on port $PORT"
    status || true
    return
  fi

  backup_snapshot "pre-start"
  redis-server \
    --port "$PORT" \
    --bind 127.0.0.1 \
    --dir "$DATA_DIR" \
    --dbfilename "$DBFILE" \
    --save "3600 1 300 100 60 10000" \
    --appendonly yes \
    --appendfilename "appendonly.aof" \
    --appendfsync everysec \
    --daemonize yes \
    --pidfile "$PIDFILE" \
    --logfile "$LOGFILE" >/dev/null 2>&1

  for _ in $(seq 1 50); do
    if is_running; then
      break
    fi
    sleep 0.1
  done

  if ! is_running; then
    echo "[user-redis] failed to start on port $PORT" >&2
    exit 1
  fi

  status || true
}

stop() {
  if ! is_running; then
    echo "[user-redis] already stopped (port $PORT)"
    return
  fi
  backup_snapshot "pre-stop"
  redis-cli -p "$PORT" shutdown save >/dev/null 2>&1 || true
  echo "[user-redis] stopped (port $PORT)"
}

usage() {
  cat <<EOF
Usage: ./scripts/user-redis.sh <start|stop|status|backup|restore> [args]

Examples:
  ./scripts/user-redis.sh start
  ./scripts/user-redis.sh backup
  ./scripts/user-redis.sh restore --source /path/to/dump.rdb
EOF
}

restore() {
  need_tools
  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  "$script_dir/redis-restore-from-rdb.sh" --target-port "$PORT" "$@"
}

case "$ACTION" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  status)
    status || true
    ;;
  backup)
    backup_snapshot "manual"
    ;;
  restore)
    restore "$@"
    ;;
  *)
    usage
    exit 2
    ;;
esac
