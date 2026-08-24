#!/usr/bin/env bash
# Shared mount helpers for sync-skills.sh. They read the caller's counters and
# flags, keeping the CLI orchestration small without changing write boundaries.

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
  local link_target="$3"
  local link_path="$target_dir/$skill_name"

  if [ -L "$link_path" ]; then
    local existing
    existing="$(readlink "$link_path")"
    if [ "$existing" = "$link_target" ]; then
      skipped=$((skipped + 1))
      return 0
    fi
    if $DRY_RUN; then
      log_action "would replace $link_path → $link_target"
      created=$((created + 1))
      return 0
    fi
    rm "$link_path"
  elif [ -e "$link_path" ]; then
    printf "  ${RED}ERROR${NC} %s (exists but not a symlink)\n" "$link_path"
    errors=$((errors + 1))
    return 0
  fi

  if [ ! -d "$target_dir" ]; then
    if $DRY_RUN; then
      log_action "would mkdir $target_dir"
    else
      mkdir -p "$target_dir"
    fi
  fi

  if $DRY_RUN; then
    log_action "would create $link_path → $link_target"
  else
    ln -s "$link_target" "$link_path"
    log_action "created $link_path → $link_target"
  fi
  created=$((created + 1))
}

sync_shared_refs() {
  local target_dir="$1"
  local link_target="$2"
  local link_path="$target_dir/$SHARED_REFS_ALIAS"

  if [ -L "$link_path" ] && [ "$(readlink "$link_path")" = "$link_target" ]; then
    skipped=$((skipped + 1))
    return 0
  fi
  if [ -e "$link_path" ] || [ -L "$link_path" ]; then
    printf "  ${RED}ERROR${NC} %s (reserved shared refs coordinate is occupied)\n" "$link_path"
    errors=$((errors + 1))
    return 0
  fi
  if [ ! -d "$target_dir" ]; then
    if $DRY_RUN; then
      log_action "would mkdir $target_dir"
    else
      mkdir -p "$target_dir"
    fi
  fi
  if $DRY_RUN; then
    log_action "would create $link_path → $link_target"
  else
    ln -s "$link_target" "$link_path"
    log_action "created $link_path → $link_target"
  fi
  created=$((created + 1))
}

collect_skill_names() {
  local source="$1"
  skill_names=()
  for skill_dir in "$source"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_names+=("$skill_name")
  done
}
