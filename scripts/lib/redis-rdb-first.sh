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

# redis-cli -t bounds connecting, not waiting for a reply. Node is part of the
# supported launcher toolchain; bound the actual child without a shell watchdog.
cat_cafe_redis_ping_command() {
  node - "$@" <<'NODE'
const { spawnSync } = require('node:child_process');
const result = spawnSync('redis-cli', process.argv.slice(2), {
  encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL',
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) process.stderr.write(`[redis-rdb-first] PING command failed: ${result.error.message}\n`);
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
NODE
}

cat_cafe_redis_wait_for_ping() {
  local port="$1"
  local attempts="${2:-300}"
  local delay="${3:-0.1}"
  local deadline=$((SECONDS + 30))
  local response status

  for _ in $(seq 1 "$attempts"); do
    [ "$SECONDS" -lt "$deadline" ] || break
    status=0
    # Keep the shell-local named ownership wrapper on every observation.
    # Redis error replies can have CLI status 0: only PONG proves readiness.
    if [ "$(type -t redis-cli)" = function ]; then
      response="$(redis-cli -h 127.0.0.1 -p "$port" --raw ping 2>&1)" || status=$?
    else
      response="$(cat_cafe_redis_ping_command -h 127.0.0.1 -p "$port" --raw ping 2>&1)" || status=$?
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    if [ "$status" -eq 0 ] && [ "$response" = PONG ]; then
      return 0
    fi
    if [ "$status" -eq 0 ] && [[ "$response" = 'LOADING '* ]]; then
      : # A loading reply is retryable, never permission for DBSIZE or AOF.
    elif [ "$status" -ne 0 ] && [ "$response" = "Could not connect to Redis at 127.0.0.1:$port: Connection refused" ]; then
      : # The generic daemon may not have opened its listener yet.
    else
      echo "[redis-rdb-first] PING refused on port $port (status $status): $response" >&2
      return 1
    fi
    sleep "$delay"
  done
  echo "[redis-rdb-first] readiness wait budget exhausted on port $port; no PONG received in time" >&2
  return 1
}

cat_cafe_redis_read_dbsize() {
  local size
  size="$(redis-cli -h 127.0.0.1 -p "$1" --raw dbsize)" || return 1
  if ! [[ "$size" =~ ^[0-9]+$ ]]; then
    echo "[redis-rdb-first] dbsize is unreadable on port $1; refusing to infer an empty database" >&2
    return 1
  fi
  printf '%s\n' "$size"
}

cat_cafe_redis_enable_aof_after_rdb_boot() {
  local port="$1"
  local dump_path="$2"
  local appendfsync="$3"

  local dbsize dump_size
  REDIS_STARTUP_DATA_UNVERIFIED=true
  dbsize="$(cat_cafe_redis_read_dbsize "$port")" || return 1
  dump_size="$(cat_cafe_file_size_bytes "$dump_path")"

  if [ "${dump_size:-0}" -ge 1024 ] && [ "${dbsize:-0}" = "0" ]; then
    echo "[redis-rdb-first] refusing to enable AOF after suspicious empty RDB load: dump=${dump_size}B dbsize=0" >&2
    redis-cli -e -p "$port" shutdown nosave >/dev/null 2>&1 || true
    return 1
  fi

  REDIS_STARTUP_DATA_UNVERIFIED=false
  local response
  response="$(redis-cli -e -p "$port" config set appendfsync "$appendfsync")" || {
    echo "[redis-rdb-first] appendfsync configuration refused: $response" >&2
    return 1
  }
  response="$(redis-cli -e -p "$port" config set appendonly yes)" || {
    echo "[redis-rdb-first] appendonly configuration refused: $response" >&2
    return 1
  }
  # CONFIG SET changes the enabled flag synchronously; the initial rewrite
  # may still run in the background. A failed identity/read is never a retry.
  response="$(redis-cli -e -p "$port" --raw config get appendonly)" || return 1
  if [ "$(printf '%s\n' "$response" | sed -n '2p')" = yes ]; then return 0; fi

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
  local named_alpha_ownership=false

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
      --named-alpha-ownership) named_alpha_ownership=true; shift ;;
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
  if [ "$named_alpha_ownership" = true ] && [ "$(type -t named_alpha_capture_redis_identity)" != function ]; then
    echo "[redis-rdb-first] named Alpha requires its fixed native ownership callback" >&2
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

  # A readiness refusal must never allow EXIT cleanup to save over this input.
  [ ! -f "$dump_path" ] || REDIS_STARTUP_DATA_UNVERIFIED=true
  REDIS_STARTUP_READINESS_FAILED=false
  redis-server "${args[@]}" >/dev/null 2>&1 || return 1
  # A fixed launcher callback proves the spawned OS incarnation before this
  # helper's first protocol read. No environment-supplied command is executed.
  if [ "$named_alpha_ownership" = true ]; then
    named_alpha_capture_redis_identity "$port" "$dir" "$pidfile" || return 1
  fi
  if ! cat_cafe_redis_wait_for_ping "$port"; then
    REDIS_STARTUP_READINESS_FAILED=true
    return 1
  fi

  if [ "$rdb_first" = true ]; then
    cat_cafe_redis_enable_aof_after_rdb_boot "$port" "$dump_path" "$appendfsync" || return 1
  fi
}
