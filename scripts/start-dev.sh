#!/bin/bash

# Cat Cafe 启动脚本（底层实现）
# 用户入口:
#   pnpm start                        — runtime worktree 稳定启动（由 runtime-worktree.sh 注入 --prod-web）
#   pnpm start:direct                 — 当前目录稳定启动（package.json 注入 --prod-web + --profile=opensource + 非 watch API + 优先当前 .env 端口）
#   pnpm dev:direct                   — 当前目录开发模式 (next dev + 热重载，package.json 注入 --profile=opensource)
#
# 直接调用脚本:
#   ./scripts/start-dev.sh            — 开发模式 (next dev + Redis 持久化)
#   ./scripts/start-dev.sh --prod-web — 前端 production build + next start
#   ./scripts/start-dev.sh --quick    — 仅跳过重复构建；不改变 dev/prod 模式
#   ./scripts/start-dev.sh --memory   — 使用内存存储 (重启丢数据)
#   ./scripts/start-dev.sh --no-redis — 同 --memory
#   ./scripts/start-dev.sh --daemon   — 后台运行 (日志输出到 cat-cafe-daemon.log)
#   ./scripts/start-dev.sh --stop     — 停止后台 daemon
#   ./scripts/start-dev.sh --status   — 查看 daemon 状态
#   ./scripts/start-dev.sh --profile=dev          — 家里开发默认值 (proxy ON, sidecar ON)
#   ./scripts/start-dev.sh --profile=production   — 日常生产 (proxy OFF, sidecar OFF, TTL=永久)
#   ./scripts/start-dev.sh --profile=opensource   — 开源演示 (proxy OFF, sidecar OFF, TTL=永久)
#   ./scripts/start-dev.sh -- --npm-registry=URL --pip-index-url=URL --hf-endpoint=URL
#                                               — 显式指定安装/模型下载镜像（仅手动 override）
#
# Profile 说明:
#   dev        — proxy ON, ASR/TTS/LLM ON, TTL=永久, redis-dev
#   production — proxy OFF, ASR/TTS/LLM OFF, TTL=永久, redis-opensource (日常生产)
#   opensource — proxy OFF, ASR/TTS/LLM OFF, TTL=永久, redis-opensource (开源演示)
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
# Parallel 本地实例若仅改 REDIS_PORT，默认会自动隔离到独立目录:
#   REDIS_PORT=6389 -> ~/.cat-cafe/redis-dev-6389

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
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
DEBUG_MODE=false
PROFILE=""
DAEMON_MODE=false
for arg in "$@"; do
    case $arg in
        --quick|-q) QUICK_MODE=true ;;
        --memory|--no-redis) USE_REDIS=false ;;
        --prod-web) PROD_WEB=true ;;
        --debug) DEBUG_MODE=true ;;
        --profile=*) PROFILE="${arg#*=}" ;;
        --daemon|-d) DAEMON_MODE=true ;;
        *)
            parse_manual_download_source_arg "$arg" || true
            ;;
    esac
done

# 加载环境变量 (放最前面，后续函数需要端口号)
# 默认读取 .env；.env.local 仅用于 DARE 相关白名单键，避免全量覆盖引发配置漂移。
CLI_FRONTEND_PORT_OVERRIDE="${FRONTEND_PORT-}"
CLI_API_SERVER_PORT_OVERRIDE="${API_SERVER_PORT-}"
CLI_REDIS_PORT_OVERRIDE="${REDIS_PORT-}"
CLI_REDIS_DATA_DIR_OVERRIDE="${REDIS_DATA_DIR-}"
CLI_REDIS_BACKUP_DIR_OVERRIDE="${REDIS_BACKUP_DIR-}"
CLI_NEXT_PUBLIC_API_URL_OVERRIDE="${NEXT_PUBLIC_API_URL-}"
CLI_PREVIEW_GATEWAY_PORT_OVERRIDE="${PREVIEW_GATEWAY_PORT-}"
CLI_ANTHROPIC_PROXY_PORT_OVERRIDE="${ANTHROPIC_PROXY_PORT-}"
CLI_WHISPER_PORT_OVERRIDE="${WHISPER_PORT-}"
CLI_TTS_PORT_OVERRIDE="${TTS_PORT-}"
CLI_LLM_POSTPROCESS_PORT_OVERRIDE="${LLM_POSTPROCESS_PORT-}"
PREFER_DOTENV_PORTS="${CAT_CAFE_RESPECT_DOTENV_PORTS:-0}"

clear_inherited_profile_env() {
    [ "${CAT_CAFE_STRICT_PROFILE_DEFAULTS:-0}" = "1" ] || return 0
    [ -n "$PROFILE" ] || return 0

    # Public direct-launch wrappers should honor the requested profile rather
    # than ambient Cat Cafe shell exports leaked from another checkout.
    unset ANTHROPIC_PROXY_ENABLED ASR_ENABLED TTS_ENABLED LLM_POSTPROCESS_ENABLED EMBED_ENABLED
    unset MESSAGE_TTL_SECONDS THREAD_TTL_SECONDS TASK_TTL_SECONDS SUMMARY_TTL_SECONDS
    unset REDIS_PROFILE
}

clear_inherited_profile_env

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

restore_cli_override() {
    local name="$1"
    local value="$2"
    [ -n "$value" ] || return 0
    export "$name=$value"
}

if [ "$PREFER_DOTENV_PORTS" != "1" ]; then
    restore_cli_override "FRONTEND_PORT" "$CLI_FRONTEND_PORT_OVERRIDE"
    restore_cli_override "API_SERVER_PORT" "$CLI_API_SERVER_PORT_OVERRIDE"
    restore_cli_override "REDIS_PORT" "$CLI_REDIS_PORT_OVERRIDE"
    restore_cli_override "REDIS_DATA_DIR" "$CLI_REDIS_DATA_DIR_OVERRIDE"
    restore_cli_override "REDIS_BACKUP_DIR" "$CLI_REDIS_BACKUP_DIR_OVERRIDE"
    restore_cli_override "NEXT_PUBLIC_API_URL" "$CLI_NEXT_PUBLIC_API_URL_OVERRIDE"
    restore_cli_override "PREVIEW_GATEWAY_PORT" "$CLI_PREVIEW_GATEWAY_PORT_OVERRIDE"
    restore_cli_override "ANTHROPIC_PROXY_PORT" "$CLI_ANTHROPIC_PROXY_PORT_OVERRIDE"
    restore_cli_override "WHISPER_PORT" "$CLI_WHISPER_PORT_OVERRIDE"
    restore_cli_override "TTS_PORT" "$CLI_TTS_PORT_OVERRIDE"
    restore_cli_override "LLM_POSTPROCESS_PORT" "$CLI_LLM_POSTPROCESS_PORT_OVERRIDE"
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
apply_manual_download_source_overrides

default_redis_port() {
    if [ "$PROD_WEB" = true ]; then
        echo "6399"
    else
        echo "6398"
    fi
}

normalize_raw_dev_redis_defaults() {
    [ "$USE_REDIS" = true ] || return 0
    [ "$PROD_WEB" = false ] || return 0
    [ "$PREFER_DOTENV_PORTS" = "1" ] && return 0
    [ -n "$CLI_REDIS_PORT_OVERRIDE" ] && return 0
    [ "${REDIS_PORT:-}" = "6399" ] || return 0

    REDIS_PORT="6398"
    case "${REDIS_URL:-}" in
        ""|"redis://localhost:6399"|"redis://127.0.0.1:6399")
            REDIS_URL="redis://localhost:6398"
            ;;
    esac
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
        production)
            _PROF_ANTHROPIC_PROXY_ENABLED=0
            _PROF_ASR_ENABLED=0
            _PROF_TTS_ENABLED=0
            _PROF_LLM_POSTPROCESS_ENABLED=0
            _PROF_MESSAGE_TTL_SECONDS=0
            _PROF_THREAD_TTL_SECONDS=0
            _PROF_TASK_TTL_SECONDS=0
            _PROF_SUMMARY_TTL_SECONDS=0
            _PROF_REDIS_PROFILE=opensource
            ;;
        opensource)
            _PROF_ANTHROPIC_PROXY_ENABLED=0
            _PROF_ASR_ENABLED=0
            _PROF_TTS_ENABLED=0
            _PROF_LLM_POSTPROCESS_ENABLED=0
            _PROF_MESSAGE_TTL_SECONDS=0
            _PROF_THREAD_TTL_SECONDS=0
            _PROF_TASK_TTL_SECONDS=0
            _PROF_SUMMARY_TTL_SECONDS=0
            _PROF_REDIS_PROFILE=opensource
            ;;
        "")
            # No profile — all _PROF_ vars stay unset, existing behavior preserved
            ;;
        *)
            echo -e "${RED}ERROR: Unknown profile '$profile'. Valid: dev, production, opensource${NC}"
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
normalize_raw_dev_redis_defaults

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

default_redis_storage_key() {
    local profile="${1:-$REDIS_PROFILE}"
    local port="${2:-$REDIS_PORT}"
    local default_port="${3:-6399}"
    if [ "$port" = "$default_port" ]; then
        printf '%s' "$profile"
    else
        printf '%s-%s' "$profile" "$port"
    fi
}

default_redis_data_dir() {
    local key
    key=$(default_redis_storage_key "${1:-$REDIS_PROFILE}" "${2:-$REDIS_PORT}")
    printf '%s/.cat-cafe/redis-%s' "$HOME" "$key"
}

default_redis_backup_dir() {
    local key
    key=$(default_redis_storage_key "${1:-$REDIS_PROFILE}" "${2:-$REDIS_PORT}")
    printf '%s/.cat-cafe/redis-backups/%s' "$HOME" "$key"
}

REDIS_STORAGE_KEY=$(default_redis_storage_key "$REDIS_PROFILE" "$REDIS_PORT")
if [ -n "$CLI_REDIS_DATA_DIR_OVERRIDE" ]; then
    REDIS_DATA_DIR="$CLI_REDIS_DATA_DIR_OVERRIDE"
elif [ -n "$CLI_REDIS_PORT_OVERRIDE" ]; then
    REDIS_DATA_DIR="$(default_redis_data_dir "$REDIS_PROFILE" "$REDIS_PORT")"
else
    REDIS_DATA_DIR=${REDIS_DATA_DIR:-"$(default_redis_data_dir "$REDIS_PROFILE" "$REDIS_PORT")"}
fi

if [ -n "$CLI_REDIS_BACKUP_DIR_OVERRIDE" ]; then
    REDIS_BACKUP_DIR="$CLI_REDIS_BACKUP_DIR_OVERRIDE"
elif [ -n "$CLI_REDIS_PORT_OVERRIDE" ]; then
    REDIS_BACKUP_DIR="$(default_redis_backup_dir "$REDIS_PROFILE" "$REDIS_PORT")"
else
    REDIS_BACKUP_DIR=${REDIS_BACKUP_DIR:-"$(default_redis_backup_dir "$REDIS_PROFILE" "$REDIS_PORT")"}
fi
REDIS_DBFILE=${REDIS_DBFILE:-dump.rdb}
REDIS_PIDFILE="${REDIS_DATA_DIR}/redis-${REDIS_PORT}.pid"
REDIS_LOGFILE="${REDIS_DATA_DIR}/redis-${REDIS_PORT}.log"
STARTED_REDIS=false
CLEANUP_RUNNING=false
MANAGED_PIDS=()
DAEMON_STATE_DIR="${HOME}/.cat-cafe"
DAEMON_PID_FILE="${DAEMON_STATE_DIR}/daemon.pid"
DAEMON_LOG_PATH_FILE="${DAEMON_STATE_DIR}/daemon.log-path"
DAEMON_LOG_FILE="${PROJECT_DIR}/cat-cafe-daemon.log"

export MESSAGE_TTL_SECONDS THREAD_TTL_SECONDS TASK_TTL_SECONDS SUMMARY_TTL_SECONDS

register_managed_pid() {
    local pid="${1:-}"
    local existing
    [ -n "$pid" ] || return 0
    for existing in "${MANAGED_PIDS[@]}"; do
        [ "$existing" = "$pid" ] && return 0
    done
    MANAGED_PIDS+=("$pid")
}

probe_port_with_lsof() {
    local port=$1
    lsof -nP -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1
}

probe_port_with_ss() {
    local port=$1
    ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR > 1 { found = 1; exit } END { exit found ? 0 : 1 }'
}

probe_port_with_nc() {
    local port=$1
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z localhost "$port" >/dev/null 2>&1
}

probe_port_with_dev_tcp() {
    local port=$1
    # Bash-only: requires net redirections support (enabled in most mainstream builds).
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 || (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1
}

port_listen_pids() {
    local port=$1
    local pids=""

    if command -v lsof >/dev/null 2>&1; then
        pids=$(lsof -nP -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
        if [ -n "$pids" ]; then
            printf '%s\n' "$pids"
            return 0
        fi
    fi

    if command -v ss >/dev/null 2>&1; then
        pids=$(ss -ltnp "( sport = :$port )" 2>/dev/null | awk '
            {
                while (match($0, /pid=[0-9]+/)) {
                    print substr($0, RSTART + 4, RLENGTH - 4)
                    $0 = substr($0, RSTART + RLENGTH)
                }
            }
        ' | sort -u || true)
        if [ -n "$pids" ]; then
            printf '%s\n' "$pids"
            return 0
        fi
    fi

    if command -v fuser >/dev/null 2>&1; then
        pids=$(fuser -n tcp "$port" 2>&1 | sed 's#^[^:]*:##' | grep -oE '[0-9]+' | sort -u || true)
        if [ -n "$pids" ]; then
            printf '%s\n' "$pids"
            return 0
        fi
    fi

    return 1
}

pid_cwd() {
    local pid=$1
    local cwd=""

    if [ -L "/proc/$pid/cwd" ]; then
        cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    fi

    if [ -z "$cwd" ] && command -v lsof >/dev/null 2>&1; then
        cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/ {print substr($0, 2); exit }')
    fi

    [ -n "$cwd" ] || return 1
    printf '%s\n' "$cwd"
}

path_is_within_project() {
    local path="$1"
    case "$path" in
        "$PROJECT_DIR"|"$PROJECT_DIR"/*) return 0 ;;
        *) return 1 ;;
    esac
}

guard_port_kill_ownership() {
    local port="$1"
    local name="$2"
    local pids="$3"
    local pid cwd
    local foreign=()
    local entry

    while IFS= read -r pid; do
        [ -n "$pid" ] || continue
        cwd=$(pid_cwd "$pid" || true)
        if [ -n "$cwd" ] && path_is_within_project "$cwd"; then
            continue
        fi

        if [ -n "$cwd" ]; then
            foreign+=("${pid}:${cwd}")
        else
            foreign+=("${pid}:<unknown-cwd>")
        fi
    done <<< "$pids"

    [ "${#foreign[@]}" -eq 0 ] && return 0

    if [ "${CAT_CAFE_RUNTIME_RESTART_OK:-0}" = "1" ]; then
        echo -e "${YELLOW}  ⚠ 端口 $port ($name) 存在跨 worktree 占用；CAT_CAFE_RUNTIME_RESTART_OK=1，继续强制释放。${NC}"
        return 0
    fi

    echo -e "${RED}  ✗ 端口 $port ($name) 被跨 worktree 进程占用，已拒绝终止：${NC}"
    for entry in "${foreign[@]}"; do
        echo "    - $entry"
    done
    echo "  为避免误杀 runtime/alpha，请改用隔离端口（例如 3201/3202）或显式授权："
    echo "    CAT_CAFE_RUNTIME_RESTART_OK=1 pnpm dev:direct"
    return 1
}

port_is_listening() {
    local port=$1

    if command -v lsof >/dev/null 2>&1 && probe_port_with_lsof "$port"; then
        return 0
    fi
    if command -v ss >/dev/null 2>&1 && probe_port_with_ss "$port"; then
        return 0
    fi
    if command -v nc >/dev/null 2>&1 && probe_port_with_nc "$port"; then
        return 0
    fi
    if probe_port_with_dev_tcp "$port"; then
        return 0
    fi

    return 1
}

list_child_pids() {
    local pid=$1
    command -v pgrep >/dev/null 2>&1 || return 0
    pgrep -P "$pid" 2>/dev/null || true
}

terminate_pid_tree_with_signal() {
    local signal="$1"
    local pid="$2"
    local child

    [ -n "$pid" ] || return 0
    kill -0 "$pid" 2>/dev/null || return 0

    while IFS= read -r child; do
        [ -n "$child" ] || continue
        terminate_pid_tree_with_signal "$signal" "$child"
    done < <(list_child_pids "$pid")

    kill "-$signal" "$pid" 2>/dev/null || true
}

terminate_managed_pids() {
    local pid
    for pid in "${MANAGED_PIDS[@]}"; do
        terminate_pid_tree_with_signal TERM "$pid"
    done
    sleep 1
    for pid in "${MANAGED_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            terminate_pid_tree_with_signal KILL "$pid"
        fi
    done
    MANAGED_PIDS=()
}

# 杀掉占用端口的进程
kill_port() {
    local port=$1
    local name=$2
    local pids
    pids=$(port_listen_pids "$port" || true)
    if [ -n "$pids" ]; then
        guard_port_kill_ownership "$port" "$name" "$pids" || return 1
        echo -e "${YELLOW}  端口 $port ($name) 被占用，正在终止进程...${NC}"
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 1
        # 确认已死
        pids=$(port_listen_pids "$port" || true)
        if [ -n "$pids" ]; then
            echo -e "${YELLOW}  强制终止...${NC}"
            echo "$pids" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
        pids=$(port_listen_pids "$port" || true)
        if [ -n "$pids" ]; then
            echo -e "${RED}  ✗ 端口 $port 仍被占用，无法继续启动 $name${NC}"
            return 1
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
        [ "${ANTHROPIC_PROXY_ENABLED:-1}" != "0" ] && [ "${ANTHROPIC_PROXY_ENABLED:-1}" != "0" ] && kill_port ${ANTHROPIC_PROXY_PORT:-9877} "Proxy"
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
        if port_is_listening "$port"; then
            echo -e "${GREEN}  ✓ $name 已启动 (端口 $port, ${elapsed}s)${NC}"
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    echo -e "${RED}  ✗ $name 启动超时（端口 $port, ${max_wait}s 内未监听）${NC}"
    return 1
}

wait_for_port_or_exit() {
    local port=$1
    local name=$2
    local pid=$3
    local max_wait=${4:-15}
    local elapsed=0

    while [ $elapsed -lt $max_wait ]; do
        if port_is_listening "$port"; then
            echo -e "${GREEN}  ✓ $name 已启动 (端口 $port, ${elapsed}s)${NC}"
            return 0
        fi

        if ! kill -0 "$pid" 2>/dev/null; then
            echo -e "${RED}  ✗ $name 启动失败（进程已退出，端口 $port 未监听）${NC}"
            return 1
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
    background_eval_with_null_stdin "$launch_cmd"
    if wait_for_port "$port" "$name" "$timeout"; then
        eval "${state_var}=ready"
    else
        eval "${state_var}=failed"
    fi
}

# 后台 Node dev 进程（tsx watch / next dev）在 macOS + Node 25 下若继承 TTY stdin，
# 可能在读取 fd0 时抛出 `TTY.onStreamRead` EIO。统一把后台任务 stdin 切到 /dev/null。
background_eval_with_null_stdin() {
    local launch_cmd="$1"
    (
        exec </dev/null
        eval "$launch_cmd"
    ) &
    register_managed_pid "$!"
}

api_node_env() {
    # NODE_ENV is driven by launch mode (--prod-web), not by profile.
    # Profile controls data isolation (Redis, TTLs, sidecar features);
    # --prod-web controls whether the API runs in production or dev mode.
    # dev:direct may carry --profile=opensource but is still development.
    if [ "$PROD_WEB" = true ]; then
        printf '%s' 'production'
    else
        printf '%s' 'development'
    fi
}

api_launch_command() {
    local env_prefix="NODE_ENV=$(api_node_env) "
    if [ "$DEBUG_MODE" = true ]; then
        env_prefix="${env_prefix}LOG_LEVEL=debug "
    fi
    if [ "${CAT_CAFE_DIRECT_NO_WATCH:-0}" = "1" ]; then
        printf '%s' "cd packages/api && exec env ${env_prefix}pnpm run start"
    else
        printf '%s' "cd packages/api && exec env ${env_prefix}pnpm run dev"
    fi
}

frontend_launch_command() {
    if [ "$PROD_WEB" = true ]; then
        printf 'cd packages/web && PORT=%s exec pnpm exec next start -p %s -H 0.0.0.0' "$WEB_PORT" "$WEB_PORT"
    else
        printf 'cd packages/web && NEXT_IGNORE_INCORRECT_LOCKFILE=1 PORT=%s exec pnpm exec next dev -p %s' "$WEB_PORT" "$WEB_PORT"
    fi
}

# Sidecar summary: ready → 地址, failed → 报告, disabled → 静默
print_sidecar_summary_all() {
    local name state_var port state
    for entry in "ASR:_STATE_ASR:${ASR_PORT:-9876}" "TTS:_STATE_TTS:${TTS_PORT_VAL:-9879}" "LLM后修:_STATE_LLM_PP:${LLM_PP_PORT:-9878}" "Embedding:_STATE_EMBED:${EMBED_PORT:-9880}"; do
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

file_size_bytes() {
    local path="$1"
    [ -f "$path" ] || {
        echo "0"
        return 0
    }

    if stat -f '%z' "$path" >/dev/null 2>&1; then
        stat -f '%z' "$path"
        return 0
    fi

    if stat -c '%s' "$path" >/dev/null 2>&1; then
        stat -c '%s' "$path"
        return 0
    fi

    wc -c < "$path" | tr -d ' '
}

file_mtime_epoch() {
    local path="$1"
    [ -e "$path" ] || {
        echo "0"
        return 0
    }

    if stat -f '%m' "$path" >/dev/null 2>&1; then
        stat -f '%m' "$path"
        return 0
    fi

    if stat -c '%Y' "$path" >/dev/null 2>&1; then
        stat -c '%Y' "$path"
        return 0
    fi

    echo "0"
}

maybe_quarantine_stale_aof_dir() {
    [ "${CAT_CAFE_DISABLE_STALE_AOF_GUARD:-0}" = "1" ] && return 0

    local dump_path="$REDIS_DATA_DIR/$REDIS_DBFILE"
    local append_dir_name="${REDIS_APPEND_DIR:-appendonlydir}"
    local append_dir_path="$REDIS_DATA_DIR/$append_dir_name"

    [ -f "$dump_path" ] || return 0
    [ -d "$append_dir_path" ] || return 0

    local dump_size
    dump_size=$(file_size_bytes "$dump_path")
    # 小数据集不做自动隔离，避免误判。
    [ "${dump_size:-0}" -ge 1048576 ] || return 0

    local total_aof_size=0
    local latest_aof_mtime=0
    local aof_file_count=0
    local aof_incr_count=0
    local largest_base_size=0
    local file size mtime
    while IFS= read -r file; do
        [ -n "$file" ] || continue
        size=$(file_size_bytes "$file")
        mtime=$(file_mtime_epoch "$file")
        total_aof_size=$((total_aof_size + size))
        aof_file_count=$((aof_file_count + 1))
        [ "$mtime" -gt "$latest_aof_mtime" ] && latest_aof_mtime="$mtime"
        case "$(basename "$file")" in
            *.incr.aof) aof_incr_count=$((aof_incr_count + 1)) ;;
            *.base.rdb|*.base.aof)
                [ "$size" -gt "$largest_base_size" ] && largest_base_size="$size"
                ;;
        esac
    done < <(find "$append_dir_path" -type f -name 'appendonly.aof*' 2>/dev/null || true)

    [ "$aof_file_count" -gt 0 ] || return 0

    local stale_detected=false
    local ratio_threshold="${CAT_CAFE_STALE_AOF_RATIO_THRESHOLD:-100}"
    local base_ratio=0
    if [ "$largest_base_size" -gt 0 ]; then
        base_ratio=$((dump_size / largest_base_size))
        # 以 base 为准：dump 至少比 base 大 100 倍，视为明显脱节。
        [ "$base_ratio" -ge "$ratio_threshold" ] && stale_detected=true
    elif [ "$total_aof_size" -le 131072 ]; then
        # 没有 base 文件时仅在 AOF 总体极小才兜底触发。
        stale_detected=true
    fi

    [ "$stale_detected" = true ] || return 0

    local dump_mtime
    dump_mtime=$(file_mtime_epoch "$dump_path")
    [ "$dump_mtime" -gt 0 ] || return 0
    [ "$latest_aof_mtime" -gt 0 ] || return 0
    # dump 比 AOF 至少新 10 分钟，规避同一时段写入噪音。
    [ $((dump_mtime - latest_aof_mtime)) -ge 600 ] || return 0

    ensure_redis_dirs
    local stamp quarantine
    stamp=$(date '+%Y%m%d-%H%M%S')
    quarantine="$REDIS_BACKUP_DIR/stale-aof-${REDIS_STORAGE_KEY}-${stamp}"

    if mv "$append_dir_path" "$quarantine" 2>/dev/null; then
        echo -e "${YELLOW}  ⚠ 检测到可疑 stale AOF：已隔离 $append_dir_name → $quarantine${NC}"
        echo -e "${YELLOW}    条件: dump=${dump_size}B, aof=${total_aof_size}B, base=${largest_base_size}B, ratio=${base_ratio}x, incr=${aof_incr_count}, AOF 旧于 dump${NC}"
    else
        echo -e "${YELLOW}  ⚠ 检测到可疑 stale AOF，但隔离失败: $append_dir_path${NC}"
        echo -e "${YELLOW}    建议手动处理后重试，避免冷启动优先加载旧 AOF${NC}"
    fi
}

prune_redis_backups() {
    local keep="${1:-20}"
    local files=()
    while IFS= read -r f; do
        files+=("$f")
    done < <(ls -1t "$REDIS_BACKUP_DIR"/"${REDIS_STORAGE_KEY}"-*.rdb 2>/dev/null || true)

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
    local target="$REDIS_BACKUP_DIR/${REDIS_STORAGE_KEY}-${reason}-${stamp}.rdb"
    if cp -p "$source" "$target" 2>/dev/null || cp "$source" "$target" 2>/dev/null; then
        echo -e "${GREEN}  ✓ Redis 快照归档: $target${NC}"
    else
        echo -e "${YELLOW}  ⚠ Redis 快照归档失败，继续启动: $target${NC}"
        return 0
    fi
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
        maybe_quarantine_stale_aof_dir
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
    [ "$CLEANUP_RUNNING" = true ] && return 0
    CLEANUP_RUNNING=true

    echo ""
    echo "正在关闭服务..."

    local job_pid
    while IFS= read -r job_pid; do
        register_managed_pid "$job_pid"
    done <<< "$(jobs -p 2>/dev/null || true)"

    terminate_managed_pids

    # 关闭我们启动的专属 Redis (不影响其他 Redis 实例)
    if [ "$USE_REDIS" = true ] && [ "$STARTED_REDIS" = true ] && redis-cli -p "$REDIS_PORT" ping &> /dev/null 2>&1; then
        archive_redis_snapshot "pre-stop"
        redis-cli -p "$REDIS_PORT" shutdown save &> /dev/null || true
        echo "  Redis (端口 $REDIS_PORT) 已关闭"
    fi
    wait 2>/dev/null || true
    # Only remove PID file if we are the daemon that wrote it (avoid orphaning a parallel daemon)
    if [ -f "$DAEMON_PID_FILE" ] && [ "$(cat "$DAEMON_PID_FILE" 2>/dev/null)" = "$$" ]; then
        rm -f "$DAEMON_PID_FILE"
        rm -f "$DAEMON_LOG_PATH_FILE"
    fi
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

    # 2.5. 自动安装依赖（worktree 等场景 node_modules 可能不存在或不完整）
    if [ ! -x "$PROJECT_DIR/node_modules/.bin/tsc" ]; then
        echo ""
        echo -e "${YELLOW}检测到依赖不完整，自动安装...${NC}"
        run_logged_step "pnpm install" 5 pnpm install --frozen-lockfile
        echo -e "${GREEN}  ✓ 依赖安装完成${NC}"
    fi

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
            background_eval_with_null_stdin "ANTHROPIC_PROXY_PORT=$PROXY_PORT node scripts/anthropic-proxy.mjs --port $PROXY_PORT --upstreams \"$PROXY_UPSTREAMS\""
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
    _STATE_EMBED=disabled

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

    # Embedding Server (F102 记忆系统 — Qwen3-Embedding MLX GPU)
    if [ "${EMBED_ENABLED:-0}" = "1" ]; then
        if ! check_sidecar_dep "Embedding" "python3"; then
            _STATE_EMBED=failed
        elif [ -f "scripts/embed-server.sh" ]; then
            start_sidecar "Embedding" "_STATE_EMBED" "${EMBED_PORT:-9880}" "${EMBED_TIMEOUT:-30}" \
                "EMBED_PORT=${EMBED_PORT:-9880} bash scripts/embed-server.sh"
        else
            echo -e "${RED}  ✗ Embedding 已启用，但脚本未找到${NC}"
            echo "    请运行: ./scripts/setup.sh"
            _STATE_EMBED=failed
        fi
    fi

    API_LAUNCH_CMD="$(api_launch_command)"
    if [ "${CAT_CAFE_DIRECT_NO_WATCH:-0}" = "1" ]; then
        echo -e "${YELLOW}  ⚠ API 使用非 watch 模式 (CAT_CAFE_DIRECT_NO_WATCH=1)${NC}"
    fi

    # API Server
    echo "  启动 API Server (端口 $API_PORT)..."
    background_eval_with_null_stdin "$API_LAUNCH_CMD"
    API_PID=$!
    wait_for_port_or_exit "$API_PORT" "API Server" "$API_PID" 20 || exit 1

    # Frontend
    if [ "$PROD_WEB" = true ]; then
        # Production: next start (PWA + Tailscale 友好)
        echo "  启动 Frontend (端口 $WEB_PORT, production)..."
        if [ -d "packages/web/.next" ]; then
            background_eval_with_null_stdin "$(frontend_launch_command)"
        else
            echo -e "${RED}  ✗ .next 目录不存在，无法以 production 模式启动${NC}"
            echo -e "${RED}    请先不带 --quick 运行以执行 next build${NC}"
            exit 1
        fi
    else
        # Development: next dev (热重载)
        echo "  启动 Frontend (端口 $WEB_PORT, dev)..."
        background_eval_with_null_stdin "$(frontend_launch_command)"
    fi
    WEB_PID=$!
    wait_for_port_or_exit "$WEB_PORT" "Frontend" "$WEB_PID" 30 || exit 1

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
    print_manual_download_source_summary
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

if [[ "${1:-}" == "--stop" ]] || [[ "${1:-}" == "stop" ]] || \
   [[ "${1:-}" == "--status" ]] || [[ "${1:-}" == "status" ]]; then
    trap - EXIT INT TERM
fi

# --stop: 停止后台运行的 daemon
if [[ "${1:-}" == "--stop" ]] || [[ "${1:-}" == "stop" ]]; then
    if [ ! -f "$DAEMON_PID_FILE" ]; then
        echo "没有找到运行中的 daemon（$DAEMON_PID_FILE 不存在）"
        exit 1
    fi
    DAEMON_PID=$(cat "$DAEMON_PID_FILE")
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "正在停止 Cat Café daemon (PID: $DAEMON_PID)..."
        kill -TERM "$DAEMON_PID" 2>/dev/null || true
        for i in $(seq 1 15); do
            kill -0 "$DAEMON_PID" 2>/dev/null || break
            sleep 1
        done
        if kill -0 "$DAEMON_PID" 2>/dev/null; then
            echo "  进程未响应 TERM，发送 KILL..."
            kill -KILL "$DAEMON_PID" 2>/dev/null || true
        fi
        rm -f "$DAEMON_PID_FILE"
        rm -f "$DAEMON_LOG_PATH_FILE"
        echo "Cat Café daemon 已停止 🐾"
    else
        echo "Daemon 进程 (PID: $DAEMON_PID) 已不存在，清理 PID 文件"
        rm -f "$DAEMON_PID_FILE"
        rm -f "$DAEMON_LOG_PATH_FILE"
    fi
    exit 0
fi

if [[ "${1:-}" == "--status" ]] || [[ "${1:-}" == "status" ]]; then
    if [ ! -f "$DAEMON_PID_FILE" ]; then
        echo "Cat Café daemon 未运行（无 PID 文件）"
        exit 1
    fi
    DAEMON_PID=$(cat "$DAEMON_PID_FILE")
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
        REAL_LOG="$DAEMON_LOG_FILE"
        [ -f "$DAEMON_LOG_PATH_FILE" ] && REAL_LOG=$(cat "$DAEMON_LOG_PATH_FILE")
        echo -e "${GREEN}Cat Café daemon 运行中${NC} (PID: $DAEMON_PID)"
        [ -f "$REAL_LOG" ] && echo "  日志: $REAL_LOG"
        echo "  停止: pnpm stop  或  ./scripts/start-dev.sh --stop"
        echo "  查看日志: tail -f $REAL_LOG"
    else
        echo "Daemon 进程 (PID: $DAEMON_PID) 已不存在，清理 PID 文件"
        rm -f "$DAEMON_PID_FILE"
        exit 1
    fi
    exit 0
fi

if [ "$DAEMON_MODE" = true ]; then
    if [ -f "$DAEMON_PID_FILE" ]; then
        EXISTING_PID=$(cat "$DAEMON_PID_FILE")
        if kill -0 "$EXISTING_PID" 2>/dev/null; then
            echo -e "${RED}Cat Café daemon 已在运行 (PID: $EXISTING_PID)${NC}"
            echo "  停止: pnpm stop  或  ./scripts/start-dev.sh --stop"
            echo "  查看日志: tail -f $DAEMON_LOG_FILE"
            exit 1
        else
            rm -f "$DAEMON_PID_FILE"
        fi
    fi

    RESTART_ARGS=()
    for arg in "$@"; do
        case "$arg" in
            --daemon|-d) ;;
            *) RESTART_ARGS+=("$arg") ;;
        esac
    done

    mkdir -p "$DAEMON_STATE_DIR"
    echo "🐱 Cat Café 以后台模式启动..."
    echo "  日志输出: $DAEMON_LOG_FILE"
    nohup "$0" "${RESTART_ARGS[@]}" > "$DAEMON_LOG_FILE" 2>&1 &
    DAEMON_PID=$!
    disown "$DAEMON_PID"
    echo "$DAEMON_PID" > "$DAEMON_PID_FILE"
    echo "$DAEMON_LOG_FILE" > "$DAEMON_LOG_PATH_FILE"
    echo -e "${GREEN}  Daemon PID: $DAEMON_PID${NC}"
    echo ""
    echo "管理命令:"
    echo "  查看状态: pnpm start:status"
    echo "  查看日志: tail -f $DAEMON_LOG_FILE"
    echo "  停止服务: pnpm stop"
    trap - EXIT INT TERM
    exit 0
fi

main "$@"
