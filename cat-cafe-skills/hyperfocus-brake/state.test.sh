#!/usr/bin/env bash
# F085 Hyperfocus Brake - State Management Tests
# TDD: Red → Green → Refactor

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_SCRIPT="$SCRIPT_DIR/state.sh"

# 测试辅助函数
setup() {
  export TMPDIR="${TMPDIR:-/tmp}/hyperfocus-test-$$"
  mkdir -p "$TMPDIR"
  # 每个测试前清理状态
  rm -f "$TMPDIR/hyperfocus-brake-state.json"
}

teardown() {
  rm -rf "$TMPDIR"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local msg="${3:-assertion failed}"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $msg"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    return 1
  fi
}

# Test 1: init 创建有效的 JSON 状态文件
test_init_creates_valid_state() {
  setup
  source "$STATE_SCRIPT"
  init_state

  local state
  state=$(cat "$STATE_FILE")

  # 验证必要字段存在
  assert_eq "0" "$(echo "$state" | jq -r '.active_work_ms')" "active_work_ms should be 0"
  assert_eq "0" "$(echo "$state" | jq -r '.trigger_level')" "trigger_level should be 0"
  assert_eq "0" "$(echo "$state" | jq -r '.bypass_count')" "bypass_count should be 0"
  assert_eq "false" "$(echo "$state" | jq -r '.dismissed')" "dismissed should be false"

  echo "✓ test_init_creates_valid_state"
  teardown
}

# Test 2: record_activity 累加活跃时间
test_record_activity_accumulates_time() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 模拟第一次活动
  set_field "last_activity_ts" "$(($(date +%s) - 60))000"  # 60秒前

  local result
  result=$(record_activity)

  # 应该累加了约 60 秒（60000ms）的时间
  # 由于时间差可能有几毫秒误差，检查是否在合理范围内
  if [[ $result -lt 59000 ]] || [[ $result -gt 61000 ]]; then
    echo "FAIL: active_work_ms should be ~60000, got $result"
    teardown
    return 1
  fi

  echo "✓ test_record_activity_accumulates_time"
  teardown
}

# Test 3: 超过 5 分钟不活动不累加
test_gap_over_5min_resets() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置 10 分钟前的活动
  set_field "last_activity_ts" "$(($(date +%s) - 600))000"
  set_field "active_work_ms" "1000000"  # 已有 1000 秒

  local result
  result=$(record_activity)

  # 由于超过 5 分钟，不应该累加
  assert_eq "1000000" "$result" "should not accumulate after 5min gap"

  echo "✓ test_gap_over_5min_resets"
  teardown
}

# Test 4: should_trigger 在阈值前返回 0
test_should_trigger_before_threshold() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置 80 分钟的活跃时间
  set_field "active_work_ms" "4800000"  # 80min

  local result
  result=$(should_trigger 5400000)  # 90min 阈值

  assert_eq "0" "$result" "should not trigger before 90min"

  echo "✓ test_should_trigger_before_threshold"
  teardown
}

# Test 5: should_trigger 在 90min 返回 L1
test_should_trigger_l1_at_90min() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置 95 分钟的活跃时间
  set_field "active_work_ms" "5700000"  # 95min

  local result
  result=$(should_trigger 5400000)

  assert_eq "1" "$result" "should trigger L1 at 95min"

  echo "✓ test_should_trigger_l1_at_90min"
  teardown
}

# Test 6: should_trigger 在 180min 返回 L2
test_should_trigger_l2_at_180min() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "11000000"  # ~183min

  local result
  result=$(should_trigger 5400000)

  assert_eq "2" "$result" "should trigger L2 at 180min+"

  echo "✓ test_should_trigger_l2_at_180min"
  teardown
}

# Test 7: bypass 冷却时间递增
test_bypass_cooldown_escalation() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 初始状态: 30min
  local cd1
  cd1=$(get_bypass_cooldown)
  assert_eq "30" "$cd1" "first bypass should have 30min cooldown"

  # 记录一次 bypass
  record_bypass > /dev/null
  local cd2
  cd2=$(get_bypass_cooldown)
  assert_eq "30" "$cd2" "after 1 bypass should still be 30min"

  # 记录第二次 bypass
  record_bypass > /dev/null
  local cd3
  cd3=$(get_bypass_cooldown)
  assert_eq "45" "$cd3" "after 2 bypasses should be 45min"

  # 记录第三次 bypass
  record_bypass > /dev/null
  local cd4
  cd4=$(get_bypass_cooldown)
  assert_eq "-1" "$cd4" "after 3 bypasses should be disabled (-1)"

  echo "✓ test_bypass_cooldown_escalation"
  teardown
}

# Test 8: checkin 选项 1 重置计时器
test_checkin_rest_resets_timer() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "6000000"  # 100min
  set_field "trigger_level" "1"

  handle_checkin "1"

  local active
  active=$(get_field "active_work_ms")
  assert_eq "0" "$active" "rest should reset active_work_ms to 0"

  local dismissed
  dismissed=$(get_field "dismissed")
  assert_eq "true" "$dismissed" "rest should set dismissed to true"

  echo "✓ test_checkin_rest_resets_timer"
  teardown
}

# Test 9: handle_checkin 3 preserves bypass count (P1-1 regression)
test_checkin_bypass_preserves_count() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "6000000"  # 100min

  # checkin=3 should record a bypass AND set dismissed
  handle_checkin "3"

  local bypass_count
  bypass_count=$(get_field "bypass_count")
  if ! assert_eq "1" "$bypass_count" "handle_checkin 3 should preserve bypass_count=1"; then
    teardown; return 1
  fi

  echo "✓ test_checkin_bypass_preserves_count"
  teardown
}

# Test 10: state file rejects symlinks (P1-2 security)
test_state_file_rejects_symlink() {
  setup
  source "$STATE_SCRIPT"

  # Create a symlink pointing to a sensitive file
  local target_file="$TMPDIR/symlink-target.txt"
  echo "original content" > "$target_file"
  rm -f "$STATE_FILE"
  ln -s "$target_file" "$STATE_FILE"

  # init_state should detect the symlink and refuse to write
  # (or use O_NOFOLLOW equivalent)
  init_state 2>/dev/null

  local target_content
  target_content=$(cat "$target_file" 2>/dev/null)
  if [[ "$target_content" != "original content" ]]; then
    echo "FAIL: init_state followed symlink and overwrote target file"
    echo "  target now: $target_content"
    teardown
    return 1
  fi

  echo "✓ test_state_file_rejects_symlink"
  teardown
}

# Test 11: dismissed resets after cooldown period (P1-3 regression)
test_dismissed_resets_after_cooldown() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "6000000"  # 100min

  # Check-in → dismissed
  handle_checkin "1"
  local dismissed
  dismissed=$(get_field "dismissed")
  assert_eq "true" "$dismissed" "should be dismissed after check-in"

  # Simulate time passing: set last_check_in_ts to 35min ago
  # (default bypass cooldown is 30min)
  local old_ts=$(( ($(date +%s) - 2100) ))000  # 35 min ago
  set_field "last_check_in_ts" "$old_ts"

  # After enough time, record_activity should clear dismissed
  # so should_trigger can fire again
  set_field "active_work_ms" "6000000"  # still over threshold
  set_field "last_activity_ts" "$(($(date +%s) - 30))000"  # 30s ago (within 5min gap)
  record_activity > /dev/null

  dismissed=$(get_field "dismissed")
  if ! assert_eq "false" "$dismissed" "dismissed should reset after cooldown period"; then
    teardown; return 1
  fi

  echo "✓ test_dismissed_resets_after_cooldown"
  teardown
}

# Test 12: checkin choice 2 (wrap-up) uses 10min cooldown, not 30min (R2 P1-3)
test_wrap_up_uses_10min_cooldown() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "6000000"  # 100min

  # Wrap-up (10min)
  handle_checkin "2"
  local dismissed
  dismissed=$(get_field "dismissed")
  assert_eq "true" "$dismissed" "should be dismissed after wrap-up"

  # Simulate 11 minutes passing (> 10min wrap-up cooldown)
  local old_ts=$(( ($(date +%s) - 660) ))000  # 11 min ago
  set_field "last_check_in_ts" "$old_ts"
  set_field "active_work_ms" "6000000"
  set_field "last_activity_ts" "$(($(date +%s) - 30))000"
  record_activity > /dev/null

  dismissed=$(get_field "dismissed")
  if ! assert_eq "false" "$dismissed" "wrap-up dismissed should reset after 10min, not 30min"; then
    teardown; return 1
  fi

  echo "✓ test_wrap_up_uses_10min_cooldown"
  teardown
}

# Test 13: cross-session sharing — different sessions share the same state file
# (protects the human, not the cat session)
test_cross_session_sharing() {
  setup
  source "$STATE_SCRIPT"

  init_state
  set_field "active_work_ms" "9000000"  # 150min

  # Re-source to simulate a new session — should see the same state
  source "$STATE_SCRIPT"
  local active
  active=$(get_field "active_work_ms")
  if ! assert_eq "9000000" "$active" "new session should see existing state (user-level sharing)"; then
    teardown; return 1
  fi

  echo "✓ test_cross_session_sharing"
  teardown
}

# Test 14: second bypass uses 45min cooldown, not 30min (R3 P1)
test_bypass_escalation_cooldown() {
  setup
  source "$STATE_SCRIPT"
  init_state
  set_field "active_work_ms" "6000000"

  # First bypass → bypass_count=1, cooldown should be 30min
  handle_checkin "3"
  local cd1
  cd1=$(get_field "dismiss_cooldown_ms")
  if ! assert_eq "1800000" "$cd1" "first bypass cooldown should be 30min (1800000)"; then
    teardown; return 1
  fi

  # Reset dismissed to simulate next trigger cycle
  set_field "dismissed" "false"
  set_field "active_work_ms" "6000000"

  # Second bypass → bypass_count=2, cooldown should be 45min
  handle_checkin "3"
  local cd2
  cd2=$(get_field "dismiss_cooldown_ms")
  if ! assert_eq "2700000" "$cd2" "second bypass cooldown should be 45min (2700000)"; then
    teardown; return 1
  fi

  # Reset and try third bypass → should be rejected (bypass disabled)
  set_field "dismissed" "false"
  set_field "active_work_ms" "6000000"
  handle_checkin "3"
  local dismissed3
  dismissed3=$(get_field "dismissed")
  if ! assert_eq "false" "$dismissed3" "third bypass should be rejected (bypass disabled)"; then
    teardown; return 1
  fi

  echo "✓ test_bypass_escalation_cooldown"
  teardown
}

# Test 15: touch_user_heartbeat 写入心跳
test_touch_user_heartbeat() {
  setup
  source "$STATE_SCRIPT"

  touch_user_heartbeat

  if [[ ! -f "$HEARTBEAT_FILE" ]]; then
    echo "FAIL: heartbeat file should exist after touch_user_heartbeat"
    teardown
    return 1
  fi

  local beat
  beat=$(cat "$HEARTBEAT_FILE")
  local now
  now=$(date +%s)
  local diff=$((now - beat))

  if [[ $diff -gt 2 ]]; then
    echo "FAIL: heartbeat should be within 2s of now, got diff=$diff"
    teardown
    return 1
  fi

  echo "✓ test_touch_user_heartbeat"
  teardown
}

# Test 16: is_human_active 返回 true（心跳新鲜）
test_is_human_active_recent() {
  setup
  source "$STATE_SCRIPT"

  touch_user_heartbeat

  if ! is_human_active; then
    echo "FAIL: should be active right after heartbeat"
    teardown
    return 1
  fi

  echo "✓ test_is_human_active_recent"
  teardown
}

# Test 17: is_human_active 返回 false（心跳过期）
test_is_human_active_stale() {
  setup
  source "$STATE_SCRIPT"

  _resolve_heartbeat_file
  # 写入 20 分钟前的时间戳
  echo $(($(date +%s) - 1200)) > "$HEARTBEAT_FILE"

  if is_human_active; then
    echo "FAIL: should NOT be active with 20min old heartbeat"
    teardown
    return 1
  fi

  echo "✓ test_is_human_active_stale"
  teardown
}

# Test 18: is_human_active 无心跳文件默认 true（首次运行）
test_is_human_active_no_file() {
  setup
  source "$STATE_SCRIPT"

  _resolve_heartbeat_file
  rm -f "$HEARTBEAT_FILE"

  if ! is_human_active; then
    echo "FAIL: should default to active when no heartbeat file exists"
    teardown
    return 1
  fi

  echo "✓ test_is_human_active_no_file"
  teardown
}

# Test 19: night_mode 检测
test_night_mode_detection() {
  setup
  source "$STATE_SCRIPT"

  local result
  result=$(is_night_mode)

  # 这个测试依赖于实际时间，只验证返回值是 true 或 false
  if [[ "$result" != "true" ]] && [[ "$result" != "false" ]]; then
    echo "FAIL: is_night_mode should return true or false, got: $result"
    teardown
    return 1
  fi

  echo "✓ test_night_mode_detection"
  teardown
}

# 运行所有测试
run_all_tests() {
  local failed=0

  test_init_creates_valid_state || ((failed++))
  test_record_activity_accumulates_time || ((failed++))
  test_gap_over_5min_resets || ((failed++))
  test_should_trigger_before_threshold || ((failed++))
  test_should_trigger_l1_at_90min || ((failed++))
  test_should_trigger_l2_at_180min || ((failed++))
  test_bypass_cooldown_escalation || ((failed++))
  test_checkin_rest_resets_timer || ((failed++))
  test_checkin_bypass_preserves_count || ((failed++))
  test_state_file_rejects_symlink || ((failed++))
  test_dismissed_resets_after_cooldown || ((failed++))
  test_wrap_up_uses_10min_cooldown || ((failed++))
  test_cross_session_sharing || ((failed++))
  test_bypass_escalation_cooldown || ((failed++))
  test_touch_user_heartbeat || ((failed++))
  test_is_human_active_recent || ((failed++))
  test_is_human_active_stale || ((failed++))
  test_is_human_active_no_file || ((failed++))
  test_night_mode_detection || ((failed++))

  echo ""
  if [[ $failed -eq 0 ]]; then
    echo "All tests passed! ✅"
  else
    echo "$failed test(s) failed ❌"
    exit 1
  fi
}

run_all_tests
