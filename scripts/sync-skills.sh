#!/usr/bin/env bash
# sync-skills.sh — 从 cat-cafe-skills/ 自动同步 symlinks 到 provider skills 目录
# 解决 Wave 2 欠债：手工 symlink 反复遗漏
#
# 同步目标（默认 — project-level）：
#   1. 调用命令所在的 worktree  .{claude,codex,gemini,kimi}/skills/
#
# 同步目标（--all — 显式 fleet repair）：
#   2. 每个 eligible worktree  .{claude,codex,gemini,kimi}/skills/
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
# 用法: pnpm sync:skills [--dry-run] [--user] [--all] [--verbose]

set -euo pipefail

WORKTREE_LIST="$(git worktree list --porcelain)"
MAIN_REPO=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      MAIN_REPO="${line#worktree }"
      break
      ;;
  esac
done <<< "$WORKTREE_LIST"
if [ -z "$MAIN_REPO" ]; then
  printf "ERROR: failed to resolve main worktree from git worktree list\n" >&2
  exit 1
fi
HOME_SKILLS_SRC="$MAIN_REPO/cat-cafe-skills"
CURRENT_REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$CURRENT_REPO" ] || [ ! -d "$CURRENT_REPO/cat-cafe-skills" ]; then
  printf "ERROR: run sync:skills from a Clowder AI worktree with cat-cafe-skills/\n" >&2
  exit 1
fi

# HOME-level uses absolute symlinks (check-skills-mount.sh expects this)
HOME_CLAUDE="$HOME/.claude/skills"
HOME_CODEX="$HOME/.codex/skills"
HOME_GEMINI="$HOME/.gemini/skills"
HOME_KIMI="$HOME/.kimi/skills"

DRY_RUN=false
USER_MODE=false
ALL_MODE=false
VERBOSE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --user) USER_MODE=true ;;
    --all) ALL_MODE=true ;;
    --verbose) VERBOSE=true ;;
    -h|--help)
      printf "Usage: pnpm sync:skills [--dry-run] [--user] [--all] [--verbose]\n"
      printf "  --dry-run   Show what would change without writing.\n"
      printf "  --user      Also mount HOME-level symlinks at ~/.{claude,codex,gemini,kimi}/skills/.\n"
      printf "              Default: project-level only (ADR-025 第 3 条).\n"
      printf "  --all       Repair every eligible worktree instead of only the invoking one.\n"
      printf "  --verbose   Print individual mount actions in addition to the summary.\n"
      exit 0
      ;;
    *)
      printf "Unknown flag: %s\n" "$arg" >&2
      printf "Usage: pnpm sync:skills [--dry-run] [--user] [--all] [--verbose]\n" >&2
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
worktrees_scanned=0
provider_targets=0
state_writes=0
SHARED_REFS_ALIAS=".cat-cafe-shared-refs"

log_action() {
  $VERBOSE || return 0
  printf "  [action] %s\n" "$*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/sync-skills-helpers.sh
source "$SCRIPT_DIR/lib/sync-skills-helpers.sh"

SKILLS_SRC="$CURRENT_REPO/cat-cafe-skills"
collect_skill_names "$SKILLS_SRC"

printf "\n${BOLD}Clowder AI Skills Sync${NC}\n"
if $ALL_MODE; then
  printf "Scope: all eligible worktrees\n"
  printf "Source: each worktree's cat-cafe-skills/\n"
else
  printf "Scope: current worktree\n"
  printf "Source: %s (%d skills)\n" "$SKILLS_SRC" "${#skill_names[@]}"
fi
$DRY_RUN && printf "${YELLOW}[DRY RUN MODE]${NC}\n"

# ─── Part 1: Project-level targets (current by default; --all for fleet) ───

# Collect worktree paths
worktree_paths=()
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      wt_path="${line#worktree }"
      worktree_paths+=("$wt_path")
      ;;
  esac
done <<< "$WORKTREE_LIST"

if ! $ALL_MODE; then
  worktree_paths=("$CURRENT_REPO")
fi

if $VERBOSE; then
  printf "\n${BOLD}[Worktrees]${NC} %d selected × 4 providers (claude/codex/gemini/kimi)\n" "${#worktree_paths[@]}"
fi
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

  worktrees_scanned=$((worktrees_scanned + 1))
  wt_label="$(basename "$wt")"
  [ "$wt" = "$MAIN_REPO" ] && wt_label="main"

  # Per-worktree expected mount source(s): primary is worktree-local
  # `cat-cafe-skills/` (matches per-skill relative target `../../cat-cafe-skills/$skill_name`).
  # Legacy directory-level symlinks may target either the worktree-local source
  # OR the main repo's source — classify_provider_dir accepts a list of expected
  # sources, so we pass both candidates and any match counts as valid.
  wt_skills_src="$wt/cat-cafe-skills"
  if [ -d "$wt_skills_src" ]; then
    collect_skill_names "$wt_skills_src"
  else
    wt_skills_src="$HOME_SKILLS_SRC"
    skill_names=()
  fi

  # ADR-025: project-level mount covers all 4 providers (claude/codex/gemini/kimi),
  # aligned with governance-bootstrap. .codex/ .gemini/ .kimi/ are gitignored at
  # repo root so generated symlinks won't dirty git status; .claude/skills is tracked.
  for provider in claude codex gemini kimi; do
    wt_skills="$wt/.${provider}/skills"
    provider_targets=$((provider_targets + 1))

    # Provider-dir guard (mirrors skill-sync.ts shouldSkipDirectoryLevelSkillsSymlink):
    # If $wt_skills itself is a symlink to a cat-cafe-skills/ source, the provider
    # is already mounted at the directory level. Descending into it would re-enter
    # the source tree and report bogus per-skill anomalies — skip wholesale.
    # Accept either worktree-local OR main-repo source as a valid dir-mount target.
    case "$(classify_provider_dir "$wt_skills" "$wt_skills_src" "$HOME_SKILLS_SRC")" in
      skip)
        dir_mounted=$((dir_mounted + 1))
        log_action "$wt_label (.${provider}): dir-level mount OK (skip per-skill)"
        continue
        ;;
      invalid)
        printf "  ${RED}ERROR${NC} %s is a symlink with unexpected target (expected one of: %s, %s)\n" "$wt_skills" "$wt_skills_src" "$HOME_SKILLS_SRC"
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
    before=$created
    sync_shared_refs "$wt_skills" "../../cat-cafe-skills/refs"
    [ "$created" -gt "$before" ] && synced=$((synced + 1))
    for skill_name in "${skill_names[@]}"; do
      before=$created
      sync_link "$skill_name" "$wt_skills" "../../cat-cafe-skills/$skill_name"
      [ "$created" -gt "$before" ] && synced=$((synced + 1))
    done
    if $VERBOSE && [ "$synced" -gt 0 ]; then
      log_action "$wt_label (.${provider}): $synced repaired"
    fi
  done
done

# ─── Part 2: HOME-level (absolute symlinks) — opt-in via --user (ADR-025 第 3 条) ───

if $USER_MODE; then
  collect_skill_names "$HOME_SKILLS_SRC"
  printf "\n${BOLD}[HOME]${NC} ~/.{claude,codex,gemini,kimi}/skills/ (--user opt-in)\n"
  printf "HOME targets: %s, %s, %s, %s\n" "$HOME_CLAUDE" "$HOME_CODEX" "$HOME_GEMINI" "$HOME_KIMI"
  sync_shared_refs "$HOME_CLAUDE" "$HOME_SKILLS_SRC/refs"
  sync_shared_refs "$HOME_CODEX" "$HOME_SKILLS_SRC/refs"
  sync_shared_refs "$HOME_GEMINI" "$HOME_SKILLS_SRC/refs"
  sync_shared_refs "$HOME_KIMI" "$HOME_SKILLS_SRC/refs"
  for skill_name in "${skill_names[@]}"; do
    sync_link "$skill_name" "$HOME_CLAUDE" "$HOME_SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_CODEX"  "$HOME_SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_GEMINI" "$HOME_SKILLS_SRC/$skill_name"
    sync_link "$skill_name" "$HOME_KIMI"   "$HOME_SKILLS_SRC/$skill_name"
  done
else
  printf "\n${BOLD}[HOME]${NC} skipped (default project-level only)\n"
  printf "  ${YELLOW}Note${NC}: HOME-level skill mount is now opt-in per ADR-025.\n"
  printf "  Run \`pnpm sync:skills --user\` to mount ~/.{claude,codex,gemini,kimi}/skills/.\n"
fi

# ─── Part 3: Write sync state ───
# Gate the state write on errors == 0: a partial sync where some provider was
# skipped or rejected should NOT record a fresh manifest, mirroring skill-sync.ts
# which fails before writing state (cloud P2 round 5 on PR #2325 line 241).
# v2: capabilities.json#skillsSync is the source of truth for checkStaleness()
# Legacy: skills-state.json kept for backward compatibility

if ! $DRY_RUN && [ "$errors" -eq 0 ]; then
  STATE_REPO="$CURRENT_REPO"
  STATE_SOURCE="$CURRENT_REPO/cat-cafe-skills"
  if $ALL_MODE; then
    STATE_REPO="$MAIN_REPO"
    STATE_SOURCE="$HOME_SKILLS_SRC"
  fi
  collect_skill_names "$STATE_SOURCE"

  STATE_DIR="$STATE_REPO/.cat-cafe"
  mkdir -p "$STATE_DIR"

  # Compute manifest hash: SHA-256 of sorted skill names
  # Must match computeSourceManifestHash() in skills-state.ts
  MANIFEST_HASH="sha256:$(printf '%s\n' "${skill_names[@]}" | sort | shasum -a 256 | cut -c1-16)"
  SYNCED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # sourceRoot is always relative to the worktree receiving this state update.
  SOURCE_ROOT="${STATE_SOURCE#"$STATE_REPO"/}"

  # v2: merge skillsSync into capabilities.json (source of truth for API staleness)
  CAP_FILE="$STATE_DIR/capabilities.json"
  node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const capFile = process.argv[1];
const syncState = JSON.parse(process.argv[2]);
let config;
try { config = JSON.parse(readFileSync(capFile, 'utf8')); } catch { config = { version: 2, capabilities: [] }; }
config.skillsSync = syncState;
writeFileSync(capFile, JSON.stringify(config, null, 2) + '\n');
" "$CAP_FILE" "{\"sourceRoot\":\"$SOURCE_ROOT\",\"sourceManifestHash\":\"$MANIFEST_HASH\",\"lastSyncedAt\":\"$SYNCED_AT\"}"

  state_writes=$((state_writes + 1))
  log_action "updated $CAP_FILE#skillsSync ($MANIFEST_HASH)"

  # Legacy: skills-state.json (backward compat — will be removed in a future cleanup)
  STATE_FILE="$STATE_DIR/skills-state.json"
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

  state_writes=$((state_writes + 1))
  log_action "updated $STATE_FILE ($MANIFEST_HASH)"
fi

# ─── Summary ───

printf "\nTargets: %d provider surfaces across %d worktrees\n" "$provider_targets" "$worktrees_scanned"
printf "\n${BOLD}结果${NC}: "
if [ "$created" -gt 0 ]; then
  printf "${GREEN}%d 新建/修复${NC} " "$created"
fi
printf "%d 已正确 " "$skipped"
if [ "$dir_mounted" -gt 0 ]; then
  printf "${GREEN}%d providers dir-level mount${NC} " "$dir_mounted"
fi
if [ "$state_writes" -gt 0 ]; then
  printf "%d state files updated " "$state_writes"
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
