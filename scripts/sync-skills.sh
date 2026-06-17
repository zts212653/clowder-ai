#!/usr/bin/env bash
# sync-skills.sh — 从 cat-cafe-skills/ 自动同步 symlinks 到 provider skills 目录
# 解决 Wave 2 欠债：手工 symlink 反复遗漏
#
# 同步目标（默认 — project-level）：
#   1. main worktree  .{claude,codex,gemini,kimi}/skills/  （git tracked）
#   2. 所有 worktree   .{claude,codex,gemini,kimi}/skills/  （runtime 等）
#
# 同步目标（--user opt-in — HOME-level，per ADR-025 第 3 条）：
#   3. HOME 级  ~/.claude/skills/          （Claude Code 全局）
#   4. HOME 级  ~/.codex/skills/           （Codex）
#   5. HOME 级  ~/.gemini/skills/          （Gemini）
#   6. HOME 级  ~/.kimi/skills/            （Kimi）
#
# 注：ADR-025 第 3 条规定用户级目录不默认承载官方 skills；
#     contributor 想全局共享 cat-cafe-skills/ 需显式 `--user` opt-in。
#
# 用法: pnpm sync:skills [--dry-run] [--user]

set -euo pipefail

MAIN_REPO="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"

# HOME-level uses absolute symlinks (check-skills-mount.sh expects this)
HOME_CLAUDE="$HOME/.claude/skills"
HOME_CODEX="$HOME/.codex/skills"
HOME_GEMINI="$HOME/.gemini/skills"
HOME_KIMI="$HOME/.kimi/skills"

DRY_RUN=false
USER_MODE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --user) USER_MODE=true ;;
    -h|--help)
      printf "Usage: pnpm sync:skills [--dry-run] [--user]\n"
      printf "  --dry-run   Show what would change without writing.\n"
      printf "  --user      Also mount HOME-level symlinks at ~/.{claude,codex,gemini,kimi}/skills/.\n"
      printf "              Default: project-level only (ADR-025 第 3 条).\n"
      exit 0
      ;;
    *)
      printf "Unknown flag: %s\n" "$arg" >&2
      printf "Usage: pnpm sync:skills [--dry-run] [--user]\n" >&2
      exit 1
      ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

created=0
skipped=0
errors=0
dir_mounted=0  # providers where .{provider}/skills is a valid directory-level
               # symlink (legacy mount, already valid) — skipped wholesale

# Canonicalize a path to its physical (symlink-resolved) location. macOS
# readlink lacks -f; using `cd && pwd -P` is a builtin and avoids spawning
# python3 thousands of times across the worktree × provider matrix.
# Returns empty on resolution failure so callers can treat that as invalid.
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

# Mirror skill-sync.ts shouldSkipDirectoryLevelSkillsSymlink: classify a
# provider's skills directory before per-skill loop.
#
# Accepts one or more expected source paths — caller passes worktree-local
# AND main-repo sources so a legacy dir-level symlink targeting either is
# treated as valid (cloud P2 round 2 on PR #2325: worktrees may have dir-
# level mounts pointing at the main source even when worktree-local
# cat-cafe-skills/ exists).
#
# Echoes one of:
#   skip      $skills_dir is a valid directory-level symlink to any of the
#             provided expected sources. Caller MUST skip per-skill writes
#             (would re-enter source tree).
#   loop      $skills_dir is not a symlink; per-skill loop is appropriate.
#   invalid   $skills_dir is a symlink but resolves to none of the provided
#             expected sources. Caller MUST NOT write through it.
classify_provider_dir() {
  local skills_dir="$1"
  shift
  if [ ! -L "$skills_dir" ]; then
    echo loop
    return 0
  fi
  local mounted_root
  mounted_root="$(canon_path "$skills_dir")"
  if [ -z "$mounted_root" ]; then
    echo invalid
    return 0
  fi
  local src expected_root
  for src in "$@"; do
    expected_root="$(canon_path "$src")"
    if [ -n "$expected_root" ] && [ "$mounted_root" = "$expected_root" ]; then
      echo skip
      return 0
    fi
  done
  echo invalid
}

sync_link() {
  local skill_name="$1"
  local target_dir="$2"
  local link_target="$3"  # absolute or relative path to skill dir
  local link_path="$target_dir/$skill_name"

  # Skip if correct symlink already exists
  if [ -L "$link_path" ]; then
    local existing
    existing="$(readlink "$link_path")"
    if [ "$existing" = "$link_target" ]; then
      skipped=$((skipped + 1))
      return 0
    fi
    # Wrong target — remove and recreate
    if $DRY_RUN; then
      printf "  ${YELLOW}[dry-run]${NC} would replace %s → %s\n" "$link_path" "$link_target"
      created=$((created + 1))
      return 0
    fi
    rm "$link_path"
  elif [ -e "$link_path" ]; then
    # Not a symlink but something exists. Surface as a real error: directory-
    # level legacy mounts are handled by classify_provider_dir upstream, so any
    # path hitting this branch is genuinely unexpected (corrupted state, hand-
    # created file, etc.) and shouldn't silently pass.
    printf "  ${RED}SKIP${NC} %s (exists but not a symlink)\n" "$link_path"
    errors=$((errors + 1))
    return 0
  fi

  # Ensure target dir exists
  if [ ! -d "$target_dir" ]; then
    if $DRY_RUN; then
      printf "  ${YELLOW}[dry-run]${NC} would mkdir %s\n" "$target_dir"
    else
      mkdir -p "$target_dir"
    fi
  fi

  if $DRY_RUN; then
    printf "  ${YELLOW}[dry-run]${NC} would create %s → %s\n" "$link_path" "$link_target"
  else
    ln -s "$link_target" "$link_path"
    printf "  ${GREEN}✓${NC} %s → %s\n" "$skill_name" "$target_dir/"
  fi
  created=$((created + 1))
}

# Collect all skill names
skill_names=()
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue
  skill_names+=("$skill_name")
done

printf "\n${BOLD}Clowder AI Skills Sync${NC}\n"
printf "源: %s (%d skills)\n" "$SKILLS_SRC" "${#skill_names[@]}"
$DRY_RUN && printf "${YELLOW}[DRY RUN MODE]${NC}\n"

# ─── Part 1: All worktrees (project-level, relative symlinks) ───

# Collect worktree paths
worktree_paths=()
while IFS= read -r line; do
  wt_path="${line#worktree }"
  worktree_paths+=("$wt_path")
done < <(git worktree list --porcelain | grep '^worktree ')

printf "\n${BOLD}[Worktrees]${NC} %d 个 × 4 providers (claude/codex/gemini/kimi)\n" "${#worktree_paths[@]}"
for wt in "${worktree_paths[@]}"; do
  # Skip prunable / stale worktree entries — `git worktree list` may still list
  # a path that has been deleted on disk before `git worktree prune` ran. Writing
  # into a non-existent worktree creates broken symlinks (cloud P2 round 2 on PR
  # #2325). Skip silently; user runs `git worktree prune` to clean the list.
  if [ ! -d "$wt" ]; then
    continue
  fi

  # Skip ff-only sync worktrees (runtime, alpha) — their content comes from
  # origin/main; local symlink generation only causes merge conflicts.
  wt_branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$wt_branch" == */main-sync ]]; then
    continue
  fi

  wt_label="$(basename "$wt")"
  [ "$wt" = "$MAIN_REPO" ] && wt_label="main"

  # Per-worktree expected mount source(s): primary is worktree-local
  # `cat-cafe-skills/` (matches per-skill relative target `../../cat-cafe-skills/$skill_name`).
  # Legacy directory-level symlinks may target either the worktree-local source
  # OR the main repo's source — classify_provider_dir accepts a list of expected
  # sources, so we pass both candidates and any match counts as valid.
  wt_skills_src="$wt/cat-cafe-skills"
  [ -d "$wt_skills_src" ] || wt_skills_src="$SKILLS_SRC"

  # ADR-025: project-level mount covers all 4 providers (claude/codex/gemini/kimi),
  # aligned with governance-bootstrap. .codex/ .gemini/ .kimi/ are gitignored at
  # repo root so generated symlinks won't dirty git status; .claude/skills is tracked.
  for provider in claude codex gemini kimi; do
    wt_skills="$wt/.${provider}/skills"

    # Provider-dir guard (mirrors skill-sync.ts shouldSkipDirectoryLevelSkillsSymlink):
    # If $wt_skills itself is a symlink to a cat-cafe-skills/ source, the provider
    # is already mounted at the directory level. Descending into it would re-enter
    # the source tree and report bogus per-skill anomalies — skip wholesale.
    # Accept either worktree-local OR main-repo source as a valid dir-mount target.
    case "$(classify_provider_dir "$wt_skills" "$wt_skills_src" "$SKILLS_SRC")" in
      skip)
        dir_mounted=$((dir_mounted + 1))
        printf "  ${GREEN}%s${NC} (.${provider}): dir-level mount OK (skip per-skill)\n" "$wt_label"
        continue
        ;;
      invalid)
        printf "  ${RED}ERROR${NC} %s is a symlink with unexpected target (expected one of: %s, %s)\n" "$wt_skills" "$wt_skills_src" "$SKILLS_SRC"
        errors=$((errors + 1))
        continue
        ;;
      loop)
        ;;
    esac

    # Per-skill links use relative target `../../cat-cafe-skills/$skill` which
    # resolves to $wt/cat-cafe-skills/$skill. If the worktree lacks its own
    # cat-cafe-skills/ (sparse checkout, old branch), relative links would
    # dangle into a non-existent path. Skip per-skill mount in that case —
    # the worktree can still pick up dir-level mounts via the guard above,
    # but plain per-skill writes would create broken symlinks (cloud P2
    # round 3 on PR #2325 line 220).
    if [ ! -d "$wt/cat-cafe-skills" ]; then
      printf "  ${YELLOW}skip${NC} %s (.${provider}): no %s/cat-cafe-skills/\n" "$wt_label" "$wt_label"
      continue
    fi

    # Parent-dir escape guard: if .${provider} (or its parent path) is a symlink
    # leading outside the worktree (e.g. `.codex -> ~/.codex`), per-skill writes
    # would land in the user's HOME — violating the default-mode contract that
    # HOME-level skills are only written via --user (cloud P2 round 5 on PR #2325).
    wt_real="$(canon_path "$wt")"
    target_parent_real="$(canon_path "$(dirname "$wt_skills")")"
    if [ -n "$target_parent_real" ] && [ -n "$wt_real" ]; then
      case "$target_parent_real" in
        "$wt_real"|"$wt_real"/*) ;;
        *)
          printf "  ${RED}ERROR${NC} %s parent escapes worktree (resolves to %s)\n" "$wt_skills" "$target_parent_real"
          errors=$((errors + 1))
          continue
          ;;
      esac
    fi

    synced=0
    for skill_name in "${skill_names[@]}"; do
      before=$created
      sync_link "$skill_name" "$wt_skills" "../../cat-cafe-skills/$skill_name"
      [ "$created" -gt "$before" ] && synced=$((synced + 1))
    done
    if [ "$synced" -gt 0 ]; then
      printf "  ${GREEN}%s${NC} (.${provider}): %d 修复\n" "$wt_label" "$synced"
    fi
  done
done

# ─── Part 2: HOME-level (absolute symlinks) — opt-in via --user (ADR-025 第 3 条) ───

if $USER_MODE; then
  printf "\n${BOLD}[HOME]${NC} ~/.{claude,codex,gemini,kimi}/skills/ (--user opt-in)\n"
  for skill_name in "${skill_names[@]}"; do
    sync_link "$skill_name" "$HOME_CLAUDE" "$SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_CODEX"  "$SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_GEMINI" "$SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_KIMI"   "$SKILLS_SRC/$skill_name"
  done
else
  printf "\n${BOLD}[HOME]${NC} skipped (default project-level only)\n"
  printf "  ${YELLOW}Note${NC}: HOME-level skill mount is now opt-in per ADR-025.\n"
  printf "  Run \`pnpm sync:skills --user\` to mount ~/.{claude,codex,gemini,kimi}/skills/.\n"
fi

# ─── Part 3: Write skills-state.json (ADR-025 Phase 1) ───
# Gate the state write on errors == 0: a partial sync where some provider was
# skipped or rejected should NOT record a fresh manifest, mirroring skill-sync.ts
# which fails before writing state (cloud P2 round 5 on PR #2325 line 241).

if ! $DRY_RUN && [ "$errors" -eq 0 ]; then
  STATE_DIR="$MAIN_REPO/.cat-cafe"
  STATE_FILE="$STATE_DIR/skills-state.json"
  mkdir -p "$STATE_DIR"

  # Compute manifest hash: SHA-256 of sorted skill names
  # Must match computeSourceManifestHash() in skills-state.ts
  MANIFEST_HASH="sha256:$(printf '%s\n' "${skill_names[@]}" | sort | shasum -a 256 | cut -c1-16)"
  SYNCED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # sourceRoot: relative path from project root to skills source
  # For main repo: SKILLS_SRC is $MAIN_REPO/cat-cafe-skills → relative = "cat-cafe-skills"
  SOURCE_ROOT="${SKILLS_SRC#"$MAIN_REPO"/}"

  # Build JSON (sorted names for deterministic output)
  SORTED_NAMES=$(printf '%s\n' "${skill_names[@]}" | sort | awk '{printf "    \"%s\"", $0; if (NR<TOTAL) printf ","; printf "\n"}' TOTAL="${#skill_names[@]}")
  cat > "$STATE_FILE" <<EOJSON
{
  "managedSkillNames": [
${SORTED_NAMES}
  ],
  "sourceRoot": "${SOURCE_ROOT}",
  "sourceManifestHash": "${MANIFEST_HASH}",
  "lastSyncedAt": "${SYNCED_AT}"
}
EOJSON

  printf "${BOLD}[State]${NC} ${GREEN}✓${NC} %s (hash: %s)\n" "$STATE_FILE" "$MANIFEST_HASH"
fi

# ─── Summary ───

printf "\n${BOLD}结果${NC}: "
if [ "$created" -gt 0 ]; then
  printf "${GREEN}%d 新建/修复${NC} " "$created"
fi
printf "%d 已正确 " "$skipped"
if [ "$dir_mounted" -gt 0 ]; then
  printf "${GREEN}%d providers dir-level mount${NC} " "$dir_mounted"
fi
if [ "$errors" -gt 0 ]; then
  printf "${RED}%d 错误${NC}" "$errors"
fi
printf "\n\n"

if [ "$created" -gt 0 ] && ! $DRY_RUN; then
  printf "${YELLOW}提示${NC}: 项目级 symlinks 需要 git add + commit 才能持久化\n"
  printf "  git add .claude/skills/ && git commit -m 'fix(skills): sync missing symlinks'\n\n"
fi

exit "$errors"
