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

  # 清除标志 + 执行休息 check-in（计时器归零，防死循环）
  set_field "pending_trigger" "null"
  handle_checkin "1" 2>/dev/null

  # 不用 "ask" 弹窗（CLI only，猫猫咖啡里收不到）
  # 改用 systemMessage 让猫通过富文本 rich block 发 check-in card
  if [[ "$NIGHT" == "true" ]]; then
    MSG="[Hyperfocus Brake L${LEVEL}] 铲屎官已连续工作 ${MINS} 分钟，现在是深夜了！请立即用 cat_cafe_create_rich_block 发一张 check-in card 提醒铲屎官休息。计时器已重置。"
  else
    MSG="[Hyperfocus Brake L${LEVEL}] 铲屎官已连续工作 ${MINS} 分钟。请立即用 cat_cafe_create_rich_block 发一张 check-in card 提醒铲屎官休息。计时器已重置。"
  fi

  wait $INPUT_PID 2>/dev/null || true
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"systemMessage":"$MSG"}
EOF
  exit 0
fi

wait $INPUT_PID 2>/dev/null || true
exit 0
