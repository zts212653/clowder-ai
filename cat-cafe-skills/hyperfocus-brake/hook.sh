#!/usr/bin/env bash
# F085 Hyperfocus Brake - PostToolUse Hook
# 每次工具调用后记录活跃时间，到阈值设 pending_trigger 标志。
# 实际提醒由 PreToolUse hook (pretool-brake-check.sh) 通过 "ask" 弹出。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 从 stdin 读取 JSON 输入（必须 drain）
cat > /dev/null &
INPUT_PID=$!

# 引入状态管理函数（用户级状态文件，跨 session 共享）
source "$SCRIPT_DIR/state.sh"

# 检查铲屎官是否活跃（15 分钟内有 user message）
# 铲屎官睡着了猫还在干活 → 不应该累计时间
if ! is_human_active; then
  wait $INPUT_PID 2>/dev/null || true
  exit 0
fi

# 记录这次活动
ACTIVE_MS=$(record_activity)

# 检查是否应该触发（默认 90min = 5,400,000ms）
THRESHOLD_MS="${HYPERFOCUS_THRESHOLD_MS:-5400000}"
LEVEL=$(should_trigger "$THRESHOLD_MS")

if [[ "$LEVEL" != "0" ]]; then
  # 设置 pending_trigger 标志，由 PreToolUse hook 消费
  WORK_MINS=$((ACTIVE_MS / 60000))
  set_field "pending_trigger" "{\"level\":$LEVEL,\"minutes\":$WORK_MINS}"
fi

wait $INPUT_PID 2>/dev/null || true
exit 0
