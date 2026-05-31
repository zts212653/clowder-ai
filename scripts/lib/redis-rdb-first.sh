#!/usr/bin/env bash

# Shared Redis daemon startup helpers. Sourced by local/dev recovery scripts.

cat_cafe_file_size_bytes() {
  local path="$1"
  [ -f "$path" ] || {
    echo "0"
    return 0
  }

  if stat -f '%z' "$path" >/dev/null 2>&1; then
    stat -f '%z' "$path"
    return 0
  fi
  if stat -c '%s' "$path" >/dev/null 2>&1; then
    stat -c '%s' "$path"
    return 0
  fi

  wc -c < "$path" | tr -d ' '
}

cat_cafe_redis_wait_for_ping() {
  local port="$1"
  local attempts="${2:-50}"
  local delay="${3:-0.1}"

  for _ in $(seq 1 "$attempts"); do
    if redis-cli -p "$port" ping >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

cat_cafe_redis_enable_aof_after_rdb_boot() {
  local port="$1"
  local dump_path="$2"
  local appendfsync="$3"

  local dbsize dump_size
  dbsize="$(redis-cli -p "$port" dbsize 2>/dev/null || echo "0")"
  dump_size="$(cat_cafe_file_size_bytes "$dump_path")"

  if [ "${dump_size:-0}" -ge 1024 ] && [ "${dbsize:-0}" = "0" ]; then
    echo "[redis-rdb-first] refusing to enable AOF after suspicious empty RDB load: dump=${dump_size}B dbsize=0" >&2
    redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true
    return 1
  fi

  redis-cli -p "$port" config set appendfsync "$appendfsync" >/dev/null
  redis-cli -p "$port" config set appendonly yes >/dev/null

  for _ in $(seq 1 50); do
    if [ "$(redis-cli -p "$port" config get appendonly 2>/dev/null | sed -n '2p')" = "yes" ]; then
      return 0
    fi
    sleep 0.1
  done

  echo "[redis-rdb-first] appendonly did not become yes on port $port" >&2
  return 1
}

cat_cafe_redis_server_supports_appenddirname() {
  local major
  major="$(redis-server --version 2>/dev/null | sed -nE 's/.* v=([0-9]+).*/\1/p' | head -n 1)"

  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$major" -ge 7 ]
}

cat_cafe_redis_start_daemon() {
  local port=""
  local bind_addr=""
  local dir=""
  local dbfilename="dump.rdb"
  local save_policy="3600 1 300 100 60 10000"
  local appendonly="yes"
  local appendfilename="appendonly.aof"
  local appenddirname="appendonlydir"
  local appendfsync="everysec"
  local pidfile=""
  local logfile=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --port) port="$2"; shift 2 ;;
      --bind) bind_addr="$2"; shift 2 ;;
      --dir) dir="$2"; shift 2 ;;
      --dbfilename) dbfilename="$2"; shift 2 ;;
      --save) save_policy="$2"; shift 2 ;;
      --appendonly) appendonly="$2"; shift 2 ;;
      --appendfilename) appendfilename="$2"; shift 2 ;;
      --appenddirname) appenddirname="$2"; shift 2 ;;
      --appendfsync) appendfsync="$2"; shift 2 ;;
      --daemonize) shift 2 ;;
      --pidfile) pidfile="$2"; shift 2 ;;
      --logfile) logfile="$2"; shift 2 ;;
      *)
        echo "[redis-rdb-first] unknown arg: $1" >&2
        return 2
        ;;
    esac
  done

  if [ -z "$port" ] || [ -z "$dir" ]; then
    echo "[redis-rdb-first] --port and --dir are required" >&2
    return 2
  fi

  local dump_path="$dir/$dbfilename"
  local append_dir_path="$dir/$appenddirname"
  local append_file_path="$dir/$appendfilename"
  local appenddirname_supported=false
  local append_artifact_exists=false
  local missing_append_artifact="$appendfilename"
  local boot_appendonly="$appendonly"
  local rdb_first=false

  if cat_cafe_redis_server_supports_appenddirname; then
    appenddirname_supported=true
    missing_append_artifact="$appenddirname"
    [ -d "$append_dir_path" ] && append_artifact_exists=true
  else
    [ -f "$append_file_path" ] && append_artifact_exists=true
  fi

  if [ "$appendonly" = "yes" ] && [ -f "$dump_path" ] && [ "$append_artifact_exists" = false ]; then
    boot_appendonly="no"
    rdb_first=true
    echo "[redis-rdb-first] dump.rdb exists without $missing_append_artifact; booting RDB first, then enabling AOF"
  fi

  local args=(
    --port "$port"
    --dir "$dir"
    --dbfilename "$dbfilename"
    --save "$save_policy"
    --appendonly "$boot_appendonly"
    --appendfilename "$appendfilename"
    --appendfsync "$appendfsync"
    --daemonize yes
  )
  [ "$appenddirname_supported" = true ] && args+=(--appenddirname "$appenddirname")
  [ -n "$bind_addr" ] && args+=(--bind "$bind_addr")
  [ -n "$pidfile" ] && args+=(--pidfile "$pidfile")
  [ -n "$logfile" ] && args+=(--logfile "$logfile")

  redis-server "${args[@]}" >/dev/null 2>&1 || return 1
  cat_cafe_redis_wait_for_ping "$port" || return 1

  if [ "$rdb_first" = true ]; then
    cat_cafe_redis_enable_aof_after_rdb_boot "$port" "$dump_path" "$appendfsync" || return 1
  fi
}
