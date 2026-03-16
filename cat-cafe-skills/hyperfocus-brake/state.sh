#!/usr/bin/env bash
# F085 Hyperfocus Brake - State Management
# 状态文件读写函数，供 hook 和 skill 使用

set -euo pipefail

# 用户级状态文件（跨 session 共享，保护铲屎官而非猫猫 session）
# 5 分钟间隔检测已确保真正休息时不累加
_resolve_state_file() {
  STATE_FILE="${TMPDIR:-/tmp}/hyperfocus-brake-state-${USER:-default}.json"
}

# P1-2 安全：拒绝 symlink（防止 symlink clobber 攻击）
ensure_safe_state_file() {
  _resolve_state_file
  if [[ -L "$STATE_FILE" ]]; then
    rm -f "$STATE_FILE"  # 删除 symlink，不跟随
  fi
}

# 安全写入：先检查 symlink，再写入
safe_write_state() {
  ensure_safe_state_file
  cat > "$STATE_FILE"
}

# 初始化空状态
init_state() {
  ensure_safe_state_file
  cat > "$STATE_FILE" <<EOF
{
  "active_work_ms": 0,
  "last_activity_ts": 0,
  "session_started_ts": $(date +%s)000,
  "trigger_level": 0,
  "bypass_count": 0,
  "bypass_timestamps": [],
  "last_check_in_ts": 0,
  "dismiss_cooldown_ms": 1800000,
  "dismissed": false
}
EOF
}

# 读取整个状态
read_state() {
  _resolve_state_file
  if [[ ! -f "$STATE_FILE" ]]; then
    init_state >&2
  fi
  cat "$STATE_FILE"
}

# 读取单个字段
get_field() {
  local field="$1"
  read_state | jq -r "if .$field == null then empty else .$field end"
}

# 更新单个字段
set_field() {
  _resolve_state_file
  local field="$1"
  local value="$2"
  local current
  current=$(read_state)
  ensure_safe_state_file
  echo "$current" | jq ".$field = $value" > "$STATE_FILE"
}

# 记录活动时间戳（由 PostToolUse hook 调用）
record_activity() {
  local now_ms
  now_ms=$(date +%s)000

  local state
  state=$(read_state)

  local last_ts
  last_ts=$(echo "$state" | jq -r '.last_activity_ts')

  local active_ms
  active_ms=$(echo "$state" | jq -r '.active_work_ms')

  # 如果距离上次活动超过 5 分钟（300000ms），不累加（视为休息）
  local gap_ms=$((now_ms - last_ts))
  if [[ $gap_ms -lt 300000 ]] && [[ $last_ts -gt 0 ]]; then
    active_ms=$((active_ms + gap_ms))
  fi

  echo "$state" | jq \
    --argjson now "$now_ms" \
    --argjson active "$active_ms" \
    '.last_activity_ts = $now | .active_work_ms = $active' | safe_write_state

  # P1-3: Auto-reset dismissed after per-choice cooldown period
  # so the hook can fire again for the next check-in cycle
  local dismissed
  dismissed=$(get_field "dismissed")
  if [[ "$dismissed" == "true" ]]; then
    local last_checkin_ts
    last_checkin_ts=$(get_field "last_check_in_ts")
    if [[ -n "$last_checkin_ts" ]] && [[ "$last_checkin_ts" != "0" ]]; then
      local cooldown_ms
      cooldown_ms=$(get_field "dismiss_cooldown_ms")
      cooldown_ms="${cooldown_ms:-1800000}"  # fallback 30min for legacy state
      local elapsed=$((now_ms - last_checkin_ts))
      if [[ $elapsed -ge $cooldown_ms ]]; then
        set_field "dismissed" "false"
      fi
    fi
  fi

  echo "$active_ms"
}

# 检查是否应该触发提醒
# 返回值: 0=不触发, 1/2/3=对应的 L1/L2/L3 档位
should_trigger() {
  local threshold_ms="${1:-5400000}"  # 默认 90min = 5,400,000 ms
  local state
  state=$(read_state)

  local active_ms
  active_ms=$(echo "$state" | jq -r '.active_work_ms')

  local dismissed
  dismissed=$(echo "$state" | jq -r '.dismissed')

  local current_level
  current_level=$(echo "$state" | jq -r '.trigger_level')

  # 如果已经被用户处理过，不触发
  if [[ "$dismissed" == "true" ]]; then
    echo "0"
    return
  fi

  # 计算应该触发的档位
  if [[ $active_ms -ge $((threshold_ms * 3)) ]]; then
    echo "3"  # L3: 270min
  elif [[ $active_ms -ge $((threshold_ms * 2)) ]]; then
    echo "2"  # L2: 180min
  elif [[ $active_ms -ge $threshold_ms ]]; then
    echo "1"  # L1: 90min
  else
    echo "0"  # 未到阈值
  fi
}

# 记录 bypass
record_bypass() {
  _resolve_state_file
  local now_ms
  now_ms=$(date +%s)000

  local state
  state=$(read_state)

  # 清理 4 小时前的 bypass 记录
  local four_hours_ago=$((now_ms - 14400000))

  echo "$state" | jq \
    --argjson now "$now_ms" \
    --argjson cutoff "$four_hours_ago" \
    '.bypass_timestamps = [.bypass_timestamps[] | select(. > $cutoff)] + [$now] |
     .bypass_count = (.bypass_timestamps | length)' | safe_write_state

  # 返回当前 bypass 次数
  cat "$STATE_FILE" | jq -r '.bypass_count'
}

# 获取下次 bypass 冷却时间（分钟）
get_bypass_cooldown() {
  local count
  count=$(get_field "bypass_count")

  case "$count" in
    0|1) echo "30" ;;   # 第 1 次: 30min
    2)   echo "45" ;;   # 第 2 次: 45min
    *)   echo "-1" ;;   # 第 3 次+: 禁用
  esac
}

# 处理用户 check-in
handle_checkin() {
  local choice="$1"  # 1=rest, 2=wrap_up, 3=continue
  local now_ms
  now_ms=$(date +%s)000

  local state
  state=$(read_state)

  case "$choice" in
    1)  # 立刻休息 - 重置计时器 (5min cooldown)
      echo "$state" | jq \
        --argjson now "$now_ms" \
        '.active_work_ms = 0 | .dismissed = true | .last_check_in_ts = $now | .trigger_level = 0 | .dismiss_cooldown_ms = 300000' | safe_write_state
      ;;
    2)  # 收尾 10min - 设置短延迟后强制休息 (10min cooldown)
      echo "$state" | jq \
        --argjson now "$now_ms" \
        '.dismissed = true | .last_check_in_ts = $now | .dismiss_cooldown_ms = 600000' | safe_write_state
      ;;
    3)  # 继续 - 需要 bypass (动态 cooldown: 30→45→禁用)
      record_bypass
      # Re-read state after record_bypass wrote to STATE_FILE
      state=$(read_state)
      local cooldown_min
      cooldown_min=$(get_bypass_cooldown)
      if [[ "$cooldown_min" == "-1" ]]; then
        # Bypass 已禁用（第 3 次+），不 dismiss
        return
      fi
      local cooldown_ms=$((cooldown_min * 60000))
      echo "$state" | jq \
        --argjson now "$now_ms" \
        --argjson cd "$cooldown_ms" \
        '.dismissed = true | .last_check_in_ts = $now | .dismiss_cooldown_ms = $cd' | safe_write_state
      ;;
  esac
}

# 重置 dismissed 状态（用于新的检查周期）
reset_dismissed() {
  set_field "dismissed" "false"
}

# 判断是否是夜间模式 (23:00 - 06:00)
is_night_mode() {
  local hour
  hour=$(date +%-H)  # %-H 避免前导零被当成八进制
  if [[ $hour -ge 23 ]] || [[ $hour -lt 6 ]]; then
    echo "true"
  else
    echo "false"
  fi
}

# 如果直接运行脚本，显示用法
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-help}" in
    init)         init_state ;;
    read)         read_state ;;
    get)          get_field "${2:-active_work_ms}" ;;
    set)          set_field "$2" "$3" ;;
    record)       record_activity ;;
    trigger)      should_trigger "${2:-5400000}" ;;
    bypass)       record_bypass ;;
    cooldown)     get_bypass_cooldown ;;
    checkin)      handle_checkin "$2" ;;
    reset)        reset_dismissed ;;
    night)        is_night_mode ;;
    *)
      echo "Usage: $0 {init|read|get|set|record|trigger|bypass|cooldown|checkin|reset|night}"
      exit 1
      ;;
  esac
fi
