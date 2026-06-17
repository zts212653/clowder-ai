---
feature_ids: [F098]
related_features: [F097, F022, F056, F086, F088]
topics: [ux, frontend, chat-bubble, callback, a2a, direction, evidence]
doc_kind: spec
created: 2026-03-11
---

# F098: Callback Message UX — 猫猫传话可视化

> **Status**: done | **Completed**: 2026-03-12 | **Owner**: Ragdoll | **Priority**: P1

## Why

operator experience（2026-03-11 16:50，F097 收尾时发现）：

> "你们猫猫之间传递消息，有好几个 MCP 传递的消息，有可能你得想想要怎么样的去展现。假设你是 at Maine Coon，你这里是不是得标明Ragdoll to Maine Coon或者Ragdoll箭头Maine Coon？然后如果是 multi mention，你这里也需要标明。然后我们曾经做的悄悄话的功能，那里就会标明operator跟什么猫猫说，你是不是也得那样子去优化一下？"

> "你看你的证据地方的字，我是看不见的。还有，你不觉得它超级突兀吗？跟你的其他的东西是不是一个设计感？"

### 核心痛点

1. **方向不明** — 猫猫通过 MCP（post_message / cross_post / multi_mention）传话时，operator看不到"谁对谁说"。stream 消息知道是谁说的（有 catId），但 callback 消息不标明目标受众
2. **视觉断裂** — CLI 块和 Thinking 块有统一的 tinted-dark 设计语言（F097），但 callback 消息还是普通气泡，跟旁边的深色面板放一起很突兀
3. **Evidence Panel 不可读** — 深色气泡背景上 Evidence Panel 的表格文字看不见，样式没有适配品种色主题
4. **Whisper 不对称** — operator的悄悄话有 "悄悄话 → [猫名]" 方向标注，但猫猫的悄悄话只显示 "悄悄话"，没有方向

### 现状分析

| 消息类型 | origin | 方向标注 | 视觉风格 | 问题 |
|---------|--------|---------|---------|------|
| 猫猫 stream 输出 | `stream` | 无（catId 足够） | CLI 块 tinted-dark ✅ | — |
| 猫猫 callback（post_message） | `callback` | ❌ 无 | 普通气泡 ❌ | 不知道对谁说 |
| 猫猫跨 thread 转发 | `callback` + `crossPost` | 📮 badge 有来源 | 普通气泡 ❌ | 只有来源没有方向 |
| multi_mention 结果 | `connector` | ❌ 无 | connector 样式 | 不知道谁被 @ 了 |
| operator悄悄话 | — | ✅ "悄悄话 → [猫名]" | amber badge ✅ | — |
| 猫猫悄悄话 | — | ❌ 只有 "悄悄话" | amber badge | 缺方向 |
| Evidence Panel | `system` variant=evidence | — | 独立组件 | 深色背景上不可读 |
| A2A 内部讨论 | `stream`/`callback` | — | 品种色气泡 + opacity-80 | 颜色刺眼（绿底+深绿 CLI 块叠加） |

## What

### Phase A: 方向标注 + Callback 消息视觉统一

**A1: 方向标注系统**

在 callback 消息的 header 区域显示发送方向：

```
┌─ Ragdoll（Opus）16:28 ──────────────────────────┐
│  → @Maine Coon                              ← 方向标注 │
│                                                    │
│  R2 修复确认 (commit a47ee782)                      │
│  ... 消息内容 ...                                   │
│                                                    │
│  @codex                                            │
└────────────────────────────────────────────────────┘
```

方向标注规则：
- **post_message + 行首 @mention** → `→ @猫名` （从消息内容解析 @mention）
- **multi_mention** → `→ @猫A + @猫B + @猫C` （从 targets 解析）
- **cross_post** → `↗ [来源 thread] → [目标 thread]` （已有 crossPost 元数据）
- **whisper（猫猫）** → `悄悄话 → @猫名` （复用 whisperTo 字段，和operator一致）
- **无明确目标** → 不显示方向标注（向 thread 全体发言）

方向标注视觉：品种色 pill badge（和 @mention 徽章同款），紧贴 header 行。

**A2: Callback 消息视觉升级**

Callback 消息从普通气泡升级为 **浅色品种气泡**（区别于 CLI/Thinking 的深色面板）：
- 背景：`tintedLight(accent, 0.08)` — 品种色极浅底（和 tintedDark 对称）
- 边框：品种色 12% opacity
- 文字：保持深色（`#1E293B`），不用浅色主题的文字
- **和 CLI 块的区分**：CLI 块 = 深色面板（执行日志），Callback = 浅色面板（面向人类的发言）

**A3: 猫猫 Whisper 方向补全**

猫猫的悄悄话 badge 从 "悄悄话" 改为 "悄悄话 → @猫名"，和operator悄悄话一致。

**A4: A2A 内部讨论颜色优化**

当前问题（operator 17:28 截图）：
- A2A 折叠展开后，内部消息用品种色 `secondary` 做气泡背景（如Maine Coon `#C8E6C9` 浅绿）
- 气泡内的 CLI 块用 `tintedDark(greenAccent)` → 深绿面板
- 浅绿气泡 + 深绿 CLI + `opacity-80` 叠加 → **颜色刺眼，看了眼疼**

修复方案：
- A2A 内部消息气泡**不用品种色背景**，改为中性浅灰底（`#F1F5F9` / dark: `#1E293B`），保留品种色左边框作为身份标识
- 移除 `opacity-80`（不需要，灰底已经有视觉层级区分）
- 品种色只用于：左边框 + 猫名 badge + @mention 徽章
- CLI 块和 Thinking 块保持原有 `tintedDark` 品种色方案（深色面板内颜色是可读的）

### Phase B: Evidence Panel 适配 + 组件统一

**B1: Evidence Panel 深色适配**

- Evidence Panel 表格/文字适配深色气泡背景（和 F097 的 `.cli-output-md` 同思路）
- EvidenceCard 颜色适配品种色主题
- 或者：Evidence Panel 独立浅色底（不跟随气泡深色），作为"内嵌卡片"

**B2: Connector 消息统一**

- multi_mention 结果消息（type='connector', connector='multi-mention-result'）视觉统一
- 飞书/Telegram connector 消息（F088）视觉统一

### Phase B.5: Connector 可扩展设计

**operator新需求**（2026-03-12 20:26）：
> "我可能现在还要想要接苹果的iMessage，那你其实，在你的设计上得预留给他们一些空间，就不能写死。"

- 将 `getConnectorTheme()` 从 if-else 硬编码重构为注册表驱动
- 在 shared `ConnectorDefinition` 扩展 Tailwind theme 字段
- 新平台只需在 `CONNECTOR_DEFINITIONS` 加一条，前端自动生效
- Default fallback theme 保证未注册 connector 也有合理样式

### Phase C: 后端元数据增强（可选）

**C1: 消息级 targetCats 字段**

当前 callback 消息没有 `targetCats` 元数据，方向信息只能从消息内容的 @mention 解析。Phase C 在 post_message API 层面补 `targetCats: string[]` 字段，让前端不依赖正文解析。

**C2: multi_mention 消息归属**

当前 multi_mention 结果是 connector 消息，不关联发起者。Phase C 补充发起者 catId + targets 元数据。

### Phase D: 消息流位置正确性

**D1: operator消息的"收到时刻"展示**

operator experience（2026-03-12 19:12）：
> "假设你们正在猫猫调用这个阶段，我的消息在我们的 channel 里面排队嘛。但是我在前端看到的我的消息展现的位置是在我发的那一刻，但其实不是在你们收到的那一刻。这样子就会给别人一种误解，以后在回顾这整个 thread 的时候，就会分不清楚这些消息到底是什么时候被你们收到了。"

当前问题：
- operator在猫猫调用期间发的消息进入 channel 排队
- 前端展示位置是 **发送时刻**（`timestamp`）
- 实际被猫猫处理的时刻可能延后很多（排队等待）
- 回顾 thread 时，消息看起来像是在猫猫输出中间插入的，但实际猫猫当时还没看到

修复方向（终态设计）：
- 方案 A：消息卡片增加"猫猫收到时间"标注（如 `发送 19:05 · 收到 19:12`）
- 方案 B：消息在 thread 中按**实际被处理/收到时刻**排序，而非发送时刻
- 方案 C：在猫猫输出流中插入"收到operator消息"的系统提示，标明延迟
- 需要在 Phase D 设计时确定最终方案

## Acceptance Criteria

### Phase A（方向标注 + 视觉统一）
- [x] AC-A1: callback 消息 header 显示方向标注（→ @猫名），从消息内容 @mention 解析 ✅
- [ ] ~~AC-A2~~: **降级到 Phase B**（依赖 Phase C2 后端元数据，见 KD-5）
- [x] AC-A3: cross_post 消息方向标注包含来源/目标 thread ✅
- [x] AC-A4: 猫猫 whisper badge 显示 "悄悄话 → @猫名"（和operator whisper 一致）✅
- [x] AC-A5: callback 消息有品种色浅底气泡，视觉上和 CLI 深色块区分（tintedLight(primary, 0.08) + pill 提供区分）✅
- [x] AC-A6: 方向标注用品种色 pill badge（和 @mention 彩色徽章同款样式）✅
- [x] AC-A7: A2A 内部讨论消息用中性灰底（不用品种色背景），品种色仅用于边框/badge ✅

### Phase B（Evidence Panel + 组件统一 + multi_mention 方向）
- [x] AC-B1: Evidence Panel 在深色/品种色气泡上文字可读 ✅
- [x] AC-B2: connector 消息（multi-mention-result、飞书、Telegram）视觉统一 ✅
- [x] AC-A2（从 Phase A 降级）: multi_mention 结果消息显示 `→ @猫A + @猫B` 方向（依赖 AC-C2 后端元数据）✅

### Phase B.5（Connector 可扩展设计）
- [x] AC-B5-1: `getConnectorTheme()` 改为从 `ConnectorDefinition` 注册表读取，不再 if-else 硬编码 ✅
- [x] AC-B5-2: shared `ConnectorDefinition` 扩展 `tailwindTheme` 字段 ✅
- [x] AC-B5-3: 未注册 connector 自动 fallback 到 default theme ✅
- [x] AC-B5-4: 新增平台（如 iMessage）只需在 `CONNECTOR_DEFINITIONS` 加一条 ✅

### Phase C（后端元数据，可选）
- [x] AC-C1: post_message API 支持 `targetCats` 字段 ✅
- [x] AC-C2: multi_mention 结果消息包含发起者 + targets 元数据 ✅

### Phase D（消息流位置正确性）
- [x] AC-D1: operator在猫猫调用期间发的消息，回顾时能区分"发送时刻"和"被收到时刻" ✅
- [x] AC-D2: 消息在 thread 时间线中的位置能反映实际被处理顺序（不误导读者） ✅

## 需求点 Checklist

| # | 需求点 | 来源 | Phase | AC |
|---|--------|------|-------|-----|
| R1 | callback 消息显示 "→ @猫名" 方向 | operator 16:50 | A | AC-A1 |
| R2 | multi_mention 显示方向 | operator 16:50 | A | AC-A2 |
| R3 | cross_post 方向标注 | Ragdoll分析 | A | AC-A3 |
| R4 | 猫猫 whisper 方向对齐operator whisper | operator 16:50 | A | AC-A4 |
| R5 | callback 消息视觉统一（不突兀） | operator 16:50 | A | AC-A5 |
| R6 | Evidence Panel 文字可读 | operator 16:50 截图 | B | AC-B1 |
| R7 | connector 消息视觉统一 | Ragdoll分析 | B | AC-B2 |
| R8 | 后端 targetCats 元数据 | Ragdoll分析（优化） | C | AC-C1 |
| R9 | A2A 内部讨论颜色刺眼 | operator 17:28 截图 | A | AC-A7 |
| R10 | 消息流位置正确性 — operator消息"发送 vs 收到"时间差导致回顾误导 | operator 19:12 (2026-03-12) | D | AC-D1/D2 |
| R11 | Connector 主题不能写死，要预留给未来平台（iMessage 等）空间 | operator 20:26 (2026-03-12) | B.5 | AC-B5-1~4 |

## Dependencies

- **Evolved from**: F097（CLI Output Collapsible UX — tintedDark 品种色方案、@mention 彩色徽章）
- **Related**: F022（Rich Blocks）、F056（Cat Café 设计语言）、F086（Cat Orchestration — multi_mention）、F088（Multi-Platform Chat Gateway — connector 消息）

## Risk

| 风险 | 缓解 |
|------|------|
| 方向解析依赖消息内容 @mention（可能不准） | Phase A 先做内容解析，Phase C 补后端元数据 |
| callback 浅色底和 CLI 深色底在同一气泡内冲突 | callback 和 stream 是不同 message，不在同一气泡 |
| Evidence Panel 改造影响 Hindsight 功能 | Evidence Panel 只改 CSS，不改数据逻辑 |
| connector 消息种类多（multi-mention / 飞书 / Telegram） | Phase B 逐一适配，不急 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 方向信息从消息内容 @mention 解析（Phase A），后端元数据后补（Phase C） | 前端先上，不阻塞后端改动 | 2026-03-11 |
| KD-2 | 猫猫 whisper 方向标注和operator whisper 统一 | 一致性，用户心智模型统一 | 2026-03-11 |
| KD-3 | 方向标注放 header 行（猫名右侧 pill badge） | 设计稿确认，不占额外行高 | 2026-03-11 |
| KD-4 | A2A 内部讨论改中性灰底 + 品种色边框/badge | operator截图确认颜色刺眼，灰底解决叠色问题 | 2026-03-11 |
| KD-5 | AC-A2 降级到 Phase B | multi_mention 结果是 `type:'connector'` 聚合消息（无 targets 元数据），方向标注需 Phase C2 后端补 targets 字段后才能可靠渲染。AC-B2 已覆盖 connector 视觉统一 | 2026-03-11 |
| KD-6 | Phase D 采用 Method A 双时间标注（`deliveredAt` 字段） | 不重排序（保留实时体验）、不加系统消息（不添杂音）、最精确（读者可自行判断延迟）。StoredMessage 加 `deliveredAt?: number`，InvocationQueue dequeue 时回填，前端 gap>5s 时显示"发送 HH:MM · 收到 HH:MM" | 2026-03-12 |

## Review Gate

- Phase A: 跨家族 review（@codex 或 @gpt52）
