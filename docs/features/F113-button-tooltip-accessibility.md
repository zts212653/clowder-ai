---
feature_ids: [F113]
related_features: [F071, F056]
topics: [ux, accessibility, tooltip, frontend]
doc_kind: spec
created: 2026-03-13
---

# F113: Button Tooltip Accessibility

> **Status**: spec | **Owner**: opus | **Priority**: P2

## Why

Console 上约 60% 的按钮（特别是 icon-only 按钮）没有 hover 提示，用户无法判断功能。这直接影响可发现性（discoverability）和无障碍体验（accessibility）。

CVO 反馈：「当前 console 上很多按钮都没有提示这是干嘛的。」

## What

### Phase A: Icon-Only Buttons

给所有没有可见文字的 icon-only 按钮添加 `title` 属性。这些按钮用户完全无法判断功能，是最高优先级。

**方案**：使用原生 HTML `title` 属性（项目已有模式，参考 `VoiceCompanionButton.tsx` 的 `aria-label` + `title` 双保险写法）。

涉及组件：
- 关闭 X 按钮（ToastContainer, VoteConfigModal, CatCafeHub）
- 复制代码（MarkdownContent）
- 展开/收起（A2ACollapsible, story-export）
- 侧边栏/面板开关（ChatContainerHeader）
- 发送/停止/录音（ChatInputActionButton）
- 移除图片（ImagePreview）
- 队列操作（QueuePanel）
- 音频播放/暂停（rich/AudioBlock）
- 图片放大（rich/MediaGalleryBlock）
- 停止所有（ParallelStatusBar）

### Phase B: Context-Enhancement Tooltips

给有文字但需要额外上下文的按钮添加 `title`：
- 权限操作按钮（AuthorizationCard — 区分 scope 差异）
- 悄悄话目标切换（ChatInput）
- Signal 操作按钮（SignalArticleDetail）
- 休息模式选项（BrakeModal）

### Phase C: Full Coverage

扫描剩余所有缺少 `title` 的按钮，补全 tooltip 覆盖。

## Acceptance Criteria

### Phase A（Icon-Only Buttons）
- [ ] AC-A1: 所有 icon-only 按钮（无可见文字）均有 `title` 属性
- [ ] AC-A2: tooltip 文字使用中文，与现有 title 风格一致
- [ ] AC-A3: 有状态切换的按钮 title 随状态变化（如「收起/展开」）
- [ ] AC-A4: `pnpm check` + `pnpm lint` 通过

### Phase B（Context-Enhancement）
- [ ] AC-B1: AuthorizationCard 所有权限按钮有 title 解释 scope 差异
- [ ] AC-B2: ChatInput 悄悄话目标切换有 title
- [ ] AC-B3: Signal 相关操作按钮有 title

### Phase C（Full Coverage）
- [ ] AC-C1: 全站 `<button>` 元素 title 覆盖率 > 90%

## Dependencies

- **Related**: F071（UX Debt Batch）
- **Related**: F056（Cat Cafe Design Language）

## Risk

| 风险 | 缓解 |
|------|------|
| 部分文件已接近行数上限 | `title` 加在现有行上，不增加新行 |
| tooltip 文字翻译一致性 | 统一使用中文，参考现有 title 风格 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 使用原生 `title` 而非自定义 Tooltip 组件 | 零依赖、匹配现有模式、不增加行数 | 2026-03-13 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-13 | 立项（Issue #18） |

## Review Gate

- Phase A: 缅因猫 review（纯 UI 属性变更，低风险）
