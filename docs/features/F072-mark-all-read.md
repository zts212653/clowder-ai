---
feature_ids: [F072]
related_features: [F069]
topics: [unread, badge, ux, thread-sidebar]
doc_kind: spec
created: 2026-03-07
---

# F072: Mark All Read — 一键清理未读 Badge

> **Status**: done | **Owner**: 三猫
**Completed: 2026-03-07**
**PR**: #270 (commit `3071eb14`)

## Why

operator在日常使用中，Thread 侧栏的未读数字 badge 累积过多（尤其冷启动/F5 刷新后），分散了对猫猫状态颜色（橙色/黄色/绿色）的注意力。需要一种快速方式清掉所有未读数字，只保留猫猫活跃状态的视觉提示。

## What

1. **后端 API**: `POST /api/threads/read/mark-all` — 遍历当前用户的所有 thread，对每个 thread 的 read cursor ack 到最新消息
2. **前端按钮**: ThreadSidebar 顶部添加"全部已读"按钮，点击后调用 API 并清空本地 unread state
3. **UX 细节**:
   - 清除的是 unread count（数字 badge），不影响猫猫状态颜色指示器（橙/黄/绿）
   - 按钮仅在有 ≥1 个 unread thread 时可见/可点击
   - 操作后即时更新 UI（乐观更新），无需刷新

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: 用户点击"全部已读"后，所有 thread 的 unread count badge 消失
- [x] AC-2: 猫猫状态颜色（橙/黄/绿）不受影响，仍然正常显示
- [x] AC-3: 后端 ack 幂等 — 重复点击不报错
- [x] AC-4: 无 unread thread 时按钮禁用或隐藏
- [x] AC-5: 有对应的后端集成测试 + 前端交互测试

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "一键清理未读消息" | AC-1 | test + screenshot | [x] |
| R2 | "只看到猫猫是橙色 黄色 绿色 他的目前状态" | AC-2 | screenshot | [x] |
| R3 | 幂等操作，不能因重复点击出错 | AC-3 | test | [x] |
| R4 | 没有未读时不要显示无意义按钮 | AC-4 | screenshot | [x] |
| R5 | 测试覆盖 | AC-5 | test output | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Key Decisions

- 只清 unread count，不清猫猫状态颜色（operator明确区分了这两种视觉信息）
- 复用 F069 的 `RedisThreadReadStateStore.ack()` 批量调用，不引入新的存储机制

## Dependencies

- **Evolved from**: F069（Thread Read State 基础设施）
- F069 Thread Read State（已完成，read cursor 基础设施）

## Risk

- 低风险：只是对已有 ack 接口的批量封装
- 安全：只修改当前用户自己的 read cursor，auth 中间件已有 userId 校验

## Review Gate

- 本地 review: 跨 family（codex）
- remote review: PR comment 触发

## 签收表

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll/Ragdoll (opus) | F072 spec, thread 03:00 原话, threads.ts, ThreadSidebar.tsx, chatStore.ts | 核心问题=badge 噪音; 交付物=一键清零+状态色保留; 体验=点一次数字消失猫色仍在 | ✅ |
| Maine Coon/Maine Coon (codex) | F072 spec, thread 03:00 原话, threads.ts:382, ThreadSidebar.tsx:279, chatStore.ts:898 | 同上，独立验证对齐 | ✅ |
