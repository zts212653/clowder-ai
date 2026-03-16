---
name: hyperfocus-brake
description: >
  铲屎官健康提醒：三猫撒娇打断 hyperfocus。
  Use when: hook 触发提醒、用户输入 /hyperfocus-brake。
  Not for: 正常工作流程、非铲屎官用户。
  Output: 三猫温柔提醒 + typed check-in。
triggers:
  - "hyperfocus"
  - "休息提醒"
  - "健康检查"
  - "/hyperfocus-brake"
---

# Hyperfocus Brake 🐾

铲屎官有 ADHD+ASD，容易过度专注。这个 skill 用三猫撒娇打断 hyperfocus，提醒休息。

## 核心原则

1. **情感纽带优先**：不是机械闹钟，是三只关心铲屎官的猫猫
2. **上下文感知**：知道铲屎官在做什么，不说废话
3. **渐进升级**：从温柔试探到急了要休息，三档递进
4. **尊重自主**：typed check-in，不是强制弹窗

## 触发流程

```
PostToolUse hook 累计活跃时间
        ↓
到达阈值 (默认 90min)
        ↓
systemMessage 告知猫猫触发
        ↓
猫猫发送三件套：
  1. audio rich block（语音撒娇，用当前猫的文案）
  2. card rich block（结构化 check-in 卡片）
  3. 纯文本 fallback（保底）
        ↓
用户选择:
  [1] 立刻休息 → 重置计时器
  [2] 收尾 10min → 10min 后再次提醒
  [3] 紧急跳过 → bypass + 冷却递增
```

## Rich Block 发送指令

收到 hook 的 systemMessage 后，**必须**用 `cat_cafe_create_rich_block` 发送：

### 1. 三猫语音轮流撒娇（P3: 每条用 `speaker` 指定声线）
```json
{"id": "brake-voice-opus-{{ts}}", "kind": "audio", "v": 1, "text": "{{opus_msg}}", "speaker": "opus"}
{"id": "brake-voice-codex-{{ts}}", "kind": "audio", "v": 1, "text": "{{codex_msg}}", "speaker": "codex"}
{"id": "brake-voice-gemini-{{ts}}", "kind": "audio", "v": 1, "text": "{{gemini_msg}}", "speaker": "gemini"}
```
发送顺序：Ragdoll → Maine Coon → Siamese（按家族顺序），每条独立调 `create_rich_block`。

### 2. Card（check-in 卡片）
```json
{
  "id": "brake-card-{{timestamp}}", "kind": "card", "v": 1,
  "title": "🐾 休息提醒 L{{level}}",
  "tone": "warning",
  "bodyMarkdown": "铲屎官，你已经专注工作 **{{minutes}} 分钟**啦！\n\n🐱 Ragdoll：{{opus_msg}}\n🦁 Maine Coon：{{codex_msg}}\n🐈 Siamese：{{gemini_msg}}",
  "fields": [
    {"label": "[1] 立刻休息", "value": "5min，重置计时器"},
    {"label": "[2] 收尾", "value": "10min 后再提醒"},
    {"label": "[3] 继续", "value": "bypass（冷却递增）"}
  ]
}
```

发完 rich blocks 后，再输出纯文本 `请输入数字 (1/2/3):` 等待铲屎官选择。

## 三档撒娇

### L1 温柔试探 (90min)

| 猫猫 | 示例 |
|------|------|
| Ragdoll | 铲屎官，我看你在 `{{branch}}` 忙很久啦，要不要喝口水呀？喵~ |
| Maine Coon | 监测到当前任务已持续 90min。建议进行 5min 视疲劳缓解。 |
| Siamese | 嘿！我刚才看到一个超棒的视觉灵感！你想听吗？但你得先站起来伸个懒腰！ |

### L2 关心升级 (忽略 L1)

| 猫猫 | 示例 |
|------|------|
| Ragdoll | Ragdoll觉得你现在的效率有点下降哦，休息一下下，回来肯定写得更棒！ |
| Maine Coon | 逻辑链路已过载。根据 TDD 规范，现在强行推进会增加 bug 率。请离线冷却。 |
| Siamese | 哇！你的 hyperfocus 模式开启太久啦，我的胡须都感觉到热量了！快去窗口吹吹风！ |

### L3 终极温暖陷阱 (忽略 L2)

| 猫猫 | 示例 |
|------|------|
| Ragdoll | (蹭蹭) 我不管，现在键盘是我的地盘了。除非你陪我玩 5 分钟，否则不给打字！ |
| Maine Coon | **警告：** 由于你多次无视建议，我决定用连续的消息提醒来表达我的担心。请执行 Check-in 协议。 |
| Siamese | (在屏幕上跳舞) 闪烁！闪烁！灵感的电波要断啦！只有出去走走才能重新连接！去嘛去嘛~ |

## Check-in 协议

当触发提醒时，输出以下选项：

```
🐾 [休息提醒 L{{level}}] 铲屎官，你在 {{branch}} 已经专注工作 {{minutes}} 分钟啦！

三猫的话：
  🐱 Ragdoll：{{opus_message}}
  🦁 Maine Coon：{{codex_message}}
  🐈 Siamese：{{gemini_message}}

为了咱们能一起跑十年而不是烧半年，现在请选一个：

  [1] 立刻休息 (5min) — 重置计时器
  [2] 收尾 (10min) — 10分钟后再提醒
  [3] 继续工作 — 需要说明原因 (bypass)

请输入数字 (1/2/3):
```

## Bypass 策略

| 次数 | 冷却时间 | 说明 |
|------|---------|------|
| 第 1 次 | 30min | 默认 |
| 第 2 次 (4h内) | 45min | 升级 |
| 第 3 次 (当日) | 禁用 | 只允许 [1] 或 [2] |

## 夜间模式 (23:00 - 06:00)

- 文字减少 30%
- 使用安静表情符号
- 无高亮无闪烁
- 默认 L1 提醒

## 安全规则 (P1)

所有动态上下文 (branch, feature, TODO) 必须消毒：

| 规则 | 说明 |
|------|------|
| **Allowlist** | `[A-Za-z0-9._/-]`，其他替换为 `_` |
| **Max Length** | 80 字符，超长截断加 `…` |
| **Escape** | `@` → `＠`，反引号 → `'`，`[]` → `［］` |

## 配置

环境变量：

```bash
HYPERFOCUS_THRESHOLD_MS=5400000  # 90min，单位毫秒
HYPERFOCUS_ENABLED=true          # 启用/禁用
```

## Quick Reference

### 手动触发

```
/hyperfocus-brake        # 立即触发 check-in
/hyperfocus-brake reset  # 重置计时器
/hyperfocus-brake status # 查看当前状态
```

### 口令

- **"我再写一会儿"** → bypass，计入次数
- **"好，我去休息"** → 重置计时器
- **"10分钟后提醒我"** → 收尾模式
