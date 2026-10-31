#!/usr/bin/env bash
# clean-stale-skill-links.sh — clean up HOME-level skill symlinks left over from
# the legacy default-on `pnpm sync:skills` behavior, per ADR-025 第 8 条.
#
# Scope: scans $HOME/.{claude,codex,gemini,kimi}/skills/ for symlinks whose
# resolved target lives inside this repo's cat-cafe-skills/ source. Those are
# "managed" links the legacy script installed; safe to remove now that
# `pnpm sync:skills` defaults to project-level (F239 Phase A).
#
# Safety:
# - Default mode is --dry-run: list candidates, delete nothing (ADR-025 第 8 条).
# - --apply: actually delete. Non-symlink entries (real files/dirs) AND symlinks
#   pointing outside cat-cafe-skills/ (user's own custom links) are NEVER touched.
# - Idempotent: re-runs on already-clean state report 0 candidates.
#
# Usage: pnpm clean:stale-skill-links [--dry-run] [--apply] [--help]
#
# Env:
#   CLEAN_STALE_SKILLS_SRC  Override skills source (for tests). Default: auto-
#                           detect via `git worktree list` → main repo /cat-cafe-skills.

set -euo pipefail

DRY_RUN=true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --apply)   DRY_RUN=false ;;
    -h|--help)
      cat <<'USAGE'
Usage: pnpm clean:stale-skill-links [--dry-run] [--apply] [--help]
  --dry-run   (default) Scan and list candidates. No files deleted.
  --apply     Delete the listed stale symlinks. Only links pointing to
              cat-cafe-skills/ source are removed; user-owned links and
              real files are preserved.

Per ADR-025 第 8 条: 旧用户级 symlinks → 清理提示（不自动删除）.
Default to --dry-run; --apply is a deliberate, idempotent action.
USAGE
      exit 0
      ;;
    *)
      printf "Unknown flag: %s\n" "$arg" >&2
      printf "Usage: pnpm clean:stale-skill-links [--dry-run] [--apply] [--help]\n" >&2
      exit 1
      ;;
  esac
done

# Detect the managed skills source(s). Multi-source support (cloud P2 round 2
# PR #2328 line 60): legacy HOME symlinks may point at the main-repo source OR
# the worktree-local source — must scan against both so the cleanup actually
# matches what setup.sh's stale-link hint reports.
if [ -n "${CLEAN_STALE_SKILLS_SRC:-}" ]; then
  SKILLS_SRC="$CLEAN_STALE_SKILLS_SRC"
  SKILLS_SRC_EXTRA=""  # test-injected single source; no fallback
else
  MAIN_REPO="$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //' || true)"
  if [ -z "$MAIN_REPO" ]; then
    printf "ERROR: cannot detect cat-cafe repo via 'git worktree list'.\n" >&2
    printf "Run from within the cat-cafe repo, or set CLEAN_STALE_SKILLS_SRC explicitly.\n" >&2
    exit 1
  fi
  SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"
  # If invoked from a linked worktree with its own cat-cafe-skills/, accept
  # that as an additional candidate source (mirrors setup.sh detection).
  PWD_SKILLS="$(pwd)/cat-cafe-skills"
  if [ -d "$PWD_SKILLS" ] && [ "$PWD_SKILLS" != "$SKILLS_SRC" ]; then
    SKILLS_SRC_EXTRA="$PWD_SKILLS"
  else
    SKILLS_SRC_EXTRA=""
  fi
fi

if [ ! -d "$SKILLS_SRC" ]; then
  printf "ERROR: skills source %s does not exist.\n" "$SKILLS_SRC" >&2
  exit 1
fi

# Canonicalize a path via shell builtin (avoids python fork; macOS readlink lacks -f).
canon_path() {
  local p="$1"
  if [ -d "$p" ]; then
    (cd "$p" 2>/dev/null && pwd -P) || true
  elif [ -e "$p" ] || [ -L "$p" ]; then
    local dir base
    dir="$(dirname "$p")"
    base="$(basename "$p")"
    if [ -d "$dir" ]; then
      printf "%s/%s\n" "$(cd "$dir" 2>/dev/null && pwd -P)" "$base"
    fi
  fi
}

SKILLS_SRC_REAL="$(canon_path "$SKILLS_SRC")"
if [ -z "$SKILLS_SRC_REAL" ]; then
  printf "ERROR: cannot canonicalize skills source %s\n" "$SKILLS_SRC" >&2
  exit 1
fi

# Canonicalize the optional extra source (worktree-local). Empty if absent.
SKILLS_SRC_EXTRA_REAL=""
if [ -n "${SKILLS_SRC_EXTRA:-}" ]; then
  SKILLS_SRC_EXTRA_REAL="$(canon_path "$SKILLS_SRC_EXTRA")"
  # If extra resolves to the same canonical as main, drop it (avoid dup match).
  [ "$SKILLS_SRC_EXTRA_REAL" = "$SKILLS_SRC_REAL" ] && SKILLS_SRC_EXTRA_REAL=""
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

candidates=()
preserved_user=0
preserved_real=0

scan_provider() {
  local provider_dir="$1"
  [ -d "$provider_dir" ] || return 0
  local entry target real_target canon_target
  for entry in "$provider_dir"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    if [ ! -L "$entry" ]; then
      preserved_real=$((preserved_real + 1))
      continue
    fi
    # Symlink: build the candidate absolute path. For relative targets, just
    # concatenate against provider_dir — canon_path will resolve actual on-disk
    # links when possible. For dangling symlinks (target dir doesn't exist),
    # canon_path returns empty; we fall back to the unresolved string which
    # cannot match SKILLS_SRC_REAL → entry is preserved as user-owned.
    # (Avoids `cd ...` chain that would trip `set -e` on dangling targets —
    # cloud P2 / 砚砚 round 1 on PR #2328.)
    target="$(readlink "$entry")"
    case "$target" in
      /*) real_target="$target" ;;
      *)  real_target="$provider_dir/$target" ;;
    esac
    canon_target="$(canon_path "$real_target")"
    [ -z "$canon_target" ] && canon_target="$real_target"
    # Match against EITHER main-repo source OR worktree-local source (when set
    # and distinct). Matches setup.sh detection so cleanup actually removes
    # what the hint reports (cloud P2 round 2 PR #2328 line 60).
    matched=0
    case "$canon_target" in
      "$SKILLS_SRC_REAL"/*|"$SKILLS_SRC_REAL") matched=1 ;;
    esac
    if [ "$matched" = "0" ] && [ -n "$SKILLS_SRC_EXTRA_REAL" ]; then
      case "$canon_target" in
        "$SKILLS_SRC_EXTRA_REAL"/*|"$SKILLS_SRC_EXTRA_REAL") matched=1 ;;
      esac
    fi
    if [ "$matched" = "1" ]; then
      candidates+=("$entry")
    else
      preserved_user=$((preserved_user + 1))
    fi
  done
}

printf "\n${BOLD}Stale skill link cleanup${NC} (ADR-025 第 8 条)\n"
printf "Source: %s\n" "$SKILLS_SRC_REAL"
$DRY_RUN && printf "${YELLOW}[DRY RUN]${NC} no files will be deleted\n" || printf "${RED}[APPLY]${NC} candidates will be removed\n"

for provider in claude codex gemini kimi; do
  scan_provider "$HOME/.${provider}/skills"
done

printf "\n${BOLD}Candidates (%d)${NC}\n" "${#candidates[@]}"
if [ "${#candidates[@]}" -gt 0 ]; then
  for c in "${candidates[@]}"; do
    if $DRY_RUN; then
      printf "  ${YELLOW}would remove${NC} %s\n" "$c"
    else
      rm "$c"
      printf "  ${GREEN}removed${NC} %s\n" "$c"
    fi
  done
fi

printf "\n${BOLD}Summary${NC}\n"
if $DRY_RUN; then
  printf "  ${YELLOW}%d${NC} stale candidates (run with --apply to remove)\n" "${#candidates[@]}"
else
  printf "  ${GREEN}%d${NC} stale links removed\n" "${#candidates[@]}"
fi
printf "  preserved: %d user-owned symlinks + %d real files/dirs\n" "$preserved_user" "$preserved_real"

exit 0
