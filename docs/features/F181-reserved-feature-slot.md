---
feature_ids: [F181]
related_features: []
topics: [planning, reserved]
doc_kind: spec
created: 2026-04-30
---

# F181: Reserved Feature Slot — 待补充需求锚点

> **Status**: idea | **Owner**: 待定 | **Priority**: TBD
>
> 这是一个占号锚点，不是完整 spec。范围未补齐前不得开实现 worktree 或 PR。

## Why

team experience（2026-04-30）：

> "我们家里记得f181立项一下？为他保留一下？"

先保留 F181，给后续需求一个稳定 feature ID 和可追踪入口。当前信息不足以判断"他"具体指谁或哪项能力，因此本文档只记录占号事实、待补问题和正式展开前的门槛，不臆造需求范围。

## What

### Phase A: Scope Capture

- 确认"他"的具体指代：人、社区反馈、PR/issue、内部能力，或其它上下文。
- 补齐 feature 名称、owner、priority、Why/What、Acceptance Criteria、Dependencies。
- 正式进入 `spec` 前重新做关联检测，确认 F181 不是已有 feature 的子任务或重复入口。

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "f181立项一下？为他保留一下？" | AC-A1 | feature doc + BACKLOG row | [x] |
| R2 | 正式开发前补齐"他"的指代和完整需求范围 | AC-A2 | spec review | [ ] |
| R3 | 展开前确认不是重复 feature 或现有 feature 子任务 | AC-A3 | BACKLOG/features/search_evidence 关联检测 | [ ] |

### 覆盖检查

- [x] 每个已知需求点都能映射到至少一个 AC
- [x] 每个已知 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用：当前不适用）

## Acceptance Criteria

### Phase A（Scope Capture）

- [x] AC-A1: F181 有稳定 `docs/features/` 聚合文件和 `docs/ROADMAP.md` 活跃入口。
- [ ] AC-A2: 正式实现前，spec 记录清楚具体对象、owner、priority、Why、What 和可验证 AC。
- [ ] AC-A3: F181 从 `idea` 推进到 `spec` 前，完成 BACKLOG、feature docs、记忆索引的重复/关联检测，并记录结论。

## Dependencies

- **Evolved from**: none（待确认）
- **Blocked by**: CVO scope confirmation（确认"他"指代与需求范围）
- **Related**: none（待关联检测后补齐）

## Risk

| 风险 | 缓解 |
|------|------|
| 占号文档被误认为完整 spec，导致猫猫直接开工 | Status 保持 `idea`，并在文档头部写明未补齐前不得实现 |
| 后续发现其实是已有 feature 子任务 | AC-A3 要求推进前做重复/关联检测，必要时把 F181 改为 related/parking anchor |
| 未知上下文长期悬空 | BACKLOG 保留 `idea` 状态，后续由 CVO 或接球猫补 scope 后推进 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 先占号，不推断需求范围 | team lead只要求"为他保留"，当前证据不足，编造 scope 会污染真相源 | 2026-04-30 |
