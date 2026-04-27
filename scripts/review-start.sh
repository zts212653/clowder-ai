#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_WEB_PORT=3201
DEFAULT_API_PORT=3202
MAX_PORT_SCAN_PAIRS=60

WEB_PORT=""
API_PORT=""
DRY_RUN=0
EXTRA_ARGS=()

usage() {
    cat <<'EOF'
Usage:
  pnpm review:start [--web-port=<port>] [--api-port=<port>] [--dry-run] [-- <extra start-dev args>]

Defaults:
  web=3201, api=3202 (auto-advance in +2 pairs when occupied)
  profile=opensource (unless you pass --profile=...)
  storage=memory (--memory)

Safety:
  - Must run inside /tmp/cat-cafe-review/... (or /private/tmp/... on macOS) by default.
  - Refuses runtime/alpha reserved ports (3003/3004/3011/3012/4111).
EOF
}

port_is_reserved() {
    local port="$1"
    case "$port" in
        3003|3004|3011|3012|4111) return 0 ;;
        *) return 1 ;;
    esac
}

probe_port_with_lsof() {
    local port="$1"
    lsof -nP -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1
}

probe_port_with_ss() {
    local port="$1"
    ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR > 1 { found = 1; exit } END { exit found ? 0 : 1 }'
}

probe_port_with_nc() {
    local port="$1"
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 || nc -z localhost "$port" >/dev/null 2>&1
}

probe_port_with_dev_tcp() {
    local port="$1"
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 || (exec 3<>"/dev/tcp/localhost/$port") >/dev/null 2>&1
}

port_is_listening() {
    local port="$1"

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

validate_port() {
    local label="$1"
    local port="$2"

    [[ "$port" =~ ^[0-9]+$ ]] || {
        echo "✗ ${label} 不是数字端口: $port" >&2
        exit 1
    }
    [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || {
        echo "✗ ${label} 超出范围(1024-65535): $port" >&2
        exit 1
    }
    if port_is_reserved "$port"; then
        echo "✗ ${label} 命中 runtime/alpha 保留端口: $port" >&2
        exit 1
    fi
}

has_profile_arg() {
    local arg
    if [ "${#EXTRA_ARGS[@]}" -eq 0 ]; then
        return 1
    fi
    for arg in "${EXTRA_ARGS[@]}"; do
        case "$arg" in
            --profile=*) return 0 ;;
        esac
    done
    return 1
}

enforce_review_sandbox() {
    local pwd_real
    pwd_real="$(pwd -P)"
    case "$pwd_real" in
        /tmp/cat-cafe-review/*|/private/tmp/cat-cafe-review/*) return 0 ;;
    esac

    if [ "${CAT_CAFE_ALLOW_NON_SANDBOX_REVIEW:-0}" = "1" ]; then
        echo "⚠ 非 review 沙盒路径运行，因 CAT_CAFE_ALLOW_NON_SANDBOX_REVIEW=1 放行: $pwd_real"
        return 0
    fi

    echo "✗ review:start 只允许在 review 沙盒运行：" >&2
    echo "  /tmp/cat-cafe-review/{review-target-id}/{reviewer-handle}" >&2
    echo "  /private/tmp/cat-cafe-review/{review-target-id}/{reviewer-handle} (macOS realpath)" >&2
    echo "  当前目录: $pwd_real" >&2
    echo "  如需临时绕过: CAT_CAFE_ALLOW_NON_SANDBOX_REVIEW=1 pnpm review:start" >&2
    exit 1
}

pick_port_pair() {
    local i web api
    for ((i=0; i<MAX_PORT_SCAN_PAIRS; i++)); do
        web=$((DEFAULT_WEB_PORT + i * 2))
        api=$((DEFAULT_API_PORT + i * 2))
        if port_is_reserved "$web" || port_is_reserved "$api"; then
            continue
        fi
        if port_is_listening "$web" || port_is_listening "$api"; then
            continue
        fi
        WEB_PORT="$web"
        API_PORT="$api"
        return 0
    done
    return 1
}

for arg in "$@"; do
    case "$arg" in
        --web-port=*)
            WEB_PORT="${arg#*=}"
            ;;
        --api-port=*)
            API_PORT="${arg#*=}"
            ;;
        --dry-run)
            DRY_RUN=1
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            EXTRA_ARGS+=("$arg")
            ;;
    esac
done

enforce_review_sandbox

if [ -n "$WEB_PORT" ]; then
    validate_port "web port" "$WEB_PORT"
fi
if [ -n "$API_PORT" ]; then
    validate_port "api port" "$API_PORT"
fi

if [ -z "$WEB_PORT" ] && [ -z "$API_PORT" ]; then
    pick_port_pair || {
        echo "✗ 未找到可用 review 端口对（起点 ${DEFAULT_WEB_PORT}/${DEFAULT_API_PORT}，扫描 ${MAX_PORT_SCAN_PAIRS} 组）" >&2
        exit 1
    }
elif [ -z "$WEB_PORT" ] || [ -z "$API_PORT" ]; then
    echo "✗ --web-port 与 --api-port 需要成对提供" >&2
    exit 1
else
    if port_is_listening "$WEB_PORT"; then
        echo "✗ web port 已被占用: $WEB_PORT" >&2
        exit 1
    fi
    if port_is_listening "$API_PORT"; then
        echo "✗ api port 已被占用: $API_PORT" >&2
        exit 1
    fi
fi

if [ "$WEB_PORT" = "$API_PORT" ]; then
    echo "✗ web/api 端口不能相同: $WEB_PORT" >&2
    exit 1
fi

if ! has_profile_arg; then
    if [ "${#EXTRA_ARGS[@]}" -eq 0 ]; then
        EXTRA_ARGS=(--profile=opensource)
    else
        EXTRA_ARGS=(--profile=opensource "${EXTRA_ARGS[@]}")
    fi
fi

echo "🐱 Review 沙盒启动"
echo "  project:  $PROJECT_DIR"
echo "  cwd:      $(pwd -P)"
echo "  web port: $WEB_PORT"
echo "  api port: $API_PORT"
echo "  api url:  http://localhost:$API_PORT"
echo "  mode:     --memory"

if [ "$DRY_RUN" = "1" ]; then
    echo "  dry-run:  true (未实际启动)"
    exit 0
fi

cd "$PROJECT_DIR"
# Review sandboxes should not inherit local sidecar/proxy toggles from .env or shell.
# Keep the default deterministic for reviewers, while still allowing explicit overrides.
FRONTEND_PORT="$WEB_PORT" \
API_SERVER_PORT="$API_PORT" \
NEXT_PUBLIC_API_URL="http://localhost:$API_PORT" \
PREVIEW_GATEWAY_PORT=0 \
CAT_CAFE_RESPECT_DOTENV_PORTS=0 \
ANTHROPIC_PROXY_ENABLED=0 \
ASR_ENABLED=0 \
TTS_ENABLED=0 \
LLM_POSTPROCESS_ENABLED=0 \
EMBED_ENABLED=0 \
bash ./scripts/start-dev.sh --memory "${EXTRA_ARGS[@]}"
