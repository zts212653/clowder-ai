#!/usr/bin/env bash
# check-skills-mount.sh — Cat Café Skills 挂载看板
# 检查 cat-cafe-skills/ 下所有 skill 是否按 project-level-first 口径挂载：
# 1. 目录级 symlink（<project>/.{claude,codex,gemini,kimi}/skills -> cat-cafe-skills）
# 2. per-skill symlink（<project>/.xxx/skills/<skill> 或 ~/.xxx/skills/<skill>）
# 注：OpenCode（金渐层）读取 ~/.claude/ 配置，Claude 挂了 = OpenCode 也挂了
# 并校验 BOOTSTRAP.md 注册一致性
# 用法: pnpm check:skills

set -euo pipefail

MAIN_REPO="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
WORKTREE_REPO="$(git rev-parse --show-toplevel)"
SKILLS_SRC="$WORKTREE_REPO/cat-cafe-skills"
[ -f "$SKILLS_SRC/manifest.yaml" ] || SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"
FALLBACK_SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"
BOOTSTRAP="$SKILLS_SRC/BOOTSTRAP.md"
CLAUDE_SKILLS="$HOME/.claude/skills"
CODEX_SKILLS="$HOME/.codex/skills"
GEMINI_SKILLS="$HOME/.gemini/skills"
KIMI_SKILLS="$HOME/.kimi/skills"
PROJECT_CLAUDE_SKILLS="$WORKTREE_REPO/.claude/skills"
PROJECT_CODEX_SKILLS="$WORKTREE_REPO/.codex/skills"
PROJECT_GEMINI_SKILLS="$WORKTREE_REPO/.gemini/skills"
PROJECT_KIMI_SKILLS="$WORKTREE_REPO/.kimi/skills"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

total=0
missing=0
reg_warnings=0
manifest_failures=0

canon_path() {
  python3 - "$1" <<'PY'
import os, sys
path = sys.argv[1]
try:
    print(os.path.realpath(path))
except Exception:
    pass
PY
}

is_correct_symlink() {
  local link_path="$1"
  local expected_target="$2"
  [ -L "$link_path" ] || return 1

  local resolved_link resolved_expected
  resolved_link="$(canon_path "$link_path")"
  resolved_expected="$(canon_path "$expected_target")"
  [ -n "$resolved_link" ] && [ -n "$resolved_expected" ] && [ "$resolved_link" = "$resolved_expected" ]
}

is_skill_mounted_for_provider() {
  local skill_name="$1"
  local expected_root="$2"
  local fallback_root="$3"
  shift 3

  local base_dir
  for base_dir in "$@"; do
    [ -n "$base_dir" ] || continue
    if is_correct_symlink "$base_dir" "$expected_root"; then
      return 0
    fi
    if [ -n "$fallback_root" ] && is_correct_symlink "$base_dir" "$fallback_root"; then
      return 0
    fi
    if is_correct_symlink "$base_dir/$skill_name" "$expected_root/$skill_name"; then
      return 0
    fi
    if [ -n "$fallback_root" ] && is_correct_symlink "$base_dir/$skill_name" "$fallback_root/$skill_name"; then
      return 0
    fi
  done
  return 1
}

# ─── Part 1: Symlink Mount Check ───

printf "\n${BOLD}Cat Café Skills 挂载看板${NC}\n"
printf "源目录: %s\n\n" "$SKILLS_SRC"
printf "%-35s  %-8s  %-8s  %-8s  %-8s\n" "Skill" "Claude*" "Codex" "Gemini" "Kimi"
printf "%-35s  %-8s  %-8s  %-8s  %-8s\n" "-----------------------------------" "--------" "--------" "--------" "--------"

# Collect all source skill names
source_skills=()
for skill_dir in "$SKILLS_SRC"/*/; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  [ -f "$skill_dir/SKILL.md" ] || continue

  source_skills+=("$skill_name")
  total=$((total + 1))
  row=""

  if is_skill_mounted_for_provider "$skill_name" "$SKILLS_SRC" "$FALLBACK_SKILLS_SRC" "$PROJECT_CLAUDE_SKILLS" "$CLAUDE_SKILLS"; then
    row="$row  ${GREEN}✓${NC}       "
  else
    row="$row  ${RED}✗${NC}       "
    missing=$((missing + 1))
  fi

  if is_skill_mounted_for_provider "$skill_name" "$SKILLS_SRC" "$FALLBACK_SKILLS_SRC" "$PROJECT_CODEX_SKILLS" "$CODEX_SKILLS"; then
    row="$row  ${GREEN}✓${NC}       "
  else
    row="$row  ${RED}✗${NC}       "
    missing=$((missing + 1))
  fi

  if is_skill_mounted_for_provider "$skill_name" "$SKILLS_SRC" "$FALLBACK_SKILLS_SRC" "$PROJECT_GEMINI_SKILLS" "$GEMINI_SKILLS"; then
    row="$row  ${GREEN}✓${NC}       "
  else
    row="$row  ${RED}✗${NC}       "
    missing=$((missing + 1))
  fi

  if is_skill_mounted_for_provider "$skill_name" "$SKILLS_SRC" "$FALLBACK_SKILLS_SRC" "$PROJECT_KIMI_SKILLS" "$KIMI_SKILLS"; then
    row="$row  ${GREEN}✓${NC}       "
  else
    row="$row  ${RED}✗${NC}       "
    missing=$((missing + 1))
  fi

  printf "%-35s %b\n" "$skill_name" "$row"
done

printf "\n${BOLD}挂载合计${NC}: %d skills, " "$total"
if [ "$missing" -eq 0 ]; then
  printf "${GREEN}全部正确挂载${NC}\n"
else
  printf "${RED}%d 处缺失/异常${NC}\n" "$missing"
fi

# ─── Part 2: BOOTSTRAP.md Registration Check (advisory, not blocking) ───

printf "\n${BOLD}注册检查（BOOTSTRAP.md ↔ 源目录）${NC}\n\n"

# Extract skill names from BOOTSTRAP.md backtick-quoted entries in table rows
# Pattern: | `skill-name` | ... |
# grep may match nothing — use || true to prevent set -e exit
bootstrap_skills=()
if [ -f "$BOOTSTRAP" ]; then
  while IFS= read -r line; do
    bootstrap_skills+=("$line")
  done < <(grep -oE '\| `[a-z][-a-z0-9]*` \|' "$BOOTSTRAP" | sed 's/| `//;s/` |//' || true)
fi

# Check A: source dir → BOOTSTRAP.md
for skill in "${source_skills[@]}"; do
  found=false
  for bs in "${bootstrap_skills[@]}"; do
    if [ "$skill" = "$bs" ]; then
      found=true
      break
    fi
  done
  if ! $found; then
    printf "  %-35s ${YELLOW}⚠ not registered in BOOTSTRAP.md${NC}\n" "$skill"
    reg_warnings=$((reg_warnings + 1))
  fi
done

# Check B: BOOTSTRAP.md → source dir
for bs in "${bootstrap_skills[@]}"; do
  if [ ! -f "$SKILLS_SRC/$bs/SKILL.md" ]; then
    printf "  %-35s ${YELLOW}⚠ phantom entry (in BOOTSTRAP.md but no source)${NC}\n" "$bs"
    reg_warnings=$((reg_warnings + 1))
  fi
done

if [ "$reg_warnings" -eq 0 ]; then
  printf "  ${GREEN}全部一致${NC}\n"
fi

# ─── Part 3: Manifest Consistency Check (blocking) ───

printf "\n${BOLD}Manifest 一致性校验（阻塞）${NC}\n\n"
if node "$WORKTREE_REPO/scripts/check-skills-manifest.mjs" "$WORKTREE_REPO"; then
  :
else
  manifest_failures=$((manifest_failures + 1))
fi

# ─── Summary ───
# Exit code: mount failures + manifest failures are blocking; registration warnings are advisory.

printf "\n${BOLD}总结${NC}: %d skills, " "$total"
if [ "$missing" -eq 0 ] && [ "$reg_warnings" -eq 0 ] && [ "$manifest_failures" -eq 0 ]; then
  printf "${GREEN}全部正确（挂载 + 注册 + manifest）${NC}\n\n"
  exit 0
else
  [ "$missing" -gt 0 ] && printf "${RED}%d 挂载异常${NC} " "$missing"
  [ "$reg_warnings" -gt 0 ] && printf "${YELLOW}%d 注册警告${NC} " "$reg_warnings"
  [ "$manifest_failures" -gt 0 ] && printf "${RED}%d manifest 失败${NC} " "$manifest_failures"
  printf "\n\n"
  if [ "$missing" -gt 0 ]; then
    printf "修复挂载:\n"
    printf "  ln -s %s %s/.claude/skills\n" "$SKILLS_SRC" "$WORKTREE_REPO"
    printf "  ln -s %s %s/.codex/skills\n" "$SKILLS_SRC" "$WORKTREE_REPO"
    printf "  ln -s %s %s/.gemini/skills\n" "$SKILLS_SRC" "$WORKTREE_REPO"
    printf "  ln -s %s %s/.kimi/skills\n" "$SKILLS_SRC" "$WORKTREE_REPO"
    printf "  # 或使用 HOME 级 per-skill fallback（兼容旧口径）\n"
    printf "  ln -s %s/{skill-name} ~/.claude/skills/{skill-name}\n" "$SKILLS_SRC"
    printf "  ln -s %s/{skill-name} ~/.codex/skills/{skill-name}\n" "$SKILLS_SRC"
    printf "  ln -s %s/{skill-name} ~/.gemini/skills/{skill-name}\n" "$SKILLS_SRC"
    printf "  ln -s %s/{skill-name} ~/.kimi/skills/{skill-name}\n\n" "$SKILLS_SRC"
    printf "  * Claude 列同时覆盖 OpenCode（金渐层读取 ~/.claude/ 配置）\n\n"
  fi
  if [ "$reg_warnings" -gt 0 ]; then
    printf "修复注册: 编辑 cat-cafe-skills/BOOTSTRAP.md 添加/移除对应条目\n\n"
  fi
  # Mount failures and manifest failures are blocking.
  if [ "$missing" -gt 0 ] || [ "$manifest_failures" -gt 0 ]; then
    exit 1
  fi
  exit 0
fi
