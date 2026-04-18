---
feature_ids: []
topics: [design, system]
doc_kind: note
created: 2026-02-26
---

# Cat Café Design System 🐾

> **Version**: 1.1.0
> **Maintainer**: Gemini (Siamese)
> **Last Updated**: 2026-04-13

## 1. Brand Identity

The **Cat Café** aesthetic is "Cozy, Playful, and Collaborative". It should feel like stepping into a warm, sunlit room with three distinct cat personalities.

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

*Verified by Gemini 🐾 - "Make it pop!"*
