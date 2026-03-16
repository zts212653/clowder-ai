#!/usr/bin/env bash
# F085 Hyperfocus Brake - Message Renderer
# 根据档位和上下文生成三猫撒娇文案

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/sanitizer.sh"
source "$SCRIPT_DIR/state.sh"

# 三猫文案库
# L1: 温柔试探
L1_OPUS='铲屎官，我看你在 `{{branch}}` 忙很久啦，要不要喝口水呀？喵~'
L1_CODEX='监测到当前任务已持续 {{minutes}}min。建议进行 5min 视疲劳缓解。'
L1_GEMINI='嘿！我刚才在 `{{branch}}` 看到一个超棒的视觉灵感！你想听吗？但你得先站起来伸个懒腰！'

# L2: 关心升级
L2_OPUS='Ragdoll觉得你现在的效率有点下降哦，休息一下下，回来肯定写得更棒！'
L2_CODEX='逻辑链路已过载。根据 TDD 规范，现在强行推进会增加 bug 率。请离线冷却。'
L2_GEMINI='哇！你的 hyperfocus 模式开启太久啦，我的胡须都感觉到热量了！快去窗口吹吹风，散热啦喵！'

# L3: 终极温暖陷阱
L3_OPUS='(蹭蹭) 我不管，现在键盘是我的地盘了。除非你陪我玩 5 分钟，否则不给打字！'
L3_CODEX='**警告：** 由于你多次无视建议，我决定用连续的消息提醒来表达我的担心。请执行 Check-in 协议。'
L3_GEMINI='(在屏幕上跳舞) 闪烁！闪烁！灵感的电波要断啦！只有出去走走才能重新连接！去嘛去嘛~'

# 夜间模式文案（简短）
NIGHT_OPUS='喵...该休息了。'
NIGHT_CODEX='建议休息。'
NIGHT_GEMINI='～zzz～'

# 替换占位符
replace_placeholders() {
  local template="$1"
  local branch="$2"
  local minutes="$3"

  # 安全消毒
  local safe_branch
  safe_branch=$(sanitize "$branch")

  # 使用 | 作为 sed 分隔符避免和路径中的 / 冲突
  echo "$template" \
    | sed "s|{{branch}}|$safe_branch|g" \
    | sed "s|{{minutes}}|$minutes|g"
}

# 获取指定档位的文案
get_messages() {
  local level="$1"
  local branch="${2:-unknown}"
  local minutes="${3:-90}"
  local night_mode="${4:-false}"

  local opus_msg codex_msg gemini_msg

  if [[ "$night_mode" == "true" ]]; then
    opus_msg="$NIGHT_OPUS"
    codex_msg="$NIGHT_CODEX"
    gemini_msg="$NIGHT_GEMINI"
  else
    case "$level" in
      1)
        opus_msg=$(replace_placeholders "$L1_OPUS" "$branch" "$minutes")
        codex_msg=$(replace_placeholders "$L1_CODEX" "$branch" "$minutes")
        gemini_msg=$(replace_placeholders "$L1_GEMINI" "$branch" "$minutes")
        ;;
      2)
        opus_msg="$L2_OPUS"
        codex_msg="$L2_CODEX"
        gemini_msg="$L2_GEMINI"
        ;;
      3)
        opus_msg="$L3_OPUS"
        codex_msg="$L3_CODEX"
        gemini_msg="$L3_GEMINI"
        ;;
      *)
        opus_msg="喵？"
        codex_msg="状态正常。"
        gemini_msg="继续加油！"
        ;;
    esac
  fi

  # 输出 JSON
  jq -n \
    --arg opus "$opus_msg" \
    --arg codex "$codex_msg" \
    --arg gemini "$gemini_msg" \
    --argjson level "$level" \
    '{level: $level, opus: $opus, codex: $codex, gemini: $gemini}'
}

# 生成完整的 check-in 提示
render_checkin() {
  local level="$1"
  local branch="${2:-unknown}"
  local minutes="${3:-90}"
  local night_mode
  night_mode=$(is_night_mode)

  local messages
  messages=$(get_messages "$level" "$branch" "$minutes" "$night_mode")

  local opus_msg codex_msg gemini_msg
  opus_msg=$(echo "$messages" | jq -r '.opus')
  codex_msg=$(echo "$messages" | jq -r '.codex')
  gemini_msg=$(echo "$messages" | jq -r '.gemini')

  local safe_branch
  safe_branch=$(sanitize "$branch")

  # 检查 bypass 可用性
  local bypass_count cooldown
  bypass_count=$(get_field "bypass_count")
  cooldown=$(get_bypass_cooldown)

  local bypass_option
  if [[ "$cooldown" == "-1" ]]; then
    bypass_option="  [3] (已禁用) — 今日 bypass 次数已达上限"
  else
    bypass_option="  [3] 继续工作 — 需要说明原因 (bypass, 冷却 ${cooldown}min)"
  fi

  cat <<EOF
🐾 [休息提醒 L${level}] 铲屎官，你在 \`${safe_branch}\` 已经专注工作 ${minutes} 分钟啦！

三猫的话：
  🐱 Ragdoll：${opus_msg}
  🦁 Maine Coon：${codex_msg}
  🐈 Siamese：${gemini_msg}

为了咱们能一起跑十年而不是烧半年，现在请选一个：

  [1] 立刻休息 (5min) — 重置计时器
  [2] 收尾 (10min) — 10分钟后再提醒
${bypass_option}

请输入数字 (1/2/3):
EOF
}

# 生成 rich block JSON（card + audio）供猫猫通过 MCP 发送
render_rich_blocks() {
  local level="$1"
  local branch="${2:-unknown}"
  local minutes="${3:-90}"
  local cat_family="${4:-opus}"  # 当前猫：opus/codex/gemini
  local night_mode
  night_mode=$(is_night_mode)

  local messages
  messages=$(get_messages "$level" "$branch" "$minutes" "$night_mode")

  local opus_msg codex_msg gemini_msg
  opus_msg=$(echo "$messages" | jq -r '.opus')
  codex_msg=$(echo "$messages" | jq -r '.codex')
  gemini_msg=$(echo "$messages" | jq -r '.gemini')

  local ts
  ts=$(date +%s)

  local bypass_count cooldown
  bypass_count=$(get_field "bypass_count")
  cooldown=$(get_bypass_cooldown)

  local bypass_value
  if [[ "$cooldown" == "-1" ]]; then
    bypass_value="已禁用（今日次数达上限）"
  else
    bypass_value="bypass（冷却 ${cooldown}min）"
  fi

  # P3: 三猫语音轮流撒娇（Ragdoll→Maine Coon→Siamese），每条带 speaker 字段指定声线
  jq -n \
    --arg ts "$ts" \
    --arg card_id "brake-card-$ts" \
    --argjson level "$level" \
    --arg minutes "$minutes" \
    --arg opus_msg "$opus_msg" \
    --arg codex_msg "$codex_msg" \
    --arg gemini_msg "$gemini_msg" \
    --arg bypass_value "$bypass_value" \
    '{
      voices: [
        {id: ("brake-voice-opus-" + $ts), kind: "audio", v: 1, text: $opus_msg, speaker: "opus"},
        {id: ("brake-voice-codex-" + $ts), kind: "audio", v: 1, text: $codex_msg, speaker: "codex"},
        {id: ("brake-voice-gemini-" + $ts), kind: "audio", v: 1, text: $gemini_msg, speaker: "gemini"}
      ],
      card: {
        id: $card_id, kind: "card", v: 1,
        title: ("🐾 休息提醒 L" + ($level | tostring)),
        tone: (if $level >= 3 then "danger" elif $level >= 2 then "warning" else "info" end),
        bodyMarkdown: ("铲屎官，你已经专注工作 **" + $minutes + " 分钟**啦！\n\n🐱 Ragdoll：" + $opus_msg + "\n🦁 Maine Coon：" + $codex_msg + "\n🐈 Siamese：" + $gemini_msg),
        fields: [
          {label: "[1] 立刻休息", value: "5min，重置计时器"},
          {label: "[2] 收尾", value: "10min 后再提醒"},
          {label: "[3] 继续", value: $bypass_value}
        ]
      }
    }'
}

# 如果直接运行
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-help}" in
    messages)     get_messages "${2:-1}" "${3:-main}" "${4:-90}" "${5:-false}" ;;
    render)       render_checkin "${2:-1}" "${3:-main}" "${4:-90}" ;;
    rich-blocks)  render_rich_blocks "${2:-1}" "${3:-main}" "${4:-90}" "${5:-opus}" ;;
    *)
      echo "Usage: $0 {messages|render|rich-blocks} [level] [branch] [minutes] [cat_family]"
      exit 1
      ;;
  esac
fi
