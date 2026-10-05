#!/bin/bash
# scripts/pre-merge-check.sh — Latest-main 风险匹配门禁
#
# merge-gate 的硬门禁脚本。在 squash merge 前，先冻结一次 origin/main
# 再分类 targeted / reusable green / full；长门禁期间不追逐继续移动的 main。
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
SOURCE_FULL_SHA=""
GATE_VERIFICATION_SCOPE="merge"
SKIP_INSTALL=false
AUTO_FIX=false
RISK_AXIS=""
CAT_CAFE_GATE_TEST_MODE="${CAT_CAFE_GATE_TEST_MODE:-auto}"
GATE_ORIGINAL_ARGS=("$@")
GATE_ORIGINAL_ARG_COUNT=$#
GATE_IDENTITY_ARGS=()
GATE_IDENTITY_ARG_COUNT=0
GATE_RESUME_RUN_ID=""
GATE_CONTINUITY_CLAIM_ID=""
GATE_CONTINUITY_BASE_SHA=""
GATE_RESUME_MODE=""
GATE_RESUME_IDENTITY_JSON=""
GATE_EXECUTION_OWNER_JOB_ID=""
GATE_EXECUTION_ORIGIN_TASK_ID=""
GATE_EXECUTION_RESUME_KIND=""
GATE_EXECUTION_RESUME_KEY=""
GATE_EXECUTION_RESUME_SOURCE_RUN_ID=""
unset CAT_CAFE_GATE_EXECUTION_RESUME_SOURCE_RUN_ID
GATE_TERMINAL_ACTIVE=false
GATE_TERMINAL_STATUS="failed"
GATE_RUN_ID=""
GATE_REQUIRED_STAGES=""
GATE_FAILED_STAGE=""
GATE_FAILURE_OUTPUT_FILE=""
GATE_CONTROL_PLANE_DIR=""
GATE_ROUTE_CLASSIFIER_SCRIPT=""
GATE_TERMINAL_RECEIPT_SCRIPT=""
GATE_ROUTE="full"
GATE_ROUTE_JSON=""
GATE_BROWSER_PLAN_FILE=""
GATE_ROUTE_REQUIRED_CHECKS=""
GATE_NATIVE_REQUIREMENTS=""
GATE_TIMING_ROOT=""
GATE_TIMING_DIR=""
GATE_TIMING_ID=""
GATE_ORIGINAL_PATH="$PATH"
GATE_REAL_NODE="${CAT_CAFE_REAL_NODE:-$(node -p 'process.execPath')}"
GATE_REAL_TSX="${CAT_CAFE_REAL_TSX:-}"
GATE_NODE_COMMAND="${CAT_CAFE_NODE_COMMAND:-$(command -v node)}"
# Reporter wiring is enabled only around one resumed test stage. Do not let an
# inherited shell setting influence route/planner fingerprints before then.
unset CAT_CAFE_TEST_TIMING_DIR CAT_CAFE_TEST_TIMING_REPO_ROOT CAT_CAFE_TEST_TIMING_STAGE CAT_CAFE_TEST_TIMING_REPORTER
unset CAT_CAFE_REAL_NODE CAT_CAFE_REAL_TSX CAT_CAFE_NODE_COMMAND
# A classified-but-unverified route must not share an exit code with a verified
# one. Consumers (cat shells, the managed wakeWhen carrier, any `cmd && merge`
# chain) read the exit code, not the colour of a stdout line.
GATE_EXIT_UNVERIFIED=3
# Mirrors MANAGED_COMMAND_TERMINAL_DECLARATION_KEY in
# packages/api/src/domains/ball-custody/managed-command-terminal-declaration.ts —
# a guard test pins the two together so the contract cannot drift silently.
GATE_MANAGED_TERMINAL_DECLARATION_KEY="CAT_CAFE_MANAGED_TERMINAL_STATE"

report_native_verification_required() {
  echo -e "${YELLOW}⚠ UNVERIFIED — native verification remains required; this is not full-gate green.${NC}" >&2
  echo "$GATE_NATIVE_REQUIREMENTS" >&2
  echo "Attach native evidence for this exact HEAD and complete risk-matched review; Web checks do not certify native interaction." >&2
  echo "${GATE_MANAGED_TERMINAL_DECLARATION_KEY}=unverified" >&2
}
GATE_REEXEC_DEPTH="${CAT_CAFE_GATE_REEXEC_DEPTH:-0}"
unset CAT_CAFE_GATE_REEXEC_DEPTH

# A gate verifies a development tree, so no stage may inherit a production
# environment. Both entry paths leak it today: a cat shell that exported
# NODE_ENV=production, and the API-managed wakeWhen carrier, whose child env is
# derived from a runtime process that legitimately runs in production. Only the
# install stage stripped these, so build/tsc/test silently ran production-shaped
# and produced false reds. Stripping once at the entry covers both callers.
#
# Single-variable sample (captured by @codex-astra, job
# managed-gate-0c709983-2332-4fa3-aec0-0850a6fa46ca at HEAD 214e054b): the same
# worktree, the same cut, one command difference. With the inherited value,
# test-non-browser failed 31 of 67 collective-client tests on React production
# `act()` errors — `act` is a no-op in a production build, so the assertions
# collapse. With `env -u NODE_ENV`, 21 files / 67 tests passed. That run burned
# 54m48 of wall clock against 2m53 of admitted execution.
# Stages that genuinely need production semantics set it themselves: pnpm
# install re-states the same unset for devDependency resolution, and `next
# build` sets NODE_ENV=production internally.
unset NODE_ENV npm_config_production NPM_CONFIG_PRODUCTION

case "$GATE_REEXEC_DEPTH" in
  ''|*[!0-9]*)
    echo "Invalid CAT_CAFE_GATE_REEXEC_DEPTH: $GATE_REEXEC_DEPTH" >&2
    exit 1
    ;;
esac

usage() {
  cat <<'EOF'
Usage: scripts/pre-merge-check.sh [--source-full <exact-sha>] [--no-rebase] [--skip-install] [--auto-fix] [--risk <axis>] [--resume <run-id>] [--continuity-claim <hash>] [--]

Default behavior:
  1. Fail if the worktree is dirty
  2. Fetch origin/main and rebase current branch onto it
  3. Classify coverage from the frozen diff and existing evidence
  4. Only for full: refresh dependencies, then build / tsc / test / lint / check

Flags:
  --source-full <sha> Verify the clean exact source and complete browser catalog without fetch/rebase; emits source_full evidence only
  --no-rebase    Skip fetch + rebase, retain coverage classification (local verification only)
  --skip-install Skip dependency refresh after rebase
  --auto-fix     Run allowlisted auto-fix (biome format) before gate, auto-commit changes as [qc-bot]
  --risk <axis>  Declare behavior/data/security/contract/irreversible assurance; coverage is classified independently
  --resume <id>  Continue one frozen non-green gate run without fetching or selecting a new base
  --continuity-claim <hash>  Source checkout only: consume C2 as targeted/unverified without fetch/rebase; public exports reject it
  --             pnpm passthrough separator (consumed; subsequent flags still parsed)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-full)
      if [ $# -lt 2 ] || [ -n "$SOURCE_FULL_SHA" ] || ! [[ "$2" =~ ^[0-9a-f]{40}$ ]]; then
        echo "--source-full requires one exact 40-hex source SHA" >&2
        exit 1
      fi
      SOURCE_FULL_SHA="$2"
      GATE_VERIFICATION_SCOPE="source_full"
      shift 2
      ;;
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
    --risk)
      if [ $# -lt 2 ]; then
        echo "Missing value for --risk" >&2
        exit 1
      fi
      RISK_AXIS="$2"
      shift 2
      ;;
    --resume)
      if [ $# -lt 2 ] || [ -n "$GATE_RESUME_RUN_ID" ]; then
        echo "--resume requires one gate run id" >&2
        exit 1
      fi
      GATE_RESUME_RUN_ID="$2"
      shift 2
      ;;
    --continuity-claim)
      if [ $# -lt 2 ] || [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; then
        echo "--continuity-claim requires one claim hash" >&2
        exit 1
      fi
      GATE_CONTINUITY_CLAIM_ID="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      # pnpm 9.x passes '--' as a literal arg; consume it and keep parsing
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "$SOURCE_FULL_SHA" ] && { [ "$NO_REBASE" = "true" ] || [ "$SKIP_INSTALL" = "true" ] || [ "$AUTO_FIX" = "true" ] || [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; }; then
  echo "--source-full cannot be combined with --no-rebase, --skip-install, --auto-fix or --continuity-claim" >&2
  exit 1
fi

# Resume/continuity locators are control arguments, never frozen invocation inputs.
# Preserve every other byte of the original invocation so risk/mode semantics
# still participate in the exact-tree fingerprint.
for ((GATE_ARG_INDEX = 0; GATE_ARG_INDEX < GATE_ORIGINAL_ARG_COUNT; GATE_ARG_INDEX += 1)); do
  if [ "${GATE_ORIGINAL_ARGS[$GATE_ARG_INDEX]}" = "--resume" ] || [ "${GATE_ORIGINAL_ARGS[$GATE_ARG_INDEX]}" = "--continuity-claim" ]; then
    GATE_ARG_INDEX=$((GATE_ARG_INDEX + 1))
    continue
  fi
  GATE_IDENTITY_ARGS+=("${GATE_ORIGINAL_ARGS[$GATE_ARG_INDEX]}")
done
GATE_IDENTITY_ARG_COUNT=${#GATE_IDENTITY_ARGS[@]}

if [ -n "${CAT_CAFE_MANAGED_GATE_RESUME_EPOCH:-}" ]; then
  if [ -z "${CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON:-}" ]; then
    echo "Managed gate resume is missing its frozen identity" >&2
    exit 1
  fi
  GATE_RESUME_MODE="managed"
  GATE_RESUME_IDENTITY_JSON="$CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON"
elif [ -n "$GATE_RESUME_RUN_ID" ]; then
  GATE_RESUME_MODE="explicit"
fi

if [ -n "$GATE_RESUME_MODE" ] && { [ "$NO_REBASE" = "true" ] || [ "$AUTO_FIX" = "true" ]; }; then
  echo "Gate resume cannot be combined with --no-rebase or --auto-fix" >&2
  exit 1
fi
if [ -n "$GATE_CONTINUITY_CLAIM_ID" ] && { [ -n "$GATE_RESUME_MODE" ] || [ "$NO_REBASE" = "true" ] || [ "$AUTO_FIX" = "true" ]; }; then
  echo "Continuity claims cannot be combined with resume, --no-rebase or --auto-fix" >&2
  exit 1
fi

case "$CAT_CAFE_GATE_TEST_MODE" in
  auto|full|public)
    ;;
  *)
    echo -e "${RED}❌ CAT_CAFE_GATE_TEST_MODE must be auto, full, or public (got: $CAT_CAFE_GATE_TEST_MODE)${NC}" >&2
    exit 1
    ;;
esac

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
if [ -n "$SOURCE_FULL_SHA" ] && [ "$(git rev-parse HEAD)" != "$SOURCE_FULL_SHA" ]; then
  echo "--source-full requires HEAD to equal the exact source SHA" >&2
  exit 1
fi

# Worktree 位置守卫：禁止在主仓库内部的 worktree 跑 gate
# 根因：仓库内 worktree (.claude/worktrees/) 会导致 Node/Next
# 向上解析到兄弟目录的 node_modules，造成 web build 假红。
# 规则来源：cat-cafe-skills/worktree/SKILL.md "禁止在项目内部创建"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$GATE_REAL_TSX" ]; then
  GATE_REAL_TSX="$REPO_ROOT/node_modules/.bin/tsx"
fi
GATE_ROUTE_CLASSIFIER_SCRIPT="$REPO_ROOT/scripts/classify-gate-route.mjs"
if [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; then
  GATE_CONTINUITY_PACKET="$(node "$REPO_ROOT/scripts/gate-continuity-claim.mjs" inspect --claim-id "$GATE_CONTINUITY_CLAIM_ID")"
  GATE_CONTINUITY_BASE_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).target.baseSha)' "$GATE_CONTINUITY_PACKET")"
fi
GATE_TERMINAL_RECEIPT_SCRIPT="$REPO_ROOT/scripts/gate-terminal-receipt.mjs"
GATE_DATABASE_PATH="${CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH:-$(git rev-parse --path-format=absolute --git-common-dir)/cat-cafe-full-gate-resources.sqlite}"
if [ -n "$GATE_RESUME_MODE" ] && [ ! -f "$GATE_TERMINAL_RECEIPT_SCRIPT" ]; then
  echo "Gate resume requires the installed durable terminal control plane" >&2
  exit 1
fi
if [ -n "$GATE_RESUME_RUN_ID" ]; then
  GATE_RESUME_CANDIDATE_JSON="$(node "$GATE_TERMINAL_RECEIPT_SCRIPT" resume-inspect --run-id "$GATE_RESUME_RUN_ID")"
  GATE_RESUME_SOURCE_IDENTITY_JSON="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(value.frozenIdentity));' "$GATE_RESUME_CANDIDATE_JSON")"
  if [ "$GATE_RESUME_MODE" = "explicit" ]; then
    GATE_RESUME_IDENTITY_JSON="$GATE_RESUME_SOURCE_IDENTITY_JSON"
  else
    node -e '
      const managed = JSON.parse(process.argv[1]);
      const source = JSON.parse(process.argv[2]);
      managed.verificationScope ??= "merge";
      source.verificationScope ??= "merge";
      const fields = ["protocolVersion", "headSha", "treeSha", "baseSha", "route", "risk", "mode", "verificationScope", "fingerprint", "runnerFingerprint", "toolchainFingerprint"];
      if (fields.some((field) => managed[field] !== source[field])) {
        process.stderr.write("Managed wake frozen identity does not match its explicit resume source\n");
        process.exit(1);
      }
    ' "$GATE_RESUME_IDENTITY_JSON" "$GATE_RESUME_SOURCE_IDENTITY_JSON"
  fi
  GATE_EXECUTION_OWNER_JOB_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).executionOwnerJobId)' "$GATE_RESUME_CANDIDATE_JSON")"
  GATE_EXECUTION_ORIGIN_TASK_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).executionOriginTaskId)' "$GATE_RESUME_CANDIDATE_JSON")"
  if [ "$GATE_RESUME_MODE" = "managed" ]; then
    GATE_EXECUTION_RESUME_KIND="owner_recovery"
    GATE_EXECUTION_RESUME_KEY="owner:${CAT_CAFE_MANAGED_JOB_ID}:${CAT_CAFE_MANAGED_GATE_RESUME_EPOCH}"
  else
    GATE_EXECUTION_RESUME_KIND="explicit_resume"
    GATE_EXECUTION_RESUME_KEY="explicit:$GATE_RESUME_RUN_ID"
    GATE_EXECUTION_RESUME_SOURCE_RUN_ID="$GATE_RESUME_RUN_ID"
  fi
elif [ "${CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL:-}" = "2" ]; then
  GATE_EXECUTION_OWNER_JOB_ID="${CAT_CAFE_MANAGED_JOB_ID:-}"
  GATE_EXECUTION_ORIGIN_TASK_ID="${CAT_CAFE_GATE_ORIGIN_TASK_ID:-}"
  if [ "$GATE_RESUME_MODE" = "managed" ]; then
    GATE_EXECUTION_RESUME_KIND="owner_recovery"
    GATE_EXECUTION_RESUME_KEY="owner:${CAT_CAFE_MANAGED_JOB_ID}:${CAT_CAFE_MANAGED_GATE_RESUME_EPOCH}"
  fi
fi
if [ "${CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL:-}" = "2" ] || [ -n "$GATE_EXECUTION_RESUME_KIND" ]; then
  if [ -z "$GATE_EXECUTION_OWNER_JOB_ID" ] || [ -z "$GATE_EXECUTION_ORIGIN_TASK_ID" ]; then
    echo "Recovery-aware gate execution is missing its durable owner identity" >&2
    exit 1
  fi
  export CAT_CAFE_GATE_EXECUTION_OWNER_JOB_ID="$GATE_EXECUTION_OWNER_JOB_ID"
  export CAT_CAFE_GATE_EXECUTION_ORIGIN_TASK_ID="$GATE_EXECUTION_ORIGIN_TASK_ID"
  if [ -n "$GATE_EXECUTION_RESUME_KIND" ]; then
    if [ -z "$GATE_EXECUTION_RESUME_KEY" ]; then
      echo "Recovery-aware gate execution is missing its idempotency key" >&2
      exit 1
    fi
    export CAT_CAFE_GATE_EXECUTION_RESUME_KIND="$GATE_EXECUTION_RESUME_KIND"
    export CAT_CAFE_GATE_EXECUTION_RESUME_KEY="$GATE_EXECUTION_RESUME_KEY"
    if [ "$GATE_EXECUTION_RESUME_KIND" = "explicit_resume" ]; then
      export CAT_CAFE_GATE_EXECUTION_RESUME_SOURCE_RUN_ID="$GATE_EXECUTION_RESUME_SOURCE_RUN_ID"
    fi
  fi
fi
if [ -n "$GATE_RESUME_MODE" ]; then
  GATE_RESUME_IDENTITY_JSON="$(node "$GATE_TERMINAL_RECEIPT_SCRIPT" resume-parse --frozen-identity-json "$GATE_RESUME_IDENTITY_JSON")"
  GATE_RESUME_HEAD_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).headSha)' "$GATE_RESUME_IDENTITY_JSON")"
  GATE_RESUME_TREE_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).treeSha)' "$GATE_RESUME_IDENTITY_JSON")"
  GATE_RESUME_BASE_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).baseSha)' "$GATE_RESUME_IDENTITY_JSON")"
  git cat-file -e "${GATE_RESUME_BASE_SHA}^{commit}"
  if [ "$(git rev-parse HEAD)" != "$GATE_RESUME_HEAD_SHA" ] ||
    [ "$(git rev-parse 'HEAD^{tree}')" != "$GATE_RESUME_TREE_SHA" ]; then
    echo -e "${RED}❌ Gate resume requires the clean frozen HEAD/tree; start a normal gate for changed input${NC}" >&2
    exit 1
  fi
fi
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
      echo "   正确做法：pnpm worktree:new ../cat-cafe-{feature-name} --branch feat/{name}"
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
if [ -n "$SOURCE_FULL_SHA" ] && { [ "$PUBLIC_EXPORT" = "true" ] || [ "$TEST_MODE" != "full" ]; }; then
  echo "--source-full requires the canonical source full gate; public mode/export is unsupported" >&2
  exit 2
fi
# Every resumable stage that writes a green receipt must be listed here, or
# terminal green can be settled without it ever passing. The cheap check tiers
# run in both modes. scripts/gate-required-stages.test.mjs pins this.
if [ "$TEST_MODE" = "public" ]; then
  GATE_REQUIRED_STAGES="check-sources,check-installed,tsc,test-public,lint-web,check"
else
  GATE_REQUIRED_STAGES="check-sources,check-installed,tsc,test-non-browser,test-web-unit,test-web-browser,test-web-guards,lint-web,check"
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
    local heartbeat_status=0
    shift 2
    heartbeat_gate_receipt || heartbeat_status=$?
    if [ "$heartbeat_status" -ne 0 ]; then
      echo -e "${RED}❌ Gate receipt heartbeat failed before $stage${NC}" >&2
      return "$heartbeat_status"
    fi
    if [ "$mode" = "planned" ]; then
      if [ "$stage" != "test-web-browser" ]; then
        echo "Planned admission is only supported for browser verification" >&2
        return 1
      fi
      # The execution plan owns per-unit resource admission and budgets. Holding
      # an outer exclusive permit here would deadlock its first browser unit.
      "$@"
    else
      node "$GATE_RESOURCE_RUNNER" --mode "$mode" --stage "$stage" -- "$@"
    fi
  }
fi

is_test_file_timing_stage() {
  # Durable per-file artifacts belong to the home gate receipt store. The
  # public export deliberately runs without that Clowder AI control plane.
  [ "$PUBLIC_EXPORT" = "false" ] || return 1
  case "$1" in
    test-public|test-non-browser|test-web-unit|test-web-browser|test-web-guards) return 0 ;;
    *) return 1 ;;
  esac
}

disable_test_file_timing() {
  export PATH="$GATE_ORIGINAL_PATH"
  unset CAT_CAFE_TEST_TIMING_DIR CAT_CAFE_TEST_TIMING_REPO_ROOT CAT_CAFE_TEST_TIMING_STAGE CAT_CAFE_TEST_TIMING_REPORTER
  unset CAT_CAFE_REAL_NODE CAT_CAFE_REAL_TSX CAT_CAFE_NODE_COMMAND
  GATE_TIMING_DIR=""
}

enable_test_file_timing() {
  local stage="$1"
  GATE_TIMING_DIR="$GATE_TIMING_ROOT/$stage"
  mkdir -p "$GATE_TIMING_DIR"
  export CAT_CAFE_TEST_TIMING_DIR="$GATE_TIMING_DIR"
  export CAT_CAFE_TEST_TIMING_REPO_ROOT="$REPO_ROOT"
  export CAT_CAFE_TEST_TIMING_STAGE="$stage"
  export CAT_CAFE_TEST_TIMING_REPORTER="scripts/test-file-timing/node-file-timing-reporter.mjs"
  export CAT_CAFE_REAL_NODE="$GATE_REAL_NODE"
  export CAT_CAFE_REAL_TSX="$GATE_REAL_TSX"
  export CAT_CAFE_NODE_COMMAND="$GATE_NODE_COMMAND"
  if [ "$stage" = "test-web-browser" ]; then
    # The planned browser runner is itself a governed Node entrypoint and must
    # remain visible to the gate's command stub. Browser test commands use the
    # web wrapper (which injects reporters directly), so no PATH shim is needed.
    export PATH="$GATE_ORIGINAL_PATH"
  else
    export PATH="$REPO_ROOT/scripts/test-file-timing/bin:$GATE_ORIGINAL_PATH"
  fi
}

finalize_test_file_timing() {
  local stage="$1"
  local output="$GATE_TIMING_ROOT/$stage.json"
  "$GATE_REAL_NODE" "$REPO_ROOT/scripts/test-file-timing/finalize-test-file-timing.mjs" \
    --dir "$GATE_TIMING_DIR" --output "$output" --stage "$stage" --run-id "$GATE_TIMING_ID"
  echo "[test-file-timing] stage=$stage artifact=$output"
}

heartbeat_gate_receipt() {
  if [ "$GATE_TERMINAL_ACTIVE" = "true" ]; then
    node "$GATE_TERMINAL_RECEIPT_SCRIPT" heartbeat --run-id "$GATE_RUN_ID" --owner-pid "$$"
  fi
}

gate_stage_is_green() {
  local stage="$1"
  if [ "$GATE_TERMINAL_ACTIVE" != "true" ]; then
    return 3
  fi
  node "$GATE_TERMINAL_RECEIPT_SCRIPT" stage-check --run-id "$GATE_RUN_ID" --stage "$stage"
}

mark_gate_stage_green() {
  local stage="$1"
  local duration_ms="$2"
  local timing_artifact="${3:-}"
  if [ "$GATE_TERMINAL_ACTIVE" = "true" ]; then
    local receipt_args=(
      stage-green --run-id "$GATE_RUN_ID" --stage "$stage" --owner-pid "$$"
      --duration-ms "$duration_ms" --route "$GATE_ROUTE"
    )
    if [ -n "$timing_artifact" ]; then
      receipt_args+=(--test-file-timing-artifact "$timing_artifact")
    fi
    if [ "$GATE_VERIFICATION_SCOPE" = "source_full" ] && [ "$stage" = "test-web-browser" ]; then
      receipt_args+=(--browser-plan-file "$GATE_BROWSER_PLAN_FILE" --expected-plan-fingerprint "$GATE_BROWSER_PLAN_FINGERPRINT")
    fi
    node "$GATE_TERMINAL_RECEIPT_SCRIPT" "${receipt_args[@]}"
  fi
}

run_resumable_gate_stage() {
  local mode="$1"
  local stage="$2"
  local stage_start=$SECONDS
  local receipt_status=0
  shift 2
  disable_test_file_timing
  gate_stage_is_green "$stage" || receipt_status=$?
  case "$receipt_status" in
    0)
      echo -e "${GREEN}↻ Reused exact-tree green stage: $stage${NC}"
      return 0
      ;;
    3)
      ;;
    *)
      GATE_FAILED_STAGE="$stage"
      echo -e "${RED}❌ Stage receipt integrity check failed before $stage${NC}" >&2
      return "$receipt_status"
      ;;
  esac
  receipt_status=0
  if is_test_file_timing_stage "$stage"; then
    enable_test_file_timing "$stage"
  fi
  : >"$GATE_FAILURE_OUTPUT_FILE"
  if run_gate_resource_stage "$mode" "$stage" "$@" 2>&1 | tee "$GATE_FAILURE_OUTPUT_FILE"; then
    local timing_artifact=""
    if is_test_file_timing_stage "$stage"; then
      timing_artifact="$GATE_TIMING_ROOT/$stage.json"
    fi
    if is_test_file_timing_stage "$stage" && ! finalize_test_file_timing "$stage"; then
      disable_test_file_timing
      GATE_FAILED_STAGE="$stage"
      echo -e "${RED}❌ Test-file timing artifact write failed for $stage${NC}" >&2
      return 1
    fi
    disable_test_file_timing
    mark_gate_stage_green "$stage" "$(( (SECONDS - stage_start) * 1000 ))" "$timing_artifact" || receipt_status=$?
    if [ "$receipt_status" -ne 0 ]; then
      GATE_FAILED_STAGE="$stage"
      echo -e "${RED}❌ Green stage receipt write failed for $stage${NC}" >&2
      return "$receipt_status"
    fi
    return 0
  fi
  disable_test_file_timing
  GATE_FAILED_STAGE="$stage"
  return 1
}

run_browser_gate_stage() {
  if [ "$PUBLIC_EXPORT" = "true" ]; then
    # The public full-mode opt-in keeps its existing package contract; the home
    # execution/receipt control plane is intentionally not part of that export.
    run_resumable_gate_stage exclusive test-web-browser env -u REDIS_URL pnpm --filter @cat-cafe/web run test:browser
  else
    local plan_args=()
    if [ "$GATE_VERIFICATION_SCOPE" = "source_full" ]; then
      plan_args+=(--expected-plan-fingerprint "$GATE_BROWSER_PLAN_FINGERPRINT")
    fi
    run_resumable_gate_stage planned test-web-browser env -u REDIS_URL node \
      "$REPO_ROOT/scripts/run-browser-verification.mjs" --repo-root "$REPO_ROOT" \
      --head "$GATE_CONTROL_REVISION" --base "$GATE_BASE_SHA" --mode "$GATE_VERIFICATION_SCOPE" ${plan_args[@]+"${plan_args[@]}"}
  fi
}

settle_gate_receipt() {
  local status="$1"
  if [ "$GATE_TERMINAL_ACTIVE" != "true" ]; then
    return 0
  fi
  local settle_args=(settle --run-id "$GATE_RUN_ID" --status "$status" --route-json "$GATE_ROUTE_JSON" --failure-output-file "$GATE_FAILURE_OUTPUT_FILE")
  if [ "$GATE_VERIFICATION_SCOPE" = "source_full" ]; then
    settle_args+=(--browser-plan-file "$GATE_BROWSER_PLAN_FILE" --expected-plan-fingerprint "$GATE_BROWSER_PLAN_FINGERPRINT")
  fi
  if [ -n "$GATE_FAILED_STAGE" ]; then
    settle_args+=(--failed-stage "$GATE_FAILED_STAGE")
  fi
  if [ "$status" = "green" ]; then
    settle_args+=(--required-stages "$GATE_REQUIRED_STAGES")
  fi
  node "$GATE_TERMINAL_RECEIPT_SCRIPT" "${settle_args[@]}" || return "$?"
  GATE_TERMINAL_ACTIVE=false
}

GATE_GUARD_SCRIPT="$REPO_ROOT/scripts/pre-merge-gate-guard.mjs"
GATE_LOCK_DIR="${CAT_CAFE_GATE_LOCK_DIR:-$REPO_ROOT/.cat-cafe/gate/pre-merge-check.lock}"
GATE_GUARD_ACTIVE=false
release_gate_guard() {
  if [ "$GATE_GUARD_ACTIVE" = "true" ]; then
    node "$GATE_GUARD_SCRIPT" release --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$" >/dev/null 2>&1 || true
    GATE_GUARD_ACTIVE=false
  fi
}
gate_exit() {
  local exit_code=$?
  local settlement_exit=0
  if [ "$exit_code" -eq 124 ]; then
    GATE_TERMINAL_STATUS=timed_out
  fi
  settle_gate_receipt "$GATE_TERMINAL_STATUS" >/dev/null || settlement_exit=$?
  if [ "$settlement_exit" -ne 0 ]; then
    echo "[gate-receipt] terminal settlement failed: run=$GATE_RUN_ID status=$GATE_TERMINAL_STATUS exit=$settlement_exit; terminal result was not recorded" >&2
    if [ "$exit_code" -eq 0 ]; then
      exit_code=1
    fi
  fi
  release_gate_guard
  if [ -n "$GATE_FAILURE_OUTPUT_FILE" ]; then
    rm -f "$GATE_FAILURE_OUTPUT_FILE"
  fi
  if [ -n "$GATE_CONTROL_PLANE_DIR" ]; then
    case "$GATE_CONTROL_PLANE_DIR" in
      "${TMPDIR:-/tmp}"/cat-cafe-gate-control.*)
        rm -rf "$GATE_CONTROL_PLANE_DIR"
        ;;
      *)
        echo "refusing to remove unexpected gate control-plane path: $GATE_CONTROL_PLANE_DIR" >&2
        ;;
    esac
  fi
  return "$exit_code"
}
trap gate_exit EXIT
trap 'GATE_TERMINAL_STATUS=cancelled; exit 130' INT
trap 'GATE_TERMINAL_STATUS=cancelled; exit 143' TERM

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
if [ -n "$GATE_RESUME_MODE" ]; then
  echo "── Step 1/6: 恢复冻结 integration cut（不 fetch / 不 rebase）──"
  GATE_BASE_SHA="$GATE_RESUME_BASE_SHA"
  REBASE_SUMMARY="resumed frozen base ${GATE_BASE_SHA:0:8}"
  echo -e "${GREEN}✓ frozen HEAD/tree/base 保持不变: ${GATE_BASE_SHA:0:8}${NC}"
  record_step "resume-cut" "$STEP_START"
  echo ""
elif [ -n "$SOURCE_FULL_SHA" ]; then
  GATE_BASE_SHA="$SOURCE_FULL_SHA"
  REBASE_SUMMARY="source_full frozen source ${SOURCE_FULL_SHA:0:8}"
  echo "── Step 1/6: source_full exact cut（不 fetch / 不 rebase）──"
  record_step "source-cut" "$STEP_START"
elif [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; then
  if [ "$PUBLIC_EXPORT" != "false" ] || [ "$TEST_MODE" != "full" ]; then
    echo "Continuity claims require the canonical source gate classifier" >&2
    exit 2
  fi
  GATE_BASE_SHA="$GATE_CONTINUITY_BASE_SHA"
  REBASE_SUMMARY="C2 claim frozen base ${GATE_BASE_SHA:0:8}"
  echo "── Step 1/6: C2 claim exact cut（不 fetch / 不 rebase）──"
  record_step "continuity-cut" "$STEP_START"
elif [ "$NO_REBASE" = "true" ]; then
  echo "── Step 1/6: 跳过 rebase（--no-rebase）──"
  echo -e "${YELLOW}⚠ 已跳过 origin/main rebase，仅用于本地验证${NC}"
  GATE_BASE_SHA="$(git rev-parse origin/main)"
  record_step "rebase" "$STEP_START"
  echo ""
else
  echo "── Step 1/6: 同步 origin/main ──"
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

  # Freeze the integration cut before syncing. Other worktrees share the
  # origin/main tracking ref and may fetch while this 30-minute gate is still
  # running. Export this exact cut for base-aware child checkers; in particular,
  # governance checks must not fetch and replace their comparison target midway.
  GATE_BASE_SHA="$(git rev-parse origin/main)"
  GATE_HEAD_BEFORE_REBASE="$(git rev-parse HEAD)"

  ANCESTRY_RESULT=0
  git merge-base --is-ancestor "$GATE_BASE_SHA" HEAD 2>&1 || ANCESTRY_RESULT=$?
  if [ "$ANCESTRY_RESULT" -gt 1 ]; then
    echo -e "${RED}❌ Cannot verify frozen origin/main ancestry${NC}" >&2
    exit 1
  fi
  if [ "$ANCESTRY_RESULT" -eq 0 ]; then
    # The latest main may already be a merge parent. Rebasing that graph
    # replays its other feature parent and can conflict on duplicate commits.
    REBASE_SUMMARY="already contains frozen origin/main ${GATE_BASE_SHA:0:8}"
    echo -e "${GREEN}✓ Already contains frozen origin/main ${GATE_BASE_SHA:0:8}${NC}"
  else
    GATE_SYNC_MODE="rebase"
    PUBLISHED_BRANCH_REF="refs/remotes/origin/$BRANCH"
    PUBLISHED_REF_RESULT=0
    git show-ref --verify --quiet "$PUBLISHED_BRANCH_REF" || PUBLISHED_REF_RESULT=$?
    if [ "$PUBLISHED_REF_RESULT" -gt 1 ]; then
      echo -e "${RED}❌ Cannot verify published branch ref${NC}" >&2
      exit 1
    fi
    if [ "$PUBLISHED_REF_RESULT" -eq 0 ]; then
      if ! PUBLISHED_HEAD_SHA="$(git rev-parse --verify "$PUBLISHED_BRANCH_REF^{commit}")"; then
        echo -e "${RED}❌ Cannot resolve published branch commit${NC}" >&2
        exit 1
      fi
      PUBLISHED_HEAD_ANCESTRY=0
      git merge-base --is-ancestor "$PUBLISHED_HEAD_SHA" HEAD 2>&1 || PUBLISHED_HEAD_ANCESTRY=$?
      if [ "$PUBLISHED_HEAD_ANCESTRY" -gt 1 ]; then
        echo -e "${RED}❌ Cannot verify published branch ancestry${NC}" >&2
        exit 1
      fi
      if [ "$PUBLISHED_HEAD_ANCESTRY" -eq 0 ]; then
        PUBLISHED_BASE_ANCESTRY=0
        git merge-base --is-ancestor "$PUBLISHED_HEAD_SHA" "$GATE_BASE_SHA" 2>&1 || PUBLISHED_BASE_ANCESTRY=$?
        if [ "$PUBLISHED_BASE_ANCESTRY" -gt 1 ]; then
          echo -e "${RED}❌ Cannot verify published branch ancestry against frozen main${NC}" >&2
          exit 1
        fi
        # Preserve positively known published history until main contains it.
        # A later main fetch must not replay an earlier resolved merge. A
        # missing tracking ref or a deliberately diverged local branch keeps
        # the existing rebase policy; neither proves fresh remote absence.
        if [ "$PUBLISHED_BASE_ANCESTRY" -eq 1 ]; then
          GATE_SYNC_MODE="merge"
        fi
      fi
    fi
    if [ "$GATE_SYNC_MODE" = "merge" ]; then
      echo -e "${GREEN}✓ Preserving published branch history ${PUBLISHED_HEAD_SHA:0:8}${NC}"
      if ! git merge "$GATE_BASE_SHA" --quiet \
        -m "chore(gate): integrate frozen origin/main ${GATE_BASE_SHA:0:8}" \
        -m "Why: preserve published branch ancestry and resolved merges while verifying the latest main integration."; then
        echo -e "${RED}❌ Published branch merge failed; resolve or abort the merge before rerunning pnpm gate${NC}" >&2
        exit 1
      fi
      REBASE_SUMMARY="merged ${GATE_BASE_SHA:0:8} (frozen origin/main; published history preserved)"
      echo -e "${GREEN}✓ merge frozen origin/main ${GATE_BASE_SHA:0:8} 成功${NC}"
    else
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
    fi
  fi
  record_step "rebase" "$STEP_START"
  echo ""

  # A rebase or merge can replace this script or any gate-control dependency
  # while Bash still holds the original function definitions. Do not mix
  # that loaded shell with synced CLIs. Re-exec the current tree
  # before route classification, receipt creation, or any expensive stage.
  GATE_HEAD_AFTER_REBASE="$(git rev-parse HEAD)"
  if [ "$GATE_HEAD_AFTER_REBASE" != "$GATE_HEAD_BEFORE_REBASE" ]; then
    if [ "$GATE_REEXEC_DEPTH" -ge 3 ]; then
      echo -e "${RED}❌ Gate HEAD kept changing across 3 post-rebase restarts; refusing a mixed control plane${NC}" >&2
      exit 1
    fi
    if [ "$GATE_SYNC_MODE" = "merge" ]; then
      echo -e "${YELLOW}↻ Merge changed HEAD; restarting gate from the merged tree before post-sync commands${NC}"
    else
      echo -e "${YELLOW}↻ Rebase changed HEAD; restarting gate from the rebased tree before post-rebase commands${NC}"
    fi
    export CAT_CAFE_GATE_REEXEC_DEPTH="$((GATE_REEXEC_DEPTH + 1))"
    if [ "$GATE_ORIGINAL_ARG_COUNT" -eq 0 ]; then
      exec bash "$REPO_ROOT/scripts/pre-merge-check.sh"
    else
      exec bash "$REPO_ROOT/scripts/pre-merge-check.sh" "${GATE_ORIGINAL_ARGS[@]}"
    fi
  fi
fi

export CAT_CAFE_GATE_BASE_SHA="$GATE_BASE_SHA"
echo -e "${GREEN}✓ Gate baseline frozen: ${GATE_BASE_SHA:0:8}${NC}"
echo ""

# Route from repository and receipt truth after the integration cut is frozen.
# Local --no-rebase probes use the same classifier, but cannot publish merge
# evidence. Public exports retain their historical full contract.
if [ "$PUBLIC_EXPORT" = "false" ] && [ "$TEST_MODE" = "full" ]; then
  GATE_CONTROL_REVISION="$(git rev-parse HEAD)"
  GATE_CONTROL_PLANE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cat-cafe-gate-control.XXXXXX")"
  node "$REPO_ROOT/scripts/snapshot-gate-control-plane.mjs" \
    --repo-root "$REPO_ROOT" \
    --revision "$GATE_CONTROL_REVISION" \
    --destination "$GATE_CONTROL_PLANE_DIR" >/dev/null
  if [ "$(git rev-parse HEAD)" != "$GATE_CONTROL_REVISION" ]; then
    echo -e "${RED}❌ Gate HEAD changed while freezing its receipt control plane${NC}" >&2
    exit 1
  fi
  GATE_ROUTE_CLASSIFIER_SCRIPT="$GATE_CONTROL_PLANE_DIR/scripts/classify-gate-route.mjs"
  GATE_TERMINAL_RECEIPT_SCRIPT="$GATE_CONTROL_PLANE_DIR/scripts/gate-terminal-receipt.mjs"
  GATE_DATABASE_PATH="${CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH:-$(git rev-parse --path-format=absolute --git-common-dir)/cat-cafe-full-gate-resources.sqlite}"
  GATE_ROUTE_ARGS=(--repo-root "$REPO_ROOT" --base-sha "$GATE_BASE_SHA" --database-path "$GATE_DATABASE_PATH")
  if [ "$GATE_IDENTITY_ARG_COUNT" -eq 0 ]; then
    GATE_ORIGINAL_ARGS_JSON='[]'
  else
    GATE_ORIGINAL_ARGS_JSON="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "${GATE_IDENTITY_ARGS[@]}")"
  fi
  GATE_ROUTE_ARGS+=(--invocation-args-json "$GATE_ORIGINAL_ARGS_JSON")
  if [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; then
    GATE_ROUTE_ARGS+=(--continuity-claim "$GATE_CONTINUITY_CLAIM_ID")
  fi
  if [ -n "$RISK_AXIS" ]; then
    GATE_ROUTE_ARGS+=(--risk "$RISK_AXIS")
  fi
  GATE_ROUTE_JSON="$(node "$GATE_ROUTE_CLASSIFIER_SCRIPT" "${GATE_ROUTE_ARGS[@]}")"
  # Browser membership policy and owner documents are home-only. Keep their
  # admission consumer in this source-only branch, outside the exported classifier.
  GATE_ROUTE_JSON="$(node "$GATE_CONTROL_PLANE_DIR/scripts/check-gate-browser-membership.mjs" \
    --repo-root "$REPO_ROOT" <<<"$GATE_ROUTE_JSON")"
  GATE_ROUTE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).route)' "$GATE_ROUTE_JSON")"
  GATE_ROUTE_HEAD_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).headSha)' "$GATE_ROUTE_JSON")"
  GATE_ROUTE_FINGERPRINT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).fingerprint ?? "")' "$GATE_ROUTE_JSON")"
  if [ "$GATE_ROUTE_HEAD_SHA" != "$GATE_CONTROL_REVISION" ]; then
    echo -e "${RED}❌ Gate route tree no longer matches its control-plane snapshot${NC}" >&2
    exit 1
  fi
  GATE_ROUTE_REASONS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).reasons.join("; "))' "$GATE_ROUTE_JSON")"
  # The classifier already computes which evidence is still owed; surfacing it
  # keeps the terminal state actionable instead of a generic warning.
  GATE_ROUTE_REQUIRED_CHECKS="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).requiredChecks ?? []).join(", "))' "$GATE_ROUTE_JSON")"
  echo -e "${GREEN}✓ Gate route=${GATE_ROUTE}: ${GATE_ROUTE_REASONS}${NC}"
  if [ -n "$GATE_CONTINUITY_CLAIM_ID" ]; then
    if [ "$GATE_ROUTE" != "targeted" ]; then
      echo "Continuity claim rejected; a fresh full gate is required. Inspect the rejection before starting another gate." >&2
      exit 2
    fi
    echo "C2 claimHash=$GATE_CONTINUITY_CLAIM_ID (gate-owner assertion; C3 remains unverified)"
  fi
  GATE_ASSURANCE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).assuranceLevel ?? "standard")' "$GATE_ROUTE_JSON")"
  echo -e "${GREEN}✓ Assurance=${GATE_ASSURANCE}; required review and authorization remain separate from test coverage${NC}"
  if [ -n "$GATE_RESUME_MODE" ]; then
    RESUME_VALIDATE_ARGS=(
      resume-validate --frozen-identity-json "$GATE_RESUME_IDENTITY_JSON"
      --route-json "$GATE_ROUTE_JSON" --mode "$TEST_MODE" --risk "${RISK_AXIS:-none}"
    )
    node "$GATE_TERMINAL_RECEIPT_SCRIPT" "${RESUME_VALIDATE_ARGS[@]}" >/dev/null
    echo -e "${GREEN}✓ Resume identity matches the frozen cut${NC}"
  fi
  echo ""
  case "$GATE_ROUTE" in
    targeted)
      echo -e "${YELLOW}⚠ UNVERIFIED — gate classification finished; this route carries no verification evidence.${NC}" >&2
      echo "   Still owed at this exact HEAD: ${GATE_ROUTE_REQUIRED_CHECKS:-risk-matched-targeted-evidence}" >&2
      echo "   Run those checks, attach their output, then merge. This terminal state never means passed." >&2
      # Declared for the API-managed wake renderer: a non-zero exit alone reads as
      # an ordinary failure, which sends the owner to debug a break that did not
      # happen. Keep this the last line so it survives output-tail truncation.
      echo "${GATE_MANAGED_TERMINAL_DECLARATION_KEY}=unverified" >&2
      exit "$GATE_EXIT_UNVERIFIED"
      ;;
    reuse)
      echo -e "${GREEN}✓ Reused canonical exact-tree terminal-green evidence${NC}"
      if [ "$NO_REBASE" = "false" ] && [ "$GATE_VERIFICATION_SCOPE" = "merge" ]; then
        bash "$(dirname "$0")/write-gate-last-run.sh" "$REPO_ROOT"
      fi
      exit 0
      ;;
    full)
      # Coverage is determined entirely from frozen Git inputs. Discover a
      # missing classification before spending time on install/build/tests or
      # joining a resource queue. Execution still revalidates its own plan.
      GATE_BROWSER_PLAN_EXIT=0
      # Plans grow with the full catalog and can exceed the OS argv budget.
      # Keep the exact plan beside its frozen control plane until EXIT cleanup.
      GATE_BROWSER_PLAN_FILE="$GATE_CONTROL_PLANE_DIR/browser-plan.json"
      CAT_CAFE_TEST_TIMING_DIR=planned CAT_CAFE_TEST_TIMING_REPORTER=scripts/test-file-timing/node-file-timing-reporter.mjs \
        node "$GATE_CONTROL_PLANE_DIR/scripts/plan-browser-verification.mjs" \
        --repo-root "$REPO_ROOT" --head "$GATE_CONTROL_REVISION" --base "$GATE_BASE_SHA" --mode "$GATE_VERIFICATION_SCOPE" \
        --output "$GATE_BROWSER_PLAN_FILE" \
        || GATE_BROWSER_PLAN_EXIT=$?
      case "$GATE_BROWSER_PLAN_EXIT" in
        0)
          GATE_BROWSER_PLAN_FINGERPRINT="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(0,"utf8")).planFingerprint)' <"$GATE_BROWSER_PLAN_FILE")"
          GATE_BROWSER_REQUIRED_COUNT="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(p.status!=="ready") process.exit(1); process.stdout.write(String(p.requiredUnitIds.length))' <"$GATE_BROWSER_PLAN_FILE")"
          echo -e "${GREEN}✓ Browser coverage preflight: required=${GATE_BROWSER_REQUIRED_COUNT}${NC}"
          GATE_NATIVE_REQUIREMENTS="$(node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!Array.isArray(p.nativeVerificationRequirements)) throw new Error("Missing native coverage disposition"); if(p.nativeVerificationRequirements.length) process.stdout.write(JSON.stringify(p.nativeVerificationRequirements))' <"$GATE_BROWSER_PLAN_FILE")"
          if [ -n "$GATE_NATIVE_REQUIREMENTS" ]; then
            echo "Native verification remains separate; available checks will run without publishing full-gate green." >&2
            echo "$GATE_NATIVE_REQUIREMENTS" >&2
          fi
          ;;
        3)
          echo -e "${YELLOW}⚠ UNVERIFIED — browser coverage must be resolved before full-gate execution.${NC}" >&2
          node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); console.error(JSON.stringify({status:"unverified", coverageGaps:p.coverageGaps, requiredUnitIds:p.requiredUnitIds}))' <"$GATE_BROWSER_PLAN_FILE"
          echo "${GATE_MANAGED_TERMINAL_DECLARATION_KEY}=unverified" >&2
          exit "$GATE_EXIT_UNVERIFIED"
          ;;
        *)
          echo -e "${RED}❌ Browser coverage planning failed before full-gate execution${NC}" >&2
          exit "$GATE_BROWSER_PLAN_EXIT"
          ;;
      esac
      ;;
    *)
      echo -e "${RED}❌ Invalid gate route: ${GATE_ROUTE}${NC}" >&2
      exit 1
      ;;
  esac
fi

GATE_FAILURE_OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/cat-cafe-gate-output.XXXXXX")"

# Long full gates launched from a cat CLI must use the API-managed wakeWhen carrier.
# Classification stays cheap and foreground-safe, so targeted routes never get
# rejected merely because their caller is a cat process.
if [ -n "${CAT_CAFE_PROCESS_OWNER_ID:-}" ] || [ "${CAT_CAFE_CLI_PROCESS_CONTEXT:-}" = "cat" ]; then
  echo "⛔ 猫猫 CLI 不能前台运行 full gate。" >&2
  echo "   请调用 cat_cafe_hold_ball({ wakeWhen: { command: \"pnpm gate\" } })。" >&2
  echo "   Hub 会显示结构化运行状态，并在命令终态自动唤醒当前猫猫。" >&2
  exit 2
fi

node "$GATE_GUARD_SCRIPT" acquire --lock-dir "$GATE_LOCK_DIR" --holder-pid "$$"
GATE_GUARD_ACTIVE=true
echo -e "${GREEN}✓ Gate singleflight + system-pressure preflight${NC}"
echo ""

# Canonical exact-tree singleflight starts only for the complete source-full
# plan after its integration cut is frozen. Local, source-public, and exported
# public runs remain non-reusable probes.
if [ "$NO_REBASE" = "false" ] && [ "$PUBLIC_EXPORT" = "false" ] && [ "$TEST_MODE" = "full" ]; then
  export CAT_CAFE_MANAGED_JOB_ID="${CAT_CAFE_MANAGED_JOB_ID:-full-gate-$(node -e 'console.log(crypto.randomUUID())')}"
  if [ "$GATE_IDENTITY_ARG_COUNT" -eq 0 ]; then
    GATE_CLAIM_JSON="$(node "$GATE_TERMINAL_RECEIPT_SCRIPT" begin \
      --owner-pid "$$" --expected-fingerprint "$GATE_ROUTE_FINGERPRINT" \
      --head-sha "$GATE_CONTROL_REVISION" --tree-sha "$(git rev-parse 'HEAD^{tree}')" \
      --base-sha "$GATE_BASE_SHA" --route "$GATE_ROUTE" --risk "${RISK_AXIS:-none}" --mode "$TEST_MODE" --)"
  else
    GATE_CLAIM_JSON="$(node "$GATE_TERMINAL_RECEIPT_SCRIPT" begin \
      --owner-pid "$$" --expected-fingerprint "$GATE_ROUTE_FINGERPRINT" \
      --head-sha "$GATE_CONTROL_REVISION" --tree-sha "$(git rev-parse 'HEAD^{tree}')" \
      --base-sha "$GATE_BASE_SHA" --route "$GATE_ROUTE" --risk "${RISK_AXIS:-none}" --mode "$TEST_MODE" \
      -- "${GATE_IDENTITY_ARGS[@]}")"
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
      if [ "$GATE_CLAIM_STATUS" = "partial" ] && [ -n "$GATE_NATIVE_REQUIREMENTS" ]; then
        report_native_verification_required
        exit "$GATE_EXIT_UNVERIFIED"
      fi
      if [ "$GATE_CLAIM_STATUS" = "green" ]; then
        echo -e "${GREEN}✓ Reused canonical exact-tree terminal-green receipt: ${GATE_RUN_ID}${NC}"
        if [ "$GATE_VERIFICATION_SCOPE" = "merge" ]; then
          bash "$(dirname "$0")/write-gate-last-run.sh" "$REPO_ROOT"
        fi
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

# Per-file timing is observational evidence, kept outside the worktree so it
# cannot change the exact-tree fingerprint or dirty the author branch. A
# producer run uses its durable receipt id; local/public probes use a unique
# process-scoped id.
if [ "$PUBLIC_EXPORT" = "false" ]; then
  GATE_TIMING_ID="${GATE_RUN_ID:-manual-$$-$(date +%s)}"
  GATE_TIMING_BASE_PATH="${CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH:-${GATE_DATABASE_PATH:-$REPO_ROOT/.cat-cafe}}"
  GATE_TIMING_BASE_PATH="${GATE_TIMING_BASE_PATH%/*}"
  GATE_TIMING_ROOT="$GATE_TIMING_BASE_PATH/cat-cafe-gate-test-file-timing/$GATE_TIMING_ID"
  mkdir -p "$GATE_TIMING_ROOT"
fi

# ── Step 2a: Source-only checks ──
# These read the frozen tree and nothing else: no node_modules, no build output.
# Running them here turns a missing tips_exempt entry or an over-sized directory
# into a red before the author pays for install, build and the full test suite.
# Membership is evidence-based and lives in package.json, not here.
STEP_START=$SECONDS
echo "── Step 2/6a: 源码级检查（不依赖安装/构建）──"
if ! run_resumable_gate_stage shared check-sources pnpm check:sources; then
  echo ""
  echo -e "${RED}❌ 源码级 check 失败（尚未安装依赖，这些失败与依赖无关）${NC}"
  exit 1
fi
echo -e "${GREEN}✓ 源码级 check 通过${NC}"
echo ""
record_step "check-sources" "$STEP_START"

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

# ── Step 2b: Dependency-only checks ──
# These need node_modules but not build output, so they run before the build
# rather than after it.
STEP_START=$SECONDS
echo "── Step 2/6b: 依赖级检查（不依赖构建产物）──"
if ! run_resumable_gate_stage shared check-installed pnpm check:installed; then
  echo ""
  echo -e "${RED}❌ 依赖级 check 失败（尚未构建，这些失败与构建产物无关）${NC}"
  exit 1
fi
echo -e "${GREEN}✓ 依赖级 check 通过${NC}"
echo ""
record_step "check-installed" "$STEP_START"

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
# API tests and check:pre-merge-gate have separate finite Node test budgets.
# The stage permit runner also proves descendant cleanup before releasing its
# resource claim; a timed-out test may have spawned a detached child.
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
    ! run_browser_gate_stage ||
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

# Only the artifact-dependent remainder is left here; the source-only and
# dependency-only tiers already ran in Step 2a/2b against the same frozen tree.
if ! run_resumable_gate_stage shared check pnpm check:artifacts; then
  echo ""
  echo -e "${RED}❌ check 失败${NC}"
  exit 1
fi
echo -e "${GREEN}✓ check 通过（源码级/依赖级已在 Step 2a/2b 覆盖）${NC}"
record_step "lint+check" "$STEP_START"
echo ""

# ── 报告 ──

# Web/unit success does not discharge native Host obligations. Like targeted
# classification, this result needs separately reviewed evidence before merge.
# Keep the existing singleflight and per-stage evidence, but settle the whole
# run as partial. Only terminal green is reusable as complete gate evidence.
if [ -n "$GATE_NATIVE_REQUIREMENTS" ]; then
  GATE_TERMINAL_STATUS=partial
  settle_gate_receipt partial
  echo "Available automated checks passed; native evidence remains separate."
  report_native_verification_required
  exit "$GATE_EXIT_UNVERIFIED"
fi

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
if [ "$GATE_VERIFICATION_SCOPE" = "merge" ] && [ -n "$OBSERVED_MAIN_SHA" ] && [ "$OBSERVED_MAIN_SHA" != "$GATE_BASE_SHA" ]; then
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
if [ "$GATE_VERIFICATION_SCOPE" = "source_full" ]; then
  echo "source_full 完成：冻结 source 的完整自动验证通过。"
elif [ "$NO_REBASE" = "true" ]; then
  echo "本地验证完成；--no-rebase 不发布 latest-main 合入证据。"
else
  echo "可以安全执行 merge-gate 的后续步骤了。"
fi

# F253 Phase C (AC-C1): Write gate-last-run sentinel for pre-push Layer 4
# This timestamp lets check-gate-freshness.sh know gate passed recently.
if [ "$NO_REBASE" = "false" ] && [ "$GATE_VERIFICATION_SCOPE" = "merge" ]; then
  bash "$(dirname "$0")/write-gate-last-run.sh" "$REPO_ROOT"
fi
settle_gate_receipt green
