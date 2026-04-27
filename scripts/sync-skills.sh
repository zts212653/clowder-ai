#!/usr/bin/env bash
# sync-skills.sh — 从 cat-cafe-skills/ 自动同步 symlinks 到三猫 skills 目录
# 解决 Wave 2 欠债：手工 symlink 反复遗漏
#
# 同步目标：
#   1. main worktree  .claude/skills/     （git tracked）
#   2. 所有 worktree   .claude/skills/     （runtime 等）
#   3. HOME 级  ~/.claude/skills/          （Claude Code 全局 + Hub 检测）
#   4. HOME 级  ~/.codex/skills/           （Codex）
#   5. HOME 级  ~/.gemini/skills/          （Gemini）
#
# 注：OpenCode（金渐层）读取 ~/.claude/ 配置，无需单独同步
#
# 用法: pnpm sync:skills [--dry-run]

set -euo pipefail

MAIN_REPO="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"

# HOME-level uses absolute symlinks (check-skills-mount.sh expects this)
HOME_CLAUDE="$HOME/.claude/skills"
HOME_CODEX="$HOME/.codex/skills"
HOME_GEMINI="$HOME/.gemini/skills"

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

created=0
skipped=0
errors=0

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
    # Not a symlink but something exists — skip with warning
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

printf "\n${BOLD}Cat Café Skills Sync${NC}\n"
printf "源: %s (%d skills)\n" "$SKILLS_SRC" "${#skill_names[@]}"
$DRY_RUN && printf "${YELLOW}[DRY RUN MODE]${NC}\n"

# ─── Part 1: All worktrees (project-level, relative symlinks) ───

# Collect worktree paths
worktree_paths=()
while IFS= read -r line; do
  wt_path="${line#worktree }"
  worktree_paths+=("$wt_path")
done < <(git worktree list --porcelain | grep '^worktree ')

printf "\n${BOLD}[Worktrees]${NC} %d 个\n" "${#worktree_paths[@]}"
for wt in "${worktree_paths[@]}"; do
  wt_skills="$wt/.claude/skills"

  # Skip ff-only sync worktrees (runtime, alpha) — their content comes from
  # origin/main; local symlink generation only causes merge conflicts.
  wt_branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$wt_branch" == */main-sync ]]; then
    continue
  fi

  # Only sync worktrees that have a .claude/skills dir (or main)
  if [ "$wt" = "$MAIN_REPO" ] || [ -d "$wt_skills" ]; then
    wt_label="$(basename "$wt")"
    [ "$wt" = "$MAIN_REPO" ] && wt_label="main"
    synced=0
    for skill_name in "${skill_names[@]}"; do
      before=$created
      sync_link "$skill_name" "$wt_skills" "../../cat-cafe-skills/$skill_name"
      [ "$created" -gt "$before" ] && synced=$((synced + 1))
    done
    if [ "$synced" -gt 0 ]; then
      printf "  ${GREEN}%s${NC}: %d 修复\n" "$wt_label" "$synced"
    fi
  fi
done

# ─── Part 2: HOME-level (absolute symlinks) ───

printf "\n${BOLD}[HOME]${NC} ~/.{claude,codex,gemini}/skills/ (OpenCode via ~/.claude/)\n"
for skill_name in "${skill_names[@]}"; do
  sync_link "$skill_name" "$HOME_CLAUDE" "$SKILLS_SRC/$skill_name"
  sync_link "$skill_name" "$HOME_CODEX"  "$SKILLS_SRC/$skill_name"
  sync_link "$skill_name" "$HOME_GEMINI" "$SKILLS_SRC/$skill_name"
done

# ─── Part 3: Write skills-state.json (ADR-025 Phase 1) ───

if ! $DRY_RUN; then
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
if [ "$errors" -gt 0 ]; then
  printf "${RED}%d 错误${NC}" "$errors"
fi
printf "\n\n"

if [ "$created" -gt 0 ] && ! $DRY_RUN; then
  printf "${YELLOW}提示${NC}: 项目级 symlinks 需要 git add + commit 才能持久化\n"
  printf "  git add .claude/skills/ && git commit -m 'fix(skills): sync missing symlinks'\n\n"
fi

exit "$errors"
