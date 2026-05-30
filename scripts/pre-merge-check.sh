#!/bin/bash
# scripts/pre-merge-check.sh — Latest-main 全量门禁
#
# merge-gate 的硬门禁脚本。在 squash merge 前，基于最新 origin/main
# 跑全量 build + test + lint/check，确保合流后仍然全绿。
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

usage() {
  cat <<'EOF'
Usage: scripts/pre-merge-check.sh [--no-rebase] [--skip-install]

Default behavior:
  1. Fail if the worktree is dirty
  2. Fetch origin/main and rebase current branch onto it
  3. Refresh dependencies with pnpm install --frozen-lockfile
  4. Run build / tsc --noEmit / test / lint / check

Flags:
  --no-rebase    Skip fetch + rebase (local verification only)
  --skip-install Skip dependency refresh after rebase
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
MAIN_WORKTREE="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
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

GATE_GUARD_SCRIPT="$REPO_ROOT/scripts/pre-merge-gate-guard.mjs"
GATE_LOCK_DIR="${CAT_CAFE_GATE_LOCK_DIR:-$REPO_ROOT/.cat-cafe/gate/pre-merge-check.lock}"
node "$GATE_GUARD_SCRIPT" acquire --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$"
release_gate_guard() {
  node "$GATE_GUARD_SCRIPT" release --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$" >/dev/null 2>&1 || true
}
trap release_gate_guard EXIT
trap 'release_gate_guard; exit 130' INT
trap 'release_gate_guard; exit 143' TERM
echo -e "${GREEN}✓ Gate singleflight + system-pressure preflight${NC}"
echo ""

# ── Step 1: Fetch + Rebase origin/main ──

REBASE_SUMMARY="skipped (--no-rebase)"
STEP_START=$SECONDS
if [ "$NO_REBASE" = "true" ]; then
  echo "── Step 1/6: 跳过 rebase（--no-rebase）──"
  echo -e "${YELLOW}⚠ 已跳过 origin/main rebase，仅用于本地验证${NC}"
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

  REBASE_RESULT=0
  git rebase origin/main --quiet 2>&1 || REBASE_RESULT=$?
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
  REBASE_SUMMARY="rebased onto origin/main"
  echo -e "${GREEN}✓ rebase origin/main 成功${NC}"
  record_step "rebase" "$STEP_START"
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
  if ! env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION pnpm install --frozen-lockfile; then
    echo ""
    echo -e "${RED}❌ pnpm install --frozen-lockfile 失败${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓ 依赖刷新通过${NC}"
  echo ""
fi
record_step "install" "$STEP_START"

# ── Step 3: Build ──
STEP_START=$SECONDS
echo "── Step 3/6: 全量 build ──"
if ! pnpm -r --if-present run build; then
  echo ""
  echo -e "${RED}❌ Build 失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ build 通过${NC}"
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
if ! pnpm -r exec bash -lc 'if command -v tsc >/dev/null 2>&1; then tsc --noEmit; fi'; then
  echo ""
  echo -e "${RED}❌ TypeScript 类型检查失败${NC}"
  echo "   测试文件的类型也必须通过 — 请同步更新 mock 对象"
  exit 1
fi
echo -e "${GREEN}✓ tsc --noEmit 通过（含测试文件）${NC}"
record_step "tsc" "$STEP_START"
echo ""

# ── Step 5: Test（全量，不是 --filter） ──
STEP_START=$SECONDS
echo "── Step 5/6: 全量测试 ──"
# 清除 REDIS_URL 以避免触发 Redis 隔离守卫。
# Worktree 的 .env.local 设置了 REDIS_URL=6398（用于开发），
# 但全量测试不应依赖 Redis——Redis 集成测试有专门的 test:redis 命令。
# 这与 CI 行为一致：CI 环境也不设 REDIS_URL。
#
# 挂起保护：API test script 配了 --test-timeout=30000，单个测试
# 超过 30s 会被 node --test 标记为 FAIL 并继续。无需外部 watchdog。
if ! env -u REDIS_URL pnpm test; then
  echo ""
  echo -e "${RED}❌ 全量测试未通过${NC}"
  echo "   请修复失败的测试后重新执行 pnpm gate"
  exit 1
fi
echo -e "${GREEN}✓ 全量测试通过${NC}"
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
if ! pnpm --filter @cat-cafe/web lint; then
  echo ""
  echo -e "${RED}❌ web lint 失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ web lint 通过（api/shared/mcp/ppt tsc 已在 Step 4 覆盖）${NC}"

if ! pnpm check; then
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
echo "可以安全执行 merge-gate 的后续步骤了。"
