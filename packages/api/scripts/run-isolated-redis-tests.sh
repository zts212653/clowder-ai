#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

REPEAT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repeat)
      if [[ $# -lt 2 ]]; then
        echo "[redis-test] --repeat requires a positive integer" >&2
        exit 2
      fi
      REPEAT="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if ! [[ "$REPEAT" =~ ^[1-9][0-9]*$ ]]; then
  echo "[redis-test] invalid --repeat value: $REPEAT" >&2
  exit 2
fi

REGISTRY_DIR="${CAT_CAFE_REDIS_TEST_REGISTRY_DIR:-${TMPDIR:-/tmp}/cat-cafe-redis-tests}"
REGISTRY_FILE="${REGISTRY_DIR}/registry.tsv"
PROTECTED_REDIS_TEST_PORTS_REGEX='^(6398|6399|6401)$'

is_protected_port() {
  [[ "$1" =~ $PROTECTED_REDIS_TEST_PORTS_REGEX ]]
}

validate_test_port() {
  local port="$1"
  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "[redis-test] invalid Redis test port: $port" >&2
    exit 2
  fi
  if is_protected_port "$port"; then
    echo "[redis-test] refusing to use protected Redis port: $port" >&2
    exit 2
  fi
}

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts="${2:-20}"
  for _ in $(seq 1 "$attempts"); do
    if ! pid_alive "$pid"; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

stop_instance() {
  local port="$1"
  local pid="${2:-}"
  local datadir="${3:-}"

  if [[ -n "$port" ]]; then
    validate_test_port "$port"
    if command -v redis-cli >/dev/null 2>&1; then
      redis-cli -h 127.0.0.1 -p "$port" shutdown nosave >/dev/null 2>&1 || true
    fi
  fi

  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    wait_for_pid_exit "$pid" 20 || true
  fi
  # Guard against PID reuse: verify the PID is still a redis-server on the
  # expected port before escalating to SIGTERM/SIGKILL.  Checks both process
  # name (redis-server) AND port in proctitle (:PORT), so a PID reused by
  # a different redis-server on a different port is also skipped.
  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    local cmd_check
    cmd_check="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmd_check" != *redis-server* ]] || { [[ -n "$port" ]] && [[ "$cmd_check" != *":${port}"* ]]; }; then
      pid=""  # PID reused or wrong port — skip signal escalation
    fi
  fi
  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    kill -s SIGTERM "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid" 20 || true
  fi
  if [[ -n "$pid" ]] && pid_alive "$pid"; then
    kill -s SIGKILL "$pid" 2>/dev/null || true
    wait_for_pid_exit "$pid" 10 || true
  fi

  if [[ -n "$datadir" ]]; then
    /bin/rm -rf "$datadir"
  fi
}

cleanup_registry() {
  mkdir -p "$REGISTRY_DIR"
  if [[ ! -f "$REGISTRY_FILE" ]]; then
    return 0
  fi

  local fresh_file="${REGISTRY_FILE}.fresh.$$"
  : > "$fresh_file"
  while IFS=$'\t' read -r port pid datadir started_at; do
    [[ -z "${port:-}" ]] && continue
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
      echo "[redis-test] skipping invalid registry entry: $port" >&2
      continue
    fi
    if is_protected_port "$port"; then
      echo "[redis-test] skipping protected registry entry on port $port" >&2
      continue
    fi
    stop_instance "$port" "$pid" "$datadir"
  done < "$REGISTRY_FILE"
  mv "$fresh_file" "$REGISTRY_FILE"
}

register_instance() {
  local port="$1"
  local pid="$2"
  local datadir="$3"
  validate_test_port "$port"
  mkdir -p "$REGISTRY_DIR"
  printf '%s\t%s\t%s\t%s\n' "$port" "$pid" "$datadir" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REGISTRY_FILE"
}

remove_current_registry_entry() {
  if [[ ! -f "$REGISTRY_FILE" || -z "${PORT:-}" || -z "${DATADIR:-}" ]]; then
    return 0
  fi
  local tmp_file="${REGISTRY_FILE}.tmp.$$"
  awk -F '\t' -v OFS='\t' -v port="$PORT" -v datadir="$DATADIR" \
    '!(($1 == port) && ($3 == datadir))' "$REGISTRY_FILE" > "$tmp_file" || true
  mv "$tmp_file" "$REGISTRY_FILE"
}

if [[ -n "${REDIS_TEST_PORT:-}" ]]; then
  validate_test_port "$REDIS_TEST_PORT"
fi

if ! command -v redis-server >/dev/null 2>&1; then
  echo "[redis-test] redis-server not found. Install Redis first." >&2
  exit 127
fi

CMD=("pnpm" "test")
if [[ $# -gt 0 ]]; then
  CMD=("$@")
fi

cleanup_registry

DATADIR="$(mktemp -d -t cat-cafe-redis-test.XXXXXX)"
PIDFILE="${DATADIR}/redis.pid"
LOGFILE="${DATADIR}/redis.log"

cleanup() {
  local pid=""
  if [[ -f "$PIDFILE" ]]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  fi
  if [[ -n "${PORT:-}" ]]; then
    stop_instance "$PORT" "$pid" "$DATADIR"
    # Only remove registry entry if the port is confirmed dead.
    # If Redis is still dying (race window), keep the entry so the next run's
    # cleanup_registry() can finish the job via port-based shutdown.
    if command -v redis-cli >/dev/null 2>&1 \
       && ! redis-cli -h 127.0.0.1 -p "$PORT" ping >/dev/null 2>&1; then
      remove_current_registry_entry
    fi
    # else: port still responding → leave entry for next cleanup_registry()
  else
    /bin/rm -rf "$DATADIR"
  fi
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

PORT="${REDIS_TEST_PORT:-}"
if [[ -z "$PORT" ]]; then
  for _ in $(seq 1 30); do
    CANDIDATE="$((6300 + RANDOM % 700))"
    if is_protected_port "$CANDIDATE"; then
      continue
    fi
    if redis-server \
      --port "$CANDIDATE" \
      --dir "$DATADIR" \
      --dbfilename dump.rdb \
      --save "" \
      --appendonly no \
      --daemonize yes \
      --pidfile "$PIDFILE" \
      --logfile "$LOGFILE" >/dev/null 2>&1; then
      PORT="$CANDIDATE"
      register_instance "$PORT" "$(cat "$PIDFILE" 2>/dev/null || true)" "$DATADIR"
      break
    fi
  done
else
  validate_test_port "$PORT"
  redis-server \
    --port "$PORT" \
    --dir "$DATADIR" \
    --dbfilename dump.rdb \
    --save "" \
    --appendonly no \
    --daemonize yes \
    --pidfile "$PIDFILE" \
    --logfile "$LOGFILE"
  register_instance "$PORT" "$(cat "$PIDFILE" 2>/dev/null || true)" "$DATADIR"
fi

if [[ -z "$PORT" ]]; then
  echo "[redis-test] failed to allocate an isolated redis port" >&2
  if [[ -f "$LOGFILE" ]]; then
    echo "[redis-test] redis log:" >&2
    cat "$LOGFILE" >&2
  fi
  exit 1
fi

if command -v redis-cli >/dev/null 2>&1; then
  READY=0
  for _ in $(seq 1 50); do
    if redis-cli -h 127.0.0.1 -p "$PORT" ping >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.1
  done
  if [[ "$READY" -ne 1 ]]; then
    echo "[redis-test] redis failed to become ready on port ${PORT}" >&2
    if [[ -f "$LOGFILE" ]]; then
      echo "[redis-test] redis log:" >&2
      cat "$LOGFILE" >&2
    fi
    exit 1
  fi
else
  sleep 0.2
fi

export REDIS_URL="redis://127.0.0.1:${PORT}/15"
export CAT_CAFE_REDIS_TEST_ISOLATED=1

cd "$API_DIR"

echo "[redis-test] isolated redis started: ${REDIS_URL}"
for RUN in $(seq 1 "$REPEAT"); do
  echo "[redis-test] run ${RUN}/${REPEAT}: ${CMD[*]}"
  "${CMD[@]}"
done
