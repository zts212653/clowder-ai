#!/usr/bin/env bash
# F085 Hyperfocus Brake - PreToolUse Hook
# 检查 PostToolUse 设置的 pending_trigger 标志，弹出 "ask" 提醒铲屎官。
# "ask" 直接打断铲屎官（不依赖 AI 处理 systemMessage），每个触发周期只弹一次。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Drain stdin
cat > /dev/null &
INPUT_PID=$!

source "$SCRIPT_DIR/state.sh"

# 读取 pending_trigger
PENDING=$(get_field "pending_trigger")

if [[ -n "$PENDING" ]] && [[ "$PENDING" != "null" ]]; then
  LEVEL=$(echo "$PENDING" | jq -r '.level')
  MINS=$(echo "$PENDING" | jq -r '.minutes')
  NIGHT=$(is_night_mode)

  # 清除标志（这次弹完就不再弹，直到下个周期）
  set_field "pending_trigger" "null"

  # 夜间模式加重语气
  if [[ "$NIGHT" == "true" ]]; then
    MSG="🌙 [Hyperfocus Brake L${LEVEL} · 夜间模式] 铲屎官已连续工作 ${MINS} 分钟，现在是深夜了！请运行 /hyperfocus-brake 让猫猫们跟你说几句话。"
  else
    MSG="⏰ [Hyperfocus Brake L${LEVEL}] 铲屎官已连续工作 ${MINS} 分钟。请运行 /hyperfocus-brake 让猫猫们跟你说几句话。"
  fi

  wait $INPUT_PID 2>/dev/null || true
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"$MSG"}}
EOF
  exit 0
fi

wait $INPUT_PID 2>/dev/null || true
exit 0
