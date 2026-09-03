#!/bin/bash
# scripts/pre-merge-check.sh — Latest-main 全量门禁
#
# merge-gate 的硬门禁脚本。在 squash merge 前，先冻结一次 origin/main
# 再跑全量 build + test + lint/check；长门禁期间不追逐继续移动的 main。
#
# Usage:
#   pnpm gate          # 在 feature worktree 里执行
#
# 前置条件：
#   - 当前在 feature branch（不是 main）
#   - 所有改动已 commit
#
# 输出：
#   - 全绿：打印 SHA + 通过标记
#   - 任一步骤失败：exit 1，打印失败原因

set -euo pipefail

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

NO_REBASE=false
SKIP_INSTALL=false
AUTO_FIX=false
CAT_CAFE_GATE_TEST_MODE="${CAT_CAFE_GATE_TEST_MODE:-auto}"
GATE_ORIGINAL_ARGS=("$@")
GATE_ORIGINAL_ARG_COUNT=$#
GATE_TERMINAL_ACTIVE=false
GATE_TERMINAL_STATUS="failed"
GATE_RUN_ID=""
GATE_REQUIRED_STAGES=""

usage() {
  cat <<'EOF'
Usage: scripts/pre-merge-check.sh [--no-rebase] [--skip-install] [--auto-fix]

Default behavior:
  1. Fail if the worktree is dirty
  2. Fetch origin/main and rebase current branch onto it
  3. Refresh dependencies with pnpm install --frozen-lockfile
  4. Run build / tsc --noEmit / test / lint / check

Flags:
  --no-rebase    Skip fetch + rebase (local verification only)
  --skip-install Skip dependency refresh after rebase
  --auto-fix     Run allowlisted auto-fix (biome format) before gate, auto-commit changes as [qc-bot]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-rebase)
      NO_REBASE=true
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    --auto-fix)
      AUTO_FIX=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$CAT_CAFE_GATE_TEST_MODE" in
  auto|full|public)
    ;;
  *)
    echo -e "${RED}❌ CAT_CAFE_GATE_TEST_MODE must be auto, full, or public (got: $CAT_CAFE_GATE_TEST_MODE)${NC}" >&2
    exit 1
    ;;
esac

# Long gates launched from a cat CLI must use the API-managed wakeWhen carrier.
# ManagedRunner removes both cat-process markers from its child environment, so
# human terminals and managed commands remain valid while every CLI carrier is
# blocked from becoming a polling progress bar for foreground gates.
if [ -n "${CAT_CAFE_PROCESS_OWNER_ID:-}" ] || [ "${CAT_CAFE_CLI_PROCESS_CONTEXT:-}" = "cat" ]; then
  echo "⛔ 猫猫 CLI 不能前台运行 full gate。" >&2
  echo "   请调用 cat_cafe_hold_ball({ wakeWhen: { command: \"pnpm gate\" } })。" >&2
  echo "   Hub 会显示结构化运行状态，并在命令终态自动唤醒当前猫猫。" >&2
  exit 2
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       🛡️  Pre-Merge Gate — Latest Main Check        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Phase timer ──
GATE_START=$SECONDS
STEP_TIMES=""
record_step() {
  local step_name="$1"
  local step_start="$2"
  local elapsed=$((SECONDS - step_start))
  STEP_TIMES="${STEP_TIMES}${step_name}:${elapsed}\n"
}

# ── Step 0: 前置检查 ──

BRANCH="$(git branch --show-current 2>/dev/null)"
if [ "$BRANCH" = "main" ]; then
  echo -e "${RED}❌ 不能在 main 分支上执行 gate 检查${NC}"
  echo "   请在 feature worktree 里执行 pnpm gate"
  exit 1
fi

UNCOMMITTED="$(git status --porcelain)"
if [ -n "$UNCOMMITTED" ]; then
  if [ "$NO_REBASE" = "true" ]; then
    echo -e "${YELLOW}⚠️  检测到未提交改动，但因 --no-rebase 继续本地验证${NC}"
    echo "$UNCOMMITTED" | head -10
    echo ""
  else
    echo -e "${YELLOW}⚠️  有未提交的改动：${NC}"
    echo "$UNCOMMITTED" | head -10
    echo ""
    echo -e "${RED}❌ 请先 commit 所有改动再执行 gate 检查${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}✓ 分支: $BRANCH${NC}"
echo -e "${GREEN}✓ 工作区干净${NC}"

# Worktree 位置守卫：禁止在主仓库内部的 worktree 跑 gate
# 根因：仓库内 worktree (.claude/worktrees/) 会导致 Node/Next
# 向上解析到兄弟目录的 node_modules，造成 web build 假红。
# 规则来源：cat-cafe-skills/worktree/SKILL.md "禁止在项目内部创建"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
# Do not truncate the producer with `head`: under `set -o pipefail`, repositories
# with enough worktrees make git receive SIGPIPE and abort the gate with exit 141.
MAIN_WORKTREE="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
if [ "$REPO_ROOT" != "$MAIN_WORKTREE" ]; then
  # 当前是非主 worktree，检查是否在主仓库目录内部
  case "$REPO_ROOT" in
    "$MAIN_WORKTREE"/*)
      echo ""
      echo -e "${RED}❌ Worktree 在主仓库内部！${NC}"
      echo "   当前路径: $REPO_ROOT"
      echo "   主仓库:   $MAIN_WORKTREE"
      echo ""
      echo "   worktree skill 铁律：禁止在项目内部创建 worktree（.claude/worktrees/ 等）"
      echo "   Node/Next 会向上解析到兄弟目录的 node_modules，导致 web build 假红。"
      echo ""
      echo "   正确做法：git worktree add ../cat-cafe-{feature-name} -b feat/{name}"
      echo "   迁移方法：在仓库外重新创建 worktree，cherry-pick 现有 commit"
      exit 1
      ;;
  esac
fi
echo -e "${GREEN}✓ Worktree 位置合规${NC}"

is_public_export() {
  [ ! -f "$REPO_ROOT/.claude/settings.json" ] &&
    [ -f "$REPO_ROOT/packages/api/package.json" ] &&
    node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(p.scripts && p.scripts["test:public"] ? 0 : 1);' "$REPO_ROOT/packages/api/package.json"
}

PUBLIC_EXPORT=false
if is_public_export; then
  PUBLIC_EXPORT=true
fi

resolve_test_mode() {
  if [ "$CAT_CAFE_GATE_TEST_MODE" = "full" ] || [ "$CAT_CAFE_GATE_TEST_MODE" = "public" ]; then
    printf '%s\n' "$CAT_CAFE_GATE_TEST_MODE"
  elif [ "$PUBLIC_EXPORT" = "true" ]; then
    printf '%s\n' "public"
  else
    printf '%s\n' "full"
  fi
}

TEST_MODE="$(resolve_test_mode)"
if [ "$TEST_MODE" = "public" ]; then
  GATE_REQUIRED_STAGES="tsc,test-public,lint-web,check"
else
  GATE_REQUIRED_STAGES="tsc,test-non-browser,test-web-unit,test-web-browser,test-web-guards,lint-web,check"
fi

GATE_RESOURCE_RUNNER="$REPO_ROOT/scripts/run-with-gate-resource-permit.mjs"
if [ "$PUBLIC_EXPORT" = "true" ]; then
  # The public repository intentionally does not export Clowder AI's shared host
  # scheduler. Keep pnpm gate as a complete public contract by running the same
  # phases directly; the public gate still retains its exported singleflight and
  # pressure guard below.
  run_gate_resource_stage() {
    shift 2
    "$@"
  }
else
  if [ ! -f "$GATE_RESOURCE_RUNNER" ]; then
    echo -e "${RED}❌ Gate resource runner missing: $GATE_RESOURCE_RUNNER${NC}" >&2
    exit 1
  fi
  run_gate_resource_stage() {
    local mode="$1"
    local stage="$2"
    shift 2
    heartbeat_gate_receipt
    node "$GATE_RESOURCE_RUNNER" --mode "$mode" --stage "$stage" -- "$@"
  }
fi

heartbeat_gate_receipt() {
  if [ "$GATE_TERMINAL_ACTIVE" = "true" ]; then
    node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" heartbeat --run-id "$GATE_RUN_ID" --owner-pid "$$"
  fi
}

gate_stage_is_green() {
  local stage="$1"
  if [ "$GATE_TERMINAL_ACTIVE" != "true" ]; then
    return 1
  fi
  node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" stage-check --run-id "$GATE_RUN_ID" --stage "$stage"
}

mark_gate_stage_green() {
  local stage="$1"
  if [ "$GATE_TERMINAL_ACTIVE" = "true" ]; then
    node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" stage-green --run-id "$GATE_RUN_ID" --stage "$stage" --owner-pid "$$"
  fi
}

run_resumable_gate_stage() {
  local mode="$1"
  local stage="$2"
  shift 2
  if gate_stage_is_green "$stage"; then
    echo -e "${GREEN}↻ Reused exact-tree green stage: $stage${NC}"
    return 0
  fi
  if ! run_gate_resource_stage "$mode" "$stage" "$@"; then
    return 1
  fi
  mark_gate_stage_green "$stage"
}

settle_gate_receipt() {
  local status="$1"
  if [ "$GATE_TERMINAL_ACTIVE" != "true" ]; then
    return 0
  fi
  if [ "$status" = "green" ]; then
    node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" settle --run-id "$GATE_RUN_ID" --status "$status" --required-stages "$GATE_REQUIRED_STAGES"
  else
    node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" settle --run-id "$GATE_RUN_ID" --status "$status"
  fi
  GATE_TERMINAL_ACTIVE=false
}

GATE_GUARD_SCRIPT="$REPO_ROOT/scripts/pre-merge-gate-guard.mjs"
GATE_LOCK_DIR="${CAT_CAFE_GATE_LOCK_DIR:-$REPO_ROOT/.cat-cafe/gate/pre-merge-check.lock}"
node "$GATE_GUARD_SCRIPT" acquire --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$"
release_gate_guard() {
  node "$GATE_GUARD_SCRIPT" release --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$" >/dev/null 2>&1 || true
}
gate_exit() {
  local exit_code=$?
  if [ "$exit_code" -eq 124 ]; then
    GATE_TERMINAL_STATUS=timed_out
  fi
  settle_gate_receipt "$GATE_TERMINAL_STATUS" >/dev/null 2>&1 || true
  release_gate_guard
  return "$exit_code"
}
trap gate_exit EXIT
trap 'GATE_TERMINAL_STATUS=cancelled; exit 130' INT
trap 'GATE_TERMINAL_STATUS=cancelled; exit 143' TERM
echo -e "${GREEN}✓ Gate singleflight + system-pressure preflight${NC}"
echo ""

# ── Step 0.5: Auto-fix (--auto-fix only, F253) ──

if [ "$AUTO_FIX" = "true" ]; then
  STEP_START=$SECONDS
  echo "── Step 0.5: Hygiene auto-fix (F253) ──"

  # Snapshot dirty FILENAMES before auto-fix to avoid committing user WIP.
  # Compare filenames only (strip XY status prefix) so status mutations
  # like M→MM don't bypass the guard (cloud review P1).
  DIRTY_BEFORE="$(git status --porcelain | sed 's/^...//' | sort)"

  AUTOFIX_EXIT=0
  pnpm run check:fix || AUTOFIX_EXIT=$?

  if [ "$AUTOFIX_EXIT" -ne 0 ]; then
    echo -e "${YELLOW}⚠ auto-fix exited with code $AUTOFIX_EXIT (best-effort, continuing)${NC}"
  else
    echo -e "${GREEN}✓ auto-fix 完成${NC}"
  fi

  # Only stage files newly dirtied by auto-fix, not pre-existing user WIP.
  DIRTY_AFTER="$(git status --porcelain | sed 's/^...//' | sort)"
  AUTOFIX_CHANGED="$(comm -13 <(echo "$DIRTY_BEFORE") <(echo "$DIRTY_AFTER"))"

  if [ -n "$AUTOFIX_CHANGED" ]; then
    echo -e "${YELLOW}  auto-fix 修改了以下文件：${NC}"
    echo "$AUTOFIX_CHANGED" | head -20
    echo "$AUTOFIX_CHANGED" | tr '\n' '\0' | xargs -0 git add --
    git commit -m "style: auto-fix hygiene [qc-bot]"
    echo -e "${GREEN}✓ auto-fix 已提交 [qc-bot]${NC}"
  else
    echo -e "${GREEN}✓ 无需 auto-fix${NC}"
  fi
  record_step "auto-fix" "$STEP_START"
  echo ""
fi

# ── Step 1: Fetch + Rebase origin/main ──

REBASE_SUMMARY="skipped (--no-rebase)"
GATE_BASE_SHA=""
STEP_START=$SECONDS
if [ "$NO_REBASE" = "true" ]; then
  echo "── Step 1/6: 跳过 rebase（--no-rebase）──"
  echo -e "${YELLOW}⚠ 已跳过 origin/main rebase，仅用于本地验证${NC}"
  GATE_BASE_SHA="$(git rev-parse origin/main)"
  record_step "rebase" "$STEP_START"
  echo ""
else
  echo "── Step 1/6: 同步 origin/main 并 rebase ──"
  # git fetch 更新共享的 refs/remotes/origin/main——git worktree 下所有 worktree 共享
  # 同一个 <main-repo>/.git，remote-tracking ref 的写入受共享 lock 保护
  # (packed-refs.lock / refs/remotes/origin/main.lock)。并发 gate 同时 fetch 可能撞 ref
  # lock。concurrent gate 现在降级为 soft-warning 放行（#1937），移除了 HARD_BLOCK 的隐式
  # fetch 串行化，所以这里 retry 容忍 ref-lock 竞争——窗口极短，2s 间隔几乎必然成功；真失败
  # （网络/auth）3 次后仍 surface exit 1。rebase 不需要 retry（操作 per-worktree HEAD，不走共享 lock）。
  for attempt in 1 2 3; do
    if git fetch origin main --quiet 2>&1; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      echo -e "${RED}❌ git fetch origin main failed after 3 attempts${NC}"
      exit 1
    fi
    echo -e "${YELLOW}⚠ fetch failed (attempt $attempt/3, likely ref-lock contention from concurrent gate), retrying in 2s...${NC}"
    sleep 2
  done
  echo -e "${GREEN}✓ fetch origin/main${NC}"

  # Freeze the integration cut before rebasing. Other worktrees share the
  # origin/main tracking ref and may fetch while this 30-minute gate is still
  # running. Export this exact cut for base-aware child checkers; in particular,
  # governance checks must not fetch and replace their comparison target midway.
  GATE_BASE_SHA="$(git rev-parse origin/main)"

  REBASE_RESULT=0
  git rebase "$GATE_BASE_SHA" --quiet 2>&1 || REBASE_RESULT=$?
  if [ $REBASE_RESULT -ne 0 ]; then
    echo ""
    echo -e "${RED}❌ Rebase 有冲突！${NC}"
    echo ""
    echo "请手动解决冲突后重新执行 pnpm gate。"
    echo "提示："
    echo "  - git status 查看冲突文件"
    echo "  - 冲突区域会显示 base/ours/theirs 三段（zdiff3 格式）"
    echo "  - 解决后 git rebase --continue"
    echo ""
    echo "三屏对比命令（针对单个冲突文件）："
    echo "  git show :1:<path>   # BASE（共同祖先）"
    echo "  git show :2:<path>   # OURS（当前分支）"
    echo "  git show :3:<path>   # THEIRS（main 上的改动）"
    exit 1
  fi
  REBASE_SUMMARY="rebased onto ${GATE_BASE_SHA:0:8} (frozen origin/main)"
  echo -e "${GREEN}✓ rebase frozen origin/main ${GATE_BASE_SHA:0:8} 成功${NC}"
  record_step "rebase" "$STEP_START"
  echo ""
fi

export CAT_CAFE_GATE_BASE_SHA="$GATE_BASE_SHA"
echo -e "${GREEN}✓ Gate baseline frozen: ${GATE_BASE_SHA:0:8}${NC}"
echo ""

# Canonical exact-tree singleflight starts only for the complete source-full
# plan after its integration cut is frozen. Local, source-public, and exported
# public runs remain non-reusable probes.
if [ "$NO_REBASE" = "false" ] && [ "$PUBLIC_EXPORT" = "false" ] && [ "$TEST_MODE" = "full" ]; then
  export CAT_CAFE_MANAGED_JOB_ID="${CAT_CAFE_MANAGED_JOB_ID:-full-gate-$(node -e 'console.log(crypto.randomUUID())')}"
  if [ "$GATE_ORIGINAL_ARG_COUNT" -eq 0 ]; then
    GATE_CLAIM_JSON="$(node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" begin --owner-pid "$$" --)"
  else
    GATE_CLAIM_JSON="$(node "$REPO_ROOT/scripts/gate-terminal-receipt.mjs" begin --owner-pid "$$" -- "${GATE_ORIGINAL_ARGS[@]}")"
  fi
  GATE_CLAIM_ROLE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).role)' "$GATE_CLAIM_JSON")"
  GATE_RUN_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runId)' "$GATE_CLAIM_JSON")"
  GATE_CLAIM_STATUS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).terminalStatus ?? "")' "$GATE_CLAIM_JSON")"
  case "$GATE_CLAIM_ROLE" in
    producer)
      GATE_TERMINAL_ACTIVE=true
      echo -e "${GREEN}✓ Durable gate producer: ${GATE_RUN_ID}${NC}"
      ;;
    reused|consumed)
      if [ "$GATE_CLAIM_STATUS" = "green" ]; then
        echo -e "${GREEN}✓ Reused canonical exact-tree terminal-green receipt: ${GATE_RUN_ID}${NC}"
        bash "$(dirname "$0")/write-gate-last-run.sh" "$REPO_ROOT"
        exit 0
      fi
      echo -e "${RED}❌ Concurrent gate producer settled ${GATE_CLAIM_STATUS}; terminal evidence consumed without rerun${NC}" >&2
      exit 1
      ;;
    *)
      echo -e "${RED}❌ Invalid durable gate claim role: ${GATE_CLAIM_ROLE}${NC}" >&2
      exit 1
      ;;
  esac
  echo ""
fi

# ── Step 2: Dependency refresh ──
STEP_START=$SECONDS

if [ "$SKIP_INSTALL" = "true" ]; then
  echo "── Step 2/6: 跳过依赖刷新（--skip-install）──"
  echo -e "${YELLOW}⚠ 已跳过 pnpm install --frozen-lockfile${NC}"
  echo ""
else
  echo "── Step 2/6: 刷新依赖（frozen-lockfile）──"
  # Gate build/test must install devDependencies even if the parent shell came in
  # with production env flags set. Otherwise a fresh worktree can falsely go red
  # on missing @types/* packages before we reach the real baseline verdict.
  if ! run_gate_resource_stage shared install env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm install --frozen-lockfile; then
    echo ""
    echo -e "${RED}❌ pnpm install --frozen-lockfile 失败${NC}"
    exit 1
  fi
  if ! pnpm run check:biome-version; then
    echo ""
    echo -e "${RED}❌ Biome 版本与 lockfile 不匹配${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ 依赖刷新 + Biome 工具链校验通过${NC}"
  echo ""
fi
record_step "install" "$STEP_START"

# ── Step 3: Build ──
STEP_START=$SECONDS
echo "── Step 3/6: 全量 build ──"
# The root recursive build has a wider output closure than the package-local
# prepared artifacts below. Always rebuild it; only later named stages resume.
unset CAT_CAFE_GATE_PREPARED_ARTIFACTS
if ! run_gate_resource_stage shared build pnpm -r --if-present run build; then
  echo ""
  echo -e "${RED}❌ Build 失败${NC}"
  exit 1
fi
if [ "$PUBLIC_EXPORT" = "true" ]; then
  unset CAT_CAFE_GATE_PREPARED_ARTIFACTS
  echo -e "${GREEN}✓ build 通过（public direct lane）${NC}"
else
  if ! node "$REPO_ROOT/scripts/gate-prepared-artifacts.mjs" record; then
    echo ""
    echo -e "${RED}❌ Build 产物收据记录失败${NC}"
    exit 1
  fi
  export CAT_CAFE_GATE_PREPARED_ARTIFACTS=1
  echo -e "${GREEN}✓ build 通过${NC}"
  echo -e "${GREEN}✓ 当前 HEAD build 产物已记录，后续 stage 可复用${NC}"
fi
record_step "build" "$STEP_START"
echo ""

# ── Step 4: TypeScript 全量类型检查（含测试文件） ──
STEP_START=$SECONDS
#
# Next.js build 只对生产代码做 tsc，__tests__/ 目录被跳过。
# 这导致测试文件的类型错误无法在 gate 阶段被发现——
# 接口改了但测试 mock 没同步的情况会静默通过 gate，
# 直到 runtime build 或 CI 才暴露。
#
# 这一步对所有包（含测试文件）跑 tsc --noEmit，堵住盲区。

echo "── Step 4/6: TypeScript 全量类型检查（含测试） ──"
if ! run_resumable_gate_stage shared tsc pnpm -r exec bash -lc 'if command -v tsc >/dev/null 2>&1; then tsc --noEmit; fi'; then
  echo ""
  echo -e "${RED}❌ TypeScript 类型检查失败${NC}"
  echo "   测试文件的类型也必须通过 — 请同步更新 mock 对象"
  exit 1
fi
echo -e "${GREEN}✓ tsc --noEmit 通过（含测试文件）${NC}"
record_step "tsc" "$STEP_START"
echo ""

# ── Step 5: Test（按仓库形态选择 full 或 public） ──
STEP_START=$SECONDS
# 清除 REDIS_URL 以避免触发 Redis 隔离守卫。
# Worktree 的 .env.local 设置了 REDIS_URL=6398（用于开发），
# 但全量测试不应依赖 Redis——Redis 集成测试有专门的 test:redis 命令。
# 这与 CI 行为一致：CI 环境也不设 REDIS_URL。
#
# 挂起保护：API test script 配了 --test-timeout=30000，单个测试
# 超过 30s 会被 node --test 标记为 FAIL 并继续。无需外部 watchdog。
if [ "$TEST_MODE" = "public" ]; then
  echo "── Step 5/6: Public repo test suite ──"
  if ! run_resumable_gate_stage shared test-public env -u REDIS_URL pnpm --filter @cat-cafe/api run test:public; then
    echo ""
    echo -e "${RED}❌ Public 测试未通过${NC}"
    echo "   请修复失败的测试后重新执行 pnpm gate"
    exit 1
  fi
  echo -e "${GREEN}✓ Public 测试通过${NC}"
else
  echo "── Step 5/6: 全量测试 ──"
  if ! run_resumable_gate_stage shared test-non-browser env -u REDIS_URL pnpm -r --workspace-concurrency=1 --if-present --filter '!@cat-cafe/web' run test ||
    ! run_resumable_gate_stage shared test-web-unit env -u REDIS_URL pnpm --filter @cat-cafe/web run test:unit ||
    ! run_resumable_gate_stage exclusive test-web-browser env -u REDIS_URL pnpm --filter @cat-cafe/web run test:browser ||
    ! run_resumable_gate_stage shared test-web-guards env -u REDIS_URL pnpm --filter @cat-cafe/web run test:guards; then
    echo ""
    echo -e "${RED}❌ 全量测试未通过${NC}"
    echo "   请修复失败的测试后重新执行 pnpm gate"
    exit 1
  fi
  echo -e "${GREEN}✓ 全量测试通过${NC}"
fi
record_step "test" "$STEP_START"
echo ""

# ── Step 6: Lint + Check ──
#
# Lint dedup: Step 4 already ran tsc --noEmit across ALL packages.
# api/shared/mcp-server/ppt-forge each define "lint": "tsc --noEmit",
# so `pnpm lint` (= pnpm -r run lint) would re-run tsc on those 4 packages.
# Only web's "lint": "next lint" (ESLint) adds value here.
STEP_START=$SECONDS
echo "── Step 6/6: lint (web only — tsc deduped from Step 4) + check ──"
if ! run_resumable_gate_stage shared lint-web pnpm --filter @cat-cafe/web lint; then
  echo ""
  echo -e "${RED}❌ web lint 失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ web lint 通过（api/shared/mcp/ppt tsc 已在 Step 4 覆盖）${NC}"

if ! run_resumable_gate_stage shared check pnpm check; then
  echo ""
  echo -e "${RED}❌ check 失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ check 通过${NC}"
record_step "lint+check" "$STEP_START"
echo ""

# ── 报告 ──

GATE_TOTAL=$((SECONDS - GATE_START))
FINAL_SHA="$(git rev-parse HEAD)"
SHORT_SHA="${FINAL_SHA:0:8}"

echo "╔══════════════════════════════════════════════════════╗"
echo "║                  ✅ GATE PASSED                     ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Branch : $BRANCH"
echo "║  SHA    : $SHORT_SHA"
echo "║  Base   : $REBASE_SUMMARY"
echo "║  Tests  : all passed"
echo "║  Lint   : passed"
echo "║  Check  : passed"
echo "╠──────────────────────────────────────────────────────╣"
echo "║  ⏱  Phase Timing:"
echo -e "$STEP_TIMES" | while IFS=: read -r name secs; do
  [ -z "$name" ] && continue
  printf "║    %-14s %3ds\n" "$name" "$secs"
done
printf "║    %-14s %3ds\n" "TOTAL" "$GATE_TOTAL"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

OBSERVED_MAIN_SHA="$(git rev-parse origin/main 2>/dev/null || true)"
if [ -n "$OBSERVED_MAIN_SHA" ] && [ "$OBSERVED_MAIN_SHA" != "$GATE_BASE_SHA" ]; then
  echo -e "${YELLOW}⚠ origin/main advanced during this gate: ${GATE_BASE_SHA:0:8} → ${OBSERVED_MAIN_SHA:0:8}${NC}"
  echo "  This completed full-gate evidence remains bound to the frozen base."
  echo "  Rebase once, prove authored patch continuity + unrelated base delta, then run targeted continuity checks."
  echo "  Do not rerun the full gate solely because main advanced."
  echo ""
fi
# LL-082 hard layer: list dirty worktrees so each uncommitted diff has known provenance
# before merge (H4 dogfood: an orphaned half-fix in a sibling worktree crossed the gate).
echo "── LL-082 dirty-worktree ledger（merge 前确认所有 worktree 的 dirty diff 都有 PR/task/comment 归属）──"
node "$(dirname "$0")/check-worktree-dirty-ledger.mjs" || true
echo ""
echo "可以安全执行 merge-gate 的后续步骤了。"

# F253 Phase C (AC-C1): Write gate-last-run sentinel for pre-push Layer 4
# This timestamp lets check-gate-freshness.sh know gate passed recently.
bash "$(dirname "$0")/write-gate-last-run.sh" "$REPO_ROOT"
settle_gate_receipt green
