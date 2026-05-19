# shellcheck shell=bash
# Quick-start build-freshness gate (ops infra; see runtime-worktree.sh).
#
# Why this exists: quick-start used to gate package rebuilds on artifact
# EXISTENCE ([ ! -f dist/index.js ]). Once the artifact existed it was never
# rebuilt, so synced source changes never reached the running process across
# any number of restarts. We gate on source FRESHNESS instead, keyed by the
# git commit recorded at build time.
#
# needs_rebuild <product> <stamp> <current_head>
#   exit 0 → rebuild required
#   exit 1 → skip (artifact is fresh — quick fast-path preserved)
needs_rebuild() {
  local product="$1" stamp="$2" current_head="$3"
  [ -f "$product" ] || return 0   # build product missing → rebuild (git or not)
  # HEAD check MUST come before stamp: non-git in-place runtime always has
  # empty HEAD, and record_build_stamp refuses to write empty — without
  # short-circuiting here, every restart would rebuild because the stamp
  # never materializes (cloud P1 PR #1706, worse than the original bug).
  [ -n "$current_head" ] || return 1  # HEAD unavailable (non-git deploy) → skip
  [ -f "$stamp" ] || return 0     # have HEAD but no stamp → legacy upgrade → rebuild
  [ "$(cat "$stamp" 2>/dev/null)" = "$current_head" ] && return 1  # stamp matches HEAD → fresh
  return 0  # stamp differs from HEAD (source synced) → rebuild
}

# record_build_stamp <stamp> <current_head>
# Persist the commit a build was produced at, so the next quick-start can tell
# whether the source moved underneath it. Best-effort: never fail the build,
# and never write a stamp we can't trust (empty HEAD).
record_build_stamp() {
  local stamp="$1" current_head="$2"
  [ -n "$current_head" ] || return 0
  mkdir -p "$(dirname "$stamp")" 2>/dev/null || return 0
  printf '%s\n' "$current_head" > "$stamp" 2>/dev/null || true
}
