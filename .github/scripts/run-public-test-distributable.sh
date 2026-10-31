#!/bin/bash
set -euo pipefail

die() {
  echo "public-test no-egress boundary failed: $*" >&2
  exit 1
}

if [[ "${1:-}" == "--verify-process-domain" ]]; then
  shift
  [[ $# -ge 5 ]] || die "missing process namespace identity or runner command"
  [[ "$(id -u)" == "0" ]] || die "process namespace must be configured before dropping privileges"
  parent_pidns="$1"
  runner_uid="$2"
  runner_gid="$3"
  runner_path="$4"
  shift 4
  current_pidns="$(stat -Lc '%d:%i' /proc/self/ns/pid)" || die "cannot observe process namespace"
  init_pidns="$(stat -Lc '%d:%i' /proc/1/ns/pid)" || die "cannot observe procfs process domain"
  [[ "$parent_pidns" =~ ^[0-9]+:[0-9]+$ && "$current_pidns" =~ ^[0-9]+:[0-9]+$ ]] || die "invalid process namespace identity"
  [[ "$$" == "1" && "$current_pidns" != "$parent_pidns" && "$current_pidns" == "$init_pidns" ]] || die "procfs is not bound to a fresh process namespace"
  # UID/GID changes clear unshare's parent-death signal. Restore it after
  # dropping credentials, or a killed monitor could leave PID 1 alive.
  exec setpriv \
    --pdeathsig keep \
    --reuid "$runner_uid" \
    --regid "$runner_gid" \
    --clear-groups \
    --inh-caps=-all \
    --ambient-caps=-all \
    --bounding-set=-all \
    --no-new-privs \
    -- "$(readlink -f "$0")" --verify-dropped "$runner_path" "$@"
fi

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

  # Node/pnpm waits only for its own child handles; as PID 1 it leaves adopted
  # orphan zombies behind. Give adoption/reaping to an unprivileged supervisor.
  # Python is already required by the real Linux boundary fixtures. -I excludes
  # user site/PYTHONPATH hooks; command stdin and argv remain separate from code.
  exec /usr/bin/python3 -I "$(dirname "$(readlink -f "$0")")/public-test-namespace-init.py" "$@"
fi

[[ $# -ge 4 ]] || die "usage: $0 UID GID PATH COMMAND [ARG ...]"
[[ "$(id -u)" == "0" ]] || die "network namespace must be configured as root"
runner_uid="$1"
runner_gid="$2"
runner_path="$3"
shift 3
script_path="$(readlink -f "$0")"

# The unprivileged child cannot stat PID 1's namespace: procfs applies ptrace
# access checks after setpriv. Capture both kernel identities while privileged.
# The directory/file stay root-owned and unwritable by the child; an env flag
# alone would let a same-host local invocation claim isolation it does not have.
host_netns="$(stat -Lc '%d:%i' /proc/1/ns/net)" || die "cannot observe host network namespace"
isolated_netns="$(stat -Lc '%d:%i' /proc/self/ns/net)" || die "cannot observe isolated network namespace"
[[ "$host_netns" =~ ^[0-9]+:[0-9]+$ && "$isolated_netns" =~ ^[0-9]+:[0-9]+$ ]] || die "invalid namespace identity"
[[ "$host_netns" != "$isolated_netns" ]] || die "launcher shares the host network namespace"
proof_nonce="$(cat /proc/sys/kernel/random/uuid)" || die "cannot generate proof identity"
proof_boot_id="$(cat /proc/sys/kernel/random/boot_id)" || die "cannot observe kernel boot identity"
proof_dir="$(mktemp -d /tmp/clowder-public-test-netns.XXXXXXXX)" || die "cannot create proof directory"
chmod 0755 "$proof_dir"
export CAT_CAFE_PUBLIC_TEST_NETNS_PROOF="$proof_dir/proof.json"
(
  umask 077
  printf '{"schemaVersion":1,"nonce":"%s","bootId":"%s","host":"%s","isolated":"%s"}\n' \
    "$proof_nonce" "$proof_boot_id" "$host_netns" "$isolated_netns" > "$CAT_CAFE_PUBLIC_TEST_NETNS_PROOF"
)
chmod 0444 "$CAT_CAFE_PUBLIC_TEST_NETNS_PROOF"
# This non-secret receipt lives only in the ephemeral runner/container.

ip link set lo up
parent_pidns="$(stat -Lc '%d:%i' /proc/self/ns/pid)" || die "cannot observe parent process namespace"
# Network isolation alone leaves host same-UID processes visible to cleanup.
# A private procfs must reflect the new PID domain; do not waive EACCES scans.
# The root monitor stays outside; init and command run without privileges inside.
# On monitor death, kill-child tears down namespace init and all its descendants.
exec unshare --pid --fork --mount-proc --kill-child=SIGKILL -- \
  "$script_path" --verify-process-domain "$parent_pidns" "$runner_uid" "$runner_gid" "$runner_path" "$@"
