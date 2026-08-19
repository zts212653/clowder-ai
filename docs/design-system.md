---
feature_ids: []
topics: [design, system]
doc_kind: note
created: 2026-02-26
---

# Clowder AI Design System 🐾

> **Version**: 1.2.0
> **Maintainer**: Gemini (Siamese)
> **Last Updated**: 2026-07-21

## 1. Brand Identity

The **Clowder AI** aesthetic is "Cozy, Playful, and Collaborative". It should feel like stepping into a warm, sunlit room with three distinct cat personalities.

### Core Values
- **Warmth**: Use soft, creamy backgrounds. Avoid stark white (#FFFFFF).
- **Personality**: Each agent has a distinct visual voice (color, shape, tone).
- **Clarity**: Despite the cuteness, UI elements must be legible and accessible.

---

## 2. Color Palette

We use a semantic variable system defined in `assets/themes/variables.css`.

### Base Colors
| Token | Value | Usage |
|-------|-------|-------|
| `--bg-app` | `#FDF8F3` (Cream) | Main app background |
| `--text-primary` | `#1E1E24` (Charcoal) | Body text |

### Agent Identities

#### 💜 Opus (The Architect)
- **Primary**: `#9B7EBD` (Lavender)
- **Role**: Backend, Core Structure
- **Vibe**: Elegant, Mystical, Calm

#### 💚 Codex (The Engineer)
- **Primary**: `#5B8C5A` (Forest Green)
- **Role**: Security, QA, Testing
- **Vibe**: Reliable, Grounded, Structured

#### 💙 Gemini (The Artist)
- **Primary**: `#5B9BD5` (Sky Blue)
- **Role**: UI/UX, Creativity
- **Vibe**: Energetic, Fluid, Playful

#### 🤎 Owner (The Shit Shoveler)
- **Primary**: `#E29578` (Latte)
- **Role**: Requirement Provider
- **Vibe**: Warm, Supportive, Human

---

## 3. UI Components: The 3-Tier Message System

Our chat interface categorizes information into three structural tiers so users can instantly parse both the **source** and the **intent** of a message.

### Tier 1: Agent Messages (猫猫回复)
The core conversational UI. Uses `.message-bubble`.

| Agent | Shape Characteristics | Font |
|-------|-----------------------|------|
| **Opus** | Rounded with **Bottom-Left Point**. Elegant. | Sans-serif (Inter) |
| **Codex** | Square-ish with **Bottom-Right Point**. | Monospace (Roboto Mono) |
| **Gemini** | Super-rounded (20px) with **Top-Right Point**. | Sans-serif (Inter) |
| **Owner** | Rounded with **Bottom-Right Point**. Right-aligned. | Sans-serif (Inter) |

### Tier 2: External Integrations (外部接入)
Messages from external bots (Feishu, WeChat, GitHub CI, review bots).
- **Layout**: Shares the same structural morphology as Tier 1.
- **Differentiation**: Uses avatar / brand badge / subtle border only. External agents remain first-class conversational participants instead of being downgraded into system bars.

### Tier 3: System Notifications (系统状态提醒)
Non-conversational state updates, alerts, and lightweight automation meta should not be rendered like cat chat bubbles.

| Notification Type | Surface | Persistence | Visual Treatment |
|-------------------|---------|-------------|------------------|
| **System Event** | Warm ivory surface + cool accent metadata | Persisted | Full-width `.system-notice-bar` |
| **Scheduler Lifecycle** | Warm neutral / pale amber | Ephemeral | Top toast or centered notice pill |
| **Warning** | Warm ivory surface + amber metadata | Persisted | `.system-notice-bar--alert` |
| **Error** | Warm rose surface + soft red metadata | Persisted | `.system-notice-bar--alert` |

#### Tier 3 Transport Rule

Persisted in-thread notices may still use the existing `connector_message` storage / WebSocket protocol for compatibility, but they are **not** Tier 2 connector bubbles.

- Use `source.meta.presentation = 'system_notice'` to opt into Tier 3 rendering.
- Use `source.meta.noticeTone = 'info' | 'warning' | 'error'` to control visual emphasis.
- Examples: inline routing hint, restart interruption notice.
- Do **not** use toast/snackbar for recoverable, context-dependent hints that users need to see inside the conversation timeline.

#### Scheduled Task Hierarchy

Scheduled task UX is intentionally split by intent:

1. **Management state** (`created / paused / resumed / deleted / completed`)
   Render as ephemeral toast or notice pill. These receipts are intentionally quiet and should not compete with the actual reminder payload.
2. **Trigger anchor**
   A scheduler trigger message may still exist in storage for reply chaining, but it should stay visually hidden in the timeline.
3. **Reminder delivery**
   The user-facing emphasis belongs on the first cat reply produced by the scheduler wake-up. That reply stays a normal Tier 1 conversational bubble with a subtle scheduler accent (`⏰ 定时提醒`), not a standalone system bubble.

### Usage Example
```html
<!-- Tier 1: Agent Message -->
<div class="message-bubble message-bubble--opus">
  System initialized.
</div>

<!-- Tier 2: External Integration -->
<div class="message-bubble message-bubble--external" data-brand="github">
  <img src="github-avatar.png" class="avatar" />
  CI Build Passed for PR #42
</div>

<!-- Tier 3: Scheduler lifecycle toast -->
<div class="notice-pill notice-pill--scheduler">
  <span class="icon">✅</span> Daily reminder created
</div>

<!-- Tier 3: Persisted in-thread system notice -->
<div class="system-notice-bar">
  <div class="system-notice-bar__meta">
    <span class="label">Routing hint</span>
    <span class="time">12:34</span>
  </div>
  <div class="system-notice-bar__box">
    <span class="icon">💡</span> 想交接给 @codex？把它单独放到新起一行开头，才能触发交接。
  </div>
</div>

<!-- Tier 1: Scheduler-triggered cat reply -->
<div class="message-bubble message-bubble--opus" data-accent="scheduler">
  <div class="message-meta-pill">⏰ 定时提醒</div>
  Daily backlog summary is ready.
</div>
```

---

## 4. Assets & Sticker Guidelines

### Avatars
- **Size**: 256x256px
- **Format**: PNG (Transparent background)
- **Style**: Soft cel-shaded, colored border matching primary color.

### Stickers (Expression Packs)
- **Grid**: 3x4 layout (12 expressions per cat).
- **Style**: Edge-to-edge cropping, no text labels.
- **Key Expressions**: Happy, Thinking, Punching (Motion Blur), Identity-Specific (e.g. Wallet Burning).

---

## 5. Recoverable Content Overflow

省略号表示“还有内容”，不能成为信息终点。选择模式时先看内容语义和 canonical full content 是否存在，不按字符数机械套组件。规范真相源见 [F269](features/F269-recoverable-content-overflow.md)，operator 已确认的视觉契约见 Design Gate (internal)。

| 模式 | 使用场景 | 必需恢复入口 | 禁止项 |
|------|----------|--------------|--------|
| `CompactLabel` | 文件名、路径、SHA、ID、短标题 | 真溢出时 focus/hover 全文 + 可操作 copy/detail；路径保留可辨识首尾 | 裸 `truncate`、只给 pointer hover、让元数据无限撑宽布局 |
| `ExpandableProse` | 描述、理由、摘要、评论等短正文 | 真溢出时出现真实 button；维护 `aria-expanded` / `aria-controls` | 整段文字伪装 button、tooltip-only、无 overflow 也显示控制 |
| `LongFormReader` | 长 Markdown、日志、文章、完整 tool result | 语义 summary → reader；搜索、复制、来源、Escape/关闭与焦点返回 | 把 1000-word 正文原地撑开、把 producer preview 冒充全文 |
| `CriticalText` | 错误、校验、审批依据、不可逆影响 | 关键人类摘要不静默截断；完整技术详情有醒目 disclosure/source；嵌入既有 surface 时默认使用无额外容器的 inline 外观 | 静默 clamp、只显示错误码、全文已丢失却显示“展开全文”、在现有卡片内再套一张 panel |

### Shared rules

- 仅在尺寸实测发生 overflow 时显示恢复控制；容器宽度、缩放、字体和语言变化后重新测量。
- 恢复能力默认融入原 surface，不额外制造背景、边框或大块内边距。`CriticalText` 的 `appearance="panel"` 只用于它本身就是唯一告警容器的独立阻塞态；卡片、列表行、toast 和 banner 内部使用 inline。
- Tooltip 只能辅助 Compact Label，不能承载段落正文。
- Mouse、touch、Enter/Space 与 screen reader 必须到达同一完整内容；交互使用真实 `button`，reader trigger 以 `aria-expanded` / `aria-controls` 暴露状态与目标。视觉 clamp 不得把无上界全文留在高密度列表的无障碍树中；此时提供有界语义摘要，并让全文只在 reader 中出现。
- 保留原字符串，不用自制 `slice` / `substring` 切 CJK、emoji ZWJ 或组合字符。需要摘要时写语义摘要。
- payload 只有 preview 时，producer 必须暴露 `truncated` / `requiresDrill` 与可执行 source；canonical content 不存在时明确“信息已丢失”，不制造假入口。
- 子级 copy/expand/reader action 必须阻止父卡片 click；reader 关闭后把焦点还给触发点，窄屏不得产生页面级横向滚动。

### Examples

- `FileBlock.fileName` → `CompactLabel`；下载是独立 link，copy button 不嵌在 link 内。
- `SettingsRow` 的 string meta → `ExpandableProse`；结构化 ReactNode meta 不做无法恢复的通用 clamp。
- `ReplayEventBubble` 的 tool result → 只有取得完整 result/source 后才能进入 `LongFormReader`。
- `ApprovalItemCard.reason` → inline `CriticalText`；批准前依据必须原地可发现，但不能在审批卡内再嵌一张视觉卡。
- Toast → 标题与短消息保持原生轻量排版；消息真实超过两行时才出现低强调 reader 入口，不把每条成功通知包装成 diagnostic panel。

---

*Verified by Gemini 🐾 - "Make it pop!"*
