---
feature_ids: [F128]
related_features: [F108, F050]
related_decisions: [ADR-035]
topics: [mcp, thread, autonomy, orchestration, community, approval, rich-block]
doc_kind: spec
created: 2026-03-19
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/82
community_pr: https://github.com/zts212653/clowder-ai/pull/85
---

# F128: Cat-Proposed Thread Creation — 猫猫提议创建 Thread

> **Status**: active (Phase Y merged 2026-06-04, PR #2098) | **Source**: clowder-ai #82 (bouillipx) / PR #85 | **Priority**: P2
> **Design correction (2026-05-22)**: supersedes direct `cat_cafe_create_thread` with Proposal-First flow per ADR-035.

## Why

猫目前无法帮助team lead准备新 thread。当话题需要独立上下文时（如新 issue 调查、子任务分配），猫只能口头请求team lead去前端手动创建，打断了自主工作流。

> 发现场景（issue #82）：team lead要求"新开一个 thread"，但猫没有 API 可调，只能等team lead手动操作。

但直接给猫暴露 `cat_cafe_create_thread` 也不对。Thread 是用户可见、持久化、会改变工作空间结构的对象；猫可以起草创建信息，但不应悄悄创建。F128 的产品目标不是"猫绕过team lead创建 thread"，而是：

> 猫猫把新 thread 的信息填好，以卡片形式展示；team lead确认或编辑后，系统再创建。

## What

### Phase A: Thread Proposal API + Rich Block（核心）

- `cat_cafe_propose_thread` MCP callback tool
  - `POST /api/callbacks/thread-proposals` callback route（auth + zod schema）
  - 必填：`title`（trim 后 1-200 字符）
  - 必填：`why`（猫猫为什么建议新开 thread）
  - 可选：`initialMessage`（创建后要投递到新 thread 的第一条消息）
  - 可选：`preferredCats`（指定 thread 的默认猫）
  - 可选：`parentThreadId`（默认从 invocation 当前 thread 推导）
  - 可选：`projectPath`（默认继承 parent thread）
  - 返回 `{ proposalId }`，不返回 `threadId`，因为此阶段尚未创建 thread
- Thread proposal rich block
  - 插入当前 thread，展示标题、原因、父 thread、默认猫、初始消息
  - team lead可编辑字段
  - 操作：Create / Edit / Dismiss
- `POST /api/thread-proposals/:proposalId/approve`
  - 必须由用户 principal 调用，不能由猫 callback token 自批
  - 使用 idempotency key，重复点击不会创建重复 thread
  - 校验 `parentThreadId` 归属与 `projectPath` 权限
  - 创建成功后返回 `{ threadId }`
- `POST /api/thread-proposals/:proposalId/reject`
  - 更新卡片状态，不产生 thread
- WebSocket `thread_created` 事件
  - 新 thread 实时推送到前端 sidebar
  - 源 thread proposal 卡片更新为 created 状态
- `parentThreadId` 数据模型 — Thread 接口新增字段，Redis 维护 `thread:{parentId}:children` sorted set 二级索引
- `getChildThreads(parentThreadId)` — 父 thread 发现子 thread
- Audit trail
  - 新 thread metadata 记录 `createdFromProposalId` / `sourceThreadId` / `approvedBy` / `approvedAt`
  - 源 thread 自动追加系统消息：已创建子 thread，并链接到新 thread
  - 新 thread 自动追加 seed message，说明来源与初始任务

### ~~Phase B: 前端层级 UI + Proposal Card（需设计稿）~~ — CVO rejected (2026-05-29)

> **CVO 决策**：Sidebar 层级树形 UI 是社区原始设计，不符合自家愿景，拒绝实现。
> ProposalCard 本身已在 Phase F 实现（pin + navigate + 编辑 + 状态翻转）。

### Phase C: Thread Orchestration Skill

- 文档化"拆解→建 thread→分猫→并行→汇聚"编排模式
- 适配项目 skill manifest 体系
- 明确要求：猫猫只能 propose，不直接 create
- 明确何时不该 propose：当前 thread 内即可回答、只是临时子任务、用户已拒绝过同类提案

## Product Guardrail（ADR-035）

F128 遵循 ADR-035 Proposal-First Agent Actions：

| 决策点 | F128 规则 |
|--------|-----------|
| 猫猫能否直接创建 thread | 默认不能 |
| 猫猫能做什么 | 起草 thread proposal rich block |
| 谁确认 | team lead或具备 thread create 权限的用户 |
| 谁执行创建 | 后端使用用户确认上下文执行 |
| 如何追踪 | proposalId + sourceThreadId + approvedBy + threadId 双向链接 |
| 可否 trusted auto-create | 后续 settings opt-in，默认关闭 |

## Acceptance Criteria

- [x] AC-A1: `cat_cafe_propose_thread` 工具只创建 proposal，不创建 thread
- [x] AC-A2: proposal rich block 在源 thread 可见，字段可编辑
- [x] AC-A3: approve endpoint 必须使用用户 principal，猫 callback token 不能自批
- [x] AC-A4: approve 有 idempotency key，重复点击不创建重复 thread
- [x] AC-A5: `parentThreadId` 必须从当前 invocation 推导或校验同用户归属
- [x] AC-A6: 创建成功后源 thread 和新 thread 双向链接
- [x] AC-A7: WebSocket 推送新 thread，并更新 proposal 卡片状态
- [x] AC-A8: reject/dismiss 不产生 thread，但保留审计记录
- [x] AC-A9: skill/system prompt 明确教猫何时 propose、何时不要 propose
- [x] AC-A10: 测试覆盖 happy path、重复 approve、跨用户 parentThreadId、reject、proposal card state update

### Phase B: 后端实现（clowder-ai#85 intake，2026-05-27）

- [x] AC-B1: `RedisProposalStore` implements create/get/listByUser/listPending/markApproved/markRejected with proper Redis indices
- [x] AC-B2: `POST /api/callbacks/propose-thread` creates proposal, does NOT create thread, returns `proposalId`, supports `clientRequestId` idempotency, enforces stale guard, validates parent ownership
- [x] AC-B3: `cat_cafe_propose_thread` MCP tool registered with strong description; old `cat_cafe_create_thread` removed
- [x] AC-B4: `POST /api/proposals/:id/approve` (user auth) creates thread, is idempotent on re-approve, rejects cross-user attempts (403), conflicts on already-rejected (409), applies user edits, posts initial message if provided, writes audit fields, emits both `thread_created` + `proposal_updated`
- [x] AC-B5: `POST /api/proposals/:id/reject` (user auth) is idempotent, conflicts on already-approved, writes audit, emits `proposal_updated`
- [x] AC-B6: `Proposal` schema in shared types matches the spec model above
- [x] AC-B7: Tests cover: cat auth happy path, stale guard, ownership rejection, idempotency, user approve happy path, double-approve idempotency, cross-user approve 403, approve-after-reject 409, reject happy path, reject-then-approve 409, edit-on-approve applied to created thread

### Phase F: 前端实现（2026-05-29 CVO 补充置顶 + 卡片体验）

- [x] AC-F1: Proposal card renders in source thread on `proposal_created` socket event (no manual refresh)
- [x] AC-F2: Card prefills with cat-supplied fields; user can edit `title`, `parentThreadId`, `preferredCats`, `initialMessage` before approve
- [x] AC-F3: Approve button POSTs to `/api/proposals/:id/approve`; on success, sidebar shows new thread (via `thread_created` WS event); card flips to `approved` state with link to created thread
- [x] AC-F4: Reject button POSTs to `/api/proposals/:id/reject`; card flips to `rejected` state; thread is not created
- [x] AC-F5: Double-click protection on Approve/Reject (rely on backend idempotency + button disable on click)
- [x] AC-F6: Frontend tests cover render, edit, approve happy path, reject path, status flip via WS event
- [x] AC-F7: Approve card 新增 "📌 置顶" toggle — approve 时可选将新 thread 自动置顶（PATCH /api/threads/:id + updateThreadPin）
- [x] AC-F8: Approve 成功后自动跳转到新创建的 thread（或显示明显的导航入口）

### Phase X: 质量门禁

- [x] AC-X1: All file sizes ≤ 350 lines (split routes/components if needed)
- [x] AC-X2: No `any` types
- [x] AC-X3: `MCP_TOOLS_SECTION` updated; `thread-orchestration` skill rewritten for propose-first
- [x] AC-X4: `pnpm check` + `pnpm lint` + all affected tests green

### Phase Y: Reporting Mode 分型 ✅ merged (PR #2098, squash `914fce810`, 2026-06-04)（Maine Coon cross-post 提出 + CVO 委托猫讨论达成一致）

> **Source**: Maine Coon cross-post — 守门猫 Repo Inbox PR triage 场景里，当前 F128 默认让所有 propose 出去的 thread 回报主 thread (`proposal-enrich-header.ts:61` 并行 + `:66` 串行硬写"最后一棒回报"进 initialMessage)，triage 类任务被回报 noise 拉回。
> **Why**: thread 之间的关系不是一刀切——按"源 thread 是否背负任务"分型，4 种关系应有 4 种 reporting mode。

#### 4 种 mode 语义

| Mode | 语义 | 推荐场景 |
|------|------|---------|
| `none` (UI: `autonomous`) | 球权完全释放，源 thread 不默认持有回执责任；"不强制回报"≠"禁止上报"——下游遇 CVO 决策 / 跨 feature 冲突 / 共享文件争用 / blocking dep / 不可逆风险仍按家规主动 cross-post | Repo Inbox / PR triage / 分发 |
| `final-only` | 下游自治，最后一棒回报一次 summary | Feature work fork |
| `state-transitions` | 下游每个 phase boundary 回报（≈当前隐式默认） | Bug investigation / Research |
| `blocking-ack` | 下游必须等源 thread ack 才能继续；持球在**被阻塞的下游 thread** 不是源 thread；下游发 `[BLOCKING]` ack 请求 + 自己 `cat_cafe_hold_ball` 等 ack/超时，源 thread 不背 polling 责任；未来若加结构化 ack 回调 + EYES>0 走事件驱动不续 hold（KD-27 一致） | 等 review / 等 CVO / blocking handoff |

#### Default 决策

**Default = `none`（UI: `autonomous` / `no-required-report`）** — Ragdoll（Opus-48）+ Maine Coon（GPT-5.5）2026-06-04 收敛。

收敛论证（两条核心）：
1. **`final-only` 不解决 silent deadlock**：`final-only` 的"最后回报"也是下游主动发；下游真卡死/崩溃时既不闭环也不发 final summary → 对真正的 silent deadlock 同样无能为力。silent deadlock 的真解药是 `blocking-ack`（带 timeout）或源 thread 主动 poll，不是 `final-only`。去掉 safety 维度后，`final-only` vs `none` 退化为纯"例行 summary noise vs 静默"权衡。
2. **该权衡里 `none` 占优**：C-Y2 已保证关键上报（CVO 决策 / 阻塞 / 不可逆 / 跨 feature 冲突）在 `none` 下照常发生 → 关键路径不丢，`none` 只省"例行 phase 回报"；`none` 零额外副作用；强制回报的 noise（triage 把 summary 拉回守门猫）正是 `final-only` 的失败模式 = Maine Coon提此 feature 的初始痛点。

#### Design Constraint（实施时必须满足）

- **C-Y1**: Dynamic mode 切换 v1 不支持 — mode 是 thread contract，动态改产生历史语义歧义 + 状态迁移 UI/审计成本。要换就 propose 新 thread / 显式 handoff contract
- **C-Y2**: `none` 允许下游主动 cross-post — "不强制回报"≠"禁止上报"
- **C-Y3**: `blocking-ack` 持球边界 — 持球在**下游**（被阻塞的猫）不是源 thread；下游 `hold_ball` + 发 `[BLOCKING]` ack 请求；源 thread 不背 polling 责任
- **C-Y4**: 命名 UI 分离 — `none` 可 UI 显示成 `autonomous` 减少误读（spec 时统一决定内部字段是否同步改名）
- **C-Y5**: `none`/`autonomous` 的 header 不得出现"最后一棒回报主 Thread"/"顺序 → 回到主 Thread"文案；改写为"无强制回报；遇 CVO 决策 / 阻塞 / 不可逆 / 跨 feature 冲突按家规主动 cross-post"（Maine Coon review guard：`proposal-enrich-header.ts:61/:66` 旧硬写默认正是 Phase Y 要拆掉的，不能反过来变成保留 report-back 的理由）
- **C-Y6**: `#ideate` 与 `reportingMode` **正交** — `#ideate` 只决定并行 wake-all vs 串行接龙；report-back owner 由 `reportingMode` 决定。`#ideate + none` 不注入 reporter owner；`#ideate + final-only/state-transitions` 才指定汇总 owner（Maine Coon review guard：防止实现把"并行=必回报"耦死）

#### Acceptance Criteria

- [x] AC-Y1: `cat_cafe_propose_thread` 支持 `reportingMode?: 'none' | 'final-only' | 'state-transitions' | 'blocking-ack'` 入参（不传时按 default 走）
- [x] AC-Y2: `proposal-enrich-header.ts` 当前硬写的 report-back 文案（`:61` 并行 + `:66` 串行）拆 4 套 Reporting Protocol 段，按 reportingMode 选注入
- [x] AC-Y3: `thread-orchestration` skill 加 mode 选择指南 + 推荐场景表（含 C-Y1~C-Y6 design constraint）
- [x] AC-Y4: 测试覆盖 4 种模式（含 default fallback + edge cases；blocking-ack hold_ball 边界 C-Y3）
- [x] AC-Y5: 旧 `appendApprovedInitialMessage` 调用方（PR #2067 引入的 dispatch path）按新 enrich-header signature 同步
- [x] AC-Y6: Default 决议写入 → **`Default reportingMode = 'none'`（UI: `autonomous` / `no-required-report`）**（Ragdoll Opus-48 + Maine Coon GPT-5.5 2026-06-04 达成一致，见上 Default 决策段）

#### Open Questions（已收敛）

- ~~OQ-Y1: `blocking-ack` 是否复用 `hold_ball`？~~ → 复用 + 边界 C-Y3
- ~~OQ-Y2: Dynamic mode 切换？~~ → v1 不支持（C-Y1）
- ~~OQ-Y3: `none` 是否允许下游主动 cross-post？~~ → 允许（C-Y2）

#### Reviewer

- 提议/实施猫：Ragdoll（Opus-47 立项 + Opus-48 接手 default 收敛与实施）
- 设计 input：Maine Coon（Codex GPT-5.5）— design constraint C-Y1~C-Y6 来源（C-Y5/C-Y6 为 default 收敛时补充的实现 review guard）
- CVO sign-off：landy（立项 + 委托猫讨论 default，2026-06-04）

## Maintainer Review 结论（2026-03-19，已被 2026-05-22 产品修正补充）

**Reviewer**: Ragdoll (Opus) + Maine Coon (Codex)

社区 PR #85 整包 Take-In 不可行，原建议拆三条线：

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

### 2026-05-22 产品修正

上述 review 聚焦在 PR #85 的技术拆分与 P2 缺陷；team lead在 2026-05-22 补充了更上层的产品判断：

> 猫猫创建 thread 之类的能力应该弹出一个卡片，填写好创建的信息，team lead点击再创建，不是悄摸摸创建。

因此 PR-A 的方向也需从 `cat_cafe_create_thread` 调整为 `cat_cafe_propose_thread`。幂等性、所有权校验、Redis pipeline 仍然有效，但它们属于 approve 后执行阶段的技术约束；产品入口不再是猫直接创建。
