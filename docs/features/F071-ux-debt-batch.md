---
feature_ids: [F071]
related_features: [F039, F075]
topics: [ux, frontend, debt, image, status, mention]
doc_kind: spec
created: 2026-03-07
completed: 2026-03-11
---

# F071: UX Debt Batch — 前端小修小补合集

> **Status**: done | **Owner**: Ragdoll | **Priority**: P2
**Completed: 2026-03-11**
**Implementation**: PR #268 (`ed06a8c7`)
**Follow-up fixes**: `a26ca1b7`（待上传图片预览）/ `e9249040`（mention 自动滚动 + “还有更多猫猫”提示）/ `1849a90d`（lightbox 开图闪烁 hotfix）

## Why

随着猫猫家族壮大和功能累积，前端出现了几个高频但零碎的 UX 痛点。单个都不大，但都直接影响operator日常聊天体验，适合合并成一个 debt batch 统一收口。

### operator experience（2026-03-07）

> "上传的图片上传后不支持预览"
>
> "发送消息当前thread没有消息和猫猫在处理；但是任然提示有猫猫正在工作"
>
> "@现在猫猫家族 的成员太多了。。我都看不到都有谁了 如何优化？"
>
> "聊天窗中发送的消息 图片支持点击预览(回显)"
>
> "d1 的这个图片预览如果我只是在上传的过程中 他能够也支持你这个预览吗？"
>
> "按键盘往下的时候只有这四只猫可以选 但是其实其他猫猫藏在下面了"

## What

本 feature 作为债务批处理，集中收口图片预览、猫猫状态面板、@ mention 列表三个高频 UX 问题，并把 merge 后才暴露出的两个真实使用边角一并收进真相源。

### D1: 图片预览统一为 Lightbox 体验

**问题**：用户在聊天中上传图片后，图片内嵌在消息里，但点击只能新标签页打开；发送前的待上传图片也只有缩略图，没有放大预览。

**根因**：`ChatMessage.tsx` 使用 `window.open(url, '_blank')`，没有复用项目里已有的 rich media lightbox 交互；`ImagePreview.tsx` 只有缩略图和删除按钮，没有放大路径。

**最终交付**：
- 提取共享 `Lightbox.tsx`，复用到普通消息图片与 rich block 媒体预览
- `ChatMessage.tsx` 的图片点击改为 inline lightbox，用户消息和猫猫消息统一支持
- `ImagePreview.tsx` 的待上传图片缩略图支持点击放大预览
- 保留 Esc 关闭、点击背景关闭、复制图片链接按钮

**关键文件**：
- `packages/web/src/components/ChatMessage.tsx`
- `packages/web/src/components/ImagePreview.tsx`
- `packages/web/src/components/Lightbox.tsx`
- `packages/web/src/components/rich/MediaGalleryBlock.tsx`

### D2: 猫猫状态面板去掉误导性的幽灵“等待调用...”

**问题**：当前 thread 没有猫猫在处理消息，但状态面板在 F5 或切 thread 后仍显示“等待调用...”，让operator误以为还有活跃任务。

**根因**：切换线程或冷启动时 `catStatuses` 可能为空，而 WebSocket 不会回放旧的 `intent_mode`；这时 UI 用“等待调用...”兜底，文案语义比真实状态更强，导致误导。

**最终交付**：
- `RightStatusPanel.tsx` 与 `MobileStatusSheet.tsx` 在无活跃 invocation 时统一显示“空闲”
- 不再声称“等待调用...”，避免把“没有状态”误写成“马上要工作”

**关键文件**：
- `packages/web/src/components/RightStatusPanel.tsx`
- `packages/web/src/components/MobileStatusSheet.tsx`

### D3: @ mention 下拉从“堆一长列”改成可过滤、可滚动、可见性明确

**问题**：猫猫家族成员增多后，@ mention 下拉变得很长。起初虽然加了滚动，但 macOS 隐藏滚动条，operator看起来只像“只有前四只猫可以选”。

**根因**：
1. 初版下拉没有输入过滤，输入 `@op` 仍显示全部
2. 初版下拉没有滚动容器，列表无限增长
3. 加上滚动后，键盘导航不会自动滚动到当前选项，也没有“下面还有猫”提示

**最终交付**：
- `ChatInput.tsx` 基于 `label` / `id` / `insert` 做 mention 过滤
- `ChatInputMenus.tsx` 增加 `max-h-80` 滚动容器和“无匹配猫猫”空态
- `chat-input-options.ts` 将 mention fragment limit 从 4 提升到 12，减少刚输入就截断的情况
- 键盘 ArrowUp / ArrowDown 选中隐藏项时自动 `scrollIntoView`
- 列表底部仍有隐藏项时显示“↓ 还有更多猫猫”提示
- 空结果时只拦截 plain `Enter`，保留 `Shift+Enter` 换行语义

> operator评价："你这只心机小坏猫！是不想让大家看到都接入了什么猫猫吗？"  
> 结论：不是心机，是滚动 affordance 不够。

**关键文件**：
- `packages/web/src/components/ChatInput.tsx`
- `packages/web/src/components/ChatInputMenus.tsx`
- `packages/web/src/components/chat-input-options.ts`

## Priority

| Issue | Severity | Effort |
|-------|----------|--------|
| D1 图片预览 | P3 | S |
| D2 幽灵状态 | P2 | M |
| D3 mention 列表 | P2 | S |

## Acceptance Criteria

### Phase A（Debt Batch 修复）
- [x] AC-A1: 点击已发送/回显消息中的图片，弹出 lightbox 全屏预览（Esc/点击背景关闭，支持复制图片链接）。
- [x] AC-A2: 发送前的待上传图片缩略图支持同样的 lightbox 放大预览。
- [x] AC-A3: F5 刷新或切换 thread 后，无活跃 invocation 时状态面板显示“空闲”，不再误导为“等待调用...”。
- [x] AC-A4: @ mention 下拉支持输入过滤、空结果提示、滚动容器，9+ 个猫也能快速定位。
- [x] AC-A5: @ mention 下拉在键盘导航时会自动滚动到当前项，并在存在隐藏项时明确提示“↓ 还有更多猫猫”。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 上传后的消息图片支持点击预览（含回显） | AC-A1 | `pnpm --filter @cat-cafe/web test` + PR #268 | [x] |
| R2 | 发送前的待上传图片也支持点击预览 | AC-A2 | code review + `a26ca1b7` | [x] |
| R3 | 无活跃任务时不要再显示“有猫猫在工作” | AC-A3 | `right-status-panel.test.ts` + PR #268 | [x] |
| R4 | @ 列表成员太多时能过滤和滚动 | AC-A4 | `chat-input-mention-filter.test.ts` + PR #268 | [x] |
| R5 | 键盘导航时隐藏的猫猫也能被看见，并提示下面还有更多 | AC-A5 | `e9249040` + `chat-input-menus.test.tsx` | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已通过 review/test/真实使用反馈完成需求→证据映射

## Dependencies

- **Evolved from**: F039（消息队列与状态呈现基线）
- **Blocked by**: 无
- **Related**: F075（@ mention 优化直接引出了猫猫排行榜想法）

## Risk

| 风险 | 缓解 |
|------|------|
| debt batch 合并多个小改动，容易漏掉边角交互 | 用 D1/D2/D3 分项验收，review 中补齐回归测试 |
| 滚动容器类问题在本地容易被隐藏滚动条掩盖 | 增加键盘导航实测 + “还有更多”可见性提示 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 共享 `Lightbox.tsx` 而不是继续 `window.open` | 消息图片、rich block、待上传图片要统一体验，避免重复实现 | 2026-03-07 |
| KD-2 | D2 用“空闲”文案兜底，而不是在本轮补后端状态回放 | 原始痛点是“误导”，先保证文案真实，比做不完整同步更稳 | 2026-03-07 |
| KD-3 | D3 先上过滤 + 滚动 + affordance，不做 breed 分组 | 这是最小有效解，能直接解决“看不见/选不到” | 2026-03-07 |
| KD-4 | mention 空结果时只拦截 plain `Enter`，保留 `Shift+Enter` 换行 | remote review 指出语义回归，修成更精确的键位处理 | 2026-03-07 |

## Review Gate

- 本地 review：@codex（2P1 + 1P2，修复后 re-review 放行）
- remote review：1 个 P2（`Shift+Enter` 语义）修复后通过
- 愿景守护 / feat close：@gpt52

## 愿景交叉验证签收

| 猫猫 | 读了哪些文档 | 三问结论（核心问题 / 交付物 / 体验） | 签收 |
|------|-------------|-------------------------------------|------|
| Ragdoll/Ragdoll (opus) | F071 spec、PR #268、自测结果、后续 `a26ca1b7` / `e9249040` | 核心问题是 3 个高频 UX 刺点；交付物覆盖 D1/D2/D3 及两处补丁；operator日常聊天路径已顺手很多 | ✅ |
| Maine Coon/Maine Coon (codex) | F071 spec、原始对话、分支 diff、PR #268、本地测试 | 初审抓出 2P1 + 1P2；修复后复审通过，确认可 merge；说明交付物经 review 打磨后已达标 | ✅ |
| Maine Coon/Maine Coon (gpt52) | F071 spec、原始对话、PR #268、`a26ca1b7`、`e9249040`、反思胶囊 | 核心问题是“聊天时几个小刺反复打断体验”；最终交付既解决主诉求，也补上真实使用才暴露的边角；现在可以从 active backlog 正式移出 | ✅ 可 close |
