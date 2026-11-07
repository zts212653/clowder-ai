#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -s)" == Darwin ]] || {
  echo 'DMG verification requires a disposable macOS GitHub-hosted runner.' >&2
  exit 2
}

distribution="$1"
evidence="$2"
mkdir -p "$evidence"
root="$(mktemp -d "$RUNNER_TEMP/desktop-dmg-XXXXXXXX")"
mount="$root/mount"
state="$root/state"
install='/Applications/Clowder AI.app'
mounted=0
pid=''
quit_pid=''
phase='preflight'
frontend=35471
api=35472
redis=36471
debug=35473

finish() {
  local exit_code=$? status=failed cleanup=true
  if [[ -n "$pid" ]]; then
    if [[ -z "$quit_pid" ]]; then quit_owned || true; fi
    local owned
    for owned in "$quit_pid" "$pid"; do
      [[ -n "$owned" ]] || continue
      if kill -0 "$owned" 2>/dev/null; then
        kill -TERM "$owned" 2>/dev/null || true
        wait_for_exit "$owned" 5 || cleanup=false
      fi
      if ! kill -0 "$owned" 2>/dev/null; then wait "$owned" 2>/dev/null || true; fi
    done
    assert_free || cleanup=false
  fi
  if [[ "$mounted" == 1 ]]; then
    hdiutil detach "$mount" >> "$evidence/dmg.log" 2>&1 || cleanup=false
  fi
  for log in main.log desktop.log startup-state.json; do
    if [[ -f "$state/data/logs/$log" ]]; then
      tail -c 2097152 "$state/data/logs/$log" > "$evidence/$log" || cleanup=false
    fi
  done
  if [[ "$exit_code" == 0 ]]; then
    if [[ "$cleanup" == true ]]; then
      status=passed
    else
      phase='cleanup-unconfirmed'
      exit_code=1
    fi
  elif [[ "$phase" == preflight ]]; then
    status=blocked
  fi
  printf '{"status":"%s","code":"macos-%s","cleanupConfirmed":%s}\n' "$status" "$phase" "$cleanup" > "$evidence/dmg-result.json"
  if [[ "$exit_code" != 0 ]]; then
    cat "$evidence/dmg-result.json" >&2
    if [[ -f "$evidence/dmg.log" ]]; then tail -n 25 "$evidence/dmg.log" >&2; fi
  fi
  exit "$exit_code"
}
trap finish EXIT
trap 'printf "macOS verification stopped in %s at line %s: %s\n" "$phase" "$LINENO" "$BASH_COMMAND" >&2' ERR

assert_free() {
  for port in "$frontend" "$api" "$redis" "$debug"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null; then
      echo "Port $port is occupied." >&2
      return 1
    fi
  done
}

launch() {
  exec env -i PATH='/usr/bin:/bin:/usr/sbin:/sbin' HOME="$root/home" TMPDIR="$root/temp" \
    CAT_CAFE_DESKTOP_INSTANCE_ROOT="$state" FRONTEND_PORT="$frontend" API_SERVER_PORT="$api" REDIS_PORT="$redis" \
    "$executable" "$@"
}

wait_for_exit() {
  local target="$1" limit="$2" seconds
  for (( seconds=0; seconds<limit; seconds++ )); do
    if ! kill -0 "$target" 2>/dev/null; then return 0; fi
    sleep 1
  done
  ! kill -0 "$target" 2>/dev/null
}

quit_owned() {
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  (launch --quit-owned-installation) >> "$evidence/quit-$phase.log" 2>&1 &
  quit_pid=$!
  wait_for_exit "$quit_pid" 30 && wait "$quit_pid" || return 1
  quit_pid=''
  wait_for_exit "$pid" 30
}

shopt -s nullglob
images=("$distribution"/*.dmg)
[[ "${#images[@]}" == 1 ]]
shasum -a 256 "${images[0]}" > "$evidence/distribution-sha256.txt"
[[ "$CANDIDATE_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ -w /Applications && ! -e "$install" && ! -L "$install" ]]
case "$NIGHTLY_PLATFORM:$(uname -m)" in
  macos-arm64:arm64|macos-x64:x86_64) ;;
  *) echo 'Runner architecture does not match the candidate.' >&2; exit 2 ;;
esac
assert_free
mkdir -p "$mount" "$state" "$root/home" "$root/temp"

phase=attach
hdiutil attach "${images[0]}" -nobrowse -readonly -mountpoint "$mount" > "$evidence/dmg.log" 2>&1
mounted=1
phase=copy
ditto "$mount/Clowder AI.app" "$install"
phase=unmount
hdiutil detach "$mount" >> "$evidence/dmg.log" 2>&1
mounted=0
phase=installed-identity
info="$install/Contents/Info.plist"
resources="$install/Contents/Resources"
executable="$install/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$info")"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$info")"
[[ "$version" == "$CANDIDATE_VERSION" && -x "$executable" ]]
[[ "$(lipo -archs "$executable")" == "$(uname -m)" ]]
# The Mac packager stamps the Web build. The API stamp is Windows-specific.
[[ "$(cat "$resources/packages/web/.next/.build-commit")" == "$CANDIDATE_SOURCE_SHA" ]]
printf '%s\n' "$version" "$CANDIDATE_SOURCE_SHA" "$(uname -m)" > "$evidence/installed-identity.txt"

if [[ "${NIGHTLY_SUITE:-}" == full ]]; then
  node "$(dirname "$0")/installed-auth.mjs" "$resources" "$evidence" "$root" ||
    echo 'Installed authentication admission verifier did not write a result' >&2
fi

for phase in create restore; do
  assert_free
  launch "--remote-debugging-port=$debug" --remote-debugging-address=127.0.0.1 \
    > "$evidence/app-$phase.log" 2>&1 &
  # Exec in the asynchronous subshell so the PID refers to the launched app.
  pid=$!
  node "$(dirname "$0")/browser.mjs" "$phase" "$evidence" "$frontend" "$api" "$debug" "$version"
  if ! quit_owned; then
    echo 'Owned application did not exit normally.' >&2
    exit 1
  fi
  wait "$pid"
  pid=''
  assert_free
done
node "$(dirname "$0")/initial-plugins.mjs" --logs "$evidence"
phase=complete
