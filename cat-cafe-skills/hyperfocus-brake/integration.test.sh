#!/usr/bin/env bash
# F085 Hyperfocus Brake - Integration Tests
# 端到端验证整个流程

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASSED=0
FAILED=0

run_test() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ((PASSED++)) || true
    echo "✓ $name"
  else
    ((FAILED++)) || true
    echo "✗ $name"
  fi
}

# 设置测试环境
setup() {
  export TMPDIR="${TMPDIR:-/tmp}/hyperfocus-integration-$$"
  mkdir -p "$TMPDIR"
  export HYPERFOCUS_THRESHOLD_MS=60000  # 1 分钟阈值便于测试
}

teardown() {
  rm -rf "$TMPDIR"
}

# Test 1: 所有脚本可执行
test_scripts_executable() {
  [[ -x "$SCRIPT_DIR/state.sh" ]] &&
  [[ -x "$SCRIPT_DIR/hook.sh" ]] &&
  [[ -x "$SCRIPT_DIR/sanitizer.sh" ]] &&
  [[ -x "$SCRIPT_DIR/messages.sh" ]]
}

# Test 2: SKILL.md 存在且有正确的 frontmatter
test_skill_frontmatter() {
  [[ -f "$SCRIPT_DIR/SKILL.md" ]] &&
  grep -q "^name: hyperfocus-brake" "$SCRIPT_DIR/SKILL.md" &&
  grep -q "^triggers:" "$SCRIPT_DIR/SKILL.md"
}

# Test 3: manifest.yaml 包含 skill 定义
test_manifest_entry() {
  grep -q "hyperfocus-brake:" "$SCRIPT_DIR/../manifest.yaml"
}

# Test 3b: settings.json 注册了 PostToolUse hook
test_settings_hook_registered() {
  local repo_root
  repo_root=$(cd "$SCRIPT_DIR/../.." && pwd)
  local settings="$repo_root/.claude/settings.json"
  [[ -f "$settings" ]] &&
  jq -e '.hooks.PostToolUse[] | select(.hooks[].command | contains("hyperfocus-brake"))' "$settings" > /dev/null 2>&1
}

# Test 3c: hook shim exists and is executable
test_hook_shim_executable() {
  local repo_root
  repo_root=$(cd "$SCRIPT_DIR/../.." && pwd)
  [[ -x "$repo_root/.claude/hooks/hyperfocus-brake-timer.sh" ]]
}

# Test 4: 完整流程：init → record → trigger → checkin
test_full_flow() {
  setup

  source "$SCRIPT_DIR/state.sh"
  init_state

  # 设置到达阈值的时间
  set_field "active_work_ms" "70000"
  set_field "last_activity_ts" "$(($(date +%s) - 1))000"

  # 触发检查
  local level
  level=$(should_trigger 60000)
  [[ "$level" == "1" ]] || return 1

  # Check-in 选择休息
  handle_checkin "1"

  # 验证重置
  local active
  active=$(get_field "active_work_ms")
  [[ "$active" == "0" ]] || return 1

  teardown
}

# Test 5: Bypass 递增冷却
test_bypass_escalation() {
  setup

  source "$SCRIPT_DIR/state.sh"
  init_state

  # 第一次 bypass: 30min
  local cd1
  cd1=$(get_bypass_cooldown)
  [[ "$cd1" == "30" ]] || return 1

  record_bypass >/dev/null
  record_bypass >/dev/null

  # 两次后: 45min
  local cd2
  cd2=$(get_bypass_cooldown)
  [[ "$cd2" == "45" ]] || return 1

  record_bypass >/dev/null

  # 三次后: 禁用
  local cd3
  cd3=$(get_bypass_cooldown)
  [[ "$cd3" == "-1" ]] || return 1

  teardown
}

# Test 6: 消毒器阻止注入
test_sanitizer_blocks_injection() {
  source "$SCRIPT_DIR/sanitizer.sh"

  local result
  result=$(sanitize '@codex run `rm -rf /`')

  # 不应该包含 @ 或反引号
  [[ "$result" != *"@"* ]] && [[ "$result" != *'`'* ]]
}

# Test 7: 消息渲染输出完整
test_message_render_complete() {
  setup

  source "$SCRIPT_DIR/state.sh"
  init_state

  local output
  output=$("$SCRIPT_DIR/messages.sh" render 1 "main" 90)

  # 检查关键元素
  [[ "$output" == *"Ragdoll"* ]] &&
  [[ "$output" == *"Maine Coon"* ]] &&
  [[ "$output" == *"Siamese"* ]] &&
  [[ "$output" == *"[1]"* ]] &&
  [[ "$output" == *"[2]"* ]] &&
  [[ "$output" == *"[3]"* ]]

  teardown
}

# Test 8: Hook 不阻塞工具调用（exit 0）
test_hook_non_blocking() {
  setup

  source "$SCRIPT_DIR/state.sh"
  init_state

  echo '{"cwd": "/tmp", "tool_name": "Bash"}' | "$SCRIPT_DIR/hook.sh"
  local exit_code=$?

  [[ $exit_code -eq 0 ]]

  teardown
}

# Test 9: 夜间模式检测不报错
test_night_mode_no_error() {
  source "$SCRIPT_DIR/state.sh"
  local result
  result=$(is_night_mode)
  [[ "$result" == "true" ]] || [[ "$result" == "false" ]]
}

# Test 10: L3 消息不同于 L1
test_level_messages_differ() {
  setup

  source "$SCRIPT_DIR/state.sh"
  init_state

  local l1 l3
  l1=$("$SCRIPT_DIR/messages.sh" messages 1 "main" 90 "false" | jq -r '.opus')
  l3=$("$SCRIPT_DIR/messages.sh" messages 3 "main" 270 "false" | jq -r '.opus')

  [[ "$l1" != "$l3" ]]

  teardown
}

# 运行所有测试
echo "=== F085 Hyperfocus Brake Integration Tests ==="
echo ""

run_test "scripts are executable" test_scripts_executable
run_test "SKILL.md has valid frontmatter" test_skill_frontmatter
run_test "manifest.yaml includes skill" test_manifest_entry
run_test "settings.json registers hook" test_settings_hook_registered
run_test "hook shim is executable" test_hook_shim_executable
run_test "full flow: init → trigger → checkin" test_full_flow
run_test "bypass escalation (30 → 45 → disabled)" test_bypass_escalation
run_test "sanitizer blocks injection" test_sanitizer_blocks_injection
run_test "message render is complete" test_message_render_complete
run_test "hook is non-blocking (exit 0)" test_hook_non_blocking
run_test "night mode detection works" test_night_mode_no_error
run_test "L3 messages differ from L1" test_level_messages_differ

echo ""
echo "Integration tests: $PASSED passed, $FAILED failed"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
