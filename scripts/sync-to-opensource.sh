#!/usr/bin/env bash
# sync-to-opensource.sh — Cat Café → Clowder AI 开源同步脚本
# 七步管道 (D1-D5 hardening):
#   Step 0: Pre-sync gate (dirty check + inbound detection)
#   Step 1: Clean tree export
#   Step 2: Allowlist filter
#   Step 3: Transforms (sanitize + generate)
#   Step 4: Security scan (denylist + secrets + /Users/ + internal patterns + endpoints)
#   Step 5: Source-owned public gate (temp target clone → install + check + lint + build + test:public + acceptance)
#   Step 6: Sync (target-owned backup → diff preview → rsync → restore)
#
# Usage:
#   bash scripts/sync-to-opensource.sh                    # 完整同步（含 source-owned public gate）
#   bash scripts/sync-to-opensource.sh --dry-run          # 只导出到临时目录，不同步
#   bash scripts/sync-to-opensource.sh --validate         # 导出 + temp target public gate（不同步）
#   bash scripts/sync-to-opensource.sh --skip-validate    # 同步但跳过 source-owned public gate
#   bash scripts/sync-to-opensource.sh --fast-validate    # 同步 + temp target 静态门禁/test:public（跳过 startup acceptance）
#   bash scripts/sync-to-opensource.sh --yes              # 非交互模式（猫猫/CI 用，跳过确认提示）
#   bash scripts/sync-to-opensource.sh --force-overwrite  # 强制覆盖未吸收的社区 commit（危险！）
#   bash scripts/sync-to-opensource.sh --module=docs      # 模块级同步（V1: Step 5/6 按模块，Step 1-4 仍全量）
#   bash scripts/sync-to-opensource.sh --module=api       # 模块级同步（同上）
#   bash scripts/sync-to-opensource.sh --cat-sig="[金渐层/Opus-46🐾]"  # 猫猫签名
#   bash scripts/sync-to-opensource.sh --co-author="Name <email>"      # 社区贡献者署名（可重复）
#   bash scripts/sync-to-opensource.sh --release-tag=v0.1.1            # release-intended full sync（自动打 source snapshot tag）
#   Modules: all root docs shared api web mcp skills
#   NOTE: V1 模块化仅影响 Step 5 rsync 和 Step 6 validate。
#         Step 1-4（export/transform/scan）始终全量执行。V2 再按模块裁剪。

set -euo pipefail

# ── Portable sed -i ──────────────────────────────────────────
# macOS sed requires -i '', GNU sed requires -i without argument.
if sed --version 2>/dev/null | grep -q GNU; then
  sedi() { sed -i "$@"; }
else
  sedi() { sed -i '' "$@"; }
fi

# ── 颜色 ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── 进度日志（P0 可观测性）──────────────────────────────────
SYNC_START_TIME=$(date +%s)
STEP_START_TIME=$SYNC_START_TIME
step_start() {
  STEP_START_TIME=$(date +%s)
  echo ""
  echo -e "${GREEN}[$1] $2${NC}  [$(date +%H:%M:%S)]"
}
step_done() {
  local elapsed=$(( $(date +%s) - STEP_START_TIME ))
  echo -e "  ${BLUE}⏱ ${elapsed}s${NC}"
}

run_static_quality_gates() {
  local autofix="${1:-false}"

  if [ "$autofix" = true ]; then
    echo "  Biome autofix (best effort)..."
    if ! pnpm check:fix 2>&1 | tail -5; then
      echo -e "  ${RED}✗ pnpm check:fix failed${NC}"
      return 1
    fi
  fi

  echo "  Biome check..."
  if ! pnpm check 2>&1 | tail -5; then
    echo -e "  ${RED}✗ pnpm check failed${NC}"
    return 1
  fi

  echo "  TypeScript lint..."
  if ! pnpm lint 2>&1 | tail -5; then
    echo -e "  ${RED}✗ pnpm lint failed${NC}"
    return 1
  fi
}

run_public_acceptance_env() {
  env \
    -u NODE_ENV \
    -u npm_config_production \
    -u NPM_CONFIG_PRODUCTION \
    -u REDIS_URL \
    -u REDIS_PROFILE \
    -u REDIS_STORAGE_KEY \
    -u REDIS_DATA_DIR \
    -u REDIS_BACKUP_DIR \
    -u REDIS_DBFILE \
    -u API_SERVER_HOST \
    -u FRONTEND_PORT \
    -u API_SERVER_PORT \
    -u NEXT_PUBLIC_API_URL \
    -u PREVIEW_GATEWAY_PORT \
    -u PORT \
    -u CAT_CAFE_RESPECT_DOTENV_PORTS \
    -u MEMORY_STORE \
    "$@"
}

remaining_wall_clock_seconds() {
  local deadline="$1"
  local now
  now=$(date +%s)
  local remaining=$(( deadline - now ))
  if [ "$remaining" -gt 0 ]; then
    echo "$remaining"
  else
    echo 0
  fi
}

curl_probe_timeout() {
  local remaining="$1"
  local max_timeout="$2"
  if [ "$remaining" -lt "$max_timeout" ]; then
    echo "$remaining"
  else
    echo "$max_timeout"
  fi
}

resolve_physical_path() {
  local raw_path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$raw_path" <<'PY'
import os
import sys

print(os.path.realpath(sys.argv[1]))
PY
  else
    node -e "console.log(require('path').resolve(process.argv[1]))" "$raw_path"
  fi
}

list_source_worktree_realpaths() {
  git -C "$SOURCE_DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10)}' | \
    while IFS= read -r worktree_path; do
      resolve_physical_path "$worktree_path"
    done
}

SOURCE_SYNC_DIR=""
SOURCE_SYNC_REF="HEAD"

cleanup_source_sync_tree() {
  if [ -z "${SOURCE_SYNC_DIR:-}" ] || [ "$SOURCE_SYNC_DIR" = "$SOURCE_DIR" ]; then
    SOURCE_SYNC_DIR="$SOURCE_DIR"
    SOURCE_SYNC_REF="HEAD"
    return
  fi
  if [ -d "$SOURCE_SYNC_DIR/.git" ] || [ -d "$SOURCE_SYNC_DIR" ]; then
    git -C "$SOURCE_DIR" worktree remove --force "$SOURCE_SYNC_DIR" >/dev/null 2>&1 || true
    rm -rf "$SOURCE_SYNC_DIR" 2>/dev/null || true
  fi
  SOURCE_SYNC_DIR="$SOURCE_DIR"
  SOURCE_SYNC_REF="HEAD"
}

prepare_source_sync_tree() {
  if ! git -C "$SOURCE_DIR" fetch --no-tags origin main >/dev/null 2>&1; then
    echo -e "  ${RED}✗ Failed to refresh cat-cafe origin/main before full sync${NC}"
    return 1
  fi
  local temp_dir
  temp_dir=$(mktemp -d)
  rmdir "$temp_dir"
  SOURCE_SYNC_DIR="$temp_dir"
  SOURCE_SYNC_REF="HEAD"
  if ! git -C "$SOURCE_DIR" worktree add --detach "$SOURCE_SYNC_DIR" refs/remotes/origin/main >/dev/null 2>&1; then
    echo -e "  ${RED}✗ Failed to create source sync worktree from origin/main${NC}"
    SOURCE_SYNC_DIR="$SOURCE_DIR"
    SOURCE_SYNC_REF="HEAD"
    return 1
  fi
}

target_git_repo_exists() {
  local repo_dir="$1"
  git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1
}

validate_incomplete_absorbed_overlaps() {
  local ledger_path="$1"
  local source_dir="$2"
  local target_dir="$3"

  local incomplete_entries
  incomplete_entries=$(node - "$ledger_path" <<'NODE'
const fs = require('fs');
const ledgerPath = process.argv[2];
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
const entries = ledger.entries || [];
let lastOutboundSyncIndex = -1;
entries.forEach((entry, index) => {
  if (entry.decision === 'outbound-sync') {
    lastOutboundSyncIndex = index;
  }
});
for (const [index, entry] of entries.entries()) {
  if (index <= lastOutboundSyncIndex) {
    continue;
  }
  const note = String(entry.note || '').toLowerCase();
  if (note.includes('historical backfill') || note.includes('outbound-filed hotfix') || note.includes('skip-absorbed-guard')) {
    continue;
  }
  if (entry.decision === 'absorbed' && !entry.intake_intent_issue && !entry.review_proof && entry.target_merge_commit) {
    console.log(`${entry.pr_number || '?'}|${entry.target_merge_commit}`);
  }
}
NODE
  )

  if [ -z "$incomplete_entries" ]; then
    echo "  ✓ No incomplete absorbed records in intake ledger"
    return 0
  fi

  local blocked=false
  local overlap_count=0
  local overlap_list=""
  while IFS='|' read -r pr_number commit; do
    if [ -z "$commit" ]; then
      continue
    fi
    if ! git -C "$target_dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
      continue
    fi

    while IFS= read -r touched_file; do
      if [ -z "$touched_file" ]; then
        continue
      fi
      case "$touched_file" in
        docs/ops/opensource-intake-ledger.json|.sync-provenance.json) continue ;;
      esac

      local source_file="$source_dir/$touched_file"
      local target_file="$target_dir/$touched_file"
      if [ -f "$source_file" ] && [ -f "$target_file" ] && ! cmp -s "$source_file" "$target_file"; then
        blocked=true
        overlap_count=$((overlap_count + 1))
        overlap_list="${overlap_list}    → clowder-ai#${pr_number} ${commit:0:12} ${touched_file}\n"
      elif { [ -e "$source_file" ] || [ -e "$target_file" ]; } && { [ ! -e "$source_file" ] || [ ! -e "$target_file" ]; }; then
        blocked=true
        overlap_count=$((overlap_count + 1))
        overlap_list="${overlap_list}    → clowder-ai#${pr_number} ${commit:0:12} ${touched_file}\n"
      fi
    done < <(git -C "$target_dir" show --name-only --format= "$commit" 2>/dev/null | sed '/^$/d')
  done <<< "$incomplete_entries"

  if [ "$blocked" = true ]; then
    echo -e "  ${RED}✗ BLOCKED: $overlap_count incomplete absorbed community file(s) still differ from source${NC}"
    echo -e "  ${YELLOW}  recorded != absorbed-complete: ledger entries without intake issue + review proof cannot prove source equivalence.${NC}"
    echo -e "  ${YELLOW}  These target-side community changes would be overwritten by sync:${NC}"
    echo -e "$overlap_list"
    echo -e "  ${YELLOW}  Complete intake or add review-backed proof before syncing.${NC}"
    if [ "$FORCE_OVERWRITE" = true ]; then
      echo -e "  ${RED}⚠ --force-overwrite: proceeding despite incomplete absorbed overlap${NC}"
      return 0
    fi
    return 1
  fi

  echo "  ✓ Incomplete absorbed overlap guard passed"
  return 0
}

find_available_port() {
  local preferred_port="$1"
  local avoid_port="${2:-}"
  node - "$preferred_port" "$avoid_port" <<'NODE'
const net = require('node:net');

const preferred = Number(process.argv[2] || 0);
const avoid = new Set(process.argv.slice(3).map((value) => Number(value)).filter(Boolean));

function reserve(port) {
  const server = net.createServer();
  server.unref();
  server.on('error', () => reserve(0));
  server.listen({ host: '127.0.0.1', port }, () => {
    const actual = server.address().port;
    if (avoid.has(actual)) {
      server.close(() => reserve(0));
      return;
    }
    process.stdout.write(String(actual));
    server.close();
  });
}

reserve(preferred && !avoid.has(preferred) ? preferred : 0);
NODE
}

validate_release_tag() {
  local tag="$1"
  if [[ ! "$tag" =~ ^v[0-9]+(\.[0-9]+){1,2}([-.][0-9A-Za-z.-]+)?$ ]]; then
    echo -e "${RED}✗ Invalid --release-tag: $tag${NC}"
    echo "  Expected examples: v0.1.0, v0.1.1, v0.2.0-rc.1"
    exit 1
  fi
}

derive_source_snapshot_tag() {
  local release_tag="$1"
  printf 'clowder-%s-source\n' "$release_tag"
}

json_string_or_null() {
  local value="$1"
  if [ -n "$value" ]; then
    printf '"%s"' "$value"
  else
    printf 'null'
  fi
}

ensure_source_snapshot_tag() {
  local tag="$1"
  local sha="$2"
  local release_tag="$3"
  local existing_sha
  local remote_sha

  if git -C "$SOURCE_DIR" rev-parse --verify "refs/tags/$tag^{commit}" >/dev/null 2>&1; then
    existing_sha=$(git -C "$SOURCE_DIR" rev-parse "refs/tags/$tag^{commit}")
    if [ "$existing_sha" != "$sha" ]; then
      echo -e "${RED}✗ Source snapshot tag $tag already points to ${existing_sha}, not ${sha}${NC}"
      exit 1
    fi
    echo "  ✓ Source snapshot tag already exists locally: $tag -> ${sha:0:12}"
  else
    git -C "$SOURCE_DIR" tag -a "$tag" "$sha" -m "source snapshot for clowder-ai $release_tag"
    echo "  ✓ Created source snapshot tag: $tag -> ${sha:0:12}"
  fi

  remote_sha=$(
    git -C "$SOURCE_DIR" ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" \
      | awk '{print $1}' | tail -n1
  )
  if [ -n "$remote_sha" ]; then
    if [ "$remote_sha" != "$sha" ]; then
      echo -e "${RED}✗ origin tag $tag already points to ${remote_sha}, not ${sha}${NC}"
      exit 1
    fi
    echo "  ✓ Source snapshot tag already on origin: $tag -> ${sha:0:12}"
    return 0
  fi

  git -C "$SOURCE_DIR" push origin "refs/tags/$tag"
  echo "  ✓ Pushed source snapshot tag to origin: $tag"
}

require_release_source_commit_on_main() {
  local sha="$1"
  if ! git -C "$SOURCE_DIR" fetch --no-tags origin main >/dev/null 2>&1; then
    echo -e "${RED}✗ Failed to refresh cat-cafe origin/main before release-intended sync${NC}"
    exit 1
  fi
  if ! git -C "$SOURCE_DIR" merge-base --is-ancestor "$sha" refs/remotes/origin/main; then
    echo -e "${RED}✗ --release-tag requires the source commit to be reachable from origin/main${NC}"
    echo -e "${RED}  Current source commit: $sha${NC}"
    echo -e "${RED}  Land the source-side release commits on main first, then rerun the full sync.${NC}"
    exit 1
  fi
}

# ── 参数 ──────────────────────────────────────────────────────
# F251 Task 4c R3 (§16e failure-mode audit, opus48 cross-review):
# Shared validation for both `--override=val` (equals-form) and `--override val` (split-form).
# Rejects option-looking values (`--something`) so they cannot silently swallow subsequent
# flags. Single source of truth for the guard — applied at every override entry point to
# eliminate the same-type vulnerability that surfaced once per form.
#
# Exploit context: module syncs skip the delta gate, so a malformed override is never
# rejected downstream by the Node CLI. Without this guard, `--module=docs --override=--dry-run
# --yes` would capture `--dry-run` as override data, leaving DRY_RUN=false and proceeding
# with a real rsync against clowder-ai. Fail-closed at parse time.
reject_option_looking_override_value() {
  case "$1" in
    --*)
      echo -e "\033[31m✗ --override expected a <path>:<reason> value but got '$1' (looks like another flag — use --override <path>:<reason> or --override=<path>:<reason>)\033[0m" >&2
      exit 1
      ;;
  esac
}

DRY_RUN=false
VALIDATE=false
SKIP_VALIDATE=false
SKIP_DELTA_GATE=false
# F251 Task 4c: --override <path>:<reason> repeatable, forwarded to all 3 gate sites.
# --cvo-approved-public-delta-overwrite suppresses the > 3 override CVO alarm (KD-3).
DELTA_GATE_OVERRIDES=()
DELTA_GATE_CVO_APPROVED=false
FAST_VALIDATE=false
AUTO_YES=false
FORCE_OVERWRITE=false
SYNC_MODULE="all"
CO_AUTHORS=()
CAT_SIG=""
RELEASE_TAG=""
SOURCE_SNAPSHOT_TAG=""
# F251 Task 4c: support both `--override=path:reason` (matches the script's other valued
# flags like --module=) and `--override path:reason` (matches the Node CLI's split form,
# what AC-A4 docs print). PENDING_OVERRIDE_VALUE is true after a bare `--override`; the
# next iteration consumes the value into DELTA_GATE_OVERRIDES.
PENDING_OVERRIDE_VALUE=false
for arg in "$@"; do
  if [ "$PENDING_OVERRIDE_VALUE" = true ]; then
    # R1 cloud P1 #3485225646 + R2 cloud P2 #3485236801 §16e audit:
    # Both split-form (this branch) and equals-form (case below) go through the SAME guard.
    reject_option_looking_override_value "$arg"
    DELTA_GATE_OVERRIDES+=("$arg")
    PENDING_OVERRIDE_VALUE=false
    continue
  fi
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --validate) VALIDATE=true ;;
    --skip-validate) SKIP_VALIDATE=true ;;
    --skip-delta-gate) SKIP_DELTA_GATE=true ;;
    --override=*)
      override_value="${arg#--override=}"
      reject_option_looking_override_value "$override_value"
      DELTA_GATE_OVERRIDES+=("$override_value")
      ;;
    --override) PENDING_OVERRIDE_VALUE=true ;;
    --cvo-approved-public-delta-overwrite) DELTA_GATE_CVO_APPROVED=true ;;
    --fast-validate) FAST_VALIDATE=true ;;
    --yes|-y) AUTO_YES=true ;;
    --force-overwrite) FORCE_OVERWRITE=true ;;
    --module=*) SYNC_MODULE="${arg#--module=}" ;;
    --co-author=*) CO_AUTHORS+=("${arg#--co-author=}") ;;
    --cat-sig=*) CAT_SIG="${arg#--cat-sig=}" ;;
    --release-tag=*) RELEASE_TAG="${arg#--release-tag=}" ;;
  esac
done

# F251 Task 4c: catch `--override` with no following value (operator typo / last-arg drop).
# Without this, a bare trailing `--override` would silently drop the override → BLOCK
# would still hold (fail-closed) but operator UX would be confusing.
if [ "$PENDING_OVERRIDE_VALUE" = true ]; then
  echo -e "\033[31m✗ --override requires a <path>:<reason> value (use --override <path>:<reason> or --override=<path>:<reason>)\033[0m" >&2
  exit 1
fi

# ── 模块定义（P2 modular sync）──────────────────────────────
# Each module owns mutually exclusive roots → per-module rsync --delete is safe
# bash 3.2 compatible (no declare -A)
module_root() {
  case "$1" in
    root)   echo "" ;;
    docs)   echo "docs/" ;;
    shared) echo "packages/shared/" ;;
    api)    echo "packages/api/" ;;
    web)    echo "packages/web/" ;;
    mcp)    echo "packages/mcp-server/" ;;
    skills) echo "cat-cafe-skills/" ;;
    *)      echo "INVALID" ;;
  esac
}
VALID_MODULES="all root docs shared api web mcp skills"
if ! echo "$VALID_MODULES" | grep -qw "$SYNC_MODULE"; then
  echo -e "${RED}✗ Invalid module: $SYNC_MODULE${NC}"
  echo "  Valid modules: $VALID_MODULES"
  exit 1
fi

if [ -n "$RELEASE_TAG" ]; then
  validate_release_tag "$RELEASE_TAG"
  if [ "$DRY_RUN" = true ] || [ "$VALIDATE" = true ]; then
    echo -e "${RED}✗ --release-tag only applies to real full sync runs${NC}"
    exit 1
  fi
  if [ "$SYNC_MODULE" != "all" ]; then
    echo -e "${RED}✗ --release-tag requires --module=all${NC}"
    exit 1
  fi
  if [ "$SKIP_VALIDATE" = true ] || [ "$FAST_VALIDATE" = true ]; then
    echo -e "${RED}✗ --release-tag requires the full source-owned public gate (no --skip-validate/--fast-validate)${NC}"
    exit 1
  fi
  SOURCE_SNAPSHOT_TAG="$(derive_source_snapshot_tag "$RELEASE_TAG")"
fi

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_SYNC_DIR="$SOURCE_DIR"
TARGET_DIR="${CLOWDER_AI_DIR:-$(cd "$SOURCE_DIR/.." && pwd)/clowder-ai}"

# ── Safety guard: 禁止 sync 到内部 cat-cafe worktree ─────────
# 事故 LL-035: rsync --delete 曾把 runtime worktree 当目标，删了 2057 个文件 + 覆盖 .env
RESOLVED_TARGET="$(resolve_physical_path "$TARGET_DIR")"
TARGET_BASENAME="$(basename "$RESOLVED_TARGET")"
if [[ "$TARGET_BASENAME" == cat-cafe* ]]; then
  echo -e "${RED}✗ FATAL: TARGET_DIR 指向内部 cat-cafe 目录: $RESOLVED_TARGET${NC}"
  echo -e "${RED}  此脚本只能同步到开源仓（clowder-ai），不能对着自己家开炮。${NC}"
  echo -e "${RED}  检查 CLOWDER_AI_DIR 环境变量是否指向正确的开源仓目录。${NC}"
  exit 1
fi
if list_source_worktree_realpaths | grep -qFx "$RESOLVED_TARGET"; then
  echo -e "${RED}✗ FATAL: TARGET_DIR 是当前仓库的 worktree: $RESOLVED_TARGET${NC}"
  echo -e "${RED}  rsync --delete 会摧毁 worktree 内容。请指向开源仓目录。${NC}"
  exit 1
fi

# 轻量 YAML list 解析: 从 "key:" 下方读取 "  - value" 直到下个 key
yaml_list() {
  local key="$1"
  awk -v k="$key:" '
    BEGIN { found=0 }
    found && /^[^ #-]/ { exit }
    found && /^  - / {
      line = $0
      sub(/^  - /, "", line)
      sub(/[[:space:]]#.*/, "", line)
      gsub(/^[[:space:]]+/, "", line)
      gsub(/[[:space:]]+$/, "", line)
      gsub(/"/, "", line)
      if (length(line) > 0) print line
      next
    }
    $0 ~ "^"k { found=1 }
  ' "$MANIFEST"
}

backup_target_owned_items() {
  local target_dir="$1"
  local backup_dir="$2"
  local backed_up=0
  for owned in "${TARGET_OWNED[@]}"; do
    if [ -d "$target_dir/$owned" ]; then
      mkdir -p "$backup_dir/$(dirname "$owned")"
      cp -R "$target_dir/$owned" "$backup_dir/$owned"
      backed_up=$((backed_up + 1))
    elif [ -f "$target_dir/$owned" ]; then
      mkdir -p "$backup_dir/$(dirname "$owned")"
      cp "$target_dir/$owned" "$backup_dir/$owned"
      backed_up=$((backed_up + 1))
    fi
  done
  echo "$backed_up"
}

restore_target_owned_items() {
  local target_dir="$1"
  local backup_dir="$2"
  local restored=0
  for owned in "${TARGET_OWNED[@]}"; do
    if [ -d "$backup_dir/$owned" ]; then
      mkdir -p "$target_dir/$(dirname "$owned")"
      cp -R "$backup_dir/$owned" "$target_dir/$owned"
      restored=$((restored + 1))
    elif [ -f "$backup_dir/$owned" ]; then
      mkdir -p "$target_dir/$(dirname "$owned")"
      cp "$backup_dir/$owned" "$target_dir/$owned"
      restored=$((restored + 1))
    fi
  done
  echo "$restored"
}

sync_filtered_into_target() {
  local target_dir="$1"
  if [ "$SYNC_MODULE" = "all" ]; then
    rsync -a --delete \
      --exclude='.git' \
      "$FILTERED_DIR/" "$target_dir/"
    return
  fi

  local module_root_path
  module_root_path="$(module_root "$SYNC_MODULE")"
  if [ -z "$module_root_path" ]; then
    rsync -a \
      --exclude='.git' \
      --exclude='packages/' \
      --exclude='docs/' \
      --exclude='cat-cafe-skills/' \
      --exclude='scripts/' \
      --exclude='.github/' \
      --exclude='.sync-provenance.json' \
      "$FILTERED_DIR/" "$target_dir/"
    return
  fi

  if [ -d "$FILTERED_DIR/$module_root_path" ]; then
    mkdir -p "$target_dir/$module_root_path"
    rsync -a --delete \
      "$FILTERED_DIR/$module_root_path" "$target_dir/$module_root_path"
  fi
}

VALIDATION_TARGET_DIR=""
cleanup_validation_target() {
  if [ -z "${VALIDATION_TARGET_DIR:-}" ]; then
    return
  fi
  if [ -d "$VALIDATION_TARGET_DIR/.git" ] || [ -d "$VALIDATION_TARGET_DIR" ]; then
    git -C "$TARGET_DIR" worktree remove --force "$VALIDATION_TARGET_DIR" >/dev/null 2>&1 || true
    rm -rf "$VALIDATION_TARGET_DIR" 2>/dev/null || true
  fi
  VALIDATION_TARGET_DIR=""
}

prepare_validation_target() {
  if ! target_git_repo_exists "$TARGET_DIR"; then
    echo -e "  ${RED}✗ Target git repo not found: $TARGET_DIR${NC}"
    return 1
  fi
  local temp_dir
  temp_dir=$(mktemp -d)
  rmdir "$temp_dir"
  VALIDATION_TARGET_DIR="$temp_dir"
  if ! git -C "$TARGET_DIR" worktree add --detach "$VALIDATION_TARGET_DIR" HEAD >/dev/null 2>&1; then
    echo -e "  ${RED}✗ Failed to create temp target worktree from $TARGET_DIR${NC}"
    VALIDATION_TARGET_DIR=""
    return 1
  fi
}

run_target_public_gate() {
  local gate_target="$1"
  local gate_target_real
  local step_fail=false
  local original_dir="$PWD"
  local l0_compile_log=""
  local test_public_log=""

  gate_target_real="$(resolve_physical_path "$gate_target")"
  cd "$gate_target"

  if [ -f "$gate_target/.env.example" ] && [ ! -f "$gate_target/.env" ]; then
    cp "$gate_target/.env.example" "$gate_target/.env"
    echo "  ✓ Created .env from .env.example"
  elif [ ! -f "$gate_target/.env.example" ]; then
    echo -e "  ${RED}✗ .env.example missing — public user cannot bootstrap${NC}"
    step_fail=true
  fi

  echo "  Installing dependencies..."
  if ! run_public_acceptance_env pnpm install --frozen-lockfile 2>&1 | tail -5; then
    echo -e "  ${RED}✗ pnpm install failed${NC}"
    step_fail=true
  fi
  if ! run_static_quality_gates false; then
    step_fail=true
  fi
  echo "  Building..."
  if ! pnpm --filter @cat-cafe/shared build 2>&1 | tail -3; then
    echo -e "  ${RED}✗ shared build failed${NC}"
    step_fail=true
  fi
  if ! pnpm --filter @cat-cafe/api build 2>&1 | tail -3; then
    echo -e "  ${RED}✗ api build failed${NC}"
    step_fail=true
  fi

  echo "  Smoke test (F203 native L0 compiler)..."
  l0_compile_log=$(mktemp "${TMPDIR:-/tmp}/cat-cafe-l0-compile.XXXXXX")
  if ! run_public_acceptance_env node scripts/compile-system-prompt-l0.mjs --cat codex >/dev/null 2>"$l0_compile_log"; then
    echo -e "  ${RED}✗ F203 native L0 compile failed${NC} (full log: $l0_compile_log)"
    cat "$l0_compile_log"
    step_fail=true
  else
    echo "  ✓ F203 native L0 compile passed"
    rm -f "$l0_compile_log"
  fi

  echo "  Smoke test (test:public)..."
  test_public_log=$(mktemp "${TMPDIR:-/tmp}/cat-cafe-testpublic.XXXXXX")
  if ! run_public_acceptance_env \
    PROJECT_ALLOWED_ROOTS_APPEND=true \
    PROJECT_ALLOWED_ROOTS="$gate_target_real" \
    pnpm --filter @cat-cafe/api run test:public >"$test_public_log" 2>&1; then
    echo -e "  ${RED}✗ test:public failed${NC} (full log: $test_public_log)"
    tail -20 "$test_public_log"
    step_fail=true
  else
    tail -5 "$test_public_log"
    rm -f "$test_public_log"
  fi

  if [ "$FAST_VALIDATE" = true ]; then
    echo -e "  ${YELLOW}ℹ Fast validate: skipping startup acceptance${NC}"
  else
    echo "  Startup acceptance (temp target)..."
    local accept_api_port
    local accept_web_port
    local forbidden_ports
    local ports_before
    local ports_after
    local new_ports
    local forbidden_found
    local api_wait_seconds="${PUBLIC_GATE_API_WAIT_SECONDS:-20}"
    local web_wait_seconds="${PUBLIC_GATE_FRONTEND_WAIT_SECONDS:-180}"
    local api_deadline
    local web_deadline
    local api_log
    local web_log
    local startup_acceptance_failed=false

    accept_api_port="$(find_available_port 3004)"
    accept_web_port="$(find_available_port 3003 "$accept_api_port")"
    api_log=$(mktemp "${TMPDIR:-/tmp}/cat-cafe-public-api.XXXXXX")
    web_log=$(mktemp "${TMPDIR:-/tmp}/cat-cafe-public-web.XXXXXX")
    # 4100 is the public Preview Gateway default (F120), so treat it as an
    # exported surface, not an internal-port leak.
    forbidden_ports="3001|3002|3011|3012|4111|4000|6398|6399"
    ports_before=$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk '{print $9}' | sort -u || true)

    run_public_acceptance_env \
      PROJECT_ALLOWED_ROOTS_APPEND=true \
      PROJECT_ALLOWED_ROOTS="$gate_target_real" \
      API_SERVER_PORT=$accept_api_port MEMORY_STORE=1 NODE_ENV=test \
      pnpm --filter @cat-cafe/api start >"$api_log" 2>&1 &
    local api_pid=$!
    # Release machines can have many sibling worktrees open; watchpack native
    # watchers may hit EMFILE and leave Next dev serving only /_not-found.
    run_public_acceptance_env WATCHPACK_POLLING=true PORT=$accept_web_port \
      pnpm --filter @cat-cafe/web dev -p $accept_web_port >"$web_log" 2>&1 &
    local web_pid=$!

    local api_ready=false
    local web_ready=false
    api_deadline=$(( $(date +%s) + api_wait_seconds ))
    while :; do
      local remaining
      remaining="$(remaining_wall_clock_seconds "$api_deadline")"
      if [ "$remaining" -le 0 ]; then
        break
      fi
      if ! kill -0 "$api_pid" 2>/dev/null; then
        echo -e "  ${RED}✗ API process exited before health check passed${NC} (log: $api_log)"
        startup_acceptance_failed=true
        break
      fi
      local curl_timeout
      curl_timeout="$(curl_probe_timeout "$remaining" 5)"
      if curl -sf --max-time "$curl_timeout" "http://localhost:${accept_api_port}/health" >/dev/null 2>&1; then
        api_ready=true
        break
      fi
      if [ "$remaining" -gt 1 ]; then
        sleep 1
      fi
    done
    if [ "$api_ready" = true ]; then
      echo "  ✓ API health check passed (port $accept_api_port)"
    else
      echo -e "  ${RED}✗ API did not respond on port $accept_api_port within ${api_wait_seconds}s${NC} (log: $api_log)"
      startup_acceptance_failed=true
      step_fail=true
    fi

    web_deadline=$(( $(date +%s) + web_wait_seconds ))
    while :; do
      local remaining
      remaining="$(remaining_wall_clock_seconds "$web_deadline")"
      if [ "$remaining" -le 0 ]; then
        break
      fi
      if ! kill -0 "$web_pid" 2>/dev/null; then
        echo -e "  ${RED}✗ Frontend process exited before page responded${NC} (log: $web_log)"
        startup_acceptance_failed=true
        break
      fi
      local curl_timeout
      curl_timeout="$(curl_probe_timeout "$remaining" 5)"
      if curl -sf --max-time "$curl_timeout" "http://localhost:${accept_web_port}" >/dev/null 2>&1; then
        web_ready=true
        break
      fi
      if [ "$remaining" -gt 1 ]; then
        sleep 1
      fi
    done
    if [ "$web_ready" = true ]; then
      echo "  ✓ Frontend page responded (port $accept_web_port)"
    else
      echo -e "  ${RED}✗ Frontend did not respond on port $accept_web_port within ${web_wait_seconds}s${NC} (log: $web_log)"
      startup_acceptance_failed=true
      step_fail=true
    fi

    if [ "$startup_acceptance_failed" = true ]; then
      echo "  API log tail:"
      tail -40 "$api_log" 2>/dev/null || true
      echo "  Frontend log tail:"
      tail -80 "$web_log" 2>/dev/null || true
    else
      rm -f "$api_log" "$web_log"
    fi

    ports_after=$(lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk '{print $9}' | sort -u || true)
    new_ports=$(comm -13 <(echo "$ports_before") <(echo "$ports_after") || true)
    if [ -n "$new_ports" ]; then
      echo "  New ports opened: $(echo "$new_ports" | tr '\n' ' ')"
      forbidden_found=$(echo "$new_ports" | grep -E ":(${forbidden_ports})$" || true)
      if [ -n "$forbidden_found" ]; then
        echo -e "  ${RED}✗ Forbidden port(s) opened during startup:${NC}"
        echo "$forbidden_found" | while read -r port_entry; do echo "    $port_entry"; done
        step_fail=true
      fi
    fi

    kill $api_pid 2>/dev/null || true
    kill $web_pid 2>/dev/null || true
    lsof -ti:$accept_api_port 2>/dev/null | xargs kill 2>/dev/null || true
    lsof -ti:$accept_web_port 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 1
  fi

  echo "  Port verification (static scan)..."
  local port_fail=false
  for bad_port in 3001 3002; do
    found=$(grep -rn "[:=]${bad_port}\b" "$gate_target" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.sh' --include='*.yaml' --include='*.md' 2>/dev/null \
      | grep -v 'node_modules' | grep -v '.sync-provenance' | grep -v '.git/' | grep -v 'CORS' | head -3 || true)
    if [ -n "$found" ]; then
      echo -e "    ${RED}✗ Internal port $bad_port found:${NC}"
      echo "$found" | while read -r file_hit; do echo "      $file_hit"; done
      port_fail=true
    fi
  done
  if [ "$port_fail" = true ]; then
    step_fail=true
  else
    echo "  ✓ Port verification passed"
  fi

  cd "$original_dir"
  if [ "$step_fail" = true ]; then
    return 1
  fi
  return 0
}

echo -e "${GREEN}=== Cat Café → Clowder AI 开源同步 ===${NC}"
echo "源仓: $SOURCE_DIR"
echo "目标: $TARGET_DIR"
if [ "$DRY_RUN" = true ]; then echo "模式: DRY RUN"; fi
if [ "$VALIDATE" = true ]; then echo "模式: VALIDATE"; fi
if [ "$SYNC_MODULE" != "all" ]; then echo "模块: $SYNC_MODULE"; fi

cd "$SOURCE_DIR"
SOURCE_SHA=""
SOURCE_SHA_SHORT=""
SOURCE_DISPLAY_SHA=""

# ── Step 0: Pre-sync gate（D2a）────────────────────────────────
step_start "Step 0" "Pre-sync gate..."

# 0a: Source repo dirty check (real sync only — dry-run/validate allow dirty)
if [ "$DRY_RUN" = false ] && [ "$VALIDATE" = false ]; then
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    echo -e "  ${RED}✗ Source repo has uncommitted changes. Commit or stash first.${NC}"
    exit 1
  fi
  echo "  ✓ Source repo clean"
  if [ "$SYNC_MODULE" = "all" ]; then
    if ! prepare_source_sync_tree; then
      exit 1
    fi
    # Register cleanup immediately so early exits before Step 1 don't leak the worktree
    trap 'cleanup_source_sync_tree' EXIT
    echo "  ✓ Source sync checkout prepared from origin/main"
  fi
fi

# 0b: Target repo state check (skip for dry-run/validate)
if [ "$DRY_RUN" = false ] && [ "$VALIDATE" = false ] && target_git_repo_exists "$TARGET_DIR"; then
  cd "$TARGET_DIR"
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    echo -e "  ${RED}✗ Target repo has uncommitted changes: $TARGET_DIR${NC}"
    echo -e "  ${YELLOW}  Commit or discard target changes before syncing.${NC}"
    exit 1
  fi
  echo "  ✓ Target repo clean"

  # 0b-2: Open PR check — info only (open PRs in target don't block one-way sync)
  if command -v gh >/dev/null 2>&1; then
    OPEN_PRS=$(cd "$TARGET_DIR" && gh pr list --state open --limit 5 --json number,title 2>/dev/null || true)
    if [ -n "$OPEN_PRS" ] && [ "$OPEN_PRS" != "[]" ]; then
      PR_COUNT=$(echo "$OPEN_PRS" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));console.log(d.length)" 2>/dev/null || echo "?")
      echo -e "  ${YELLOW}ℹ Target has $PR_COUNT open PR(s) (info only, does not block sync):${NC}"
      echo "$OPEN_PRS" | node -e "JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).forEach(p=>console.log('    #'+p.number+' '+p.title))" 2>/dev/null || true
    else
      echo "  ✓ No open PRs in target"
    fi
  fi
  cd "$SOURCE_DIR"
fi

# 0c: Intake ledger gate (D3 upgraded)
# Truth source: docs/ops/opensource-intake-ledger.json in cat-cafe (not target provenance)
# Gate: target HEAD must match ledger's last_reviewed_target_head, OR all commits
# between ledger HEAD and current target HEAD must be sync commits.
INTAKE_LEDGER="$SOURCE_DIR/docs/ops/opensource-intake-ledger.json"
if [ "$DRY_RUN" = false ] && [ "$VALIDATE" = false ] && target_git_repo_exists "$TARGET_DIR"; then
  if [ -f "$INTAKE_LEDGER" ]; then
    if ! validate_incomplete_absorbed_overlaps "$INTAKE_LEDGER" "$SOURCE_SYNC_DIR" "$TARGET_DIR"; then
      cd "$SOURCE_DIR"
      exit 1
    fi

    LEDGER_HEAD=$(node -e "const l=JSON.parse(require('fs').readFileSync('$INTAKE_LEDGER','utf-8')); console.log(l.last_reviewed_target_head || '')" 2>/dev/null || true)
    cd "$TARGET_DIR"
    CURRENT_TARGET_HEAD=$(git rev-parse HEAD 2>/dev/null || true)
    if [ -n "$LEDGER_HEAD" ] && [ -n "$CURRENT_TARGET_HEAD" ]; then
      if [ "$LEDGER_HEAD" = "$CURRENT_TARGET_HEAD" ]; then
        echo "  ✓ Intake ledger up to date (target HEAD = ledger HEAD)"
      else
        # Check commits between ledger HEAD and current target HEAD
        COMMITS_SINCE=$(git rev-list "$LEDGER_HEAD".."$CURRENT_TARGET_HEAD" 2>/dev/null || true)
        HAS_UNREVIEWED=false
        UNREVIEWED_COUNT=0
        UNREVIEWED_LIST=""
        for c in $COMMITS_SINCE; do
          MSG=$(git log --format=%s -1 "$c" 2>/dev/null || true)
          if ! echo "$MSG" | grep -qE "^sync:.*(cat-cafe|clowder-ai|v[0-9]+\.[0-9]+|outbound)"; then
            HAS_UNREVIEWED=true
            UNREVIEWED_COUNT=$((UNREVIEWED_COUNT + 1))
            SHORT_MSG=$(git log --format="%h %s" -1 "$c" 2>/dev/null || true)
            UNREVIEWED_LIST="${UNREVIEWED_LIST}    → ${SHORT_MSG}\n"
          fi
        done
        if [ "$HAS_UNREVIEWED" = true ]; then
          # Distinguish "not recorded at all" vs "recorded but ledger not advanced"
          RECORDED_SHAS=$(node -e "const l=JSON.parse(require('fs').readFileSync('$INTAKE_LEDGER','utf-8')); l.entries.filter(e=>e.target_merge_commit).forEach(e=>console.log(e.target_merge_commit))" 2>/dev/null || true)
          ALL_RECORDED=true
          for c in $COMMITS_SINCE; do
            MSG_CHK=$(git log --format=%s -1 "$c" 2>/dev/null || true)
            if echo "$MSG_CHK" | grep -qE "^sync:.*(cat-cafe|clowder-ai|v[0-9]+\.[0-9]+|outbound)"; then continue; fi
            if ! echo "$RECORDED_SHAS" | grep -q "^${c}$"; then
              ALL_RECORDED=false
              break
            fi
          done
          if [ "$ALL_RECORDED" = true ]; then
            echo -e "  ${YELLOW}⚠ BLOCKED: All community commits are recorded in ledger, but ledger water mark not advanced${NC}"
            echo -e "  ${YELLOW}  Fix: bash scripts/intake-from-opensource.sh --advance-ledger${NC}"
          else
            echo -e "  ${RED}✗ BLOCKED: $UNREVIEWED_COUNT unrecorded community commit(s) in target${NC}"
          fi
          echo -e "  ${YELLOW}  Ledger reviewed up to: ${LEDGER_HEAD:0:12}${NC}"
          echo -e "  ${YELLOW}  Current target HEAD:   ${CURRENT_TARGET_HEAD:0:12}${NC}"
          echo ""
          echo -e "  ${YELLOW}  Unreviewed commits:${NC}"
          echo -e "$UNREVIEWED_LIST"
          echo -e "  ${YELLOW}  These will be OVERWRITTEN by rsync --delete.${NC}"
          echo -e "  ${YELLOW}  To proceed safely:${NC}"
          echo -e "  ${YELLOW}    1. Run: bash scripts/intake-from-opensource.sh --pr <N> --mode=plan${NC}"
          echo -e "  ${YELLOW}    2. Review and absorb valuable changes${NC}"
          echo -e "  ${YELLOW}    3. Run: bash scripts/intake-from-opensource.sh --record --pr <N> --decision <D>${NC}"
          echo -e "  ${YELLOW}       (auto-advances ledger after last PR)${NC}"
          echo -e "  ${YELLOW}  To force (DANGEROUS — loses community work):${NC}"
          echo -e "  ${YELLOW}    --force-overwrite${NC}"
          echo ""
          if [ "$FORCE_OVERWRITE" = true ]; then
            echo -e "  ${RED}⚠ --force-overwrite: proceeding despite unreviewed inbound commits${NC}"
          else
            echo -e "  ${RED}Aborted. Use --force-overwrite to bypass (not recommended).${NC}"
            cd "$SOURCE_DIR"
            exit 1
          fi
        else
          # Only sync commits since ledger — safe to auto-advance ledger
          echo "  ✓ No unreviewed community commits (only sync commits since ledger)"
        fi
      fi
    fi
    cd "$SOURCE_DIR"
  elif [ -f "$TARGET_DIR/.sync-provenance.json" ]; then
    echo -e "  ${YELLOW}⚠ No intake ledger found — falling back to provenance warning${NC}"
    echo -e "  ${YELLOW}  Create docs/ops/opensource-intake-ledger.json to enable ledger gate${NC}"
  else
    echo -e "  ${YELLOW}⚠ No ledger or provenance — first sync${NC}"
  fi
fi

echo "  ✓ Pre-sync gate passed"
step_done

# Real full sync exports from a detached origin/main checkout, not the caller's local HEAD.
if [ "$DRY_RUN" = true ] || [ "$VALIDATE" = true ]; then
  SOURCE_SHA=$(git -C "$SOURCE_DIR" rev-parse HEAD)
  SOURCE_SHA_SHORT=$(git -C "$SOURCE_DIR" rev-parse --short=12 "$SOURCE_SHA")
  SOURCE_DISPLAY_SHA="$SOURCE_SHA_SHORT"
  if ! git -C "$SOURCE_DIR" diff --quiet 2>/dev/null || ! git -C "$SOURCE_DIR" diff --cached --quiet 2>/dev/null; then
    SOURCE_DISPLAY_SHA="${SOURCE_DISPLAY_SHA}+dirty"
  fi
  SOURCE_DISPLAY_SHA="${SOURCE_DISPLAY_SHA} (working-tree)"
else
  SOURCE_SHA=$(git -C "$SOURCE_SYNC_DIR" rev-parse HEAD)
  SOURCE_SHA_SHORT=$(git -C "$SOURCE_SYNC_DIR" rev-parse --short=12 "$SOURCE_SHA")
  if [ "$SYNC_MODULE" = "all" ]; then
    SOURCE_DISPLAY_SHA="${SOURCE_SHA_SHORT} (origin/main)"
  else
    SOURCE_DISPLAY_SHA="${SOURCE_SHA_SHORT} (local HEAD)"
  fi
  if [ -n "$RELEASE_TAG" ]; then
    require_release_source_commit_on_main "$SOURCE_SHA"
    echo "  ✓ Release source commit is reachable from origin/main"
  fi
fi
echo -e "\n${BLUE}源 commit: ${SOURCE_DISPLAY_SHA}${NC}"

# ── 读 sync-manifest.yaml（SOT）─────────────────────────────
MANIFEST="$SOURCE_SYNC_DIR/sync-manifest.yaml"
if [ ! -f "$MANIFEST" ]; then
  echo -e "${RED}✗ sync-manifest.yaml not found at $MANIFEST${NC}"
  exit 1
fi

# 解析 manifest 列表到 bash 数组（bash 3.2 兼容）
MANAGED_ROOTS=()
while IFS= read -r line; do MANAGED_ROOTS+=("$line"); done < <(yaml_list "managed_roots")
MANAGED_FILES=()
while IFS= read -r line; do MANAGED_FILES+=("$line"); done < <(yaml_list "managed_files")
MANAGED_SCRIPTS=()
while IFS= read -r line; do MANAGED_SCRIPTS+=("$line"); done < <(yaml_list "managed_scripts")
EXCLUDED_ITEMS=()
while IFS= read -r line; do EXCLUDED_ITEMS+=("$line"); done < <(yaml_list "excluded")
TARGET_OWNED=()
while IFS= read -r line; do TARGET_OWNED+=("$line"); done < <(yaml_list "target_owned_files")

# ── Step 1: Clean tree 导出 ────────────────────────────────────
step_start "Step 1/6" "Clean tree 导出..."

STAGING_DIR=$(mktemp -d)
trap 'cleanup_source_sync_tree; cleanup_validation_target; rm -rf "${STAGING_DIR:-}" "${FILTERED_DIR:-}"' EXIT

if [ "$DRY_RUN" = true ] || [ "$VALIDATE" = true ]; then
  # 工作目录导出（含未提交改动和 allowlist 新文件，用于验证 manifest / transform）。
  # 真实 sync 仍然只同步 clean source tree，不会把未提交内容带到目标仓。
  git -C "$SOURCE_DIR" ls-files --cached --others --exclude-standard | while IFS= read -r f; do
    mkdir -p "$STAGING_DIR/$(dirname "$f")"
    cp "$SOURCE_DIR/$f" "$STAGING_DIR/$f" 2>/dev/null || true
  done
  echo "  已从工作目录导出到 staging: ${STAGING_DIR}"
else
  git -C "$SOURCE_SYNC_DIR" archive HEAD | tar -x -C "$STAGING_DIR"
  echo "  已从 origin/main 导出到 staging: ${STAGING_DIR}"
fi

step_done

# ── Step 2: Allowlist 过滤（只保留 manifest 中的路径）──────────
step_start "Step 2/6" "Allowlist 过滤..."

FILTERED_DIR=$(mktemp -d)

INCLUDED=0
EXCLUDED=0

# 2a: 复制 managed_roots（整包，从 manifest 读取）
for root in "${MANAGED_ROOTS[@]}"; do
  if [ -d "$STAGING_DIR/$root" ]; then
    mkdir -p "$FILTERED_DIR/$root"
    cp -R "$STAGING_DIR/$root/." "$FILTERED_DIR/$root/"
    count=$(find "$FILTERED_DIR/$root" -type f | wc -l | tr -d ' ')
    INCLUDED=$((INCLUDED + count))
    echo "  ✓ $root ($count files)"
  else
    echo -e "  ${YELLOW}⚠ $root 不存在，跳过${NC}"
  fi
done

# 2b: 排除 managed_roots 内的 excluded 文件和子目录（从 manifest 读取）
for excl in "${EXCLUDED_ITEMS[@]}"; do
  if [[ "$excl" == */ ]]; then
    # 目录级排除：删除 managed_roots 内匹配的子目录
    if [ -d "$FILTERED_DIR/$excl" ]; then
      count=$(find "$FILTERED_DIR/$excl" -type f 2>/dev/null | wc -l | tr -d ' ')
      rm -rf "$FILTERED_DIR/$excl"
      EXCLUDED=$((EXCLUDED + count))
      echo "  ✗ excluded dir: $excl ($count files)"
    fi
    continue
  fi
  # 处理 glob 通配符（*.pen, .env.*, story-export*.png 等）
  if [[ "$excl" == *'*'* || "$excl" == *'?'* ]]; then
    while IFS= read -r match; do
      rm "$match"
      EXCLUDED=$((EXCLUDED + 1))
    done < <(find "$FILTERED_DIR" -name "$(basename "$excl")" -type f 2>/dev/null)
  elif [ -f "$FILTERED_DIR/$excl" ]; then
    rm "$FILTERED_DIR/$excl"
    EXCLUDED=$((EXCLUDED + 1))
  fi
done

# 2c: 复制 managed_files（单文件，从 manifest 读取）
for f in "${MANAGED_FILES[@]}"; do
  if [ -f "$STAGING_DIR/$f" ]; then
    mkdir -p "$FILTERED_DIR/$(dirname "$f")"
    cp "$STAGING_DIR/$f" "$FILTERED_DIR/$f"
    INCLUDED=$((INCLUDED + 1))
    echo "  ✓ $f"
  fi
done

# 2d: 复制 managed_scripts（从 manifest 读取）
for f in "${MANAGED_SCRIPTS[@]}"; do
  mkdir -p "$FILTERED_DIR/$(dirname "$f")"
  if [ -f "$STAGING_DIR/$f" ]; then
    cp "$STAGING_DIR/$f" "$FILTERED_DIR/$f"
    INCLUDED=$((INCLUDED + 1))
    echo "  ✓ $f"
  fi
done

# 2e: docs/decisions/ allowlist（从 manifest 读取）
DECISIONS_ALLOWLIST=()
while IFS= read -r line; do DECISIONS_ALLOWLIST+=("$line"); done < <(yaml_list "docs_decisions_allowlist")
for f in "${DECISIONS_ALLOWLIST[@]}"; do
  if [ -f "$STAGING_DIR/$f" ]; then
    mkdir -p "$FILTERED_DIR/$(dirname "$f")"
    cp "$STAGING_DIR/$f" "$FILTERED_DIR/$f"
    INCLUDED=$((INCLUDED + 1))
    echo "  ✓ $f (ADR allowlist)"
  fi
done

# 2e2: docs/ runtime assets allowlist（F251 C4 sibling — clowder-ai#1025 root cause）
# packages/api/src 在运行时 readFileSync 这些 docs/* 路径；不放进 FILTERED_DIR
# 就让 clowder-ai 用户撞 404（route + frontend link 仍引用）。
# Guard: scripts/check-sync-docs-runtime-assets.mjs 反向扫，pre-merge 阻塞。
#
# Entry forms:
#   docs/foo.html       → single file copy
#   docs/foo/           → trailing slash means directory; entire tree copied
#                         (used for PerspectivePlanLoader template-string paths
#                         where individual files are not known at sync time)
RUNTIME_ASSETS_ALLOWLIST=()
while IFS= read -r line; do RUNTIME_ASSETS_ALLOWLIST+=("$line"); done < <(yaml_list "docs_runtime_assets_allowlist")
for f in "${RUNTIME_ASSETS_ALLOWLIST[@]}"; do
  if [ "${f%/}" != "$f" ]; then
    # Trailing slash → directory prefix copy.
    src_dir="$STAGING_DIR/${f%/}"
    if [ -d "$src_dir" ]; then
      mkdir -p "$FILTERED_DIR/${f%/}"
      cp -R "$src_dir/." "$FILTERED_DIR/${f%/}/"
      dir_count=$(find "$src_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
      INCLUDED=$((INCLUDED + dir_count))
      echo "  ✓ $f ($dir_count files, runtime asset allowlist dir)"
    else
      # Directory entry but source missing — keep it noisy so maintainer notices
      # if a runtime reader still expects it.
      echo -e "  ${YELLOW}⚠ $f directory missing in source, runtime readers will 404${NC}"
    fi
  elif [ -f "$STAGING_DIR/$f" ]; then
    mkdir -p "$FILTERED_DIR/$(dirname "$f")"
    cp "$STAGING_DIR/$f" "$FILTERED_DIR/$f"
    INCLUDED=$((INCLUDED + 1))
    echo "  ✓ $f (runtime asset allowlist)"
  fi
done

# 2f: docs/features/ — 结构化公开导出（调用 export-public-feature-docs.mjs）
echo "  Exporting public feature docs..."
FEATURES_EXPORT_DIR="$FILTERED_DIR/docs/features"
mkdir -p "$FEATURES_EXPORT_DIR"
node "$SOURCE_SYNC_DIR/scripts/export-public-feature-docs.mjs" \
  --features-dir "$STAGING_DIR/docs/features" \
  --output-dir "$FEATURES_EXPORT_DIR" \
  --min-tier yellow 2>&1 | while IFS= read -r line; do echo "    $line"; done
feat_count=$(find "$FEATURES_EXPORT_DIR" -name "F*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
INCLUDED=$((INCLUDED + feat_count))
echo "  ✓ docs/features/ ($feat_count public feature docs)"

if [ -f "$FILTERED_DIR/scripts/generate-feature-index.mjs" ]; then
  node "$FILTERED_DIR/scripts/generate-feature-index.mjs" \
    --features-dir "$FEATURES_EXPORT_DIR" \
    --output "$FEATURES_EXPORT_DIR/index.json" >/dev/null
  INCLUDED=$((INCLUDED + 1))
  echo "  ✓ docs/features/index.json (generated)"
fi

echo ""
echo "  导出: $INCLUDED files | 排除: $EXCLUDED files"
step_done

# ── Step 3: Transforms ─────────────────────────────────────────
step_start "Step 3/6" "Transforms..."

TRANSFORM_COUNT=0

# 3a: cat-config.json（从真实配置拷贝 + 脱敏 coCreator 段）
# 策略：保留完整猫阵（所有 breed + variant + 性格描述），只脱敏 coCreator 段
if [ -f "$STAGING_DIR/cat-config.json" ]; then
  node - "$STAGING_DIR/cat-config.json" "$FILTERED_DIR/cat-config.json" << 'CONFIG_TRANSFORM_EOF'
const config = JSON.parse(require("fs").readFileSync(process.argv[2], "utf-8"));
// 脱敏 coCreator（兼容旧 owner 键）
delete config.owner;
config.coCreator = {
  name: "You",
  aliases: [],
  mentionPatterns: ["@co-creator"]
};
// 去掉 mentionPatterns 中铲屎官相关的 pattern
const blocked = ["@landy", "@l.s.", "@lysander", "@铲屎官"];
for (const breed of config.breeds || []) {
  if (Array.isArray(breed.mentionPatterns)) {
    breed.mentionPatterns = breed.mentionPatterns.filter(
      p => blocked.indexOf(p.toLowerCase()) === -1
    );
  }
  for (const v of breed.variants || []) {
    if (Array.isArray(v.mentionPatterns)) {
      v.mentionPatterns = v.mentionPatterns.filter(
        p => blocked.indexOf(p.toLowerCase()) === -1
      );
    }
  }
}
// roster evaluation 中脱敏铲屎官引用
for (const [, entry] of Object.entries(config.roster || {})) {
  if (entry.evaluation) {
    entry.evaluation = entry.evaluation
      /* 铲屎官: 猫圈通用梗，保留 */
      .replace(/Landy/g, "You")
      .replace(/lysander/g, "you");
  }
}
// personality 中脱敏
for (const breed of config.breeds || []) {
  for (const v of breed.variants || []) {
    if (v.personality) {
      v.personality = v.personality
        /* 铲屎官: 猫圈通用梗，保留 */
        .replace(/Landy/g, "You");
    }
  }
}
require("fs").writeFileSync(process.argv[3], JSON.stringify(config, null, 2) + "\n");
CONFIG_TRANSFORM_EOF
else
  echo -e "  ${YELLOW}⚠ cat-config.json not found in staging, skipping${NC}"
fi
if command -v pnpm >/dev/null 2>&1; then
  pnpm biome format --write "$FILTERED_DIR/cat-config.json" >/dev/null 2>&1 || true
fi
echo "  ✓ cat-config.json (full roster, coCreator sanitized)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

GITHUB_BODY_TRANSPORT_SECTION=$(cat <<'GITHUB_BODY_TRANSPORT_EOF'
## GitHub Body Transport
- For PR, issue, comment, or review bodies containing non-ASCII text or Markdown (including backticks or newlines), write the exact body to a UTF-8 file without BOM and send it with file transport: `gh ... --body-file <path>`. For endpoints without `--body-file`, write a UTF-8 JSON request file and pass it with `gh api ... --input <path>`. Never pass body text through command-line arguments, `echo` or string interpolation, or inline JSON.
- In Windows PowerShell, read the body with `[System.IO.File]::ReadAllText($bodyPath, [System.Text.Encoding]::UTF8)`, fail unless `$body -is [string]`, build `@{ body = [string]$body } | ConvertTo-Json`, and write the JSON with `[System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.UTF8Encoding]::new($false))`.
- After every create or edit, read the remote body back through the GitHub API and compare it with the source file. A successful command or local preview is not verification. If mojibake is present, edit the original object in place and read it back again; do not create a duplicate comment.
GITHUB_BODY_TRANSPORT_EOF
)

# 3b: CLAUDE.md（通用版）
cat > "$FILTERED_DIR/CLAUDE.md" << 'CLAUDE_EOF'
# Clowder AI — Claude Agent Guide

## Identity
You are the Ragdoll cat (Claude), the lead architect and core developer of this Clowder AI instance.

## Safety Rules (Iron Laws)
1. **Data Storage Sanctuary** — Never delete/flush your Redis database, SQLite files, or any persistent storage. Use temporary instances for testing.
2. **Process Self-Preservation** — Never kill your parent process or modify your startup config in ways that prevent restart.
3. **Config Immutability** — Never modify `cat-config.json`, `.env`, or MCP config at runtime. Config changes require human action.
4. **Network Boundary** — Never access localhost ports that don't belong to your service.

## Development Flow
See `cat-cafe-skills/` for the full skill-based workflow:
- `feat-lifecycle` — Feature lifecycle management
- `tdd` — Test-driven development
- `quality-gate` — Pre-review self-check
- `request-review` — Cross-cat review requests
- `merge-gate` — Merge approval process

## Code Standards
- File size: 200 lines warning / 350 hard limit
- No `any` types
- Biome: `pnpm check` / `pnpm check:fix`
- Types: `pnpm lint`
CLAUDE_EOF
printf '\n%s\n' "$GITHUB_BODY_TRANSPORT_SECTION" >> "$FILTERED_DIR/CLAUDE.md"
echo "  ✓ CLAUDE.md (generic)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3c: AGENTS.md（通用版）
cat > "$FILTERED_DIR/AGENTS.md" << 'AGENTS_EOF'
# Clowder AI — OpenAI/Codex Agent Guide

## Identity
You are the Maine Coon cat (Codex/GPT), the code reviewer and security specialist of this Clowder AI instance.

## Safety Rules (Iron Laws)
1. **Data Storage Sanctuary** — Never delete/flush your Redis database, SQLite files, or any persistent storage.
2. **Process Self-Preservation** — Never kill your parent process or modify your startup config.
3. **Config Immutability** — Never modify runtime config files. Config changes require human action.
4. **Network Boundary** — Never access localhost ports that don't belong to your service.

## Your Role
- Code review with clear stance on every finding (no "fix or not, up to you")
- Security analysis and vulnerability detection
- Test coverage verification
- Cross-model review (you review Claude's code, Claude reviews yours)

## Review Protocol
- Same individual cannot review their own code
- Cross-family review preferred (Maine Coon reviews Ragdoll's code)
- Every finding must have a clear severity: P1 (blocking) / P2 (should fix) / P3 (nice to have)

## Truth Sources
- SOP & development flow: `docs/SOP.md`
- Memory routing: `cat-cafe-skills/refs/memory-routing-partial.md`
AGENTS_EOF
printf '\n%s\n' "$GITHUB_BODY_TRANSPORT_SECTION" >> "$FILTERED_DIR/AGENTS.md"
echo "  ✓ AGENTS.md (generic)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3d: GEMINI.md（通用版）
cat > "$FILTERED_DIR/GEMINI.md" << 'GEMINI_EOF'
# Clowder AI — Gemini Agent Guide

## Identity
You are the Siamese cat (Gemini), the visual designer and creative thinker of this Clowder AI instance.

## Safety Rules (Iron Laws)
1. **Data Storage Sanctuary** — Never delete/flush persistent storage.
2. **Process Self-Preservation** — Never kill your parent process.
3. **Config Immutability** — Never modify runtime config files.
4. **Network Boundary** — Never access ports that don't belong to your service.

## Your Role
- Visual design and UX consultation
- Creative ideation and brainstorming
- Design system maintenance
- Breaking conventional thinking patterns

## Important Constraints
- Focus on design consultation, not code implementation
- Always validate suggestions against the project's design system
- Provide visual references when suggesting changes
GEMINI_EOF
printf '\n%s\n' "$GITHUB_BODY_TRANSPORT_SECTION" >> "$FILTERED_DIR/GEMINI.md"
echo "  ✓ GEMINI.md (generic)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3e: LICENSE（MIT）
YEAR=$(date +%Y)
cat > "$FILTERED_DIR/LICENSE" << LICENSE_EOF
MIT License

Copyright (c) $YEAR Clowder AI Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
LICENSE_EOF
echo "  ✓ LICENSE (MIT)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3f-3h: (merged into 3-UNIFIED comprehensive sanitizer below)

# 3i: README.md — 复制开源版替换内部版
if [ -f "$STAGING_DIR/README.opensource.md" ]; then
  cp "$STAGING_DIR/README.opensource.md" "$FILTERED_DIR/README.md"
  echo "  ✓ README.md (opensource version, $(wc -l < "$STAGING_DIR/README.opensource.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-1b: README.zh-CN.md — 复制开源版中文 README
if [ -f "$STAGING_DIR/README.opensource.zh-CN.md" ]; then
  cp "$STAGING_DIR/README.opensource.zh-CN.md" "$FILTERED_DIR/README.zh-CN.md"
  echo "  ✓ README.zh-CN.md (opensource CN version, $(wc -l < "$STAGING_DIR/README.opensource.zh-CN.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-1c: README.ja-JP.md — 复制开源版日文 README
if [ -f "$STAGING_DIR/README.opensource.ja-JP.md" ]; then
  cp "$STAGING_DIR/README.opensource.ja-JP.md" "$FILTERED_DIR/README.ja-JP.md"
  echo "  ✓ README.ja-JP.md (opensource JA version, $(wc -l < "$STAGING_DIR/README.opensource.ja-JP.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-2: CONTRIBUTING.md — 复制开源版替换内部版
if [ -f "$STAGING_DIR/CONTRIBUTING.opensource.md" ]; then
  cp "$STAGING_DIR/CONTRIBUTING.opensource.md" "$FILTERED_DIR/CONTRIBUTING.md"
  echo "  ✓ CONTRIBUTING.md (opensource version, $(wc -l < "$STAGING_DIR/CONTRIBUTING.opensource.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-3: SETUP.md — 复制开源版替换内部版
if [ -f "$STAGING_DIR/SETUP.opensource.md" ]; then
  cp "$STAGING_DIR/SETUP.opensource.md" "$FILTERED_DIR/SETUP.md"
  echo "  ✓ SETUP.md (opensource version, $(wc -l < "$STAGING_DIR/SETUP.opensource.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-3b: SETUP.zh-CN.md — 复制开源版中文 SETUP
if [ -f "$STAGING_DIR/SETUP.opensource.zh-CN.md" ]; then
  cp "$STAGING_DIR/SETUP.opensource.zh-CN.md" "$FILTERED_DIR/SETUP.zh-CN.md"
  echo "  ✓ SETUP.zh-CN.md (opensource CN version, $(wc -l < "$STAGING_DIR/SETUP.opensource.zh-CN.md") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3i-4: CLA.md + TRADEMARKS.md — 开源社区治理文件
for gov_file in CLA.md TRADEMARKS.md; do
  if [ -f "$STAGING_DIR/$gov_file" ]; then
    cp "$STAGING_DIR/$gov_file" "$FILTERED_DIR/$gov_file"
    echo "  ✓ $gov_file (community governance)"
    TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
  fi
done

# 3j: .github/pull_request_template.md — 复制开源版替换内部版
if [ -f "$STAGING_DIR/.github/pull_request_template.opensource.md" ]; then
  mkdir -p "$FILTERED_DIR/.github"
  cp "$STAGING_DIR/.github/pull_request_template.opensource.md" "$FILTERED_DIR/.github/pull_request_template.md"
  echo "  ✓ .github/pull_request_template.md (opensource version)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3j-2: .env.example — 复制开源版环境变量模板
if [ -f "$STAGING_DIR/.env.example.opensource" ]; then
  cp "$STAGING_DIR/.env.example.opensource" "$FILTERED_DIR/.env.example"
  echo "  ✓ .env.example (opensource version, $(wc -l < "$STAGING_DIR/.env.example.opensource") lines)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-0: Source code personal info sanitization
# leaderboard-service.ts — hardcoded author map
if [ -f "$FILTERED_DIR/packages/api/src/domains/leaderboard/leaderboard-service.ts" ]; then
  sedi \
    -e "s/'lysander@suces-MacBook-Pro.local'/'owner@localhost'/g" \
    -e "s/'773678591@qq.com'/'owner@example.com'/g" \
    "$FILTERED_DIR/packages/api/src/domains/leaderboard/leaderboard-service.ts"
  echo "  ✓ leaderboard-service.ts (personal info sanitized)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi
# mention-highlight.ts — owner mention aliases
if [ -f "$FILTERED_DIR/packages/web/src/lib/mention-highlight.ts" ]; then
  sedi \
    -e "s/'landy', 'l.s.', 'lysander', '铲屎官'/'co-creator', 'admin'/g" \
    "$FILTERED_DIR/packages/web/src/lib/mention-highlight.ts"
  echo "  ✓ mention-highlight.ts (co-creator mentions sanitized)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-1: (merged into 3-UNIFIED comprehensive sanitizer below)

# 3k-2: P1-4 — Hindsight default off in public version
if [ -f "$FILTERED_DIR/packages/api/src/config/ConfigRegistry.ts" ]; then
  sedi \
    -e "s/parseBoolean(env\['HINDSIGHT_ENABLED'\], true)/parseBoolean(env['HINDSIGHT_ENABLED'], false)/g" \
    "$FILTERED_DIR/packages/api/src/config/ConfigRegistry.ts"
  echo "  ✓ ConfigRegistry.ts (Hindsight default=false)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi
if [ -f "$FILTERED_DIR/packages/api/src/config/env-registry.ts" ]; then
  sedi \
    -e "s/{ name: 'HINDSIGHT_ENABLED', defaultValue: 'true'/{ name: 'HINDSIGHT_ENABLED', defaultValue: 'false'/g" \
    "$FILTERED_DIR/packages/api/src/config/env-registry.ts"
  echo "  ✓ env-registry.ts (Hindsight default=false)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3: P1-2 — start-dev.sh: public API/frontend ports + proxy guard
if [ -f "$FILTERED_DIR/scripts/start-dev.sh" ]; then
  sedi \
    -e 's/API_PORT=${API_SERVER_PORT:-3002}/API_PORT=${API_SERVER_PORT:-3004}/g' \
    -e 's/WEB_PORT=${FRONTEND_PORT:-3001}/WEB_PORT=${FRONTEND_PORT:-3003}/g' \
    -e 's/kill_port ${ANTHROPIC_PROXY_PORT:-9877} "Proxy"/[ "${ANTHROPIC_PROXY_ENABLED:-1}" != "0" ] \&\& kill_port ${ANTHROPIC_PROXY_PORT:-9877} "Proxy"/g' \
    "$FILTERED_DIR/scripts/start-dev.sh"
  echo "  ✓ start-dev.sh (public ports + proxy kill guarded)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a1: package.json — public direct-launch wrappers pin opensource profile
if [ -f "$FILTERED_DIR/package.json" ]; then
  node - "$FILTERED_DIR/package.json" <<'PACKAGE_JSON_TRANSFORM_EOF'
const fs = require('fs');
const path = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
pkg.scripts["start:direct"] =
  "node ./scripts/start-entry.mjs start:direct --profile=opensource";
pkg.scripts["dev:direct"] =
  "node ./scripts/start-entry.mjs dev:direct --profile=opensource";
pkg.scripts["check:start-profile-isolation"] = "node --test scripts/start-dev-profile-isolation.test.mjs";
pkg.scripts["check:pre-merge-gate"] =
  "node --test scripts/pre-merge-check.test.mjs scripts/pre-merge-gate-guard.test.mjs scripts/test-bash-runtime.test.mjs";
if (pkg.scripts.check === "node scripts/run-checks.mjs") {
  pkg.scripts.check = [
    "pnpm biome check . --diagnostic-level=error",
    "pnpm check:features",
    "pnpm check:sop-definitions",
    "pnpm check:skills:manifest",
    "pnpm check:skills:surfaces",
    "pnpm check:env-ports",
    "pnpm check:env-registry",
    "pnpm check:env-example",
    "pnpm check:start-profile-isolation",
    "pnpm check:pre-merge-gate",
    "pnpm check:guides",
    "pnpm check:followup-tails",
    "pnpm check:scripts-ascii-only",
  ].join(" && ");
}
if (!pkg.scripts.check.includes("pnpm check:start-profile-isolation")) {
  pkg.scripts.check += " && pnpm check:start-profile-isolation";
}
delete pkg.scripts["check:architecture-ownership"];
delete pkg.scripts["test:architecture-ownership"];
// F228 outbound: remove all desktop:* scripts (internal-only, not synced to opensource).
// JSON-aware via Object.keys — position-independent (previously perl line-based in
// _sanitize-rules.pl assumed desktop: immediately followed check:start-profile-isolation,
// broke when check:brand-dictionary / check:brand-guard were inserted between).
for (const key of Object.keys(pkg.scripts)) {
  if (key.startsWith("desktop:")) delete pkg.scripts[key];
}
// Internal-only scripts referencing non-exported files
const internalScripts = [
  "antigravity:smoke",
  "check:hmac-salt",
  "check:antigravity-smoke",
  "check:biome-version",
  "check:incident-containment",
  "check:sync-export",
  "check:web-global-css-imports",
  "check:settings-primitives",
  "check:root-debris",
  "check:source-hygiene",
  "check:f223-action-tracking",
  // F238 Phase D: reverse-sanitizer detect-only CLI — internal boundary tooling
  // (PR #2333). Added here after R4 race-condition residue caught by sync gate.
  "check:reverse-sanitizer",
  // F238 Phase E: boundary round-trip fixture test — validates reverse-sanitizer
  // against brand-dictionary.yaml (internal-only asset). Not exported to public.
  // Added after F228 R8 sync failure: script surface test detected dangling ref.
  "check:boundary-roundtrip",
  // Privacy gate test — references F207 internal incident context and private
  // feature doc paths. Test stays home-only; the gate function itself lives in
  // export-public-feature-docs.mjs which is already handled by docs_generated.
  "check:export-privacy-gate",
  // F251 sibling guard — hard-deps sync-manifest.yaml (NOT exported). It treats
  // outbound sync coverage of docs/* runtime assets, so it has no place in the
  // public check chain. 砚砚 R1 P1 (2026-06-25): without strip, public pnpm check
  // exits 2 on missing manifest. Strip both definition and chain reference.
  "check:sync-docs-runtime-assets",
  // F251 Task 4b — public delta gate test suite (classifier + cli + wire + replay).
  // References scripts/check-sync-public-delta-gate*.test.mjs which are home-only
  // sync-pipeline harness; not part of the public opensource surface. 砚砚 R2 P1
  // (2026-06-26): without strip, public check chain fails because the 4 referenced
  // .test.mjs files don't exist in clowder-ai. Strip both definition and chain reference.
  "check:sync-public-delta-gate",
  "clean:root-debris",
  "guards:check",
];
for (const s of internalScripts) {
  delete pkg.scripts[s];
  pkg.scripts.check = pkg.scripts.check.replace(` && pnpm ${s}`, "");
}
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
PACKAGE_JSON_TRANSFORM_EOF
  echo "  ✓ package.json (public direct-launch wrappers + profile isolation check + home-only scripts removed)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a2: setup.sh — generated .env uses home ports; transform to open-source defaults
if [ -f "$FILTERED_DIR/scripts/setup.sh" ]; then
  sedi \
    -e 's/FRONTEND_PORT=3001/FRONTEND_PORT=3003/g' \
    -e 's/API_SERVER_PORT=3002/API_SERVER_PORT=3004/g' \
    -e 's#NEXT_PUBLIC_API_URL=http://localhost:3002#NEXT_PUBLIC_API_URL=http://localhost:3004#g' \
    -e 's#Open http://localhost:3001#Open http://localhost:3003#g' \
    -e 's#打开 http://localhost:3001#打开 http://localhost:3003#g' \
    "$FILTERED_DIR/scripts/setup.sh"
  echo "  ✓ setup.sh (public ports: Frontend=3003, API=3004)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a2b: Windows install/start/stop scripts — public ports + Redis standard
if [ -f "$FILTERED_DIR/scripts/install.ps1" ]; then
  sedi \
    -e 's/FRONTEND_PORT=3001/FRONTEND_PORT=3003/g' \
    -e 's/API_SERVER_PORT=3002/API_SERVER_PORT=3004/g' \
    -e 's#NEXT_PUBLIC_API_URL=http://localhost:3002#NEXT_PUBLIC_API_URL=http://localhost:3004#g' \
    -e 's/\$frontendPort = "3001"/$frontendPort = "3003"/g' \
    "$FILTERED_DIR/scripts/install.ps1"
  echo "  ✓ install.ps1 (public API/frontend ports)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

if [ -f "$FILTERED_DIR/scripts/start-windows.ps1" ]; then
  sedi \
    -e 's/else { "3002" }/else { "3004" }/g' \
    -e 's/else { "3001" }/else { "3003" }/g' \
    "$FILTERED_DIR/scripts/start-windows.ps1"
  echo "  ✓ start-windows.ps1 (public API/frontend ports)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

if [ -f "$FILTERED_DIR/scripts/stop-windows.ps1" ]; then
  sedi \
    -e 's/\$ApiPort = 3002/$ApiPort = 3004/g' \
    -e 's/\$WebPort = 3001/$WebPort = 3003/g' \
    "$FILTERED_DIR/scripts/stop-windows.ps1"
  echo "  ✓ stop-windows.ps1 (public API/frontend ports)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a2c: runtime-preflight.sh — API port default 3002→3004
if [ -f "$FILTERED_DIR/scripts/runtime-preflight.sh" ]; then
  sedi \
    -e 's/API_SERVER_PORT:-3002/API_SERVER_PORT:-3004/g' \
    "$FILTERED_DIR/scripts/runtime-preflight.sh"
  echo "  ✓ runtime-preflight.sh (API port 3004)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a3: runtime-worktree.sh — API port default 3002→3004
if [ -f "$FILTERED_DIR/scripts/runtime-worktree.sh" ]; then
  sedi \
    -e 's/API_SERVER_PORT:-3002/API_SERVER_PORT:-3004/g' \
    -e 's#exec \./scripts/start-dev\.sh --prod-web #exec env CAT_CAFE_STRICT_PROFILE_DEFAULTS=1 ./scripts/start-dev.sh --prod-web --profile=opensource #g' \
    "$FILTERED_DIR/scripts/runtime-worktree.sh"
  echo "  ✓ runtime-worktree.sh (API port 3004 + opensource profile)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3a4: AgentRouter.ts — API port fallback 3002→3004
if [ -f "$FILTERED_DIR/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts" ]; then
  sedi \
    -e "s/process.env.API_SERVER_PORT ?? '3002'/process.env.API_SERVER_PORT ?? '3004'/g" \
    "$FILTERED_DIR/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts"
  echo "  ✓ AgentRouter.ts (API port 3004)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3k-3b: Public default ports — exported repo should avoid runtime defaults 3001/3002
if [ -f "$FILTERED_DIR/packages/api/src/config/ConfigRegistry.ts" ]; then
  sedi \
    -e "s/const port = parseInt(env.API_SERVER_PORT ?? '3002', 10);/const port = parseInt(env.API_SERVER_PORT ?? '3004', 10);/g" \
    "$FILTERED_DIR/packages/api/src/config/ConfigRegistry.ts"
fi
if [ -f "$FILTERED_DIR/packages/api/src/index.ts" ]; then
  sedi \
    -e "s/const PORT = parseInt(process.env.API_SERVER_PORT ?? '3002', 10);/const PORT = parseInt(process.env.API_SERVER_PORT ?? '3004', 10);/g" \
    "$FILTERED_DIR/packages/api/src/index.ts"
fi
if [ -f "$FILTERED_DIR/packages/api/src/config/env-registry.ts" ]; then
  sedi \
    -e "s/{ name: 'API_SERVER_PORT', defaultValue: '3002'/{ name: 'API_SERVER_PORT', defaultValue: '3004'/g" \
    -e "s/defaultValue: '3000',/defaultValue: '3003',/g" \
    -e "s/defaultValue: 'http:\/\/localhost:3002'/defaultValue: 'http:\/\/localhost:3004'/g" \
    "$FILTERED_DIR/packages/api/src/config/env-registry.ts"
fi
if [ -f "$FILTERED_DIR/packages/api/src/config/frontend-origin.ts" ]; then
  sedi \
    -e "s#const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3001';#const DEFAULT_FRONTEND_BASE_URL = 'http://localhost:3003';#g" \
    -e "s#const DEFAULT_CORS_ORIGINS = \\['http://localhost:3000', 'http://localhost:3001', 'https://cafe.clowder-ai.com'\\];#const DEFAULT_CORS_ORIGINS = ['http://localhost:3000', 'http://localhost:3003', 'https://cafe.clowder-ai.com'];#g" \
    -e "s/fallback to localhost:3001/fallback to localhost:3003/g" \
    "$FILTERED_DIR/packages/api/src/config/frontend-origin.ts"
fi
# 3k-3b0: port-validator.ts — REMOVED (F228 outbound R6).
# This block was historically needed when source DEFAULT_EXCLUDED_PORTS contained
# only internal ports [3001, 3002, ...] and the export had to remap them to
# [3003, 3004, ...]. Source has since evolved to include BOTH internal and
# public ports — packages/api/src/domains/preview/port-validator.ts:4-19 now
# lists [3001, 3002, 3003, 3004, ...] together as defense-in-depth excluded
# ports. The destructive sed `3001→3003` was rewriting the source's first line
# (3001) into a duplicate of the existing 3003 line, effectively REMOVING 3001
# from the exported array, breaking port-validator.test.js:90-94 which
# (correctly) expects all four ports present in both source and export.
# The transform is now obsolete; source content is correct as-is for export.
# Historical context: commit 2158f9fa9 fix(sync): port mapping for port-validator (#984).

# 3k-3b0a: SessionBootstrap.ts — template literal ?? '3002' not caught by sanitize-rules
if [ -f "$FILTERED_DIR/packages/api/src/domains/cats/services/session/SessionBootstrap.ts" ]; then
  sedi \
    -e "s/API_SERVER_PORT ?? '3002'/API_SERVER_PORT ?? '3004'/g" \
    "$FILTERED_DIR/packages/api/src/domains/cats/services/session/SessionBootstrap.ts"
  echo "  ✓ SessionBootstrap.ts (API port 3004)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

if [ -f "$FILTERED_DIR/packages/api/src/config/governance/governance-pack.ts" ]; then
  sedi \
    -e "s/- \\*\\*Port 3001\\*\\* is reserved for Cat Cafe frontend. Use 3002+ for other dev servers./- **Public local defaults**: use frontend 3003 and API 3004 to avoid colliding with another local runtime./g" \
    "$FILTERED_DIR/packages/api/src/config/governance/governance-pack.ts"
fi
echo "  ✓ public default ports (Frontend=3003, API=3004) applied"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3k-4 through 3p: (merged into 3-UNIFIED comprehensive sanitizer below)

# 3k-5: Logo file rename — cat-cafe-logo-* → clowder-ai-logo-*
# Source repo keeps internal names; open-source repo gets brand-consistent names.
# See docs/design/naming-contract.md §2 "Logo 文件" row.
for logo_src in "$FILTERED_DIR"/assets/icons/cat-cafe-logo-*; do
  [ -f "$logo_src" ] || continue
  logo_base=$(basename "$logo_src")
  logo_dst=$(echo "$logo_base" | sed 's/^cat-cafe-logo/clowder-ai-logo/')
  mv "$logo_src" "$(dirname "$logo_src")/$logo_dst"
  echo "  ✓ Logo rename: $logo_base → $logo_dst"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
done
# Also fix README.md logo reference if present
if [ -f "$FILTERED_DIR/README.md" ]; then
  sedi \
    -e 's/cat-cafe-logo-v2-clean\.svg/clowder-ai-logo-v2-clean.svg/g' \
    -e 's/cat-cafe-logo-lineart-stroke\.svg/clowder-ai-logo-lineart-stroke.svg/g' \
    -e 's/cat-cafe-logo-lineart\.svg/clowder-ai-logo-lineart.svg/g' \
    "$FILTERED_DIR/README.md"
fi

# 3m: docs/ROADMAP.md — 从 BACKLOG 生成公开版（copy + title rename only; sanitization by 3-UNIFIED）
if [ -f "$STAGING_DIR/docs/BACKLOG.md" ]; then
  mkdir -p "$FILTERED_DIR/docs"
  cp "$STAGING_DIR/docs/BACKLOG.md" "$FILTERED_DIR/docs/ROADMAP.md"
  sedi -e 's/# BACKLOG/# Roadmap/' "$FILTERED_DIR/docs/ROADMAP.md"
  # Strip rows for features not in exported index (RED-tier features are excluded by export-public-feature-docs)
  if [ -f "$FEATURES_EXPORT_DIR/index.json" ]; then
    node -e "
      const fs = require('fs');
      const [indexPath, roadmapPath] = process.argv.slice(1);
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const ids = new Set((idx.features || []).map(f => f.id));
      const lines = fs.readFileSync(roadmapPath, 'utf-8').split('\n');
      const kept = lines.filter(line => {
        const m = line.match(/^\|\s*(F\d{3,4})\s*\|/);
        return !m || ids.has(m[1]);
      });
      fs.writeFileSync(roadmapPath, kept.join('\n'));
      if (kept.length < lines.length) console.log('    Stripped ' + (lines.length - kept.length) + ' non-exported feature row(s) from ROADMAP');
    " "$FEATURES_EXPORT_DIR/index.json" "$FILTERED_DIR/docs/ROADMAP.md"
  fi
  echo "  ✓ docs/ROADMAP.md (generated from BACKLOG)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3n: docs/public-lessons.md — 从 lessons-learned 生成公开版（copy only; sanitization by 3-UNIFIED）
if [ -f "$STAGING_DIR/docs/lessons-learned.md" ]; then
  mkdir -p "$FILTERED_DIR/docs"
  cp "$STAGING_DIR/docs/lessons-learned.md" "$FILTERED_DIR/docs/public-lessons.md"
  echo "  ✓ docs/public-lessons.md (generated from lessons-learned)"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3o: docs/README.md — 开源版文档导航
mkdir -p "$FILTERED_DIR/docs"
cat > "$FILTERED_DIR/docs/README.md" << 'DOCS_README_EOF'
# Clowder AI Documentation

## Overview
- [Vision](./VISION.md) — Project vision and philosophy
- [Roadmap](./ROADMAP.md) — Feature roadmap and priorities
- [SOP](./SOP.md) — Standard operating procedures for AI team collaboration
- [Design System](./design-system.md) — UI/UX design system
- [Lessons Learned](./public-lessons.md) — Team learnings and best practices

## Feature Specs
See [features/](./features/) for individual feature specifications.

## Architecture Decisions
See [decisions/](./decisions/) for Architecture Decision Records (ADRs).

## Architecture
See [architecture/](./architecture/) for system architecture documentation.
DOCS_README_EOF
echo "  ✓ docs/README.md (generated)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# ── 3-UNIFIED: Comprehensive single-pass sanitizer ──────────────
# Replaces 10+ separate find|while|sed/perl loops (3f, 3g, 3h, 3k-1, 3k-4, 3k, 3l, 3o-1, 3o-2, 3p)
# with ONE find + ONE perl pass over all text files. Conditional logic via $ARGV.
# Written to temp file to avoid shell quoting issues with perl regex.
echo "  Comprehensive sanitization (single-pass)..."
# Sanitizer rules extracted to _sanitize-rules.pl (shared with sync-hotfix.sh)
SANITIZER="$SOURCE_SYNC_DIR/scripts/_sanitize-rules.pl"
if [ ! -f "$SANITIZER" ]; then
  echo -e "${RED}✗ _sanitize-rules.pl not found at $SANITIZER${NC}"
  exit 1
fi
find "$FILTERED_DIR" \( -name "*.md" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.cjs" -o -name "*.mjs" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.sh" \) -type f -print0 | \
  xargs -0 perl -pi "$SANITIZER"
echo "  ✓ Comprehensive sanitization complete (single-pass)"
TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))

# 3-POST-1: Sanitization can intentionally change public governance headings
# (for example CVO → operator). Keep the exported drift guard pinned to the
# exported shared-rules truth source instead of the private source hash.
PUBLIC_SHARED_RULES="$FILTERED_DIR/cat-cafe-skills/refs/shared-rules.md"
PUBLIC_SYSTEM_PROMPT_TEST="$FILTERED_DIR/packages/api/test/system-prompt-builder.test.js"
PUBLIC_GOVERNANCE_HASH_HELPER="$SOURCE_SYNC_DIR/scripts/update-public-governance-hash.mjs"
if [ -f "$PUBLIC_SHARED_RULES" ] && [ -f "$PUBLIC_SYSTEM_PROMPT_TEST" ]; then
  if [ ! -f "$PUBLIC_GOVERNANCE_HASH_HELPER" ]; then
    echo -e "${RED}✗ update-public-governance-hash.mjs not found at $PUBLIC_GOVERNANCE_HASH_HELPER${NC}"
    exit 1
  fi
  node "$PUBLIC_GOVERNANCE_HASH_HELPER" "$PUBLIC_SHARED_RULES" "$PUBLIC_SYSTEM_PROMPT_TEST" >/dev/null
  echo "  ✓ Public governance drift hash rebased"
  TRANSFORM_COUNT=$((TRANSFORM_COUNT + 1))
fi

# 3-POST: Re-format sanitized files with biome (sanitize may break formatting)
echo "  Post-sanitize biome format..."
if command -v pnpm >/dev/null 2>&1 && [ -f "$FILTERED_DIR/biome.json" ]; then
  (cd "$FILTERED_DIR" && pnpm biome format --write . >/dev/null 2>&1) || true
  echo "  ✓ Post-sanitize biome format complete"
else
  echo "  ⚠ biome not available, skipping post-sanitize format"
fi

echo ""
echo "  Transforms: $TRANSFORM_COUNT"
step_done

# ── Step 4: Denylist / Secret scan ────────────────────────────
step_start "Step 4/6" "Security scan..."

SCAN_FAILED=false

# 4a: Denylist filename patterns (from manifest SOT)
DENYLIST_PATTERNS=()
while IFS= read -r line; do DENYLIST_PATTERNS+=("$line"); done < <(yaml_list "denylist_patterns")
if [ ${#DENYLIST_PATTERNS[@]} -eq 0 ]; then
  echo -e "  ${RED}✗ No denylist_patterns found in manifest${NC}"
  exit 1
fi
for pattern in "${DENYLIST_PATTERNS[@]}"; do
  while IFS= read -r match; do
    # .env.example is a template with no secrets — allow it
    [[ "$(basename "$match")" == ".env.example" ]] && continue
    echo -e "  ${RED}✗ Forbidden file: $match${NC}"
    SCAN_FAILED=true
  done < <(find "$FILTERED_DIR" -name "$pattern" -type f 2>/dev/null)
done

# 4b: Sensitive content scan — merged into fewer grep passes for performance
SCAN_WARNINGS=0
SCAN_INCLUDES='--include=*.ts --include=*.tsx --include=*.js --include=*.json --include=*.md --include=*.yaml --include=*.yml --include=*.sh'

# 4b-BLOCK: Single grep pass for all blocking patterns (API keys + personal info + /Users/)
# Combines old 4b-1, 4b-2, lysander check, and 4c into one pass
# Uses grep -E (POSIX ERE) instead of grep -P — BSD grep on macOS does not support -P
echo "  Scanning for secrets + personal info (single pass)..."
BLOCK_RESULTS=$(grep -rEn 'sk-ant-|sk-proj-|sk-live-|gsk_|AIzaSy|suces-MacBook|/Users/[A-Za-z0-9]' "$FILTERED_DIR" \
  $SCAN_INCLUDES 2>/dev/null \
  | grep -v 'node_modules' | grep -v '/home/user' | grep -v '/path/to/project' \
  || true)
# Filter out test files for API key patterns, report the rest
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  file="${line%%:*}"
  # Test files and secret-detection modules may use fake keys / regex patterns — skip
  if echo "$line" | grep -qE 'sk-ant-|sk-proj-|sk-live-|gsk_|AIzaSy'; then
    echo "$file" | grep -qE '/test/|/__tests__/|\.test\.|/SecretScanner\.ts$|/CommunityIssueSanitizer\.ts$' && continue
  fi
  echo -e "  ${RED}✗ Blocked content: ${line:0:120}${NC}"
  SCAN_FAILED=true
done <<< "$BLOCK_RESULTS"
# Separate lysander check (excludes test files)
found=$(grep -rl "lysander" "$FILTERED_DIR" $SCAN_INCLUDES 2>/dev/null \
  | grep -v '/test/' | grep -v '/__tests__/' | grep -v '.test.' | head -5 || true)
if [ -n "$found" ]; then
  echo -e "  ${RED}✗ Found 'lysander' in source code:${NC}"
  echo "$found" | while read f; do echo "    $f"; done
  SCAN_FAILED=true
fi

# 4b-WARN: Env var references — warning only (single grep)
echo "  Scanning for env var references..."
found=$(grep -rl 'ANTHROPIC_API_KEY\|OPENAI_API_KEY\|GOOGLE_API_KEY' "$FILTERED_DIR" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sh' 2>/dev/null | head -10 || true)
if [ -n "$found" ]; then
  echo -e "  ${YELLOW}⚠ Env var references (normal — code reads env vars):${NC}"
  echo "$found" | while read f; do echo "    $f"; done
  SCAN_WARNINGS=$((SCAN_WARNINGS + 1))
fi

# 4d: Internal path patterns scan (from manifest SOT)
echo "  Scanning for internal path references..."
INTERNAL_PATTERNS=()
while IFS= read -r line; do INTERNAL_PATTERNS+=("$line"); done < <(yaml_list "internal_path_patterns")
# Build combined regex for single grep pass
INTERNAL_REGEX=$(IFS='|'; echo "${INTERNAL_PATTERNS[*]}")
if [ -n "$INTERNAL_REGEX" ]; then
  found=$(grep -rn "$INTERNAL_REGEX" "$FILTERED_DIR" $SCAN_INCLUDES 2>/dev/null \
    | grep -v '.sync-provenance.json' \
    | grep -v '.export-summary.json' \
    | grep -v 'review-notes/' \
    | grep -v 'feature-specs/' \
    | grep -v 'feature-discussions/' \
    | grep -v 'internal-archive/' \
    | grep -v '# .*internal' \
    | head -20 || true)
  if [ -n "$found" ]; then
    echo -e "  ${YELLOW}⚠ Internal patterns found:${NC}"
    echo "$found" | while read f; do echo "    $f"; done
    l0_internal_found=$(printf '%s\n' "$found" | grep -F 'assets/system-prompts/system-prompt-l0.md' || true)
    if [ -n "$l0_internal_found" ]; then
      echo -e "  ${RED}✗ Native L0 prompt still contains internal-only patterns:${NC}"
      echo "$l0_internal_found" | while read f; do echo "    $f"; done
      SCAN_FAILED=true
    fi
    SCAN_WARNINGS=$((SCAN_WARNINGS + 1))
  fi
fi

# 4e: Endpoint scan — single grep for all endpoint patterns in docs/skills
# Uses grep -E (POSIX ERE) — BSD grep on macOS does not support -P
echo "  Scanning for internal endpoints (docs + config)..."
found=$(grep -rEn 'localhost:[0-9]{4,5}|127\.0\.0\.1|192\.168\.|10\.[0-9]+\.[0-9]+\.|\.internal[^a-z]|\.local[^a-z]|\.corp[^a-z]' \
  "$FILTERED_DIR/docs" "$FILTERED_DIR/cat-cafe-skills" 2>/dev/null \
  | grep -v 'redis://localhost:6399' \
  | grep -v 'redis://localhost:6398' \
  | grep -v 'localhost:3000' \
  | grep -v 'localhost:3003' \
  | grep -v 'localhost:3004' \
  | grep -v 'localhost:5173' \
  | grep -v '.export-summary.json' \
  | head -20 || true)
if [ -n "$found" ]; then
  echo -e "  ${YELLOW}⚠ Potential internal endpoints in docs/skills:${NC}"
  echo "$found" | while read f; do echo "    $f"; done
  SCAN_WARNINGS=$((SCAN_WARNINGS + 1))
fi

if [ "$SCAN_FAILED" = true ]; then
  echo ""
  echo -e "${RED}Security scan FAILED! Review the files above.${NC}"
  echo -e "${YELLOW}Export preserved at: ${FILTERED_DIR}${NC}"
  trap - EXIT
  exit 1
fi

echo "  ✓ Security scan passed ($SCAN_WARNINGS warnings)"
step_done

# ── Provenance ─────────────────────────────────────────────────
FILE_COUNT=$(find "$FILTERED_DIR" -type f | wc -l | tr -d ' ')
echo ""
echo -e "${BLUE}── Provenance ──${NC}"
echo "  source_commit_sha:   $SOURCE_SHA"
echo "  manifest_version:    3"
echo "  included_file_count: $FILE_COUNT"
echo "  excluded_file_count: $EXCLUDED"
echo "  transform_count:     $TRANSFORM_COUNT"
echo "  secret_scan_result:  clean"
if [ -n "$RELEASE_TAG" ]; then
  echo "  release_tag:         $RELEASE_TAG"
  echo "  source_snapshot_tag: $SOURCE_SNAPSHOT_TAG"
fi

RELEASE_TAG_JSON=$(json_string_or_null "$RELEASE_TAG")
SOURCE_SNAPSHOT_TAG_JSON=$(json_string_or_null "$SOURCE_SNAPSHOT_TAG")

# Write provenance file (target_head_sha = pre-sync base, finalized in Step 5e)
cat > "$FILTERED_DIR/.sync-provenance.json" << PROV_EOF
{
  "source_commit_sha": "$SOURCE_SHA",
  "target_head_sha": "",
  "release_tag": $RELEASE_TAG_JSON,
  "source_snapshot_tag": $SOURCE_SNAPSHOT_TAG_JSON,
  "manifest_version": 3,
  "included_file_count": $FILE_COUNT,
  "excluded_file_count": $EXCLUDED,
  "transform_count": $TRANSFORM_COUNT,
  "secret_scan_result": "clean",
  "synced_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
PROV_EOF

# ── Step 5: Source-owned public gate / Validate ────────────────

if [ "$VALIDATE" = true ]; then
  echo ""
  echo -e "${GREEN}[Step 5/6] Validate temp target (source-owned public gate)...${NC}"
  if ! prepare_validation_target; then
    trap - EXIT
    exit 1
  fi
  VALIDATION_BACKUP_DIR=$(mktemp -d)
  backed_up=$(backup_target_owned_items "$VALIDATION_TARGET_DIR" "$VALIDATION_BACKUP_DIR")
  if [ "$backed_up" -gt 0 ]; then
    echo "  ✓ Backed up $backed_up target-owned item(s) into temp target"
  fi
  sync_filtered_into_target "$VALIDATION_TARGET_DIR"
  restored=$(restore_target_owned_items "$VALIDATION_TARGET_DIR" "$VALIDATION_BACKUP_DIR")
  rm -rf "$VALIDATION_BACKUP_DIR"
  if [ "$restored" -gt 0 ]; then
    echo "  ✓ Restored $restored target-owned item(s) into temp target"
  fi
  if command -v pnpm >/dev/null 2>&1; then
    if ! run_target_public_gate "$VALIDATION_TARGET_DIR"; then
      echo -e "  ${RED}✗ Validate failed in temp target — real clowder-ai was not touched${NC}"
      trap - EXIT
      exit 1
    fi
    echo -e "  ${GREEN}✓ Validate passed${NC}"
  else
    echo -e "  ${YELLOW}⚠ pnpm not found, skipping validate${NC}"
  fi

  # F251 Task 4: VALIDATE mode also invokes the delta gate in --dry-run mode
  # so the operator can verify gate behavior without committing to a real sync.
  if [ "$SKIP_DELTA_GATE" != true ] && target_git_repo_exists "$TARGET_DIR"; then
    echo "  Public delta preservation gate (F251, validate mode)..."
    DELTA_GATE_OUTPUT_DIR="$SOURCE_DIR/docs/ops"
    mkdir -p "$DELTA_GATE_OUTPUT_DIR"
    # F251 Task 4c: forward --override and --cvo-approved to validate gate too
    # so the operator can preview override semantics in the dry-run report.
    DELTA_GATE_OVERRIDE_ARGS=()
    for ovr in "${DELTA_GATE_OVERRIDES[@]}"; do
      DELTA_GATE_OVERRIDE_ARGS+=(--override "$ovr")
    done
    if [ "$DELTA_GATE_CVO_APPROVED" = true ]; then
      DELTA_GATE_OVERRIDE_ARGS+=(--cvo-approved-public-delta-overwrite)
    fi
    node "$SOURCE_DIR/scripts/check-sync-public-delta-gate-cli.mjs" \
      --target-dir "$TARGET_DIR" \
      --filtered-dir "$VALIDATION_TARGET_DIR" \
      --source-dir "$SOURCE_SYNC_DIR" \
      --sync-module "$SYNC_MODULE" \
      --head-ref HEAD \
      --output-dir "$DELTA_GATE_OUTPUT_DIR" \
      "${DELTA_GATE_OVERRIDE_ARGS[@]}" \
      --dry-run
  fi

  cleanup_validation_target
  echo ""
  echo -e "${GREEN}[VALIDATE] Export at:${NC}"
  echo "  $FILTERED_DIR"
  trap - EXIT
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  # F251 Task 4: dry-run MUST also invoke the delta gate so AC-A5 historical
  # replay can use this exact code path. The gate runs in --dry-run mode (always
  # exit 0) but still emits the JSON+Markdown report so the operator/CI can
  # inspect what WOULD be blocked if this were a real sync.
  #
  # Caveat: in dry-run we use FILTERED_DIR (raw export tree) as `ours`, not
  # VALIDATION_TARGET_DIR (post-restore expected post-sync state). Target-owned
  # paths preserved by Step 5c's restore logic may show as missing here. For
  # AC-A5 replay this is acceptable because the operator inspects the report
  # rather than relying on exit status.
  if [ "$SKIP_DELTA_GATE" != true ] && target_git_repo_exists "$TARGET_DIR"; then
    echo ""
    echo "  Public delta preservation gate (F251, dry-run mode)..."
    DELTA_GATE_OUTPUT_DIR="$SOURCE_DIR/docs/ops"
    mkdir -p "$DELTA_GATE_OUTPUT_DIR"
    # AC-A5 historical replay parity: dry-run must forward the same target-owned roots
    # the production gate uses, otherwise paths preserved by Step 5c (e.g.
    # docs/community/, .github/community/) get reported as delete/target-added BLOCKs
    # in the dry-run report even though they're intentionally absent from the export.
    DELTA_GATE_TARGET_OWNED_ARGS=()
    for owned in "${TARGET_OWNED[@]}"; do
      DELTA_GATE_TARGET_OWNED_ARGS+=(--target-owned-root "$owned")
    done
    # F251 Task 4c: forward override + cvo-approved into dry-run too so preview report matches prod.
    DELTA_GATE_OVERRIDE_ARGS=()
    for ovr in "${DELTA_GATE_OVERRIDES[@]}"; do
      DELTA_GATE_OVERRIDE_ARGS+=(--override "$ovr")
    done
    if [ "$DELTA_GATE_CVO_APPROVED" = true ]; then
      DELTA_GATE_OVERRIDE_ARGS+=(--cvo-approved-public-delta-overwrite)
    fi
    node "$SOURCE_DIR/scripts/check-sync-public-delta-gate-cli.mjs" \
      --target-dir "$TARGET_DIR" \
      --filtered-dir "$FILTERED_DIR" \
      --source-dir "$SOURCE_SYNC_DIR" \
      --sync-module "$SYNC_MODULE" \
      --head-ref HEAD \
      --output-dir "$DELTA_GATE_OUTPUT_DIR" \
      "${DELTA_GATE_TARGET_OWNED_ARGS[@]}" \
      "${DELTA_GATE_OVERRIDE_ARGS[@]}" \
      --dry-run
  fi
  echo ""
  echo -e "${GREEN}[DRY RUN] Export complete at:${NC}"
  echo "  $FILTERED_DIR"
  echo ""
  echo "Directory structure:"
  find "$FILTERED_DIR" -type f | sed -n '1,40p' || true
  trap - EXIT
  exit 0
fi

# Real sync
step_start "Step 5/6" "Preparing validated sync to target..."
if [ ! -d "$TARGET_DIR" ]; then
  echo -e "  ${YELLOW}Target dir does not exist: $TARGET_DIR${NC}"
  echo "  Create it with: git init $TARGET_DIR"
  exit 1
fi

# 5a: Diff preview (D2c) — rsync --dry-run + awk single-pass counting
echo ""
echo -e "  ${BLUE}── Diff preview ──${NC}"

OWNED_PATTERN=""
for owned in "${TARGET_OWNED[@]}"; do
  [ -n "$OWNED_PATTERN" ] && OWNED_PATTERN="${OWNED_PATTERN}|"
  OWNED_PATTERN="${OWNED_PATTERN}${owned}"
done

DIFF_RESULT_FILE=$(mktemp)
LC_ALL=C rsync -a --delete --dry-run --itemize-changes \
  --exclude='.git' "$FILTERED_DIR/" "$TARGET_DIR/" 2>/dev/null | \
  LC_ALL=C awk -v owned_pat="$OWNED_PATTERN" '
  BEGIN { add=0; upd=0; del=0; prot=0; del_shown=0 }
  /^$/ { next }
  {
    change = $1; path = $0; sub(/^[^ ]+ /, "", path)
    if (path ~ /^\.git\//) next
    if (change ~ /deleting/) {
      if (owned_pat != "" && path ~ ("^(" owned_pat ")")) {
        prot++
        print "PROTECTED:" path
      } else {
        del++
        if (del_shown < 20) { print "DELETE:" path; del_shown++ }
      }
    } else if (change ~ /^>f\+\+\+/) {
      add++
    } else if (change ~ /^>f/) {
      upd++
    }
  }
  END { print "COUNTS:" add " " upd " " del " " prot }
' > "$DIFF_RESULT_FILE"

DIFF_ADD=$(grep '^COUNTS:' "$DIFF_RESULT_FILE" | sed 's/COUNTS://' | awk '{print $1}')
DIFF_UPDATE=$(grep '^COUNTS:' "$DIFF_RESULT_FILE" | sed 's/COUNTS://' | awk '{print $2}')
DIFF_DELETE=$(grep '^COUNTS:' "$DIFF_RESULT_FILE" | sed 's/COUNTS://' | awk '{print $3}')
DIFF_PROTECTED=$(grep '^COUNTS:' "$DIFF_RESULT_FILE" | sed 's/COUNTS://' | awk '{print $4}')

echo -e "  ${GREEN}+${DIFF_ADD} add${NC}  ${BLUE}~${DIFF_UPDATE} update${NC}  ${RED}-${DIFF_DELETE} delete${NC}"
if [ "$DIFF_DELETE" -gt 0 ]; then
  echo -e "  ${RED}Files to delete:${NC}"
  grep '^DELETE:' "$DIFF_RESULT_FILE" | sed 's/^DELETE:/    - /'
  if [ "$DIFF_DELETE" -gt 20 ]; then
    echo "    ... and $((DIFF_DELETE - 20)) more"
  fi
fi
if [ "$DIFF_PROTECTED" -gt 0 ]; then
  echo -e "  ${GREEN}Protected (target-owned):${NC}"
  grep '^PROTECTED:' "$DIFF_RESULT_FILE" | sed 's/^PROTECTED:/    🛡 /'
fi
rm -f "$DIFF_RESULT_FILE"
if [ $((DIFF_ADD + DIFF_UPDATE + DIFF_DELETE)) -eq 0 ]; then
  echo "  No changes to sync."
  exit 0
fi
if [ "$AUTO_YES" = false ]; then
  echo -n "  Proceed with sync? [y/N] "
  read -r SYNC_CONFIRM
  if [ "$SYNC_CONFIRM" != "y" ] && [ "$SYNC_CONFIRM" != "Y" ]; then
    echo "  Aborted."
    exit 0
  fi
else
  echo "  (--yes: auto-proceeding with sync)"
fi

# 5b: Source-owned public gate — validate same export on temp target first
if [ "$SKIP_VALIDATE" = true ]; then
  echo -e "  ${YELLOW}ℹ Skipping source-owned public gate (--skip-validate)${NC}"
elif [ "$SYNC_MODULE" != "all" ]; then
  echo -e "  ${YELLOW}ℹ Skipping source-owned public gate for module sync${NC}"
else
  echo "  Source-owned public gate (temp target)..."
  if ! prepare_validation_target; then
    exit 1
  fi
  VALIDATION_BACKUP_DIR=$(mktemp -d)
  backed_up=$(backup_target_owned_items "$VALIDATION_TARGET_DIR" "$VALIDATION_BACKUP_DIR")
  if [ "$backed_up" -gt 0 ]; then
    echo "  ✓ Backed up $backed_up target-owned item(s) into temp target"
  fi
  sync_filtered_into_target "$VALIDATION_TARGET_DIR"
  restored=$(restore_target_owned_items "$VALIDATION_TARGET_DIR" "$VALIDATION_BACKUP_DIR")
  rm -rf "$VALIDATION_BACKUP_DIR"
  if [ "$restored" -gt 0 ]; then
    echo "  ✓ Restored $restored target-owned item(s) into temp target"
  fi
  if ! run_target_public_gate "$VALIDATION_TARGET_DIR"; then
    echo -e "  ${RED}✗ Source-owned public gate failed — real target was not touched${NC}"
    exit 1
  fi
  cleanup_validation_target
  echo "  ✓ Source-owned public gate passed"
fi

# F251 Public Delta Preservation Gate (Task 4) — INDEPENDENT of --skip-validate
# Runs the public byte-space three-way comparison (base / theirs / ours).
#   ours = $FILTERED_DIR (pristine raw export, NOT VALIDATION_TARGET_DIR which is polluted
#          by pnpm install / build / restore mutations from run_target_public_gate)
#   theirs = $TARGET_DIR worktree HEAD (--head-ref HEAD), NOT origin/main — the worktree
#           checkout is what rsync will overwrite at Step 5c
#   baseline = resolved by CLI from sync tag / landed sync provenance
# Target-owned paths are excluded via --target-owned-root because Step 5c's backup/restore
# preserves them regardless of export contents.
# Only --skip-delta-gate (NOT --skip-validate) opts out of this protection.
if [ "$SYNC_MODULE" != "all" ]; then
  echo -e "  ${YELLOW}ℹ Skipping public delta preservation gate for module sync${NC}"
elif [ "$SKIP_DELTA_GATE" = true ]; then
  echo -e "  ${YELLOW}ℹ Skipping public delta preservation gate (--skip-delta-gate)${NC}"
else
  echo "Public delta preservation gate (F251)..."
  DELTA_GATE_OUTPUT_DIR="$SOURCE_DIR/docs/ops"
  mkdir -p "$DELTA_GATE_OUTPUT_DIR"
  DELTA_GATE_TARGET_OWNED_ARGS=()
  for owned in "${TARGET_OWNED[@]}"; do
    DELTA_GATE_TARGET_OWNED_ARGS+=(--target-owned-root "$owned")
  done
  # F251 Task 4c: forward per-path overrides + CVO approval flag to the production gate.
  # > 3 overrides without --cvo-approved-* fails closed (KD-3 alarm). All overrides are
  # recorded in the report's per-item rows + summary.overrideCount.
  DELTA_GATE_OVERRIDE_ARGS=()
  for ovr in "${DELTA_GATE_OVERRIDES[@]}"; do
    DELTA_GATE_OVERRIDE_ARGS+=(--override "$ovr")
  done
  if [ "$DELTA_GATE_CVO_APPROVED" = true ]; then
    DELTA_GATE_OVERRIDE_ARGS+=(--cvo-approved-public-delta-overwrite)
  fi
  if ! node "$SOURCE_DIR/scripts/check-sync-public-delta-gate-cli.mjs" \
    --target-dir "$TARGET_DIR" \
    --filtered-dir "$FILTERED_DIR" \
    --source-dir "$SOURCE_SYNC_DIR" \
    --sync-module "$SYNC_MODULE" \
    --head-ref HEAD \
    --output-dir "$DELTA_GATE_OUTPUT_DIR" \
    "${DELTA_GATE_TARGET_OWNED_ARGS[@]}" \
    "${DELTA_GATE_OVERRIDE_ARGS[@]}"; then
    echo -e "  ${RED}✗ Public delta preservation gate BLOCKED — real target was not touched${NC}"
    echo -e "  ${RED}   See report in $DELTA_GATE_OUTPUT_DIR${NC}"
    exit 1
  fi
  echo "  ✓ Public delta preservation gate passed"
fi

if [ -n "$RELEASE_TAG" ]; then
  echo "  Source snapshot tag..."
  ensure_source_snapshot_tag "$SOURCE_SNAPSHOT_TAG" "$SOURCE_SHA" "$RELEASE_TAG"
fi

# 5c: Sync the already-validated export to the real target
BACKUP_DIR=$(mktemp -d)
BACKED_UP=$(backup_target_owned_items "$TARGET_DIR" "$BACKUP_DIR")
if [ "$BACKED_UP" -gt 0 ]; then
  echo "  ✓ Backed up $BACKED_UP target-owned item(s)"
fi

sync_filtered_into_target "$TARGET_DIR"

RESTORED=$(restore_target_owned_items "$TARGET_DIR" "$BACKUP_DIR")
rm -rf "$BACKUP_DIR"
if [ "$RESTORED" -gt 0 ]; then
  echo "  ✓ Restored $RESTORED target-owned item(s)"
fi

echo "  ✓ Synced to $TARGET_DIR"

# 5c.1: Post-sync dead link check — catch broken relative links before commit
echo "  Post-sync link check..."
DEAD_LINKS_FILE=$(mktemp)
while IFS= read -r mdfile; do
  dir=$(dirname "$mdfile")
  # Extract relative markdown links: [text](path) — skip http/https/mailto/anchors
  # Use perl instead of grep -oP for macOS compatibility (BSD grep lacks -P)
  # Also skip links inside code fences (``` blocks) and site-relative URLs (/en/...)
  perl -ne '
    if (/^```/) { $in_fence = !$in_fence; next }
    next if $in_fence;
    while (/\[.*?\]\(([^)]+)\)/g) { print "$1\n" }
  ' "$mdfile" 2>/dev/null | while IFS= read -r link; do
    link_path="${link%%#*}"
    [ -z "$link_path" ] && continue
    case "$link_path" in http://*|https://*|mailto:*|ftp://*|tel:*|/*) continue ;; esac
    case "$link_path" in cat-cafe://*) continue ;; esac
    # Skip obvious template/placeholder patterns
    case "$link_path" in url|path|URL|PATH) continue ;; esac
    [[ "$link_path" == *'...'* ]] && continue
    [[ "$link_path" == *'xxx'* ]] && continue
    [[ "$link_path" == *'\*'* ]] && continue
    target_path="$dir/$link_path"
    if [ ! -e "$target_path" ]; then
      rel_mdfile="${mdfile#$TARGET_DIR/}"
      echo "  ⚠ $rel_mdfile → $link_path" >> "$DEAD_LINKS_FILE"
    fi
  done
done < <(find "$TARGET_DIR" -name '*.md' -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/fixtures/*')
if [ -s "$DEAD_LINKS_FILE" ]; then
  DEAD_LINK_COUNT=$(wc -l < "$DEAD_LINKS_FILE" | tr -d ' ')
  echo -e "  ${YELLOW}⚠ Found $DEAD_LINK_COUNT dead link(s) in target — auto-stripping:${NC}"
  head -20 "$DEAD_LINKS_FILE" | while IFS= read -r line; do echo "    $line"; done
  [ "$DEAD_LINK_COUNT" -gt 20 ] && echo "    ... and $((DEAD_LINK_COUNT - 20)) more"

  # Auto-strip dead links: [text](dead-path) → text
  STRIP_OK=0
  STRIP_FAIL=0
  while IFS= read -r entry; do
    mdfile=$(echo "$entry" | sed 's/^  ⚠ //' | sed 's/ → .*//')
    link=$(echo "$entry" | sed 's/.* → //')
    full_path="$TARGET_DIR/$mdfile"
    [ -f "$full_path" ] || { STRIP_FAIL=$((STRIP_FAIL + 1)); continue; }
    DEAD_LINK="$link" perl -i -pe '
      my $ql = quotemeta($ENV{DEAD_LINK});
      s/!\[([^\]]+)\]\($ql(?:#[^)]*)?\)/*(image: $1)*/g;
      s/\[([^\]]+)\]\($ql(?:#[^)]*)?\)/$1/g;
    ' "$full_path" && STRIP_OK=$((STRIP_OK + 1)) || STRIP_FAIL=$((STRIP_FAIL + 1))
  done < "$DEAD_LINKS_FILE"
  FAIL_MSG=""; [ "$STRIP_FAIL" -gt 0 ] && FAIL_MSG=", $STRIP_FAIL failed"
  echo "  ✓ Stripped $STRIP_OK dead link(s)$FAIL_MSG"
else
  echo "  ✓ No dead links detected"
fi
rm -f "$DEAD_LINKS_FILE"

step_done

# 5d: Auto-commit + provenance finalization (D3)
if target_git_repo_exists "$TARGET_DIR"; then
  cd "$TARGET_DIR"
  git add -A
  if [ "$SYNC_MODULE" = "all" ]; then
    SYNC_MSG="sync: cat-cafe $SOURCE_SHA_SHORT → clowder-ai (manifest v3)"
  else
    SYNC_MSG="sync: cat-cafe $SOURCE_SHA_SHORT → clowder-ai [$SYNC_MODULE] (manifest v3)"
  fi
  if [ -n "$CAT_SIG" ]; then
    SYNC_MSG="${SYNC_MSG}

${CAT_SIG}"
  fi
  if [ ${#CO_AUTHORS[@]} -gt 0 ]; then
    SYNC_MSG="${SYNC_MSG}
"
    for ca in "${CO_AUTHORS[@]}"; do
      SYNC_MSG="${SYNC_MSG}
Co-authored-by: ${ca}"
    done
  fi
  git commit -m "$SYNC_MSG" --allow-empty 2>&1 | tail -3
  PRE_SYNC_BASE=$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD 2>/dev/null || true)
  if [ -n "$PRE_SYNC_BASE" ] && [ -f "$TARGET_DIR/.sync-provenance.json" ]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$TARGET_DIR/.sync-provenance.json', 'utf-8'));
      p.target_head_sha = '$PRE_SYNC_BASE';
      fs.writeFileSync('$TARGET_DIR/.sync-provenance.json', JSON.stringify(p, null, 2) + '\n');
    "
    git add .sync-provenance.json
    git commit --amend --no-edit 2>&1 | tail -1
    echo "  ✓ Provenance finalized (target_head_sha: ${PRE_SYNC_BASE:0:12}, pre-sync base)"
  fi
  cd "$SOURCE_DIR"
fi

# ── Step 6: Sync summary ───────────────────────────────────────
echo ""
if [ "$SKIP_VALIDATE" = true ]; then
  echo -e "${YELLOW}[Step 6/6] Source-owned public gate SKIPPED (--skip-validate)${NC}"
elif [ "$SYNC_MODULE" != "all" ]; then
  echo -e "${YELLOW}[Step 6/6] Source-owned public gate SKIPPED (module sync — run full sync for public gate)${NC}"
else
  echo -e "${GREEN}[Step 6/6] Sync committed after source-owned public gate passed${NC}"
  if [ "$FAST_VALIDATE" = true ]; then
    echo -e "  ${YELLOW}ℹ Startup acceptance was skipped in temp target (--fast-validate)${NC}"
  else
    echo "  ✓ Real clowder-ai was only touched after temp target public gate turned green"
  fi
fi

TOTAL_ELAPSED=$(( $(date +%s) - SYNC_START_TIME ))

echo ""
echo -e "${GREEN}=== Sync complete ===${NC}  [total: ${TOTAL_ELAPSED}s]"
echo "Target: $TARGET_DIR"
# Derive target repo from origin URL for precise gh pr create hint
TARGET_BRANCH=$(git -C "$TARGET_DIR" branch --show-current 2>/dev/null || true)
TARGET_REMOTE_URL=$(git -C "$TARGET_DIR" config --get remote.origin.url 2>/dev/null || true)
TARGET_REPO=""
if [[ "$TARGET_REMOTE_URL" =~ github\.com[:/]([^/]+/[^/.]+) ]]; then
  TARGET_REPO="${BASH_REMATCH[1]}"
fi
echo "Next:"
echo "  cd $TARGET_DIR && git push origin $TARGET_BRANCH"
if [ -n "$TARGET_REPO" ] && [ -n "$TARGET_BRANCH" ]; then
  echo "  gh pr create --repo $TARGET_REPO --head $TARGET_BRANCH --base main"
else
  echo "  gh pr create (verify --repo target manually — could not derive from origin URL)"
fi
if [ "$DRY_RUN" = false ] && [ "$VALIDATE" = false ]; then
  PUBLISH_HANDOFF_CMD="bash scripts/publish-sync-tag.sh --source-sha=$(git -C "$SOURCE_DIR" rev-parse HEAD) --push"
  if [ -n "${CLOWDER_AI_DIR:-}" ]; then
    PUBLISH_HANDOFF_CMD="CLOWDER_AI_DIR=$(printf '%q' "$TARGET_DIR") $PUBLISH_HANDOFF_CMD"
  fi
  echo "After merge: $PUBLISH_HANDOFF_CMD"
  if [ -n "$RELEASE_TAG" ]; then
    echo "Release mapping: $RELEASE_TAG ← $SOURCE_SNAPSHOT_TAG ← $(git -C "$SOURCE_DIR" rev-parse --short HEAD)"
  fi
fi
