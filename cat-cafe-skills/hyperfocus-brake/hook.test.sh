#!/usr/bin/env bash
# F085 Hyperfocus Brake - Hook Tests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$SCRIPT_DIR/hook.sh"
STATE_SCRIPT="$SCRIPT_DIR/state.sh"

# 测试辅助函数
setup() {
  export TMPDIR="${TMPDIR:-/tmp}/hyperfocus-hook-test-$$"
  mkdir -p "$TMPDIR"
  # P1-4: session isolation — mock_input uses session_id "test-session"
  export HYPERFOCUS_SESSION_ID="test-session"
  rm -f "$TMPDIR/hyperfocus-brake-state-test-session.json"
  # 设置较短的阈值方便测试 (1 分钟 = 60000ms)
  export HYPERFOCUS_THRESHOLD_MS=60000
}

teardown() {
  rm -rf "$TMPDIR"
  unset HYPERFOCUS_THRESHOLD_MS
  unset HYPERFOCUS_SESSION_ID
}

# 模拟 PostToolUse 输入
mock_input() {
  cat <<EOF
{
  "session_id": "test-session",
  "transcript_path": "/tmp/transcript.jsonl",
  "cwd": "$TMPDIR",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}
EOF
}

# Test 1: 低于阈值不触发
test_no_trigger_below_threshold() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置 30 秒的活跃时间（低于 60 秒阈值）
  set_field "active_work_ms" "30000"
  set_field "last_activity_ts" "$(($(date +%s) - 1))000"

  local output
  output=$(mock_input | "$HOOK_SCRIPT" 2>&1)

  # 不应该有输出
  if [[ -n "$output" ]]; then
    echo "FAIL: should not output anything below threshold"
    echo "  got: $output"
    teardown
    return 1
  fi

  echo "✓ test_no_trigger_below_threshold"
  teardown
}

# Test 2: 达到阈值触发 L1 — 写 pending_trigger 到 state 文件
test_trigger_l1_at_threshold() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置 70 秒的活跃时间（超过 60 秒阈值）
  set_field "active_work_ms" "70000"
  set_field "last_activity_ts" "$(($(date +%s) - 1))000"
  # 确保心跳新鲜（铲屎官在）
  touch_user_heartbeat

  mock_input | "$HOOK_SCRIPT" >/dev/null 2>&1

  # hook 应该在 state 文件里设置 pending_trigger
  local pending
  pending=$(get_field "pending_trigger")

  if [[ -z "$pending" ]] || [[ "$pending" == "null" ]]; then
    echo "FAIL: pending_trigger should be set in state file"
    teardown
    return 1
  fi

  local level
  level=$(echo "$pending" | jq -r '.level')
  if [[ "$level" != "1" ]]; then
    echo "FAIL: should be level 1, got $level"
    teardown
    return 1
  fi

  echo "✓ test_trigger_l1_at_threshold"
  teardown
}

# Test 3: dismissed 状态不触发
test_no_trigger_when_dismissed() {
  setup
  source "$STATE_SCRIPT"
  init_state

  # 设置超过阈值的时间但已经 dismissed
  set_field "active_work_ms" "70000"
  set_field "last_activity_ts" "$(($(date +%s) - 1))000"
  set_field "dismissed" "true"

  local output
  output=$(mock_input | "$HOOK_SCRIPT" 2>&1)

  if [[ -n "$output" ]]; then
    echo "FAIL: should not trigger when dismissed"
    echo "  got: $output"
    teardown
    return 1
  fi

  echo "✓ test_no_trigger_when_dismissed"
  teardown
}

# Test 4: hook 返回有效 JSON
test_output_is_valid_json() {
  setup
  source "$STATE_SCRIPT"
  init_state

  set_field "active_work_ms" "70000"
  set_field "last_activity_ts" "$(($(date +%s) - 1))000"

  local output
  output=$(mock_input | "$HOOK_SCRIPT" 2>&1)

  if ! echo "$output" | jq empty 2>/dev/null; then
    echo "FAIL: output should be valid JSON"
    echo "  got: $output"
    teardown
    return 1
  fi

  echo "✓ test_output_is_valid_json"
  teardown
}

# Test 5: hook 正常退出（exit 0）
test_hook_exits_zero() {
  setup
  source "$STATE_SCRIPT"
  init_state

  mock_input | "$HOOK_SCRIPT" >/dev/null 2>&1
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "FAIL: hook should exit 0, got $exit_code"
    teardown
    return 1
  fi

  echo "✓ test_hook_exits_zero"
  teardown
}

# 运行所有测试
run_all_tests() {
  local failed=0

  test_no_trigger_below_threshold || ((failed++))
  test_trigger_l1_at_threshold || ((failed++))
  test_no_trigger_when_dismissed || ((failed++))
  test_output_is_valid_json || ((failed++))
  test_hook_exits_zero || ((failed++))

  echo ""
  if [[ $failed -eq 0 ]]; then
    echo "All hook tests passed! ✅"
  else
    echo "$failed hook test(s) failed ❌"
    exit 1
  fi
}

run_all_tests
