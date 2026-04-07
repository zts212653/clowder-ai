#!/usr/bin/env bash
# F085 Hyperfocus Brake - UserPromptSubmit Hook
# 铲屎官每次发消息时记录心跳，用于区分"人在干活"和"猫自己干活"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Drain stdin
cat > /dev/null &
INPUT_PID=$!

source "$SCRIPT_DIR/state.sh"
touch_user_heartbeat

wait $INPUT_PID 2>/dev/null || true
exit 0
