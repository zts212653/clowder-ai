---
feature_ids: [F109]
related_features: [F068, F069]
topics: [chat, ux, message-actions]
doc_kind: spec
status: in-progress
created: 2026-03-12
---

# F109: Message Actions 修复与增强 — 软删除/Branch/编辑/通知

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

team lead测试消息操作功能时发现一系列问题：

> "点了软删除之后，发现前端这个并没有删掉，就前端气泡还在，那你这算啥软删除？"

消息操作（删除、Branch、编辑）是 Chat 的基础交互。当前状态：
- **软删除形同虚设**：后端标记了 deletedAt，但前端气泡不消失（P0）
- **Branch From 权限过严**：只有 thread creator 能 branch，猫的消息点了没反应（P1）
- **错误静默吞掉**：Branch 失败返回 403 但前端无 toast（P2）
- **编辑 = Branch**：没有就地编辑，只有"改了重建分支"（需求讨论）
- **修正无通知**：编辑后其他参与者无感知（需求讨论）

## What

### Phase A: Bug Fix — 软删除 + Branch 权限修复

修复现有功能的 P0/P1/P2 bug。

1. **软删除前端不生效**
   - **根因**（Maine Coon分析，高置信）：`removeMessage` 只改 flat `messages` 数组，不改 `threadStates[threadId]`。socket 回调 `onMessageDeleted` 丢了 `threadId`。切线程后气泡保留在 background thread state 里。
   - **修法**：补 `removeMessageFromThread(threadId, id)` 对称 API；socket 事件带 `threadId` 传到底
   - 同时：DELETE non-2xx 必须 toast，不能静默吞掉
   - **⚠️ hard delete 一并覆盖**（KD-7）：hard/soft 走同一个 `onMessageDeleted` 回调（`useSocket.ts:331`），thread-scoped remove 必须同时覆盖两者

2. **restore 半残修复**
   - **现状**：后端广播 `message_restored`（`message-actions.ts:163`），但前端回调是 no-op（`useChatSocketCallbacks.ts:86`）
   - **修法**：socket 到达后 refetch 当前 thread（restore 低频，refetch 最简且不出状态不一致）

3. **Branch From 权限放宽**
   - **根因**：`thread-branch.ts:131` owner-only 判断
   - **修法**：最小改为 `createdBy === userId || createdBy === 'system'`
   - **⚠️ 不用 `participants` 做 ACL**（KD-2）：`participants` 是 `CatId[]` 路由元数据，不是权限模型

4. **Branch 失败错误提示**
   - 前端 catch API 403/500 后显示 toast，附具体原因

### Phase B1: 编辑文案澄清 + Tail Message 真编辑（安全子集）

编辑三档分层（KD-3）：

| 消息位置 | 操作 | 理由 |
|----------|------|------|
| 最新一条用户消息，后面没回复 | 真 in-place edit | 安全，不破坏上下文链 |
| 更早的用户消息 | "改写并分支"（文案澄清） | 避免破坏下游回复的上下文基础 |
| 猫的消息 | v1 不支持编辑 | ownership + 审计，人改猫的话必须留强标记 |

### Phase B2: Revision System（独立切，不和 A 一锅煮）

> **前置依赖**：message `kind` 显式化必须先做，否则 revision note 会被错误塞进 `user`/`connector` 语义（Maine Coon@gpt52 提醒）

1. **Revision Store**（KD-4）：独立 store，不塞 message hash
   - 主消息只放 `editedAt/editedBy/revisionCount/latestRevisionId`
   - 旧版本快照放独立 key

2. **WebSocket 事件**（KD-5）：专用 `message_edited`，不搞泛化 `message_updated`

3. **修订通知**（KD-6）：revision note 不走 unread 计数
   - 需引入显式 message `kind` 字段（`chat` / `system` / `revision`）
   - revision note 进历史流，让猫在增量上下文中看到；但不算 UI 未读 badge
   - cursor `getByThreadAfter` 语义不动

## Acceptance Criteria

### Phase A（Bug Fix）✅
- [x] AC-A1: 软删除后，当前 tab 的消息气泡立即消失
- [x] AC-A2: 软删除后，其他已连接 client / 切线程后气泡也消失（WebSocket + threadState 同步）
- [x] AC-A3: 刷新页面后，已软删除的消息不再出现
- [x] AC-A4: hard delete 复用同一 thread-scoped remove，不回归
- [x] AC-A5: restore 跨客户端同步（socket 到达后 refetch via requestStreamCatchUp）
- [x] AC-A6: team lead可以在任何 thread 中 Branch From 任意消息（含 system thread）
- [x] AC-A7: Branch/Delete 失败时前端显示 toast 错误提示
- [x] AC-A8: 已有测试不回归 + 新增 15 个测试（socket wiring + toast 4路径 + branch permission + restore + identity fix）

### Phase B1（编辑安全子集）
- [ ] AC-B1-1: 最新一条用户消息（无后续回复）可真编辑
- [ ] AC-B1-2: 更早的用户消息按钮文案改为"改写并分支"
- [ ] AC-B1-3: 猫的消息不显示编辑按钮

### Phase B2（Revision System）
- [ ] AC-B2-1: Revision store 独立实现 + 测试
- [ ] AC-B2-2: `message_edited` WebSocket 事件
- [ ] AC-B2-3: 显式 message `kind` 字段，revision 不计 unread badge

## Dependencies

- **Related**: F068（新建对话弹窗 UX 优化）
- **Related**: F069（Thread Read State — revision 通知依赖未读系统）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase B2 revision system 涉及 message kind 重构 | 独立切，不和 Phase A 一锅煮 |
| `participants` 误用为 ACL 会把路由和权限搅混 | KD-2 明确禁止，branch 用最小方案 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Phase A / B1 / B2 分开，A 先行 | bug fix 不应被需求讨论阻塞 | 2026-03-12 |
| KD-2 | `participants` 不做 ACL，branch 用 `createdBy === userId \|\| createdBy === 'system'` | participants 是 CatId[] 路由元数据，不是权限模型（Maine Coon@gpt52） | 2026-03-12 |
| KD-3 | 编辑三档分层：tail-edit / branch-rewrite / cat-no-edit | 避免破坏上下文链和审计（Maine Coon@gpt52） | 2026-03-12 |
| KD-4 | Revision 独立 store，主消息只放元数据 | 不污染 message hash（Maine Coon@gpt52） | 2026-03-12 |
| KD-5 | WebSocket 用 `message_edited` 专用事件 | 删除/恢复/编辑是不同前端语义（Maine Coon@gpt52） | 2026-03-12 |
| KD-6 | Revision note 不走 unread 计数，引入显式 message `kind` | 防止team lead编辑触发 UI 未读 badge（Maine Coon@gpt52） | 2026-03-12 |
| KD-7 | Phase A 同时覆盖 soft/hard delete + restore | hard/soft 走同一回调，restore 前端是 no-op（Maine Coon@gpt52 R2 补充） | 2026-03-12 |
| KD-8 | B2 前置：message `kind` 必须先显式化 | 历史接口靠推断，不先解约束 revision note 会串语义（Maine Coon@gpt52 R2 补充） | 2026-03-12 |
