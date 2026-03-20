---
feature_ids: [F128]
related_features: [F108, F050]
topics: [mcp, thread, autonomy, orchestration, community]
doc_kind: spec
created: 2026-03-19
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/82
community_pr: https://github.com/zts212653/clowder-ai/pull/85
---

# F128: Cat-Initiated Thread Creation — 猫程序化创建 Thread

> **Status**: spec | **Source**: clowder-ai #82 (bouillipx) / PR #85 | **Priority**: P2

## Why

猫目前无法程序化创建 thread。当话题需要独立 thread 时（如新 issue 调查、子任务分配），猫必须请team lead在前端手动创建，打断了自主工作流。

> 发现场景（issue #82）：team lead要求"新开一个 thread"，但猫没有 API 可调，只能等team lead手动操作。

## What

### Phase A: API + MCP 工具（核心）

- `cat_cafe_create_thread` MCP callback tool
  - `POST /api/callbacks/create-thread` callback route（auth + zod schema）
  - 必填：`title`（trim 后 1-200 字符）
  - 可选：`preferredCats`（指定 thread 的默认猫）
  - 可选：`parentThreadId`（父子 thread 编排追踪）
  - 返回 `{ threadId }` 供猫立即 cross_post_message
- WebSocket `thread_created` 事件 — 新 thread 实时推送到前端 sidebar
- `parentThreadId` 数据模型 — Thread 接口新增字段，Redis 维护 `thread:{parentId}:children` sorted set 二级索引
- `getChildThreads(parentThreadId)` — 父 thread 发现子 thread

### Phase B: 前端层级 UI（需设计稿）

- Sidebar 可折叠展开子 thread 树形展示
- 树形连接线（├──/└──）+ 猫头像 + @handle 标签
- 展开/收起状态 localStorage 持久化
- **前置条件**：需 .pen 设计稿 + ThreadSidebar 重构（当前 727 行，超 350 行硬上限）

### Phase C: Thread Orchestration Skill

- 文档化"拆解→建 thread→分猫→并行→汇聚"编排模式
- 适配项目 skill manifest 体系

## Maintainer Review 结论（2026-03-19）

**Reviewer**: Ragdoll (Opus) + Maine Coon (Codex)

社区 PR #85 整包 Take-In 不可行，建议拆三条线：

| 线 | 范围 | 状态 |
|----|------|------|
| PR-A: API + MCP | callback route, MCP tool, parentThreadId, WebSocket, tests | 修 P2 后可合入 |
| PR-B: 前端层级 UI | ThreadHierarchyToggle, thread-hierarchy.ts, Sidebar 改动 | 需 .pen 设计稿 + Sidebar 重构 |
| PR-C: Skill | thread-orchestration SKILL.md + manifest | 适配后单独合入 |

### 阻塞项（PR-A 合入前需修复）

1. **幂等性**：`create-thread` route 无 idempotency key，callbackPost 重试会创建重复 thread
2. **parentThreadId 所有权校验**：当前接受任意 parentThreadId，可跨用户污染 children 索引
3. **Redis N+1**：`getChildThreads` 逐个 `this.get(id)`，应用 pipeline

### 建议改进

4. softDelete/delete 应清理 children 索引
5. `IThreadStore.create()` 4 个位置参数 → 建议 options 对象
6. 合入时 squash commits
