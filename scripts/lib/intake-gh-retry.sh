# shellcheck shell=bash
# intake-gh-retry.sh — Retry + stderr-capture helpers for gh CLI calls.
#
# Why a lib: callers use `out=$(_gh_with_retry ...)` which runs the helper in
# a subshell. Bash variables set inside subshell don't propagate to parent.
# We use a FILE (path env-propagates, content fs-persists) so the parent's
# fail-diagnostic branch can read captured stderr regardless of subshell.
#
# Empirical evidence: `gh pr diff` intermittently returns empty/non-zero on
# transient network/API hiccups (observed intake clowder-ai#1010 record —
# first call failed, immediate retry succeeded with no code change).
#
# Original bug (cat-cafe#2549 V1, gpt52 review finding): V1 used a global
# variable to pass stderr back, which was lost across command substitution.
# V2 uses a tempfile written once-per-call, read by caller via _gh_last_stderr.

# Init stderr file at SOURCE TIME (in sourcing shell, before any subshell call).
# File PATH set in sourcing shell propagates to subshells via env; file CONTENT
# persists across subshell exit. V1 init-on-first-call broke when first call
# was `$(_gh_with_retry ...)` — path var set inside subshell, lost to parent.
# V2 fix sources init at module load.
_INTAKE_GH_STDERR_FILE=$(mktemp -t intake-gh-stderr.XXXXXX) || _INTAKE_GH_STDERR_FILE=""

# Cleanup on script exit. Note: this composes with any existing EXIT trap by
# overwriting it — if the consuming script needs its own EXIT trap, it must
# include this cleanup in its own trap definition (or set up before sourcing).
if [ -n "$_INTAKE_GH_STDERR_FILE" ]; then
  trap '[ -n "$_INTAKE_GH_STDERR_FILE" ] && rm -f "$_INTAKE_GH_STDERR_FILE" 2>/dev/null || true' EXIT
fi

# Run gh with retry (3 attempts, backoff 0.5s + 1s) and stderr capture.
# Args are passed to gh directly: `_gh_with_retry pr diff 123 --repo foo/bar --name-only`
# Returns: gh stdout on success (exit 0); empty + stderr in $_INTAKE_GH_STDERR_FILE on final failure (exit 1).
# Caller reads stderr via _gh_last_stderr.
_gh_with_retry() {
  if [ -z "$_INTAKE_GH_STDERR_FILE" ]; then return 1; fi
  local attempt=1 max=3 sleep_s=0
  local stdout
  : > "$_INTAKE_GH_STDERR_FILE" 2>/dev/null || true
  while [ "$attempt" -le "$max" ]; do
    if [ "$sleep_s" != 0 ]; then sleep "$sleep_s"; fi
    if stdout=$(gh "$@" 2>"$_INTAKE_GH_STDERR_FILE"); then
      printf '%s\n' "$stdout"
      return 0
    fi
    case "$attempt" in
      1) sleep_s=0.5 ;;
      2) sleep_s=1 ;;
    esac
    attempt=$((attempt + 1))
  done
  return 1
}

# Read the last captured gh stderr (after _gh_with_retry failure).
# Outputs the captured stderr to stdout. Returns 1 if no stderr was captured.
_gh_last_stderr() {
  if [ -n "$_INTAKE_GH_STDERR_FILE" ] && [ -s "$_INTAKE_GH_STDERR_FILE" ]; then
    cat "$_INTAKE_GH_STDERR_FILE"
    return 0
  fi
  return 1
}
