#!/bin/bash
# F115 Phase C: Drift Guard — detect port default inconsistencies
# Run: pnpm check:ports

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Canonical defaults (F115 KD-1/KD-2)
CANONICAL_API=3004
CANONICAL_FRONTEND=3003
CANONICAL_REDIS=6399

ERRORS=0

check_pattern() {
    local file="$1"
    local pattern="$2"
    local desc="$3"

    if [ ! -f "$file" ]; then
        echo "WARN: $file not found (skipped)"
        return
    fi

    if ! grep -qE "$pattern" "$file"; then
        echo "FAIL: $file — $desc"
        ERRORS=$((ERRORS + 1))
    fi
}

echo "F115 Drift Guard: checking port default consistency..."
echo "Canonical: API=$CANONICAL_API  Frontend=$CANONICAL_FRONTEND  Redis=$CANONICAL_REDIS"
echo ""

# --- Scripts ---
check_pattern "scripts/start-dev.sh" \
    "API_PORT=.*API_SERVER_PORT:-${CANONICAL_API}" \
    "API fallback should be ${CANONICAL_API}"

check_pattern "scripts/start-dev.sh" \
    "WEB_PORT=.*FRONTEND_PORT:-${CANONICAL_FRONTEND}" \
    "Frontend fallback should be ${CANONICAL_FRONTEND}"

check_pattern "scripts/start-dev.sh" \
    "REDIS_PORT=.*REDIS_PORT:-${CANONICAL_REDIS}" \
    "Redis fallback should be ${CANONICAL_REDIS}"

check_pattern "scripts/runtime-worktree.sh" \
    "API_SERVER_PORT:-${CANONICAL_API}" \
    "is_api_running guard should use ${CANONICAL_API}"

# --- .env.example ---
check_pattern ".env.example" \
    "^REDIS_PORT=${CANONICAL_REDIS}" \
    "REDIS_PORT should be ${CANONICAL_REDIS}"

check_pattern ".env.example" \
    "^API_SERVER_PORT=${CANONICAL_API}" \
    "API_SERVER_PORT should be ${CANONICAL_API}"

check_pattern ".env.example" \
    "^FRONTEND_PORT=${CANONICAL_FRONTEND}" \
    "FRONTEND_PORT should be ${CANONICAL_FRONTEND}"

# --- TypeScript source: scan for wrong port fallbacks ---
echo "Scanning TypeScript for stale port fallbacks..."

# Wrong API port fallbacks in key files (3002 or 3003 instead of 3004)
# Exclude FRONTEND_PORT lines — 3003 is the correct canonical frontend port
STALE_API=$(grep -rn "'3002'\|'3003'" \
    packages/api/src/index.ts \
    packages/api/src/config/ConfigRegistry.ts \
    packages/api/src/config/env-registry.ts \
    packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts \
    packages/mcp-server/src/constants.ts \
    packages/web/src/utils/api-client.ts \
    2>/dev/null | grep -v node_modules | grep -v '\.test\.' | grep -v '// ' \
    | grep -v 'FRONTEND_PORT' | grep -v 'FRONTEND_BASE_URL' \
    | grep -v "defaultValue: '${CANONICAL_FRONTEND}'" || true)

if [ -n "$STALE_API" ]; then
    echo "FAIL: Found stale API port references (should be ${CANONICAL_API}):"
    echo "$STALE_API" | head -20
    ERRORS=$((ERRORS + 1))
fi

# Wrong Redis port fallback (6379 instead of 6399) in source + config
STALE_REDIS=$(grep -rn "localhost:6379" \
    packages/shared/src/ \
    packages/api/src/ \
    scripts/setup.sh \
    .env.example \
    2>/dev/null | grep -v node_modules | grep -v '\.test\.' | grep -v '// ' || true)

if [ -n "$STALE_REDIS" ]; then
    echo "FAIL: Found stale Redis port references (should be ${CANONICAL_REDIS}):"
    echo "$STALE_REDIS" | head -20
    ERRORS=$((ERRORS + 1))
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
    echo "✓ All port defaults consistent"
    exit 0
else
    echo "✗ Found $ERRORS inconsistencies — see above"
    exit 1
fi
