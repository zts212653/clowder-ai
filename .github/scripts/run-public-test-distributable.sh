#!/bin/bash
set -euo pipefail

die() {
  echo "public-test no-egress boundary failed: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--verify-dropped" ]]; then
  shift
  [[ $# -ge 2 ]] || die "missing runner PATH or shard command"
  export PATH="$1"
  shift

  [[ "$(id -u)" != "0" ]] || die "shard command still runs as root"
  grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status || die "no_new_privs is not set"
  for field in CapInh CapPrm CapEff CapBnd CapAmb; do
    grep -Eq "^${field}:[[:space:]]+0+$" /proc/self/status || die "${field} is not empty"
  done
  sudo_path="$(command -v sudo)" || die "sudo probe is unavailable"
  nsenter_path="$(command -v nsenter)" || die "nsenter probe is unavailable"
  if "$sudo_path" -n true >/dev/null 2>&1; then
    die "passwordless sudo regained privilege"
  fi
  if "$nsenter_path" -t 1 -n true >/dev/null 2>&1; then
    die "entered the parent network namespace"
  fi

  exec "$@"
fi

[[ $# -ge 4 ]] || die "usage: $0 UID GID PATH COMMAND [ARG ...]"
[[ "$(id -u)" == "0" ]] || die "network namespace must be configured as root"
runner_uid="$1"
runner_gid="$2"
runner_path="$3"
shift 3
script_path="$(readlink -f "$0")"

ip link set lo up
exec setpriv \
  --reuid "$runner_uid" \
  --regid "$runner_gid" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  --no-new-privs \
  -- "$script_path" --verify-dropped "$runner_path" "$@"
