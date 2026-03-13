---
feature_ids: [F113]
related_features: [F071, F056]
topics: [ux, accessibility, tooltip, frontend]
doc_kind: spec
created: 2026-03-13
---

# F113: Button Tooltip Accessibility — 全局按钮悬停提示

> **Status**: spec | **Owner**: opus | **Priority**: P2

## Why

Console 上约 60% 的按钮（特别是 icon-only 按钮）没有 hover 提示，用户无法判断功能。这直接影响可发现性（discoverability）和无障碍体验（accessibility）。

CVO 反馈：「当前 console 上很多按钮都没有提示这是干嘛的。」

## What

**一次性全覆盖**：给全站所有缺少 `title` 的 `<button>` 元素添加 hover tooltip。

### 设计规范（关联 F056 Design Language）

F056 Phase A3 规划了统一的核心组件库（含按钮组件），但 Design Token 体系尚未落地到代码。当前方案在 F056 框架内定义 tooltip 的设计约定：

| 约定 | 规范 |
|------|------|
| **实现方式** | 原生 HTML `title` 属性（匹配现有模式） |
| **语言** | 中文（与现有 title 风格一致） |
| **双保险** | Icon-only 按钮同时设置 `aria-label` + `title` |
| **状态感知** | 有状态切换的按钮 title 随状态变化（如「收起/展开」） |
| **参考标准** | `VoiceCompanionButton.tsx` 的写法 |
| **未来演进** | 当 F056 Token 体系落地后，可升级为自定义 Tooltip 组件 |

### 涉及范围

**全站审计结果**：约 335 个 `<button>` 元素，约 200+ 个缺少 `title`。

| 类别 | 数量 | 示例 |
|------|------|------|
| Icon-only（完全无可见文字） | ~20 | 关闭 X、复制代码、播放/暂停、侧边栏开关 |
| 有文字但需上下文 | ~20 | 权限 scope 区分、悄悄话目标、Signal 操作 |
| 有文字可增强 | ~160+ | 各种表单按钮、导航按钮 |

涉及文件（重点）：
- `ToastContainer.tsx`, `VoteConfigModal.tsx`, `CatCafeHub.tsx`
- `MarkdownContent.tsx`, `A2ACollapsible.tsx`, `ChatContainerHeader.tsx`
- `ChatInputActionButton.tsx`, `ImagePreview.tsx`, `QueuePanel.tsx`
- `rich/AudioBlock.tsx`, `rich/MediaGalleryBlock.tsx`
- `ParallelStatusBar.tsx`, `story-export/page.tsx`
- `AuthorizationCard.tsx`, `ChatInput.tsx`, `SignalArticleDetail.tsx`
- `BrakeModal.tsx`, `MobileInputToolbar.tsx`
- 及其他所有含 `<button>` 的组件文件

## Acceptance Criteria

- [ ] AC-1: 所有 icon-only 按钮（无可见文字）均有 `title` 属性
- [ ] AC-2: 所有有文字按钮中需要额外上下文说明的均有 `title`
- [ ] AC-3: tooltip 文字使用中文，与现有 title 风格一致
- [ ] AC-4: 有状态切换的按钮 title 随状态变化（如「收起/展开」）
- [ ] AC-5: 全站 `<button>` 元素 title 覆盖率 > 90%
- [ ] AC-6: `pnpm check` + `pnpm lint` 通过
- [ ] AC-7: 不引入新依赖，不增加文件行数

## Dependencies

- **Related**: F056（Cat Cafe Design Language — Token 体系 + 核心组件库规划）
- **Related**: F071（UX Debt Batch）

## Risk

| 风险 | 缓解 |
|------|------|
| 部分文件已接近行数上限 | `title` 加在现有行上，不增加新行 |
| tooltip 文字一致性 | 统一使用中文，参考现有 title 风格 |
| F056 Token 落地后需二次改造 | `title` 属性是标准 HTML，升级 Tooltip 组件时自然替换 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 使用原生 `title` 而非自定义 Tooltip 组件 | F056 Token 体系未落地，`title` 零依赖、匹配现有模式 | 2026-03-13 |
| KD-2 | 一次性全覆盖，不分 Phase | 改动机械性强，全做一遍比分批管理开销更小 | 2026-03-13 |
| KD-3 | 遵循 F056 设计语言框架 | 在 F056 的组件规范内定义 tooltip 约定，未来可平滑升级 | 2026-03-13 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-13 | 立项（Issue #18） |

## Review Gate

- 缅因猫 review（纯 UI 属性变更，低风险）
