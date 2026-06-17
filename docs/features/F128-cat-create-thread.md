---
feature_ids: [F128]
related_features: [F108, F050, F193]
related_decisions: [ADR-035]
topics: [mcp, thread, autonomy, orchestration, community, approval, rich-block]
doc_kind: spec
created: 2026-03-19
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/82
community_pr: https://github.com/zts212653/clowder-ai/pull/85
---

# F128: Cat-Proposed Thread Creation — 猫猫提议创建 Thread

> **Status**: active (Phase AA merged 2026-06-07 PR #2134) | **Source**: clowder-ai #82 (bouillipx) / PR #85 | **Priority**: P2
> **Design correction (2026-05-22)**: supersedes direct `cat_cafe_create_thread` with Proposal-First flow per ADR-035.

## Why

猫目前无法帮助operator准备新 thread。当话题需要独立上下文时（如新 issue 调查、子任务分配），猫只能口头请求operator去前端手动创建，打断了自主工作流。

> 发现场景（issue #82）：operator要求"新开一个 thread"，但猫没有 API 可调，只能等operator手动操作。

但直接给猫暴露 `cat_cafe_create_thread` 也不对。Thread 是用户可见、持久化、会改变工作空间结构的对象；猫可以起草创建信息，但不应悄悄创建。F128 的产品目标不是"猫绕过operator创建 thread"，而是：

> 猫猫把新 thread 的信息填好，以卡片形式展示；operator确认或编辑后，系统再创建。

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
  - operator可编辑字段
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

### ~~Phase B: 前端层级 UI + Proposal Card（需设计稿）~~ — operator rejected (2026-05-29)

> **operator 决策**：Sidebar 层级树形 UI 是社区原始设计，不符合自家愿景，拒绝实现。
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
| 谁确认 | operator或具备 thread create 权限的用户 |
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

### Phase F: 前端实现（2026-05-29 operator 补充置顶 + 卡片体验）

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

### Phase Y: Reporting Mode 分型 ✅ merged (PR #2098, squash `914fce810`, 2026-06-04)（Maine Coon cross-post 提出 + operator 委托猫讨论达成一致）

> **Source**: Maine Coon cross-post — 守门猫 Repo Inbox PR triage 场景里，当前 F128 默认让所有 propose 出去的 thread 回报主 thread (`proposal-enrich-header.ts:61` 并行 + `:66` 串行硬写"最后一棒回报"进 initialMessage)，triage 类任务被回报 noise 拉回。
> **Why**: thread 之间的关系不是一刀切——按"源 thread 是否背负任务"分型，4 种关系应有 4 种 reporting mode。

#### 4 种 mode 语义

| Mode | 语义 | 推荐场景 |
|------|------|---------|
| `none` (UI: `autonomous`) | 球权完全释放，源 thread 不默认持有回执责任；"不强制回报"≠"禁止上报"——下游遇 operator 决策 / 跨 feature 冲突 / 共享文件争用 / blocking dep / 不可逆风险仍按家规主动 cross-post | Repo Inbox / PR triage / 分发 |
| `final-only` | 下游自治，最后一棒回报一次 summary | Feature work fork |
| `state-transitions` | 下游每个 phase boundary 回报（≈当前隐式默认） | Bug investigation / Research |
| `blocking-ack` | 下游必须等源 thread ack 才能继续；持球在**被阻塞的下游 thread** 不是源 thread；下游发 `[BLOCKING]` ack 请求 + 自己 `cat_cafe_hold_ball` 等 ack/超时，源 thread 不背 polling 责任；未来若加结构化 ack 回调 + EYES>0 走事件驱动不续 hold（KD-27 一致） | 等 review / 等 operator / blocking handoff |

#### Default 决策（历史结论；2026-06-07 被 Phase AA 修正）

**Default = `none`（UI: `autonomous` / `no-required-report`）** — Ragdoll（Opus-48）+ Maine Coon（GPT-5.5）2026-06-04 收敛。

> **Superseded by Phase AA**: 这条 default 对 Repo Inbox / PR triage / 分发场景仍成立，但 2026-06-07 生产反馈显示，把 `none` 作为 `cat_cafe_propose_thread` 的通用默认会让普通 fork-and-return 子 thread 石沉大海：猫看到"无强制回报 / 接力完成即可"后不再回主 thread。Phase AA 将通用默认修正为 `final-only`，`none` 保留为显式 opt-in 的 autonomous 模式。

收敛论证（两条核心）：
1. **`final-only` 不解决 silent deadlock**：`final-only` 的"最后回报"也是下游主动发；下游真卡死/崩溃时既不闭环也不发 final summary → 对真正的 silent deadlock 同样无能为力。silent deadlock 的真解药是 `blocking-ack`（带 timeout）或源 thread 主动 poll，不是 `final-only`。去掉 safety 维度后，`final-only` vs `none` 退化为纯"例行 summary noise vs 静默"权衡。
2. **该权衡里 `none` 占优**：C-Y2 已保证关键上报（operator 决策 / 阻塞 / 不可逆 / 跨 feature 冲突）在 `none` 下照常发生 → 关键路径不丢，`none` 只省"例行 phase 回报"；`none` 零额外副作用；强制回报的 noise（triage 把 summary 拉回守门猫）正是 `final-only` 的失败模式 = Maine Coon提此 feature 的初始痛点。

#### Design Constraint（实施时必须满足）

- **C-Y1**: Dynamic mode 切换 v1 不支持 — mode 是 thread contract，动态改产生历史语义歧义 + 状态迁移 UI/审计成本。要换就 propose 新 thread / 显式 handoff contract
- **C-Y2**: `none` 允许下游主动 cross-post — "不强制回报"≠"禁止上报"
- **C-Y3**: `blocking-ack` 持球边界 — 持球在**下游**（被阻塞的猫）不是源 thread；下游 `hold_ball` + 发 `[BLOCKING]` ack 请求；源 thread 不背 polling 责任
- **C-Y4**: 命名 UI 分离 — `none` 可 UI 显示成 `autonomous` 减少误读（spec 时统一决定内部字段是否同步改名）
- **C-Y5**: `none`/`autonomous` 的 header 不得出现"最后一棒回报主 Thread"/"顺序 → 回到主 Thread"文案；改写为"无强制回报；遇 operator 决策 / 阻塞 / 不可逆 / 跨 feature 冲突按家规主动 cross-post"（Maine Coon review guard：`proposal-enrich-header.ts:61/:66` 旧硬写默认正是 Phase Y 要拆掉的，不能反过来变成保留 report-back 的理由）
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
- operator sign-off：landy（立项 + 委托猫讨论 default，2026-06-04）

### Phase AA: Reporting Contract UX + Source Attribution（2026-06-07）

> **Status**: ✅ merged (PR #2134, 2026-06-07)
> **Source**: operator 2026-06-07 反馈：猫 post 回主 thread 没有 @ 对应猫，消息存了但没有唤醒；同时 F128 子 thread 的首条消息显示成operator发的，而真实发起者是 propose 的猫。
> **Why**: Phase Y 在下游 header 里解决 reporting mode，但坐标系仍偏下游。第一性原理是：**猫在 propose 时就必须明确这个 thread 是 fork-and-return 还是 autonomous；子 thread 第一条消息必须带真实来源；需要回报时必须知道回到哪个 thread、唤醒哪只源猫。**

#### Design Decision

1. **通用默认改回 `final-only`**
   大多数 F128 propose 是"开一个子 thread 做事，做完把结果带回来"。`none` 仍是正确模式，但只适用于 Repo Inbox / PR triage / 分发给下游自治闭环等场景，必须显式选择。
2. **模式选择要场景化，不暴露成纯 enum 题**
   Tool description / system prompt / thread-orchestration skill 必须先问："这个子 thread 做完后，源 thread 是否需要结果回来？"
   - 需要结果回来 → `final-only`（默认）
   - 不需要，交给下游自治闭环 → `none`
   - 需要阶段性状态 → `state-transitions`
   - 遇阻塞必须等源 thread ack → `blocking-ack`
3. **首条消息作者 = source cat，不是 approver**
   operator点击 approve 是授权动作，不是 seed content 作者。Approved seed / initial message 应显示为 `proposal.sourceCatId` 的猫消息；`approvedBy` 继续保留在线程/proposal 审计元数据里。
4. **首条消息携带 F193/F52 风格来源元数据**
   Seed message `extra.crossPost` 必须携带 `sourceThreadId` + `sourceInvocationId`（未来若有 source message id，可一并扩展），前端复用现有 cross-post pill：可点击回源 thread，并尽量定位到 source invocation/message。
5. **Report-back 指令必须带 routing credentials**
   任何要求回报主 thread 的 header / protocol 文案，不能只说"用 `cat_cafe_cross_post_message` 回报主 Thread"。必须生成可执行的路由目标：`threadId = proposal.sourceThreadId`，`targetCats = [proposal.sourceCatId]`（或 content 行首 `@<source cat stable handle>`），确保消息不只是存入源 thread，而是唤醒等待的源猫。

#### Contract

- `reportingMode` 仍是 create-time thread contract；v1 不支持创建后动态切换（继承 C-Y1）。
- `#ideate` 与 `reportingMode` 继续正交（继承 C-Y6）：并行/串行只决定 wake 方式，report-back 由 `reportingMode` 决定。
- `none` 不强制回报，但不禁止上报。即使 `none` 下遇 operator 决策 / 阻塞 / 不可逆 / 跨 feature 冲突需要 cross-post，也必须使用 `targetCats` 或 line-start `@`，不能发无路由 cross-post。
- `sourceCatId` 是默认 report recipient；若实现需要展示 handle，应通过 cat registry / `primaryMentionHandleForCatId` 解析 stable handle，不写死中文名或模型名。

#### Acceptance Criteria

- [x] AC-AA1: `DEFAULT_REPORTING_MODE` 从 `none` 改为 `final-only`；`cat_cafe_propose_thread` 省略 `reportingMode` 时按 `final-only` 走；`none` 继续作为显式 opt-in autonomous 模式存在。
- [x] AC-AA2: `cat_cafe_propose_thread` MCP description、SystemPromptBuilder 工具提示、`thread-orchestration` skill 全部改成场景化选择指南，明确何时选 `final-only` / `none` / `state-transitions` / `blocking-ack`，避免猫只看到 enum 术语。
- [x] AC-AA3: Proposal card 继续 surface reporting mode；若未来加 approval-time reportingMode override，必须发生在线程创建前并同步 proposal 审计，不能违反 C-Y1 的"创建后不动态切换"边界。
- [x] AC-AA4: Approved seed / initial message 存储为 source-cat authored message：`catId = proposal.sourceCatId`；approval user 只进入 `approvedBy` / `approvedAt` 审计，不作为消息作者。
- [x] AC-AA5: Seed message `extra.crossPost` 写入 `{ sourceThreadId: proposal.sourceThreadId, sourceInvocationId: proposal.sourceInvocationId }`；前端复用现有 cross-post pill，可点击回源 thread，并在 `sourceInvocationId` 存在时定位到源 invocation/message。
- [x] AC-AA6: `proposal-enrich-header.ts` 的 `final-only` / `state-transitions` / `blocking-ack` report-back 文案生成明确路由：回报到 `sourceThreadId`，并用 `targetCats: [sourceCatId]` 或 line-start `@sourceHandle` 唤醒源猫；serial chain 的 final step 同样必须带 routing credentials。
- [x] AC-AA7: `none`/`autonomous` header 保留"无强制回报"，但关键事件上报文案也必须提醒使用 `targetCats` / line-start `@`，避免 voluntary cross-post 变成无唤醒消息。
- [x] AC-AA8: Tests 覆盖：default final-only；explicit none 不强制回报；seed message source-cat attribution；`extra.crossPost` round-trip + frontend pill；report-back header 含 `targetCats`/source handle；cross-post without routing 仍 fail-close（F193 AC-A4 不回退）。

#### Open Questions

- **OQ-AA1**: 当前 proposal 只有 `sourceInvocationId`，没有稳定 `sourceMessageId`。v1 先用 `sourceInvocationId` 定位；若后续能拿到 source message id，再扩展 `extra.crossPost.sourceMessageId`。
- **OQ-AA2（answered by Phase AC）**: reportingMode 是否允许 approval card 编辑？Phase AC 将答案收敛为"允许，但仅在线程创建前"：approve-time override 写入最终 contract + proposal 审计；创建后仍不支持动态切换。

#### Reviewer / Discussion

- 诊断与方案 input：Ragdoll（Opus-4.6）— 2026-06-07 指出 Phase Y default `none` + cross-post routing 指引缺失的叠加根因，并提出 source-cat attribution / F193-style source pill 方案。
- 设计收敛：Maine Coon（Codex GPT-5.5）— 接受"上游 contract 完整化"方向，补充：保留 Phase Y triage 价值但 supersede 通用 default；routing credentials 是 report-back contract 的硬要求，不是 header 文案 polish。
- operator correction：landy — 要求从第一性原理修 propose-time mode choice 和首条消息来源体验，避免下游补锅。

### Phase Z: projectPath 项目归属 — cwd 圣域回落根因修复（2026-06-05）

> **Status**: merged（PR #2118, squash `b3541acf`, 2026-06-06）
> **Source**: F200-B 愿景守护时 opus-47 在子 thread 被唤起后落到 `cat-cafe-runtime/packages/api`（runtime 圣域）——"我竟然在 runtime！🙀"。三方坐实根因（operator UI 截图 + Maine Coon live API + 代码 trace）。
> **Why**: Phase A 早已 spec `projectPath`（propose 继承 parent、approve 校验权限，见上 line 39/48），但实现从未让猫真正传/用它。propose 创建的子 thread 继承 source thread 的 `default` projectPath → 子 thread 无项目归属 → cat invocation 的 workingDirectory 解析不到有效 projectPath → cwd 回落 `process.cwd()` = runtime 圣域。本 Phase 补齐并扩展这条契约。

#### What

- **propose 契约**：`cat_cafe_propose_thread` + callback route 接受显式 `projectPath`，`validateProjectPath` 校验为 canonical real path；invalid → 400 fail-loud（绝不 silent fallback 到 source/default）；省略 → 继承 source thread。
- **approve override**：用户可在审批卡片上 re-home 子 thread（approve body 新增 `projectPath`），同样 fail-loud 校验且发生在 claim 之前（坏路径不会把 proposal 卡在 `approving`）；创建的 thread 与 proposal 审计记录同步成最终归属。
- **可见性**：proposal 卡片 surface 项目归属（`default` 显式展示、不隐藏）；MCP tool desc + system prompt 教猫"跨 repo 子 thread 必须显式传 projectPath"。

#### Acceptance Criteria

- [x] AC-Z1: propose route 接受显式 `projectPath`，valid → canonical real path，invalid → 400 fail-loud，省略 → 继承 **effective parent**（`callback-propose-thread-routes.ts`）
- [x] AC-Z2: approve body 支持 `projectPath` override，fail-loud 校验在 claim 之前；创建 thread + proposal 审计同步成最终归属（`proposal-routes.ts` + `proposal-approve-overrides.ts`）
- [x] AC-Z3: Redis `finalizeApproval` 持久化 projectPath override（`finalizedFields` HSET）— in-memory store 掩盖的 Redis-only 行为，live-redis 测试 revert-to-red 验证有齿
- [x] AC-Z4: 可见性 + 可用性 — proposal 卡片**前端**渲染项目归属 + 可编辑 projectPath 输入并提交 override（`ProposalCard.tsx`）+ MCP tool desc + system prompt projectPath 说明
- [x] AC-Z5: 测试覆盖 — propose/approve 契约（in-memory route）+ finalize 持久化（live-redis）+ system prompt 守护 + 前端卡片（vitest）
- [x] AC-Z6: 文件结构守 AC-X1 — propose/approve route 抽 `proposal-approve-overrides.ts` / `proposal-card-block.ts`，两个 route 回到 ≤350 行
- [x] AC-Z7: projectPath 默认继承 **effective parent**（显式 parentThreadId 或 source），propose + approve re-parent 都遵守；explicit override 永远赢（Maine Coon review P1-2）
- [x] AC-Z8: stale approve/reject recovery 从 created thread 回填 projectPath 审计（crash 窗口 thread 已 re-home、审计不能留旧值；Maine Coon review P1-3）

#### Scope Boundary（Maine Coon design review push-back #2）

- **cwd fallback guard 是独立 PR**：本 PR 只做"契约层"——让猫/用户能正确设置 projectPath（根因的正解）。当 projectPath 解析仍失败时的 defense-in-depth guard（走显式 env；**绝不**用 `findMonorepoRoot(process.cwd())`，否则会 mask 契约失败）拆到独立 PR 做。本 PR 不留 fallback 兜底尾巴——这是有意的设计边界，不是 deferred 的偷懒。

#### Review round 1（Maine Coon GPT-5.5，2026-06-05）→ REQUEST CHANGES → 3 P1 已修

Maine Coon code review 抓 3 个 P1（同族：projectPath 契约在非主路径不完整 / 用户侧未接线），均验证为真并修复：
- **P1-1**（commit 5d50beb83）：ProposalCard 前端没渲染/提交 projectPath → re-home 用户侧不可用。修：前端落地（AC-Z4）。
- **P1-2**（commit 1cef5cd34）：projectPath 继承 source 而非 effective parent，re-parent 挂错项目。修：propose + approve 都继承 effective parent（AC-Z7）。
- **P1-3**（commit f56933e1c）：stale recovery 丢 projectPath 审计同步。修：从 created thread 回填（AC-Z8）。
- 附带（commit d558c17d4，**非 F128**）：F192 `eval-domain-override.test.js` 的 redis cleanup 传字符串非数组（#1989 引入），阻塞共享 `test:redis` gate，顺手修（独立 commit 可拆）。

#### Reviewer

- 提议/实施猫：Ragdoll（Opus-47 根因定位 + Opus-48 接手 approve override / Redis 持久化 / 测试 / 结构 / round-1 修复）
- 设计 input：Maine Coon（Codex GPT-5.5）— fail-loud 契约 + cwd guard 拆分边界（push-back #1/#2）
- 跨族 code review：Maine Coon（GPT-5.5）— round 1 REQUEST CHANGES（3 P1）→ 已修并 APPROVE；云端 codex round 2 "no major issues"；PR #2118 merged

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

上述 review 聚焦在 PR #85 的技术拆分与 P2 缺陷；operator在 2026-05-22 补充了更上层的产品判断：

> 猫猫创建 thread 之类的能力应该弹出一个卡片，填写好创建的信息，operator点击再创建，不是悄摸摸创建。

因此 PR-A 的方向也需从 `cat_cafe_create_thread` 调整为 `cat_cafe_propose_thread`。幂等性、所有权校验、Redis pipeline 仍然有效，但它们属于 approve 后执行阶段的技术约束；产品入口不再是猫直接创建。

### Phase AB: Default-Parent Project Awareness（2026-06-09，merged）

> **Status**: ✅ merged via PR #2170 (squash `c411ba14d`)
> **Source**: operator 2026-06-09 反馈："我们的 f128 为什么创建的 thread 有的在未分类呀？难道不应该是和主 thread 一样？或者允许猫猫选到底哪个 project 如果没选那就和主 thread 一样"
> **Why**: Phase Z 的 projectPath 继承逻辑本身正确（"没选就继承 parent"）。但当 parent 本身是 `default`（eval/lobby/meta thread 无项目归属）时，子 thread 静默继承 `default` = 进"未分类"——继承合法但体验错。Live 数据验证：`F192 publish_verdict` 和 `F200-B' fix shadowConsumedMRR` 的子 thread 都是 `default`，因为 parent `thread_eval_memory` 本身就是 `default`。

#### Design Decision

1. **parent 有项目** → 继承（保持 Phase Z 现有逻辑，不动）
2. **parent 是 `default`/未分类** → 不能静默继承：
   - Proposal card 必须强提示"这个子 thread 会进未分类——请选择项目或明确确认保留未分类"
   - 用户可从已有 project 列表选择（不是纯文本框），或明确确认 default
3. **Cat-facing 引导**：tool description / skill 补一句：从 eval/default/lobby thread 发起 repo/实现类子 thread 时必须显式传 `projectPath`；纯 eval/meta thread 才可留 default
4. **可选**：已产生的误归类 thread 提供 re-home 操作（低优先级，按需决定）

#### Acceptance Criteria

- [x] AC-AB1: approve 时如果 effective projectPath = `default`，response 里加 `warnings: ["子 thread 将进入未分类"]`
- [x] AC-AB2: 前端 proposal card 在 parent 是 `default` 时，projectPath 字段升级为强提示（项目选择器或显眼 warning），不是安静的文本框
- [x] AC-AB3: `cat_cafe_propose_thread` MCP description 补充：从 `default` parent 提议实现/coding 类子 thread 时必须显式传 `projectPath`
- [x] AC-AB4: `thread-orchestration` skill 补一句同上引导

#### Implementation Notes

- API approve response: `proposal-routes.ts` returns a warning when the final projectPath remains `default`; pinned by `proposal-project-path.test.js`.
- Frontend card: `ProposalCard.tsx` detects the default ownership field, shows a visible warning, changes approve copy to "保留未分类", and `ProposalCardFields.tsx` offers existing project paths from the sidebar store plus manual absolute-path input; the picker subscribes to thread project updates so fresh loads populate after `/api/threads` hydration; pinned by `proposal-card-projectpath.test.tsx`.
- Cat-facing guidance: `cat_cafe_propose_thread` MCP description and `thread-orchestration` skill now tell cats to pass explicit `projectPath` when forking implementation/repo work from default/eval/lobby threads.

#### Diagnosis（Maine Coon GPT-5.5，2026-06-09）

- 查 live `/api/threads` 坐实：两个典型"未分类"子 thread 的 parent 都是 `thread_eval_memory`（`projectPath=default`）
- 排除后端丢字段的假设：继承逻辑在执行，是 parent 源头就没项目
- 底层能力已有（`projectPath` 可传 + approval card 可改），缺的是 UX 层的强提示

### Phase AC: Approval-Time Reporting Mode Override（2026-06-09）

> **Status**: ✅ merged via PR #2179 (squash `4a6c841d0`, 2026-06-09)
> **Source**: operator 2026-06-09 追问："F128 到底有没有模式就是主 thread 的猫要求子 thread 不要汇报？会不会格式写死最后汇报？" 进一步确认：proposal card 既然显示"回报模式"，operator approve 前也应该能改，不满意猫的选择时不该只能驳回重提。
> **Why**: Phase AA 把默认改回 `final-only`，并保留 `none` 作为 explicit opt-in。这个运行时契约是对的，但 UX 仍然让猫的选择过强：`reportingMode` 只在 propose 时填，用户审批卡只能看，不能改。结果猫忘记选 `none` 时，卡片看起来像"系统写死必须最终汇报"。第一性原理：proposal 是猫提出的草案，approve 是用户授权前的最终编辑点；回报契约和 projectPath 一样，必须能在创建前被用户修正。

#### Design Decision

1. **默认不变**：省略 `reportingMode` 仍按 `final-only`（大多数 fork-and-return 需要结果回来）。
2. **审批可覆盖**：approval card 编辑态提供 reportingMode selector，用户可把猫提议的 `final-only` 改成 `none` / `state-transitions` / `blocking-ack`。
3. **最终值唯一**：approve-time override 发生在线程创建前；创建后仍不支持动态切换，保持 C-Y1 的"thread contract 创建后固定"边界。
4. **审计同步**：proposal audit、Redis hash、seed message `## 主 Thread` header 全部使用最终 reportingMode；不能出现卡片显示 `none` 但子 thread header 仍要求 final report 的分裂。

#### Acceptance Criteria

- [x] AC-AC1: `/api/proposals/:proposalId/approve` 接受 `reportingMode` override（enum 校验，invalid 400），并在 claim 前完成解析。
- [x] AC-AC2: `resolveApproveOverrides` 输出 `finalReportingMode`；`appendApprovedInitialMessage` 使用最终值生成 header/chain protocol。
- [x] AC-AC3: `ProposalApproveOverrides` + in-memory/Redis proposal store 持久化最终 `reportingMode`，fresh Redis `get()` 不回到 create-time stale value。
- [x] AC-AC4: `ProposalCard` 非编辑态显示当前回报模式，编辑态提供场景化 selector；approve body 提交用户选择。
- [x] AC-AC5: Tests 覆盖：approve `final-only → none` 后 seed header 为 autonomous / 无强制回报；前端 selector 提交 `reportingMode`; Redis finalize 持久化 reportingMode。

#### Scope Boundary

- 本 Phase 只允许**创建前**修改 reportingMode。已创建子 thread 若要换模式，仍需新建/重提 thread；不做运行中动态切换，也不 retroactively 改旧 thread header。
