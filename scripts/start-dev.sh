#!/bin/bash

# Cat Cafe 启动脚本
# 用法:
#   pnpm start                        — 开发模式 (next dev + Redis 持久化)
#   pnpm start --profile=dev          — 家里开发默认值 (proxy ON, sidecar ON)
#   pnpm start --profile=opensource   — 开源仓默认值 (proxy OFF, sidecar OFF)
#   pnpm start --quick                — 跳过 rebuild
#   pnpm start --memory               — 使用内存存储 (重启丢数据)
#   pnpm start --no-redis             — 同 --memory
#   pnpm start --prod-web             — 前端 production build (PWA + Tailscale 友好)
#
# Profile 说明:
#   dev        — proxy ON, ASR/TTS/LLM ON, TTL=永久, redis-dev
#   opensource — proxy OFF, ASR/TTS/LLM OFF, TTL=86400s, redis-opensource
#   (无)       — 保持原有行为（各项 ENABLED 默认 0）
#
# .env 中的显式值覆盖 profile 默认值。启动摘要标注每个值的来源。
#
# --prod-web 模式 (runtime-worktree.sh 自动传入):
#   - next build + next start（非 next dev）
#   - PWA / Service Worker 启用
#   - Tailscale / 局域网手机访问正常
#   - --quick 时复用上次的 .next 产物
#
# Redis 数据目录 (可通过 env 覆盖):
#   REDIS_PORT=6399
#   REDIS_PROFILE=dev
#   REDIS_DATA_DIR=~/.cat-cafe/redis-dev
#   REDIS_BACKUP_DIR=~/.cat-cafe/redis-backups/dev

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "🐱 Cat Café 启动"
echo "================"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 解析参数
QUICK_MODE=false
USE_REDIS=true
PROD_WEB=false
PROFILE=""
for arg in "$@"; do
    case $arg in
        --quick|-q) QUICK_MODE=true ;;
        --memory|--no-redis) USE_REDIS=false ;;
        --prod-web) PROD_WEB=true ;;
        --profile=*) PROFILE="${arg#*=}" ;;
    esac
done

# 加载环境变量 (放最前面，后续函数需要端口号)
# 默认读取 .env；.env.local 仅用于 DARE 相关白名单键，避免全量覆盖引发配置漂移。
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

load_dare_env_from_local() {
    local env_file=".env.local"
    [ -f "$env_file" ] || return 0

    local key raw value
    for key in \
        DARE_PATH \
        DARE_ADAPTER \
        DARE_API_KEY \
        DARE_ENDPOINT \
        OPENROUTER_API_KEY \
        OPENROUTER_BASE_URL \
        OPENAI_API_KEY \
        OPENAI_BASE_URL \
        ANTHROPIC_API_KEY \
        ANTHROPIC_BASE_URL; do
        raw=$(grep -E "^${key}=" "$env_file" | tail -n1 || true)
        [ -n "$raw" ] || continue
        value="${raw#*=}"
        # 去掉包裹引号（兼容 key="value" / key='value'）
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        export "$key=$value"
    done
}

load_dare_env_from_local

default_redis_port() {
    if [ "$PROD_WEB" = true ]; then
        echo "6399"
    else
        echo "6398"
    fi
}

# Profile 默认值（env 变量优先，profile 作 fallback）
apply_profile_defaults() {
    local profile="$1"
    # Clear previous profile state
    unset _PROF_ANTHROPIC_PROXY_ENABLED _PROF_ASR_ENABLED _PROF_TTS_ENABLED
    unset _PROF_LLM_POSTPROCESS_ENABLED _PROF_REDIS_PROFILE
    unset _PROF_MESSAGE_TTL_SECONDS _PROF_THREAD_TTL_SECONDS
    unset _PROF_TASK_TTL_SECONDS _PROF_SUMMARY_TTL_SECONDS
    case "$profile" in
        dev)
            _PROF_ANTHROPIC_PROXY_ENABLED=1
            _PROF_ASR_ENABLED=1
            _PROF_TTS_ENABLED=1
            _PROF_LLM_POSTPROCESS_ENABLED=1
            _PROF_MESSAGE_TTL_SECONDS=0
            _PROF_THREAD_TTL_SECONDS=0
            _PROF_TASK_TTL_SECONDS=0
            _PROF_SUMMARY_TTL_SECONDS=0
            _PROF_REDIS_PROFILE=dev
            ;;
        opensource)
            _PROF_ANTHROPIC_PROXY_ENABLED=0
            _PROF_ASR_ENABLED=0
            _PROF_TTS_ENABLED=0
            _PROF_LLM_POSTPROCESS_ENABLED=0
            _PROF_MESSAGE_TTL_SECONDS=86400
            _PROF_THREAD_TTL_SECONDS=86400
            _PROF_TASK_TTL_SECONDS=86400
            _PROF_SUMMARY_TTL_SECONDS=86400
            _PROF_REDIS_PROFILE=opensource
            ;;
        "")
            # No profile — all _PROF_ vars stay unset, existing behavior preserved
            ;;
        *)
            echo -e "${RED}ERROR: Unknown profile '$profile'. Valid: dev, opensource${NC}"
            exit 1
            ;;
    esac
}

apply_profile_defaults "$PROFILE"

# resolve_config: env override > profile default (sets var + _SRC_ annotation)
# Usage: resolve_config "VAR_NAME" — sets VAR_NAME and _SRC_VAR_NAME in current shell
resolve_config() {
    local var_name="$1"
    local prof_var="_PROF_${var_name}"
    local env_val="${!var_name}"
    local prof_val="${!prof_var}"
    if [ -n "$env_val" ]; then
        eval "_SRC_${var_name}=\".env override\""
    elif [ -n "$prof_val" ]; then
        eval "_SRC_${var_name}=\"profile default ($PROFILE)\""
        eval "${var_name}=\"${prof_val}\""
    else
        eval "_SRC_${var_name}=\"built-in default\""
    fi
}

# print_config_summary: display each profile-aware config with its source
print_config_summary() {
    echo "  配置来源："
    local key src_var val source
    for key in ANTHROPIC_PROXY_ENABLED ASR_ENABLED TTS_ENABLED LLM_POSTPROCESS_ENABLED \
               MESSAGE_TTL_SECONDS THREAD_TTL_SECONDS TASK_TTL_SECONDS SUMMARY_TTL_SECONDS \
               REDIS_PROFILE; do
        val="${!key}"
        src_var="_SRC_${key}"
        source="${!src_var:-built-in default}"
        printf "    %-30s = %-10s ← %s\n" "$key" "$val" "$source"
    done
}

# 默认端口 (not profile-dependent)
API_PORT=${API_SERVER_PORT:-3004}
WEB_PORT=${FRONTEND_PORT:-3003}
REDIS_PORT=${REDIS_PORT:-$(default_redis_port)}

# Profile-aware config resolution
resolve_config "ANTHROPIC_PROXY_ENABLED"
resolve_config "ASR_ENABLED"
resolve_config "TTS_ENABLED"
resolve_config "LLM_POSTPROCESS_ENABLED"
resolve_config "MESSAGE_TTL_SECONDS"
resolve_config "THREAD_TTL_SECONDS"
resolve_config "TASK_TTL_SECONDS"
resolve_config "SUMMARY_TTL_SECONDS"
resolve_config "REDIS_PROFILE"

# Apply built-in fallbacks for vars with no profile and no env
: "${ANTHROPIC_PROXY_ENABLED:=0}"
: "${ASR_ENABLED:=0}"
: "${TTS_ENABLED:=0}"
: "${LLM_POSTPROCESS_ENABLED:=0}"
: "${MESSAGE_TTL_SECONDS:=0}"
: "${THREAD_TTL_SECONDS:=0}"
: "${TASK_TTL_SECONDS:=0}"
: "${SUMMARY_TTL_SECONDS:=0}"
: "${REDIS_PROFILE:=dev}"

REDIS_DATA_DIR=${REDIS_DATA_DIR:-"$HOME/.cat-cafe/redis-${REDIS_PROFILE}"}
REDIS_BACKUP_DIR=${REDIS_BACKUP_DIR:-"$HOME/.cat-cafe/redis-backups/${REDIS_PROFILE}"}
REDIS_DBFILE=${REDIS_DBFILE:-dump.rdb}
REDIS_PIDFILE="${REDIS_DATA_DIR}/redis-${REDIS_PORT}.pid"
REDIS_LOGFILE="${REDIS_DATA_DIR}/redis-${REDIS_PORT}.log"
STARTED_REDIS=false

export MESSAGE_TTL_SECONDS THREAD_TTL_SECONDS TASK_TTL_SECONDS SUMMARY_TTL_SECONDS

# 杀掉占用端口的进程
kill_port() {
    local port=$1
    local name=$2
    local pids
    pids=$(lsof -nP -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo -e "${YELLOW}  端口 $port ($name) 被占用，正在终止进程...${NC}"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 1
        # 确认已死
        pids=$(lsof -nP -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo -e "${YELLOW}  强制终止...${NC}"
            echo "$pids" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
        echo -e "${GREEN}  ✓ 端口 $port 已释放${NC}"
    fi
}

kill_managed_ports() {
    local preview_gateway_port="${PREVIEW_GATEWAY_PORT:-4100}"

    kill_port $API_PORT "API"
    kill_port $WEB_PORT "Frontend"
    if [ "$preview_gateway_port" != "0" ]; then
        kill_port $preview_gateway_port "Preview Gateway"
    fi
    if [ "${ANTHROPIC_PROXY_ENABLED:-0}" = "1" ]; then
        [ "${ANTHROPIC_PROXY_ENABLED:-1}" != "0" ] && kill_port ${ANTHROPIC_PROXY_PORT:-9877} "Proxy"
    fi
    if [ "${ASR_ENABLED:-0}" = "1" ]; then
        kill_port ${WHISPER_PORT:-9876} "ASR"
    fi
    if [ "${TTS_ENABLED:-0}" = "1" ]; then
        kill_port ${TTS_PORT:-9879} "TTS"
    fi
    if [ "${LLM_POSTPROCESS_ENABLED:-0}" = "1" ]; then
        kill_port ${LLM_POSTPROCESS_PORT:-9878} "LLM后修"
    fi
}

# 轮询等待端口监听（ML 模型加载需要时间）
# 用法: wait_for_port <port> <name> [max_seconds=15]
wait_for_port() {
    local port=$1
    local name=$2
    local max_wait=${3:-15}
    local elapsed=0
    while [ $elapsed -lt $max_wait ]; do
        if lsof -nP -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${GREEN}  ✓ $name 已启动 (端口 $port, ${elapsed}s)${NC}"
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    echo -e "${RED}  ✗ $name 启动超时（端口 $port, ${max_wait}s 内未监听）${NC}"
    return 1
}

# Sidecar 状态机：disabled → launching → ready | failed
# 用法: start_sidecar <name> <state_var> <port> <timeout> <launch_cmd...>
start_sidecar() {
    local name="$1" state_var="$2" port="$3" timeout="$4"
    shift 4
    local launch_cmd="$*"

    eval "${state_var}=launching"
    echo "  启动 ${name} (端口 ${port})..."
    eval "$launch_cmd" &
    if wait_for_port "$port" "$name" "$timeout"; then
        eval "${state_var}=ready"
    else
        eval "${state_var}=failed"
    fi
}

# Sidecar summary: ready → 地址, failed → 报告, disabled → 静默
print_sidecar_summary_all() {
    local name state_var port state
    for entry in "ASR:_STATE_ASR:${ASR_PORT:-9876}" "TTS:_STATE_TTS:${TTS_PORT_VAL:-9879}" "LLM后修:_STATE_LLM_PP:${LLM_PP_PORT:-9878}"; do
        name="${entry%%:*}"
        local rest="${entry#*:}"
        state_var="${rest%%:*}"
        port="${rest#*:}"
        state="${!state_var}"
        case "$state" in
            ready)   echo "  - ${name}:      http://localhost:${port}" ;;
            failed)  echo -e "  - ${name}:      ${RED:-}启动失败${NC:-}" ;;
        esac
    done
}

# 检查 sidecar 依赖是否存在（ENABLED=1 时调用）
# 用法: check_sidecar_dep <name> <command>
# 返回 0 = 存在, 1 = 缺失（并打印安装提示）
check_sidecar_dep() {
    local name="$1" cmd="$2"
    if ! command -v "$cmd" &>/dev/null; then
        echo -e "${RED:-}  ✗ ${name} 需要 ${cmd}，但未安装${NC:-}"
        echo "    请运行: ./scripts/setup.sh 或手动安装 ${cmd}"
        return 1
    fi
    return 0
}

# 清理缓存
# --prod-web + --quick: 保留 .next production 产物以便秒启动
clean_cache() {
    if [ "$PROD_WEB" = true ] && [ "$QUICK_MODE" = true ]; then
        echo ""
        echo -e "${YELLOW}保留 .next 产物 (--prod-web --quick)${NC}"
        return
    fi

    echo ""
    echo -e "${CYAN}清理缓存...${NC}"

    # Next.js 缓存 — 这是最容易出问题的
    if [ -d "packages/web/.next" ]; then
        /bin/rm -rf packages/web/.next
        echo -e "${GREEN}  ✓ 清理 .next 缓存${NC}"
    fi

    # Next.js tsbuildinfo
    if [ -f "packages/web/tsconfig.tsbuildinfo" ]; then
        /bin/rm -f packages/web/tsconfig.tsbuildinfo
        echo -e "${GREEN}  ✓ 清理 web tsconfig.tsbuildinfo${NC}"
    fi
}

# 清理与 pnpm 工作区冲突的 npm lockfile（会触发 Next 错误 patch 逻辑）
sanitize_lockfiles() {
    local web_lock="${1:-packages/web/package-lock.json}"
    if [ -f "$web_lock" ]; then
        /bin/rm -f "$web_lock"
        echo -e "${YELLOW}  ⚠ 已移除 $web_lock (pnpm 工作区应使用 pnpm-lock.yaml)${NC}"
    fi
}

ensure_redis_dirs() {
    mkdir -p "$REDIS_DATA_DIR" "$REDIS_BACKUP_DIR"
}

prune_redis_backups() {
    local keep="${1:-20}"
    local files=()
    while IFS= read -r f; do
        files+=("$f")
    done < <(ls -1t "$REDIS_BACKUP_DIR"/"${REDIS_PROFILE}"-*.rdb 2>/dev/null || true)

    if [ "${#files[@]}" -le "$keep" ]; then
        return
    fi

    local i
    for ((i=keep; i<${#files[@]}; i++)); do
        /bin/rm -f "${files[$i]}"
    done
}

archive_redis_snapshot() {
    local reason="${1:-manual}"
    ensure_redis_dirs

    local source=""
    local dir=""
    local dbfile=""

    if redis-cli -p "$REDIS_PORT" ping &> /dev/null; then
        redis-cli -p "$REDIS_PORT" bgsave &> /dev/null || true
        sleep 0.2
        dir=$(redis-cli -p "$REDIS_PORT" config get dir 2>/dev/null | sed -n '2p' || true)
        dbfile=$(redis-cli -p "$REDIS_PORT" config get dbfilename 2>/dev/null | sed -n '2p' || true)
        if [ -n "$dir" ] && [ -n "$dbfile" ]; then
            source="$dir/$dbfile"
        fi
    fi

    if [ -z "$source" ]; then
        source="$REDIS_DATA_DIR/$REDIS_DBFILE"
    fi

    if [ ! -f "$source" ]; then
        return
    fi

    local stamp
    stamp=$(date '+%Y%m%d-%H%M%S')
    local target="$REDIS_BACKUP_DIR/${REDIS_PROFILE}-${reason}-${stamp}.rdb"
    cp -p "$source" "$target"
    echo -e "${GREEN}  ✓ Redis 快照归档: $target${NC}"
    prune_redis_backups 20
}

print_redis_runtime_info() {
    local dir dbfile appendonly dbsize
    dir=$(redis-cli -p "$REDIS_PORT" config get dir 2>/dev/null | sed -n '2p' || true)
    dbfile=$(redis-cli -p "$REDIS_PORT" config get dbfilename 2>/dev/null | sed -n '2p' || true)
    appendonly=$(redis-cli -p "$REDIS_PORT" config get appendonly 2>/dev/null | sed -n '2p' || true)
    dbsize=$(redis-cli -p "$REDIS_PORT" dbsize 2>/dev/null || echo "?")
    echo "  Redis 配置:"
    echo "    - profile:   $REDIS_PROFILE"
    echo "    - port:      $REDIS_PORT"
    echo "    - dbsize:    $dbsize"
    [ -n "$dir" ] && echo "    - dir:       $dir"
    [ -n "$dbfile" ] && echo "    - dbfilename:$dbfile"
    [ -n "$appendonly" ] && echo "    - appendonly:$appendonly"
}

run_in_dir() {
    local dir="$1"
    shift
    (
        cd "$dir" &&
        "$@"
    )
}

run_logged_step() {
    local label="$1"
    local success_tail_lines="$2"
    shift 2

    local log_file rc
    log_file=$(mktemp "${TMPDIR:-/tmp}/cat-cafe-build-XXXXXX")

    if "$@" >"$log_file" 2>&1; then
        tail -n "$success_tail_lines" "$log_file"
        rm -f "$log_file"
        return 0
    else
        rc=$?
        echo -e "${RED}  ✗ ${label} 失败，完整日志如下：${NC}" >&2
        cat "$log_file" >&2
        echo -e "${RED}  日志文件: $log_file${NC}" >&2
        return "$rc"
    fi
}

# 构建 shared + MCP + API (tsc)；--prod-web 时额外构建 Frontend
build_packages() {
    echo ""
    echo -e "${CYAN}构建 shared...${NC}"
    run_logged_step "shared 构建" 3 run_in_dir "$PROJECT_DIR/packages/shared" pnpm run build
    echo -e "${GREEN}  ✓ shared 构建完成${NC}"

    echo ""
    echo -e "${CYAN}构建 MCP Server...${NC}"
    run_logged_step "MCP Server 构建" 3 run_in_dir "$PROJECT_DIR/packages/mcp-server" pnpm run build
    echo -e "${GREEN}  ✓ MCP Server 构建完成${NC}"

    echo ""
    echo -e "${CYAN}构建 API...${NC}"
    run_logged_step "API 构建" 3 run_in_dir "$PROJECT_DIR/packages/api" pnpm run build
    echo -e "${GREEN}  ✓ API 构建完成${NC}"

    if [ "$PROD_WEB" = true ]; then
        echo ""
        echo -e "${CYAN}构建 Frontend (production)...${NC}"
        run_logged_step "Frontend 构建" 10 run_in_dir "$PROJECT_DIR/packages/web" pnpm run build
        echo -e "${GREEN}  ✓ Frontend 构建完成 (PWA 已启用)${NC}"
    fi
}

configure_mcp_server_path() {
    export CAT_CAFE_MCP_SERVER_PATH="${CAT_CAFE_MCP_SERVER_PATH:-$PROJECT_DIR/packages/mcp-server/dist/index.js}"

    if [ -f "$CAT_CAFE_MCP_SERVER_PATH" ]; then
        echo -e "${GREEN}  ✓ MCP callback path: $CAT_CAFE_MCP_SERVER_PATH${NC}"
    else
        echo -e "${YELLOW}  ⚠ MCP callback path 不存在: $CAT_CAFE_MCP_SERVER_PATH${NC}"
        echo -e "${YELLOW}    布偶猫将无法使用 cat_cafe_* MCP 工具（含权限申请）${NC}"
    fi
}

# 检查/启动 Redis
# USE_REDIS=true (默认): 尝试启动 Redis, 失败则回退内存
# USE_REDIS=false (--memory): 跳过 Redis, 强制内存存储
setup_storage() {
    if [ "$USE_REDIS" = false ]; then
        echo -e "${YELLOW}  ⚡ 内存模式 (--memory)，重启丢数据${NC}"
        unset REDIS_URL
        export MEMORY_STORE=1
        return
    fi

    ensure_redis_dirs
    archive_redis_snapshot "pre-start"

    # 默认: 尝试 Redis 持久化 (专属端口，避免与系统 Redis 冲突)
    if redis-cli -p "$REDIS_PORT" ping &> /dev/null; then
        echo -e "${GREEN}  ✓ Redis 已运行 (端口 $REDIS_PORT)${NC}"
        export REDIS_URL="redis://localhost:$REDIS_PORT"
        print_redis_runtime_info
        return
    fi

    echo -e "${YELLOW}  ⚠ Redis 未运行，尝试在端口 $REDIS_PORT 启动...${NC}"
    if command -v redis-server &> /dev/null; then
        redis-server \
            --port "$REDIS_PORT" \
            --bind 127.0.0.1 \
            --dir "$REDIS_DATA_DIR" \
            --dbfilename "$REDIS_DBFILE" \
            --save "3600 1 300 100 60 10000" \
            --appendonly yes \
            --appendfilename "appendonly.aof" \
            --appendfsync everysec \
            --daemonize yes \
            --pidfile "$REDIS_PIDFILE" \
            --logfile "$REDIS_LOGFILE" \
            >/dev/null 2>&1 || true
        sleep 1
        if redis-cli -p "$REDIS_PORT" ping &> /dev/null; then
            echo -e "${GREEN}  ✓ Redis 已启动 (端口 $REDIS_PORT)${NC}"
            export REDIS_URL="redis://localhost:$REDIS_PORT"
            STARTED_REDIS=true
            print_redis_runtime_info
        else
            echo -e "${RED}  ✗ Redis 启动失败${NC}"
            echo -e "${RED}    使用 --memory 标志允许内存模式启动${NC}"
            exit 1
        fi
    else
        echo -e "${RED}  ✗ Redis 未安装${NC}"
        echo -e "${YELLOW}    安装: brew install redis${NC}"
        echo -e "${RED}    使用 --memory 标志允许内存模式启动${NC}"
        exit 1
    fi
}

# 清理函数 — Ctrl+C 时杀所有子进程 + 关闭专属 Redis
cleanup() {
    echo ""
    echo "正在关闭服务..."
    kill $(jobs -p) 2>/dev/null || true
    # 关闭我们启动的专属 Redis (不影响其他 Redis 实例)
    if [ "$USE_REDIS" = true ] && [ "$STARTED_REDIS" = true ] && redis-cli -p "$REDIS_PORT" ping &> /dev/null 2>&1; then
        archive_redis_snapshot "pre-stop"
        redis-cli -p "$REDIS_PORT" shutdown save &> /dev/null || true
        echo "  Redis (端口 $REDIS_PORT) 已关闭"
    fi
    wait 2>/dev/null || true
    echo "再见！🐾"
}

trap cleanup EXIT INT TERM

guard_main_branch_start() {
    if [ "${CAT_CAFE_ALLOW_MAIN_DEV:-0}" = "1" ]; then
        return
    fi

    if ! command -v git >/dev/null 2>&1; then
        return
    fi

    local branch repo_root repo_name
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
    repo_name=$(basename "${repo_root:-}")

    if [ -z "$branch" ] || [ -z "$repo_root" ]; then
        return
    fi

    if [ "$repo_name" = "cat-cafe" ] && [ "$branch" = "main" ]; then
        echo ""
        echo -e "${RED}✗ 检测到当前在 main 分支启动开发服务，已阻止。${NC}"
        echo "  目的：避免热更新重启中断会话。"
        echo ""
        echo "  请改用运行态 worktree："
        echo "    1) pnpm runtime:init"
        echo "    2) pnpm runtime:start -- --quick"
        echo ""
        echo "  临时绕过（不推荐）："
        echo "    CAT_CAFE_ALLOW_MAIN_DEV=1 pnpm start"
        exit 1
    fi
}

guard_runtime_redis_sanctuary() {
    if [ "$USE_REDIS" = false ]; then
        return
    fi

    if [ "$PROD_WEB" = true ]; then
        return
    fi

    if [ "$REDIS_PORT" = "6399" ]; then
        echo ""
        echo -e "${RED}✗ 检测到非 runtime 启动命中 Redis production Redis (sacred)，已阻止。${NC}"
        echo "  6399 只给 runtime/prod-web 使用。普通开发实例默认应走 6398。"
        echo ""
        echo "  正确路径："
        echo "    - runtime: pnpm runtime:start"
        echo "    - worktree/dev: REDIS_PORT=6398 pnpm start:direct"
        echo ""
        exit 1
    fi
}

# 主函数
main() {
    guard_main_branch_start
    guard_runtime_redis_sanctuary

    # 1. 杀掉残余进程
    echo ""
    echo -e "${CYAN}检查端口...${NC}"
    kill_managed_ports

    # 2. 清理缓存
    clean_cache
    sanitize_lockfiles

    # 3. 构建 shared + API (除非 --quick)
    if [ "$QUICK_MODE" = false ]; then
        build_packages
    else
        echo ""
        echo -e "${YELLOW}跳过构建 (--quick 模式)${NC}"
    fi

    # 4. 检查外部依赖
    echo ""
    echo -e "${CYAN}检查依赖...${NC}"
    setup_storage
    configure_mcp_server_path
    echo "  数据保留 (秒): message=${MESSAGE_TTL_SECONDS} thread=${THREAD_TTL_SECONDS} task=${TASK_TTL_SECONDS} summary=${SUMMARY_TTL_SECONDS}"
    echo "  注: 0 表示永久保留（不自动过期）"

    # 5. 启动服务
    echo ""
    echo -e "${CYAN}启动服务...${NC}"

    # Anthropic API Gateway Proxy (api_key profiles auto-routed here)
    # 默认关闭 (ANTHROPIC_PROXY_ENABLED=0)，需要反代时在 .env 设为 1
    PROXY_PORT=${ANTHROPIC_PROXY_PORT:-9877}
    if [ "${ANTHROPIC_PROXY_ENABLED:-0}" = "1" ]; then
        if [ -f "scripts/anthropic-proxy.mjs" ]; then
            echo "  启动 Anthropic Proxy (端口 $PROXY_PORT)..."
            PROXY_UPSTREAMS="${ANTHROPIC_PROXY_UPSTREAMS_PATH:-$PROJECT_DIR/.cat-cafe/proxy-upstreams.json}"
            ANTHROPIC_PROXY_PORT=$PROXY_PORT node scripts/anthropic-proxy.mjs --port $PROXY_PORT --upstreams "$PROXY_UPSTREAMS" &
            PROXY_PID=$!
            sleep 1
            if kill -0 $PROXY_PID 2>/dev/null; then
                echo -e "${GREEN}  ✓ Anthropic Proxy 已启动${NC}"
            else
                echo -e "${RED}  ✗ Anthropic Proxy 启动失败（端口 $PROXY_PORT 被占用？）${NC}"
            fi
        else
            echo -e "${YELLOW}  ⚠ anthropic-proxy.mjs 未找到，跳过 Proxy${NC}"
        fi
    else
        echo -e "${YELLOW}  ⚠ Anthropic Proxy 已禁用 (ANTHROPIC_PROXY_ENABLED=0)${NC}"
    fi

    # Sidecar 状态初始化
    ASR_PORT=${WHISPER_PORT:-9876}
    TTS_PORT_VAL=${TTS_PORT:-9879}
    LLM_PP_PORT=${LLM_POSTPROCESS_PORT:-9878}
    _STATE_ASR=disabled
    _STATE_TTS=disabled
    _STATE_LLM_PP=disabled

    # Qwen3-ASR Server (语音输入 — 替代 Whisper，同端口 drop-in)
    if [ "${ASR_ENABLED:-0}" = "1" ]; then
        if ! check_sidecar_dep "ASR" "python3"; then
            _STATE_ASR=failed
        elif [ -f "scripts/qwen3-asr-server.sh" ]; then
            start_sidecar "Qwen3-ASR" "_STATE_ASR" "$ASR_PORT" "${ASR_TIMEOUT:-30}" \
                "WHISPER_PORT=$ASR_PORT bash scripts/qwen3-asr-server.sh"
        elif [ -f "scripts/whisper-server.sh" ]; then
            start_sidecar "Whisper ASR" "_STATE_ASR" "$ASR_PORT" "${ASR_TIMEOUT:-30}" \
                "WHISPER_PORT=$ASR_PORT bash scripts/whisper-server.sh"
        else
            echo -e "${RED}  ✗ ASR 已启用，但脚本未找到${NC}"
            echo "    请运行: ./scripts/setup.sh"
            _STATE_ASR=failed
        fi
    fi

    # TTS Server (语音合成 — Qwen3-TTS / Kokoro / edge-tts)
    if [ "${TTS_ENABLED:-0}" = "1" ]; then
        if ! check_sidecar_dep "TTS" "python3"; then
            _STATE_TTS=failed
        elif [ -f "scripts/tts-server.sh" ]; then
            start_sidecar "TTS" "_STATE_TTS" "$TTS_PORT_VAL" "${TTS_TIMEOUT:-30}" \
                "TTS_PORT=$TTS_PORT_VAL bash scripts/tts-server.sh"
        else
            echo -e "${RED}  ✗ TTS 已启用，但脚本未找到${NC}"
            echo "    请运行: ./scripts/setup.sh"
            _STATE_TTS=failed
        fi
    fi

    # LLM 后修 Server (语音转写纠正 — Qwen3-4B)
    if [ "${LLM_POSTPROCESS_ENABLED:-0}" = "1" ]; then
        if ! check_sidecar_dep "LLM 后修" "python3"; then
            _STATE_LLM_PP=failed
        elif [ -f "scripts/llm-postprocess-server.sh" ]; then
            start_sidecar "LLM 后修" "_STATE_LLM_PP" "$LLM_PP_PORT" "${LLM_TIMEOUT:-60}" \
                "LLM_POSTPROCESS_PORT=$LLM_PP_PORT bash scripts/llm-postprocess-server.sh"
        else
            echo -e "${RED}  ✗ LLM 后修已启用，但脚本未找到${NC}"
            echo "    请运行: ./scripts/setup.sh"
            _STATE_LLM_PP=failed
        fi
    fi

    # API Server
    echo "  启动 API Server (端口 $API_PORT)..."
    (cd packages/api && pnpm run dev) &
    sleep 2

    # Frontend
    if [ "$PROD_WEB" = true ]; then
        # Production: next start (PWA + Tailscale 友好)
        echo "  启动 Frontend (端口 $WEB_PORT, production)..."
        if [ -d "packages/web/.next" ]; then
            (cd packages/web && PORT=$WEB_PORT pnpm exec next start -p $WEB_PORT -H 0.0.0.0) &
        else
            echo -e "${RED}  ✗ .next 目录不存在，无法以 production 模式启动${NC}"
            echo -e "${RED}    请先不带 --quick 运行以执行 next build${NC}"
            exit 1
        fi
    else
        # Development: next dev (热重载)
        echo "  启动 Frontend (端口 $WEB_PORT, dev)..."
        (cd packages/web && NEXT_IGNORE_INCORRECT_LOCKFILE=1 PORT=$WEB_PORT pnpm exec next dev -p $WEB_PORT) &
    fi
    sleep 3

    # 显示存储模式
    if [ -n "$REDIS_URL" ]; then
        STORAGE_INFO="${GREEN}Redis 持久化${NC} ($REDIS_URL)"
    else
        STORAGE_INFO="${YELLOW}内存模式${NC} (重启丢数据)"
    fi

    # 前端模式状态
    if [ "$PROD_WEB" = true ]; then
        PWA_INFO="${GREEN}production (PWA 已启用)${NC}"
    else
        PWA_INFO="${YELLOW}development (热重载, PWA 不可用)${NC}"
    fi

    echo ""
    echo "========================"
    echo -e "${GREEN}🎉 Cat Café 已启动！${NC}"
    [ -n "$PROFILE" ] && echo -e "  Profile: ${CYAN}${PROFILE}${NC}"
    echo ""
    print_config_summary
    echo ""
    echo "服务地址："
    echo "  - Frontend: http://localhost:$WEB_PORT"
    echo "  - API:      http://localhost:$API_PORT"
    [ "${ANTHROPIC_PROXY_ENABLED:-0}" = "1" ] && echo "  - Proxy:    http://localhost:$PROXY_PORT"
    print_sidecar_summary_all
    echo -e "  - 前端模式: $PWA_INFO"
    echo -e "  - 存储:     $STORAGE_INFO"
    echo ""
    echo "按 Ctrl+C 停止所有服务"
    echo ""

    # 等待所有后台进程
    wait
}

# Allow sourcing for testing without executing main
[[ "${1:-}" == "--source-only" ]] && { return 0 2>/dev/null; exit 0; }
main "$@"
