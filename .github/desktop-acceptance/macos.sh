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
phase='preflight'
frontend=35471
api=35472
redis=36471
debug=35473

finish() {
  local exit_code=$? status=failed cleanup=true
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    cleanup=false
  fi
  if [[ "$mounted" == 1 ]]; then
    hdiutil detach "$mount" >> "$evidence/dmg.log" 2>&1 || cleanup=false
  fi
  for log in main.log desktop.log startup-state.json; do
    if [[ -f "$state/data/logs/$log" ]]; then
      tail -c 2097152 "$state/data/logs/$log" > "$evidence/$log" || cleanup=false
    fi
  done
  if [[ "$cleanup" == false ]]; then
    phase='cleanup-unconfirmed'
    exit_code=1
  elif [[ "$exit_code" == 0 ]]; then
    status=passed
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

[[ "$CANDIDATE_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ -w /Applications && ! -e "$install" && ! -L "$install" ]]
case "$NIGHTLY_PLATFORM:$(uname -m)" in
  macos-arm64:arm64|macos-x64:x86_64) ;;
  *) echo 'Runner architecture does not match the candidate.' >&2; exit 2 ;;
esac
assert_free
shopt -s nullglob
images=("$distribution"/*.dmg)
[[ "${#images[@]}" == 1 ]]
shasum -a 256 "${images[0]}" > "$evidence/distribution-sha256.txt"
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
  (launch --quit-owned-installation) >> "$evidence/quit-$phase.log" 2>&1
  for (( seconds=0; seconds<30; seconds++ )); do
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo 'Owned application did not exit normally.' >&2
    exit 1
  fi
  wait "$pid"
  pid=''
  assert_free
done
node "$(dirname "$0")/initial-plugins.mjs" --logs "$evidence"
phase=complete
