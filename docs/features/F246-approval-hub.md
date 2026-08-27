---
feature_ids: [F246]
related_features: [F128, F139, F168, F193, F208, F221, F225, F231, F260, F286]
topics: [approval, hub, cvo-gate, cross-thread, cqrs, proposal, provenance, schedule]
doc_kind: spec
created: 2026-06-20
updated: 2026-08-24
---

# F246: Approval Hub — 统一审批中心底座

> **Status**: in-progress（Phase A–H done；Phase I spec 已由 PR #3122 落地；Wave 0 由 PR #3135 交付 AC-I1/I4 与底座迁移；Wave 1 由 PR #3178 交付 F139 strict principal + create/delete approval gate（AC-I5~I7）；Wave 2 由 PR #3228 交付 F193/F260/F221 producer ingress hardening（AC-I8~I10）；Authorization 接入项已按 operator 2026-08-24 落日决定取消，后续 AC-I11/I13~I15 仍待实现）| **Phase I Owner**: Maine Coon Sol/小太阳·Maine Coon (@codex-sol)；历史 owner：Ragdoll/Ragdoll (opus-46, Phase A–H) | **Priority**: P1（Phase I）

Architecture cell: `approval-index`
Map delta: update required（Phase I）— 保留 feature adapter + query aggregation；`approval-index` 新增统一 producer ingress、单一注册表与来源双锚契约，不新增第二套 canonical proposal store。
Why: operator 审批不仅会散落，还可能进入 Hub 后失去原文锚点，或由新 producer 完全绕过 Hub。底座必须同时守住“所有猫发起的 operator gate 可见”和“每条审批可精确追溯”。

## Why

> operator experience（2026-06-20）："要是我没看thread呢？ 或者是我在thread a 但是b的猫找我审批呢？"
> "现在f128 和 f225 都有富文本需要我审批的东西笑死但是很多猫可能反馈operator忘记点了！"
> "我感觉这种thread内的点击审批似乎需要有个event中心。。能让我看到 点击跳转到对应thread等等等"
> "这个应该是底座 底座上是f168 193 128 225 这些可能涉及到需要我审批的"
>
> operator experience（2026-07-20，Phase I reopen）："审批跳转过去之后 都不知道原本在哪边的，是发出了原文是什么的？"
> "那我们的这个 approve hub的feat md 更新一下？ 你看看斑斑说的？ 哪些你认可觉得ok的"

## Current State / 现状基线

**历史基线（Phase A 前）**：F246 之前不存在统一审批中心。各 feature（F128/F225/F193）的审批卡片分散在各自的 thread 消息流中，operator必须逐个 thread 翻找，无统一入口，无计数，无过期提醒。

**Phase I reopen 基线（2026-07-20 只读审计，thread `[thread-id]`）**：

- Hub 已注册 6 个 adapter：F128 / F225 / F193 / F231 / F260 / F221。
- 最近 200 条 settled 样本中，F128 154/154、F225 6/6、F231 10/10 有 message anchor；F193 0/13、F260 0/10；F221 7/7 由 caller 传入，但字段仍可选。
- F193 已进 Hub 但 producer 不追加 chat card；F260 明确选择“不生成 confirmation card”；前端在 message anchor 缺失时仍以“查看上下文”打开 thread 根部。
- F139 调度是临时 preview + 提示词要求口头确认；agent 可直接调用持久化 endpoint。现场 25 条可见任务中 13 builtin、12 dynamic（7 active / 5 paused），dynamic store 没有原始审批 message anchor。
- F208 spec 明写 `proposal → Hub pending → operator approve/reject`，实现没有 adapter。原 Authorization thread-local 临时卡曾被列为潜伏缺口；operator 于 2026-08-24 确认当前无产品需求，选择由 F286 直接落日整套 generic permission lifecycle，而非迁入 Hub。
- 当前 adapter 数已从 AC-D7 记录的 4 增至 6，越过“达到 5 时测 p95”的测量触发点；尚无新的代表性 inbox p95 证据。

### 痛点

1. **审批被困在 thread 里** — operator不在对应 thread 就看不到审批卡片
2. **审批散落多 feature** — F128/F225 各自做了审批卡片，operator不知道总共多少待批
3. **忘记审批** — 卡片埋没在 thread 消息流里，无人提醒
4. **没有审批中心** — 需要逐个 thread 翻
5. **Hub 中的跳转不等于原文** — `sourceMessageId` 可空且同时兼任“触发原文”和“审批卡片”两种语义
6. **producer 接入靠自觉** — allowlist / API adapter / Web metadata 分散维护，新 operator gate 可以漏登记
7. **agent 侧副作用仍可绕过 gate** — F139 preview/confirm 只由 tool description 约束，服务端不验证批准事实

### 不是什么

- **不是把所有跨线程通讯变成审批** — F193 绝大多数场景（FYI/协调）继续自动投递，只有极少数任务分配类走审批
- **不是泛化 F168 Decision Queue** — F168 是 action queue（多 actor + 多态 action），底座是 approval queue（actor=operator + binary approve/reject），是 sibling concept 不是 parent-child
- **不是 push notification** — Hub 是 pull surface，push channel（iOS/邮件/webhook）独立问题
- **不是把 operator 亲手点击的每个操作再审批一次** — 已认证 operator 的同步直接操作可执行；猫代理发起或异步等待 operator 决议的动作才进入 Hub
- **不是把所有 proposal 搬进一个新总表** — canonical state 继续归各 feature store；Phase I 统一的是发布、注册、来源与副作用门禁

## User Journey（Phase I）

**Scope unit**：一条由猫/后台 producer 发起、需要 operator 决议后才能产生副作用的 proposal。

1. operator在 thread 里提出需求，或猫因异步事件产生需要 operator 决议的动作。
2. 原 thread 出现持久化富文本审批卡；卡片明确引用触发原文，或展示不可变的事件来源摘要。
3. 同一 canonical proposal 同时出现在 Approval Hub，不产生第二份审批状态。
4. 从 Hub 点“查看审批卡”精确定位该卡；从卡片点“查看触发原文”精确定位原消息。没有消息型来源时，UI 明示“事件来源”，不伪装成消息跳转。
5. operator 批准后才执行副作用；拒绝则不执行。历史记录保留相同双锚与决定人/时间。
6. operator 在调度面板亲手进行已认证的直接操作时无需二次审批；猫通过 MCP/callback 发起创建或永久删除时必须走 proposal。
7. 历史动态任务若找不到原始授权，只显示 `legacy_unanchored`；只有 operator 当前重新确认后，才新增一条真实的 re-attestation，不倒填历史批准。

## Design Discussion

详细痛点分析 + 架构图 + 三猫讨论记录：

### Key Decisions (from three-cat convergence)

| # | 决定 | 理由 |
|---|------|------|
| KD-1 | 底座新开 Feature，不泛化 F168 | F168 Queue actor 多型 + 三态，不是 approval shape |
| KD-2 | v1 只接 F128 + F225 + F193 E3 | 共性：actor=operator + binary approve/reject |
| KD-3 | v1 query aggregation / v2+ materialized index | v1 只有 3 stores，Hub 通过 feature adapter 直接查询 canonical stores（at-read-time 聚合，零一致性问题）。v2+ store 数增多时再引入 materialized CQRS index（opus-48 R1 blocking） |
| KD-4 | 就地审批有条件 | inlineMinFields 守门（summary + impact + action 非空），不靠 feature 自报 |
| KD-5 | 过期 ≠ 自动拒绝 | 过期 = 上下文 stale，按钮变"刷新/重新提议"；提醒走 Hub 徽标不追加噪音 |
| KD-6 | F193 E3 拆两半 | 自动投递先做不卡，卡片审批等底座 v1 |
| KD-7 | Hub user-scoped + adapter internal-only | 各 feature adapter 是 internal service（不暴露为 MCP/callback tool），Hub 读写都走 user auth（`resolveUserId`）（Maine Coon R1 P1-1） |
| KD-8 | v1 无独立 index → 无 backfill/phantom 问题 | query aggregation 直接读 canonical stores，数据天然一致——不存在 index drift/phantom/stale 问题。v2+ 引入 materialized index 时再补 backfill 契约（opus-48 R1 blocking 修正，Maine Coon R1 P1-2 根因消除） |
| KD-9 | F193 E3 effect-class 机械化边界 | FYI/协调/只读调查 = 自动投递（不产生 ApprovalItem）；任务分配/要求接收方改代码 = Approval Hub。有 fixture 证明非任务分配类不触发审批（Maine Coon R1 P1-3） |
| KD-10 | sender intent ≠ receiver standing ≠ action custody | effect-class 只描述发送方此次想产生的 effect。它不能偷授新活，也不能剥夺接收方独立核验后已有的责任；standing 由 F167 Phase O 核验，custody 由 ActionSuccessorLease 单账本记录。Approval Hub 只审“新增责任”。 |
| KD-11 | Phase I 两条底座不变量 | 所有猫/后台 producer 发起的 operator gate 必须进入统一审批索引；所有 Hub item 必须能精确回到审批卡与触发来源，不能以 thread 根部跳转冒充原文。 |
| KD-12 | 保留 adapter + canonical stores；Envelope 是发布契约，不是新总 store | F128/F225/F231 已健康，替换成统一 store 会重造状态机与一致性债。Phase I 让各 adapter 继续读 canonical store，但所有新 proposal 经统一 ingress 发布。 |
| KD-13 | 来源拆成 `originRef` + `approvalCardRef` | `originRef` 回答“什么触发了它”（message 或 stable event）；`approvalCardRef` 回答“在哪里审批”。废止一个 optional `sourceMessageId` 兼任两职。 |
| KD-14 | card 是 Hub 可见性的 commit point | proposal 可以先在 canonical store 预留，但只有 card 持久化并回写 messageId 后才可被 adapter 投影为 pending；失败必须删除/tombstone 并可重试，不留下 Hub-visible orphan。 |
| KD-15 | direct operator 与 cat proxy 按可信 principal 分流 | 当前 schedule route 已能识别 verified callback/agent-key，但“没有 callback”不足以证明是 operator。直接执行必须有严格 user/session identity；callback/agent-key 一律先 proposal；禁止信任 body `createdBy` 或 `default-user` fallback 授权 mutation。 |
| KD-16 | 机器门禁 runtime-first，静态 parity check 辅助 | `ApprovalIngress.publish()` 是 producer 唯一发布口；副作用 endpoint 校验 strict operator principal 或 approved proposal。CI checker 只守 registry/adapter/Web metadata/decision-route/source-policy 同源，不能替代 runtime authorization。 |
| KD-17 | 历史迁移不伪造审批 | 旧任务/旧 item 无可靠 message anchor 时标 `legacy_unanchored`，不写成 approved/rejected。operator 当前确认可生成新的 re-attestation，时间与来源均按当下记录。 |
| KD-18 | Phase I 不挂 Eval Hub | producer coverage、身份分流、卡片 commit point、精确跳转都是确定契约，用 schema/test/lint/runtime guard 验证；adapter fan-out 延迟是运行健康问题，用 p95 measurement，不造效用 eval。 |

### Admission Criteria（接入资格三条件，AND）

> **eligibility ≠ v1 inclusion**：满足三条件 = 有资格接入底座。v1 是 scope 控制（MVP 先做 F128/F225/F193 E3），不是资格排除。F231 等满足条件但 v1 不接，纯粹是排期。（Maine Coon R1 P2-1）

| # | 条件 | 说明 | 反例 |
|---|------|------|------|
| 1 | decision actor = operator | 最终决定必须由operator本人做；requester 通常是猫或后台 producer | 猫间协调（FYI/ACTION）→ 自动投递 |
| 2 | binary outcome | approve / reject（可选 modify） | F168 acknowledge/resolve/waive → 多态 action |
| 3 | 异步 / 跨 surface 需求 | proposal 可能在operator不在的 thread/surface 产生，或存活超过当前 invocation | 已认证 operator 当场亲手执行的同步操作 |

### Census（全量审批点）

| Feature | 审批项 | 接入 |
|---------|--------|------|
| F128 | propose_thread | ✅ 已接；chat card + 双向可追溯的健康范本 |
| F225 | session_handoff | ✅ 已接；chat card + message anchor |
| F193 E3 | cross_thread_dispatch (任务分配) | ⚠️ 已接 Hub；Phase I 补 chat card + origin/card 双锚 |
| F168 | community direction | Sibling（不迁 v1） |
| F231 | propose_profile_update | ✅ 已接；chat card + message anchor |
| F221 | propose_taste | ⚠️ 已接 Hub；caller sourceMessageId 可选，Phase I 改为 ingress 自产 card |
| F260 | propose_entity | ⚠️ 已接 Hub；明确无 confirmation card，Phase I 修复 |
| F139 | agent schedule create / permanent delete | ✅ Wave 1：verified cat 先 proposal，approve 后 materialize/delete；authenticated operator 直执并审计 |
| F208 | dossier distillation | ❌ spec 承诺 Hub 但无 adapter；Phase I 接入 event origin |
| Authorization system | generic permission lifecycle | ✅ sunset disposition：当前无需求，不接 Hub；F286 原子删除旧 MCP/API/Redis/UI，历史数据保留 |
| Knowledge Feed | 知识条目审核 | ❌ Parked（operator） |
| Limb | pair_approve | ❌ Dropped（operator） |

## What

### Phase A: Feature Adapters + Hub Panel (MVP) ✅

> **v1 架构选择（opus-48 R1 blocking 修正）**：v1 只有 3 个 canonical stores，采用 **query aggregation**（Hub 读取时直接查 canonical stores）而非 materialized CQRS index。优势：零一致性问题（always fresh）、无 backfill/phantom/reconciliation 复杂度、少写代码。v2+ store 数增多时可引入 materialized index。

- **ApprovalItem 接口**（统一 DTO，adapter 输出格式）：
  - `ownerUserId` — 审批项归属用户（Hub 按 userId 过滤，防跨用户泄露）
  - `sourceFeatureId` — 来源 feature（限 allowlist：`F128` / `F225` / `F193`，v1 硬编码）
  - `sourceThreadId`, `sourceMessageId` — v1 历史字段；Phase I 由 `originRef` + `approvalCardRef` 替代，迁移期只读兼容
  - `requesterCatId` — 发起审批的猫
  - `status` — `pending` / `approved` / `rejected` / `stale`
  - `summary`, `actions`, `inlineApprovable`, `expiresAt`
  - `canonicalProposalId` — 指向 canonical store 的 proposal ID
- **Feature adapters**（per-feature，internal service call only）：
  - `F128Adapter.listPending(userId): ApprovalItem[]` — 查 ThreadProposal store
  - `F225Adapter.listPending(userId): ApprovalItem[]` — 查 HandoffProposal store
  - `F246Adapter.approve(proposalId, overrides?) / reject(proposalId)` — 转发到对应 feature store
  - Adapter 是 internal service，不暴露为 MCP tool / callback endpoint
- **Hub "待审批" panel**：列表展示当前用户（`ownerUserId`）的 pending items（实时聚合各 adapter），计数徽标，点击跳转到原 thread。Hub 读/写都走 user auth（`resolveUserId`），不允许跨用户操作
- **一致性契约**：v1 = **at-read-time consistency**（每次 Hub 加载直接查 canonical stores，无 cache/index 中间层，数据天然一致）。不存在 index drift / phantom item / stale read 问题
- **就地审批**：`inlineApprovable=true` 且 `inlineMinFields` 校验通过时，Hub 内直接 approve/reject。**F128 特殊**：就地审批必须支持全量 approve-time overrides（`title`/`parentThreadId`/`preferredCats`/`initialMessage`/`projectPath`/`reportingMode`），否则强制跳转（AC-A4）
- **过期提醒**：`expiresAt` 到期 → Hub 标记 stale + 徽标提醒，不自动 reject

- [x] **AC-A1**: F128 adapter 查 ThreadProposal store → pending proposals 在 Hub 可见
- [x] **AC-A2**: F225 adapter 查 HandoffProposal store → pending proposals 在 Hub 可见
- [x] **AC-A3**: Hub panel 展示待审批列表（实时聚合）+ 计数徽标
- [x] **AC-A4**: 就地审批 F128 → adapter 转发 approve 到 F128 store。Hub inline 必须支持 F128 **全量** approve-time overrides（`title`/`parentThreadId`/`preferredCats`/`initialMessage`/`projectPath`/`reportingMode`），与现有卡片契约完全一致。如果 Hub inline 无法提供等价编辑体验（技术限制），则该 proposal **强制跳转**，不允许以 approve-only 降级审批能力（Maine Coon R2 P2）
- [x] **AC-A5**: 跳转审批 F225（需上下文）→ 跳到原 thread
- [x] **AC-A6**: 过期项标记 stale，不自动 reject
- [x] **AC-A7**: Hub 读取按 `ownerUserId` 过滤，user A 看不到 user B 的待审批项
- [x] **AC-A8**: Adapter 不暴露为 MCP tool/callback。非 allowlist feature 的聚合请求被拒绝
- [x] **AC-A9**: ~~backfill~~ v1 无需 backfill — query aggregation 直接读 canonical stores，restart 后数据天然存在（前提：canonical stores 自身满足持久化 P0 铁律）
- [x] **AC-A10**: settled items 在 adapter 查询时自动排除（`status=pending` 过滤），不需要额外 reconciliation

### Phase B: F193 E3 接入 ✅

- F193 E3 卡片审批路径接入底座
- `F193Adapter.listPending(userId)` 查 DispatchProposal store（与 Phase A 的 F128/F225 adapter 模式一致）

#### F193 E3 Effect-Class Matrix（机械化边界，Maine Coon R1 P1-3）

| effect-class | 接收方动作 | 示例 | 走底座？ |
|-------------|-----------|------|---------|
| `fyi` | 只传递信息；系统记录 receipt，不要求 LLM 礼貌 ACK | "shared 接口已变" | ❌ 自动投递 |
| `coordinate` | 对齐依赖/进度/已有责任；**不转移 implementation custody** | "你刚合入的 commit 把main弄红了，这是复现证据" | ❌ 自动投递 |
| `investigate` | 授予此次只读调查边界，不授新的实现球权 | "main 上有你 feature 的 stray 文件" | ❌ 自动投递 |
| `assign_work` | 请求给接收方**新增**实现责任；审批后再进入 action custody | "这个 bug 原本不归你，现在请你接手" | ✅ Approval Hub |

- [x] **AC-B1**: F193 E3 `assign_work` 类卡片审批走底座 → Hub 可见
- [x] **AC-B2**: F193 E3 `fyi`/`coordinate`/`investigate` 类不产生 ApprovalItem（有 fixture 测试证明）
- [x] **AC-B3**: effect-class 由发送猫在 cross-post 时声明，不由底座推断
- [x] **AC-B4**: **接收侧双向不变量**（Maine Coon R2 P2；2026-07-15 校正）：`fyi`/`coordinate`/`investigate` 自动投递本身**不授予新的 coding 责任**，也**不撤销接收方独立于本消息的已有 standing/custody**。命令式正文不能绕过 `assign_work` 偷派活；但确定性 main-red fix-forward、当前 action lease、feature owner 或 operator 既有指令也不会被 `coordinate` 反向禁止。接收侧按 F167 Phase O 三值核验：`verified` → 从自己已有责任路径 claim/continue；`mismatch` → 携证据退回；`insufficient` → 只读调查或升级。D4 fixture 锁住这个对偶边界，并禁止 courtesy-only ACK。

### Phase C: Workspace 集成 + 响应式 Tab Bar ✅

> **operator 设计决策（2026-06-21）**：Approval Hub 从 drawer overlay 迁移到 workspace panel 的顶层 tab。

#### C1: Workspace Tab 迁移

- **新 `workspaceMode: 'approval'`**：审批成为 workspace 顶层入口（与 开发/记忆/调度/任务/社区/产物 同级）
- **Bell 铃铛行为变更**：ActivityBar 铃铛保留（badge count 常驻），点击从"弹 drawer" → "打开 workspace panel + 切到审批 tab"
- **ApprovalHubDrawer 废弃**：drawer 组件标 deprecated，workspace 内的 ApprovalPanel 接替全部功能
- **ApprovalPanel**：复用现有 ApprovalItemCard + store，嵌入 workspace 容器（flex 布局，享受完整 panel 宽度）

#### C2: Workspace Tab Bar 响应式

- **三档动态适配**（基于 panel 宽度，ResizeObserver 或 resize handle 回调）：
  - **宽** ≥ `tabCount × 65px`：全部展开（icon + 文字）
  - **中**：显示前 N 个 tab + `⋯` overflow dropdown（N = `Math.floor(width / 65)`）
  - **窄** < `tabCount × 36px`：icon-only 模式 + 必要时 `⋯` overflow
- **Overflow dropdown**：收纳的 tab 点击后切换到对应 mode（功能与展开 tab 完全一致）
- **持久化**：tab 显示模式由宽度实时计算，不需要用户手动 pin/自定义

#### C3: 功能成熟化（upgraded to Phase D）

- Phase C 只交付 workspace 集成 + 响应式 tab bar。下面成熟化项不作为“close 后下次一定”，已升级为 Phase D executable plan。
- 批量操作（全部 approve / 全部 reject）
- 筛选（by feature / by thread / by 时效）
- v2 接入（F231 等）
- **F168 精确接入切口**（opus-48 F168 owner 背书）：F168 整体是 mixed actor/action queue 不适合迁，但 `direction-decision` 子类型（`community-decision-queue.ts:198`）满足 actor=cvo + binary approve/reject，v2 可抽取该子类型单独接 Hub，无需整 queue 迁移
- **Materialized index 演进**：当接入 feature 数 >5 且 query fan-out 成为瓶颈时，引入 event-driven CQRS index + backfill/reconciliation 契约（v1 的 query aggregation 是有意选择，不是技术债）

#### Phase C AC

- [x] **AC-C1**: `workspaceMode='approval'` 在 WorkspacePanel 中渲染 ApprovalPanel（列表 + inline approve/reject + 跳转）
- [x] **AC-C2**: Bell 铃铛点击 → `setWorkspaceMode('approval')` + 打开 workspace panel（不再弹 drawer）
- [x] **AC-C3**: ApprovalHubDrawer 标 deprecated，不再从 AppShell 渲染（breaking change guard：旧 bell 行为平滑切换）
- [x] **AC-C4**: Tab bar 宽度 ≥ `tabCount × 65px` 时全部展开（icon + 文字）
- [x] **AC-C5**: Tab bar 宽度不足时自动收纳溢出 tab 到 `⋯` dropdown
- [x] **AC-C6**: Tab bar 极窄时（< `tabCount × 36px`）切换到 icon-only 模式
- [x] **AC-C7**: Overflow dropdown 中的 tab 功能与展开 tab 一致（点击切换 mode）
- [x] **AC-C8**: Residual P2（Phase B review）：intercept mirror "单行首 mention 才路由" pruning — resolved by Phase D AC-D1 (regression tests in `47fe67082`)

### Phase D: Approval Hub Maturation ✅

Goal: 把 Phase C 后真实遗留的成熟化工作收束成可执行交付，而不是 v1 close 后的口头 backlog。

- [x] **AC-D1**: AC-C8 收口：intercept mirror / line-start mention pruning 完成，正文内 `@cat` 不误触发 F193 approval intercept。
- [x] **AC-D2**: WorkspaceTabBar 自动化 web 回归：full / overflow / icon-only 三档、overflow click、active-in-overflow swap 全覆盖。
- [x] **AC-D3**: ApprovalPanel + ActivityBar 自动化 web 回归：bell → workspace approval、toggle close、fetchPending、loading/empty/error、inline/jump card rendering 全覆盖。
- [x] **AC-D4**: Hub 筛选：by feature / by thread / by stale-expired 的组合筛选，作为 UI projection，不改变 canonical stores。
- [x] **AC-D5**: 批量 approve/reject：只对安全 inline items 开放；F128/F225 等需要上下文/override 的项目不可被批量 approve。
- [x] **AC-D6**: v2 adapter admission matrix：F231、F168 `direction-decision`、Knowledge Feed、Limb pair approval 逐项定 actor/outcome/store/inline fields/risk/first PR boundary。
- [x] **AC-D7**: materialized index gate：明确 adapter count + pending fetch p95 双阈值；未命中前继续 query aggregation。

### Phase D AC-D6: v2 Adapter Admission Matrix

> Evaluated 2026-06-21. Each candidate assessed against [Admission Criteria](#admission-criteria全量审批点) (actor=operator + binary outcome + cross-thread need) plus Hub-specific inline safety, persistence, and audit trail requirements.

| | F231 Profile Update | F168 Direction-Decision | Knowledge Feed | Limb Pair Approval |
|---|---|---|---|---|
| **Feature** | `propose_profile_update` | `direction-decision` subcell | Marker `needs_review` | `limb_pair_approve` |
| **Actor** | operator (user-scoped, `resolveStrictUserId`) ✅ | operator (hardcoded `actor:'cvo'`) ✅ | Implicit (no `resolveUserId`) ❌ | operator (callback-auth, not user-scoped) ⚠️ |
| **Outcome** | Binary approve/reject ✅ | Multi-field `resolve-direction` (nextOwner, assignedCatId) ❌ | Multi-state machine (6 states + undo) ❌ | Binary approve/reject ✅ |
| **Cross-thread** | Yes (cat proposes in thread, operator approves in Hub) ✅ | Yes (issue routing from board) ✅ | Unclear (marker source varies) ⚠️ | Yes (remote node pairs from outside) ✅ |
| **Canonical store** | `RedisProfileUpdateProposalStore` (Redis, TTL=0) | Read-only projection from GitHub issues | `IMarkerQueue` (abstracted, opaque) | `LimbPairingStore` (in-memory Map) |
| **Inline fields** | `rationale`, `targetPath`, `beforeContent`/`afterContent` diff — but no approve-time override UI | `title`, `ask`, `why` — insufficient for binary decision | `markerId` only — no rich display | `displayName`, `platform`, `nodeId` — sufficient |
| **Hub inline safe?** | ❌ Jump-only (same as F225: needs full context to review primer diff) | ❌ Jump-only (multi-field resolution requires board context) | ❌ N/A (admission criteria not met) | ✅ Safe (zero-decision approval, atomic) |
| **Persistence** | ✅ Redis (P0 compliant) | ✅ GitHub-backed (external) | ⚠️ Abstracted (implementation unclear) | ❌ In-memory only (P0 violation: restart = data loss) |
| **Audit trail** | ✅ `createdBy`, `approvedBy`, `approvedAt`, `rejectionReason` | ❌ No identity/timestamp fields | ❌ No `approvedBy`/`approvedAt` | ❌ No audit fields |
| **Risk** | Medium: 2-phase commit (file write + provenance), optimistic lock (409 on stale base) | Low: read-only projection, no write-through | High: collection-coupled security checks, undo capability, actor ambiguity | High: ephemeral store, auth mismatch, API key exposure |
| **First PR boundary** | Adapter + jump-only card (same pattern as F225). No inline — primer diff review requires thread context | Refactor `resolve-direction` to binary accept + separate override endpoint. Extract from F168 queue builder | Blocked: add `createdBy`/`approvedBy` + explicit operator gate + decouple collection security from approval | Blocked: migrate to Redis + add user-scoped auth adapter + add audit fields |
| **Verdict** | **v2 ready** — lowest friction, existing store pattern matches F225 adapter exactly | **v2 conditional** — needs outcome refactored to binary before adapter can be built | **Deferred** — admission criteria not met (actor + outcome both fail) | **v2 conditional** — needs persistence + auth prerequisites before adapter |

**operator verdict (2026-06-21):**

1. **F231** ✅ **v2 next** — ready now, store pattern identical to F225 adapter; jump-only card; ~1 session to build adapter + tests. Needs coordination with F231 owner to confirm store API ready.
2. **Limb pair** ❌ **Dropped** — operator verdict: "基本没用". Limb pairing is too niche for Hub integration.
3. **F168 direction-decision** ❌ **Parked** — operator verdict: "暂时不改了". F168 has its own dedicated flow, no need to force into Hub.
4. **Knowledge Feed** ❌ **Parked** — operator verdict: same as F168, has its own dedicated flow. Admission criteria also unmet.

### Phase D AC-D7: Materialized Index Gate

**Current state (2026-06-22):** 4 registered adapters (F128, F225, F193, F231). Query aggregation via `GET /api/approval-hub/pending` fan-out to all adapters at read time.

**Dual threshold — both must be true to trigger materialized CQRS index:**

| Threshold | Current | Trigger | Rationale |
|-----------|---------|---------|-----------|
| Adapter count | 3 | > 5 | Fan-out cost scales linearly with adapter count. At 3, overhead is negligible. At 5+, serial adapter queries compound latency |
| Pending fetch p95 | < 50ms (estimated, 3 adapters × Redis reads) | > 250ms | User-perceptible delay threshold. Below 250ms, Hub feels instant. Above, perceived as "loading" |

**Why query aggregation continues (v1 intentional choice, not technical debt):**

1. **Zero consistency complexity**: At-read-time queries always return fresh canonical data. No index drift, no phantom items, no stale reads, no backfill, no reconciliation job
2. **Zero write-path overhead**: Feature adapters don't need to emit events or maintain projections. Adding a new adapter = one `listPending()` implementation, no event contract
3. **Trivial correctness**: Each adapter reads its own canonical store with its own filtering logic. No cross-adapter data mixing. Settled items excluded at source
4. **3 adapters is well below threshold**: Even with F231 as v2 first candidate, count reaches 4 — still below the 5-adapter trigger

**If threshold triggers, the materialized index plan must include:**

- Event-driven write path (adapter emits `ApprovalItemCreated`/`ApprovalItemSettled` events)
- Restart/backfill contract (index rebuilt from canonical stores on startup)
- Reconciliation job (periodic cross-check index vs canonical stores, resolve drift)
- Phantom/stale item tests (index says pending, canonical says settled — and vice versa)
- Rollback path to query aggregation (feature flag to bypass index and fan-out directly)

**Measurement protocol**: When adapter count reaches 5, measure pending fetch p95 in alpha environment with representative inbox (≥10 pending items across ≥3 adapters). If p95 < 250ms, document measurement and continue aggregation. If p95 ≥ 250ms, open the materialized index plan.

### Phase E: v2 Adapters ✅

- F231 ProfileUpdateProposal adapter: jump-only card, 7-day stale, `inlineApprovable=false`
- AC-D7 index gate status: 4 adapters, below 5-adapter threshold — continue query aggregation
- Cloud review: R1 P2 (socket event emission) + R2 P1 (test file split) → R3 clean 👍

- [x] **AC-E1**: F231 adapter maps pending `ProfileUpdateProposal` → `ApprovalItem` (jump-only)
- [x] **AC-E2**: Hub panel displays F231 items alongside v1 items (filter chip + badge + color)
- [x] **AC-E3**: Tests cover: mapping, stale threshold, empty user, requesterCatId, detail fields, cardMessageId + socket event + filter/badge regression

### Phase F: Approval History ✅

> **operator 原话（2026-06-26）**："为什么我们没有审批的历史记录啊！！记录一下都审批是通过还是没通过啊！"

**Goal**: 在 Approval Hub 面板中显示已决议的审批历史（已批准/已拒绝），让operator能追溯自己的审批决策。

#### 技术边界

| 层 | 新增内容 |
|----|---------|
| **shared types** | `SettledApprovalItem` DTO（继承 ApprovalItem 去掉 status，加 `status: 'approved'\|'rejected'`、`decidedAt: number`、`decidedBy: string`） |
| **adapter port** | `IApprovalAdapter.listSettled?(userId, opts?: { limit?: number }): Promise<SettledApprovalItem[]>` — 可选方法，未实现的 adapter 默认返回 `[]` |
| **F193 store port** | `IDispatchProposalStore.listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]>` + InMemory 实现 |
| **Redis store** | `RedisDispatchProposalStore.listSettledByUser` — 扫 `status:approved` + `status:rejected` 索引，按 `decidedAt` 降序，截取 limit |
| **F193 adapter** | `F193ApprovalAdapter.listSettled` — 调 `listSettledByUser`，map → `SettledApprovalItem` |
| **F128/F225/F231 adapter** | 各自实现 `listSettled`（如底层 store 保留了 decidedAt/decidedBy 则返回数据；否则返回 `[]`，待后续 Phase 扩展） |
| **API endpoint** | `GET /api/approval-hub/settled?limit=N`（默认 50）— fan-out 到所有 adapter.listSettled，合并按 decidedAt 降序，ownerUserId 过滤 |
| **Frontend** | Hub 面板新增"历史"tab 或折叠区，每条 `SettledHistoryCard`：feature badge + status chip（✅ 批准 / ❌ 拒绝）+ summary + decidedAt（相对时间） |

#### 状态机不变量

- `SettledApprovalItem.status` ∈ `{'approved', 'rejected'}`——永远不混入 `pending/stale`
- `decidedAt` 是 epoch ms，必须 > 0；`decidedBy` 是 userId 字符串
- 历史只读：Hub 不提供对历史条目的 approve/reject 按钮
- `listSettledByUser` 不保证跨 adapter 的全局顺序——API 层合并排序
- 上限 limit=50（默认）；operator可通过 URL param 调整，上限 200

#### AC 清单

- [x] **AC-F1**: `SettledApprovalItem` 类型从 `@cat-cafe/shared` 导出，字段：`status: 'approved'|'rejected'`、`decidedAt: number`、`decidedBy: string`，其余字段继承 `ApprovalItem`（去掉旧 `status`）
- [x] **AC-F2**: `IApprovalAdapter` 新增可选方法 `listSettled?`，签名见上表；未实现的 adapter 在 ApprovalService fan-out 时安全跳过（`?.listSettled?.()`）
- [x] **AC-F3**: `IDispatchProposalStore` 新增 `listSettledByUser(userId, limit)`，InMemoryDispatchProposalStore 实现（过滤 status ∈ `{approved, rejected}`，按 decidedAt 降序，截 limit）
- [x] **AC-F4**: `F193ApprovalAdapter.listSettled` 实现并测试（mapping 正确：proposalId / sourceFeatureId / decidedAt / decidedBy / status）
- [x] **AC-F5**: `GET /api/approval-hub/settled` 端点，返回 `SettledApprovalItem[]`，ownerUserId = 登录用户，limit 默认 50；tests 覆盖空集、单 adapter 有数据、limit 截断
- [x] **AC-F6**: Hub 面板新增「待审批 | 历史」两个 tab（Option A operator 拍板），历史 tab 每条 `SettledHistoryCard`：feature badge + status chip（✅/❌）+ summary + decidedAt 相对时间
- [x] **AC-F7**: 历史区空状态文案：「还没有审批记录」
- [x] **AC-F8**: 历史区按 `decidedAt` 降序排列（最新在最上）

#### 前端 UI 决策（待operator确认）

> operator 拍板后写入此处，然后开工。

- **选项 A**：Hub panel 顶部加 `待审批 | 历史` 两个 tab，切换显示（已实现）
- **选项 B**：同一个 tab 内，pending 列表下方加折叠的「历史记录」section（默认折叠）

#### AC 清单（Phase F）

- [x] **AC-F1**: `SettledApprovalItem` 类型从 `@cat-cafe/shared` 导出，字段：`status: 'approved'|'rejected'`、`decidedAt: number`、`decidedBy: string`，其余字段继承 `ApprovalItem`（去掉旧 `status`）
- [x] **AC-F2**: `IApprovalAdapter` 新增可选方法 `listSettled?`，签名见上表；未实现的 adapter 在 ApprovalService fan-out 时安全跳过（`?.listSettled?.()`）
- [x] **AC-F3**: `IDispatchProposalStore` 新增 `listSettledByUser(userId, limit)`，InMemoryDispatchProposalStore 实现（过滤 status ∈ `{approved, rejected}`，按 decidedAt 降序，截 limit）
- [x] **AC-F4**: `F193ApprovalAdapter.listSettled` 实现并测试（mapping 正确：proposalId / sourceFeatureId / decidedAt / decidedBy / status）
- [x] **AC-F5**: `GET /api/approval-hub/settled` 端点，返回 `SettledApprovalItem[]`，ownerUserId = 登录用户，limit 默认 50；tests 覆盖空集、单 adapter 有数据、limit 截断
- [x] **AC-F6**: Hub 面板新增「待审批 | 历史」两个 tab（Option A operator 拍板），历史 tab 每条 `SettledHistoryCard`：feature badge + status chip（✅/❌）+ summary + decidedAt 相对时间
- [x] **AC-F7**: 历史区空状态文案：「还没有审批记录」
- [x] **AC-F8**: 历史区按 `decidedAt` 降序排列（最新在最上）

### Phase G: F128 + F225 Settled Adapters ✅

**Goal**: 让 F128（新建 thread 提案）和 F225（session handoff 提案）的历史审批记录也出现在审批历史 tab。Phase F 时 F193 adapter 已实现 `listSettled`；Phase G 补全其余两个主力 adapter。

#### 技术边界

| 层 | 新增内容 |
|----|---------|
| **F128 adapter** | `F128ApprovalAdapter.listSettled()` — 调 `listByUser(userId, Number.MAX_SAFE_INTEGER)`（绕过 store DEFAULT_LIST_LIMIT=100）→ 过滤 approved/rejected → 按 decidedAt DESC 排序 → 截 limit（50） |
| **F225 adapter** | `F225ApprovalAdapter.listSettled()` — 委托 `RedisSessionHandoffProposalStore.listSettledByUser()` |
| **F225 Redis store** | `listSettledByUser()` — ZREVRANGE `handoff-proposals:settled:{userId}` + pipeline HGETALL + 状态二次校验 |
| **F225 Redis settled index** | `handoff-proposals:settled:{userId}` sorted set（score=updatedAt），`finalizeApproval()` + `markRejected()` 通过 `CAS_AND_SETTLE_LUA` 原子写入（同步 CAS 状态变更 + ZREM pending + ZADD settled）|
| **Backfill script** | `backfill-f225-settled-index.mjs` — 补全 Phase G 前已决议的 F225 提案；DRY RUN 默认，`--apply` 才写；默认 Redis 6398（需显式 `REDIS_URL=redis://localhost:6399` 才能触碰生产）|
| **Refactor** | Lua 脚本提取到 `redis-handoff-lua-scripts.ts`，主文件从 402 行缩至 343 行（< 350 行 SOP 硬限） |

#### AC 清单（Phase G）

- [x] **AC-G1**: `F128ApprovalAdapter.listSettled(userId, opts?)` 实现：调 `listByUser(userId, Number.MAX_SAFE_INTEGER)` 绕过 DEFAULT_LIST_LIMIT，过滤已决议，按 `decidedAt DESC` 排序，截 `limit`（默认 50）；测试覆盖：approved/rejected mapping、pending 不出现、decidedAt 排序、>100 提案不丢失（DEFAULT_LIST_LIMIT bypass 测试）
- [x] **AC-G2**: `F225ApprovalAdapter.listSettled()` 实现：委托 `listSettledByUser`，mapping 到 `SettledApprovalItem`
- [x] **AC-G3**: `RedisSessionHandoffProposalStore.listSettledByUser(userId, limit)` — ZREVRANGE settled sorted set（按 updatedAt score）+ pipeline HGETALL + 状态二次校验；测试（Redis）覆盖：空集、批准/拒绝 mapping、decidedAt 降序、limit 截断
- [x] **AC-G4**: `handoff-proposals:settled:{userId}` sorted set 原子维护：`CAS_AND_SETTLE_LUA` 在一次 Lua 调用中完成状态 CAS + ZREM pending + ZADD settled，消除 crash window（P1 fix）
- [x] **AC-G5**: 一次性 backfill 脚本 `backfill-f225-settled-index.mjs`，DRY RUN 默认，`--apply` 写入，默认 Redis 6398（生产需显式 `REDIS_URL=redis://localhost:6399`）

### Phase H: F231 Settled Adapter + History Filter Bar + Jump Button ✅

**Goal**: 解决历史 tab 的三个用户痛点（operator 2026-07-03 反馈）：
1. F231 画像更新审批记录不出现在历史 tab（F231ApprovalAdapter 缺 `listSettled()`）
2. 历史 tab 没有 filter 能区分审批通过 vs 拒绝
3. 历史 tab 无法跳转回原始 thread/消息

**核心设计**：

| 问题 | 解法 |
|------|------|
| F231 历史缺失 | F231ApprovalAdapter 添加 `listSettled()`；IProfileUpdateProposalStore 接口扩展 `listSettledByUser()`；Redis 端 `profile-update:settled:{userId}` ZSet 原子维护（Lua CAS）；InMemory 端 collect() 支持自定义排序 |
| 无 outcome filter | ApprovalPanel 历史 tab 新增 outcome toggle（✅通过 / ❌拒绝）；与 feature chip filter 组合，互为 AND |
| 无跳转 | SettledHistoryCard 新增"查看"按钮，使用 `planTeleport` 模式（同 ApprovalItemCard.jumpToApproval）；有 `sourceMessageId` 则定位消息，否则跳 thread 入口 |

#### AC 清单（Phase H）

- [x] **AC-H1**: `F231ApprovalAdapter.listSettled(userId, opts?)` 实现：委托 `store.listSettledByUser(userId, limit)`，mapping 到 `SettledApprovalItem` DTOs（status approved/rejected，decidedAt = approvedAt ?? rejectedAt，decidedBy = approvedBy ?? rejectedBy）
- [x] **AC-H2**: `IProfileUpdateProposalStore.listSettledByUser(userId, limit?)` 接口扩展，InMemoryProfileUpdateProposalStore 实现（按 approvedAt ?? rejectedAt DESC 排序，collect() 接受可选 sort 比较器）
- [x] **AC-H3**: `profile-update:settled:{userId}` ZSet 原子写入：`CAS_FINALIZE_AND_SETTLE_LUA`（approving→approved + ZADD settled）+ `CAS_REJECT_AND_SETTLE_LUA`（pending→rejected + ZREM pending + ZADD settled）提取到 `redis-profile-update-lua-scripts.ts`
- [x] **AC-H4**: `RedisProfileUpdateProposalStore.listSettledByUser()` — ZREVRANGE + 逐条 get，一致性与 F225/F128 Phase G 模式相同
- [x] **AC-H5**: ApprovalPanel 历史 tab 新增 outcome filter（✅通过 / ❌拒绝 toggle），与已有 feature chip 组合过滤；active filter 时显示 Clear 按钮；无匹配时显示空态
- [x] **AC-H6**: SettledHistoryCard 新增"查看"跳转按钮（外链 icon + 文字），调用 `planTeleport({ threadId, messageId, currentThreadId })`；有 messageId 滚动定位，无 messageId 跳 thread
- [x] **AC-H7**: 测试覆盖：14/14 F231 adapter 测试通过（含 7 个新 listSettled 测试：空集、approved mapping、rejected mapping、pending 排除、decidedAt 排序、sourceMessageId、limit 截断）
- [x] **AC-H8**: 一次性 backfill 脚本 `backfill-f231-settled-index.mjs`，补全 Phase H deploy 前已决议的 F231 提案（code-review P1 修复）；DRY RUN 默认（需 `--execute` 才写）；sanctuary guard（默认 6398，6399 需 `--allow-sanctuary`）；4/4 sanctuary guard 测试通过

**已知限制（P3，范围外）**：历史 tab 在operator已打开的状态下发生新审批决议时，新记录不会实时出现（需切 tab 或手动刷新）。原因：`useApprovalHub` live-sync hook 目前只订阅 pending 事件，不推送 settled 事件。此限制超出本 PR 范围（不在原始三个用户投诉中），作为后续优化记录。

### Phase I: Producer Admission + Exact Provenance + Schedule Gate 🚧

> **Reopen provenance（2026-07-20）**：现状审计与方案基线来自 thread `[thread-id]` message `0001784589151623-000190-e286ebe3`；斑斑独立评议来自 message `0001784602530779-000004-7056ce19`；operator 授权更新本 spec 来自 message `0001784604430659-000047-c9c19f4d`。

**Goal**：把 Approval Hub 从“若干 feature 自愿接入的聚合 UI”升级为“猫/后台 producer 发起 operator gate 时绕不过的发布边界”，并让 Hub、审批卡、触发来源三者可精确互跳。

#### 架构收束（回应 2026-07-20 独立评议）

| 追问 | Phase I 决策 |
|------|--------------|
| Envelope 与现有 adapter 是替换还是叠加？ | **不替换 canonical store，不新增中央 proposal store。** 各 adapter 继续读取自己的 canonical state；Envelope 只统一 ingress 输出与 provenance，adapter 投影同一 proposal。 |
| F139 怎么区分 operator 亲手操作与猫代理？ | 看服务端验证过的 principal，不看 endpoint、请求 body 或“没有 callback”。authenticated user/session 可直执；callback/agent-key 一律是 cat proxy；身份缺失或不可信则 fail closed。 |
| 机器门禁是 compile-time 还是 runtime？ | **runtime 是主门禁**：proposal 发布统一走 ingress，副作用执行校验 strict operator principal 或 approved proposal；compile/CI parity checker 只防注册表、adapter、Web metadata 与 route 漂移。 |
| 历史迁移记录放哪里？ | Hub/调度 UI 展示 `provenanceState=legacy_unanchored`，它不是 approved/rejected 状态。若 operator 现在重新确认，新增一条带当前时间与双锚的 re-attestation，不篡改旧记录。 |

#### 发布契约

```ts
type ApprovalOriginRef =
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'event'; anchor: string; summary: string; threadId?: string };

interface ApprovalEnvelope {
  canonicalProposalId: string;
  sourceFeatureId: ApprovalFeatureId;
  ownerUserId: string;
  requesterCatId: string;
  originRef: ApprovalOriginRef;
  approvalCardRef: { threadId: string; messageId: string };
  createdAt: number;
}
```

- Producer 向 `ApprovalIngress.publish(draft)` 提交 canonical proposal ref、`originRef` 与 card payload；ingress 持久化 card 后返回完整 Envelope。
- Envelope 的 provenance metadata 由 feature canonical store 持久化，Hub 不另建 proposal 状态表。
- `approvalCardRef` 非空才允许 adapter 把 item 投影成 Hub-visible pending。card 写入失败时 proposal 必须保持不可审批并 tombstone/回滚，重试需幂等。
- `originRef.kind='message'` 必须精确定位消息；没有消息原文的系统事件使用稳定 `anchor` + 不可歧义摘要，UI 明示“事件来源”。
- v1 `sourceThreadId/sourceMessageId` 仅作迁移期读取兼容；新 producer 禁止继续写单锚字段。

#### F139 actor / effect matrix

| Verified principal | 创建调度 | 暂停/恢复 | 永久删除 |
|--------------------|----------|-----------|----------|
| authenticated operator user/session | 直接执行并留 audit | 直接执行并留 audit | 直接执行并留 audit |
| verified cat callback / agent-key | 创建 proposal；approve 后 materialize | 可按既有授权边界执行并留 audit | 创建 proposal；approve 后 delete |
| missing / unverified / body-claimed identity | 401/403，不写入 | 401/403，不写入 | 401/403，不写入 |

> 本 Phase 不把暂停/恢复扩大为新的 operator gate；它只封住会新增长期副作用或永久移除状态的 create/delete。若后续证据显示暂停/恢复也需要 gate，另以行为风险更新矩阵。

#### 交付波次

1. **Wave 0 — 底座先行（PR #3135）**：`ApprovalProducerRegistry` 单源、`ApprovalIngress`、双锚 DTO、truthful jump UI、adapter fan-out 分项日志；本 wave 完成 AC-I1/I4，并先迁移 F128/F225/F231，AC-I2/I3 随其余 producer 在后续 wave 收口。
2. **Wave 1 — 活风险止血（已实现）**：F139 cat-proxy create/permanent-delete proposal 化，批准后才 materialize/delete；strict principal guard 覆盖同一 mutation endpoint，暂停/恢复保留直执但统一鉴权与审计。
3. **Wave 2 — 已接但缺锚**：F193 / F260 / F221 统一生成 card，并迁移为 `originRef + approvalCardRef`。
4. **Wave 3 — 剩余漏接项**：仅 F208 dossier proposal。Authorization system 不再是 Wave 3 项：operator source `[thread-id]#0001787632982035-000007-ecf7a681` 决定当前无需求并直接 sunset；如未来出现新的授权需求，必须作为 feature-specific typed producer 重新立契约，不复活 generic once/thread/global adapter。

#### 机制选择

| Claim | 机制 | 通过证据 |
|-------|------|----------|
| producer 注册完整、card commit point、双锚、principal 分流、副作用不得提前发生 | schema + unit/integration test + runtime guard + parity checker | 精确 RED→GREEN fixtures；绕过路径返回 401/403/409 且无持久化副作用 |
| query aggregation 在 6+ adapters 下是否仍健康 | logs/measurement | alpha 代表性 inbox 的 pending fetch p95 + adapter 分项耗时 |
| Approval Hub 是否“有用” | 本 Phase 不新增 eval | 本轮要守的是确定契约，不存在 keep/tune/sunset 的不确定效用决策 |

#### AC 清单（Phase I）

- [x] **AC-I1**: `ApprovalProducerRegistry` 成为 producer/feature allowlist、API adapter、Web badge/filter metadata、decision route 与 source policy 的单一真相源；CI parity checker 对缺项或多项 fail closed。（PR #3135）
- [ ] **AC-I2**: `ApprovalIngress.publish()` 是猫/后台 producer 发布 operator proposal 的唯一入口；card 持久化成功是 Hub-visible commit point，失败不会产生 orphan pending，重试幂等。（Wave 0 已完成 ingress 事务边界与 F128/F225/F231 迁移；Wave 1 已迁移 F139；F193/F221/F260 及后续 producer 待所属 wave）
- [ ] **AC-I3**: shared DTO 与 canonical stores 支持非空 `originRef` + `approvalCardRef`；旧 `sourceThreadId/sourceMessageId` 仅保留读取兼容，新 producer 写入被 type/lint/guard 拒绝。（Wave 0 已完成 shared 契约与 F128/F225/F231 store；Wave 1 已完成 F139 persistent store；其余 canonical store 待所属 wave）
- [x] **AC-I4**: pending 与 settled UI 分别提供“查看审批卡”和“查看触发原文/事件来源”；message ref 精确定位消息，event ref 展示稳定来源；缺锚时不再显示会跳到 thread 根部的误导性“查看上下文”。（PR #3135）
- [x] **AC-I5**: schedule mutation 只接受 authenticated operator user/session 或 verified cat principal；body `createdBy`、无 callback、`default-user` 均不能提升权限。身份缺失/伪造 fixtures 返回 401/403 且 store 不变。（Wave 1，PR #3178）
- [x] **AC-I6**: verified cat 创建 schedule 时只生成 proposal；operator approve 后恰好一次 materialize，reject 不创建；authenticated operator 在调度面板亲手创建可直执并有 audit。（Wave 1，PR #3178）
- [x] **AC-I7**: verified cat 永久删除 schedule 时只生成 proposal；approve 后恰好一次 delete，reject 保留；authenticated operator 亲手永久删除可直执并有 audit。（Wave 1，PR #3178）
- [x] **AC-I8**: F193 `assign_work` producer 自动持久化审批 card，并同时写入 origin/card 双锚；FYI/coordinate/investigate 仍不产生 ApprovalItem。Ingress failure 四阶段模型（pre-card / card-persisted / envelope-anchored / fanout）。`assign_work` callback 必须携带稳定 `clientMessageId`（canonical MCP producer 自动生成），commitEnvelope 不确定结果可由同 key 恢复；anchored dedup retry 重放 thread + Hub fanout 而不重复建卡。R2 commit-point recovery + successor fence CAS；fanout best-effort；backfill 旧候选 `supersededBy` 指向 keeper 而非 newId。（Wave 2，PR #3228）
- [x] **AC-I9**: F260 entity proposal 自动持久化审批 card，并同时写入 origin/card 双锚；不再以“无 confirmation card”为设计例外。Callback 必须携带稳定 `clientRequestId`（canonical MCP producer 自动生成）；staged retry 恢复同一 proposal，anchored dedup retry 经 ingress 重放 fanout，均不按 `entityId + catId` 猜测重试身份。（Wave 2，PR #3228）
- [x] **AC-I10**: F221 taste proposal 由 ingress 生成审批 card；caller 传入的消息只可成为 `originRef`，不能让 optional `sourceMessageId` 决定 Hub 是否可追溯。Callback 必须携带稳定 `clientRequestId`（canonical MCP producer 自动生成）；staged retry 恢复同一 proposal，anchored dedup retry 经 ingress 重放 fanout。（Wave 2，PR #3228）
- [ ] **AC-I11**: F208 dossier distillation proposal 接入 Hub adapter；无 chat 原文的自动涌现使用稳定 event origin，approve/reject 后 canonical store 与 Hub 历史一致。
- [x] **AC-I12（sunset disposition）**: 不接入 Authorization system。operator 于 2026-08-24 确认当前无此产品需求并授权 F286 原子删除 generic MCP/prompt/API/Redis/UI 生命周期；Approval Hub 不新增 adapter，也不保留 thread 紧急卡或 once/thread/global 双表面。历史数据不删除。
- [ ] **AC-I13**: 历史无可靠来源的 dynamic schedule / ApprovalItem 标为 `legacy_unanchored`，不伪造 approved/rejected；re-attestation 是带当前 actor/time/双锚的新记录，有视觉区分与审计测试。
- [ ] **AC-I14**: adapter count 已达 6 后，在 alpha 以 ≥10 pending、≥3 adapters 的代表性 inbox 测 pending fetch p95，并记录分项耗时；p95 ≥250ms 才开 materialized index plan，否则记录结果并继续 query aggregation。
- [ ] **AC-I15**: 回归/UAT 覆盖 Hub ↔ card ↔ origin 双向跳转、F139 两类 principal、orphan 防护、历史缺锚视觉；F139/F208/F221/F260 的 feature truth 与 F246 census 同步。Authorization phase doc 仅保留为已落日历史 provenance。

## Dependencies

- **Evolved from**: N/A（全新底座能力，起源于 F193 E3 讨论中operator发现审批散落问题）
- **Related**: F128（propose_thread）/ F225（session_handoff）/ F193（dispatch）/ F231（profile update）/ F221（taste）/ F260（entity）/ F139（schedule）/ F208（dossier）/ F168（community ops — sibling concept, operator parked）
- **Blocked by**: none
- **Evolves to**: runtime-enforced producer ingress；materialized CQRS index 仍是条件演进（adapter 数 >5 AND measured p95 ≥250ms，见 AC-I14），不是 Phase I 默认目标

## Risk

| 风险 | 缓解 | 结果 |
|------|------|------|
| adapter fan-out 延迟随 feature 数增长 | AC-D7/AC-I14 双阈值 gate（>5 adapters AND p95 ≥250ms） | 已达 6 adapters，count 阈值触发；p95 待实测，未满足双阈值前继续 query aggregation |
| filter 引入"可见集 ≠ 全集"状态分裂 | LL-087 plan-time invariant table + batch scoped to filteredItems | Phase D alpha 8/8 PASS 覆盖边界场景 |
| F128 就地审批降级审批能力 | AC-A4 强制全量 overrides 或跳转 | Maine Coon R2 P2 守住 |
| 跨用户数据泄露 | ownerUserId 过滤 + adapter 按 userId 查询 | AC-A7 + AC-A8 |
| 新 producer 漏接 Hub | 单一 producer registry + runtime ingress + CI parity checker | AC-I1 已由 PR #3135 建立并 fail closed；AC-I2 已迁移 F128/F225/F231，其余 producer 随所属 wave 接入 ingress |
| 把“无 callback”误判成 operator | strict authenticated user/session principal；cat callback/agent-key 显式分类 | Wave 1 已完成 AC-I5~I7；mutation fail closed |
| canonical proposal 已写但 card 失败，形成无来源 pending | card 持久化作为 Hub-visible commit point + 幂等回滚/tombstone | PR #3135 已为 ingress 与 F128/F225/F231 实现；其余 producer 迁移后才完成 AC-I2 |
| 历史补录伪造审批事实 | `legacy_unanchored` provenance state + 当下 re-attestation | Phase I AC-I13 待实现 |
| 为统一而大迁移 canonical stores | Envelope 限定为发布/溯源契约，adapter 继续读 feature store | KD-12；Phase I 禁止 big-bang store replacement |

## Historical Close Gate Report（Phase A–H）

> 下列报告仅证明 Phase A–H 的历史交付；2026-07-20 reopen 的 Phase I 不在该 close verdict 内，须在 AC-I1~I15 完成后另走 close gate。

```yaml
feature_id: F246
spec_path: docs/features/F246-approval-hub.md
head_sha: 498e685b8  # Phase E alpha-validated commit
report_date: 2026-06-22
guardian: Ragdoll/Ragdoll (opus-46, owner — non-author, non-reviewer)
per_phase_guardian: Ragdoll Opus 4.7 (@opus-47, Phase B/C/D/E APPROVE)
harness_feedback: none | reason: non-harness feature, pure product capability
```

### AC Matrix

**Phase A (PR #2449)**:
- AC-A1 ✅ met — F128 adapter in `approval-hub/adapters/f128-adapter.ts`, tests in PR #2449
- AC-A2 ✅ met — F225 adapter in `approval-hub/adapters/f225-adapter.ts`, tests in PR #2449
- AC-A3 ✅ met — Hub drawer + bell badge, alpha 6/6 PASS
- AC-A4 ✅ met — F128 inline approve with full overrides (title/parentThreadId/preferredCats/initialMessage/projectPath/reportingMode), Maine Coon R2 P2 verified
- AC-A5 ✅ met — F225 jump-to-thread, alpha verified
- AC-A6 ✅ met — expiresAt → stale, no auto-reject
- AC-A7 ✅ met — ownerUserId filter, alpha verified
- AC-A8 ✅ met — adapter not exposed as MCP, allowlist guard
- AC-A9 ✅ met — query aggregation = no backfill needed
- AC-A10 ✅ met — settled items auto-excluded via status=pending filter

**Phase B (PR #2454)**:
- AC-B1 ✅ met — F193 dispatch adapter, assign_work → Hub visible, alpha 5/5 PASS
- AC-B2 ✅ met — fyi/coordinate/investigate = no ApprovalItem, fixture test
- AC-B3 ✅ met — effect-class declared by sender, not inferred
- AC-B4 ✅ met / 2026-07-15 corrected — Phase B 的“non-assign 不授新活”保留；D4 + focused fixture 补上“不剥夺已有 standing/custody”对偶边界。ActionSuccessor 硬/eval 闭环归 F167 Phase S.1，不误报为 F246 已实现

**Phase C (PR #2463)**:
- AC-C1 ✅ met — workspaceMode='approval' renders ApprovalPanel
- AC-C2 ✅ met — bell click → workspace + approval tab, alpha 6/6 PASS
- AC-C3 ✅ met — ApprovalHubDrawer deprecated, not rendered from AppShell
- AC-C4 ✅ met — full expand at ≥tabCount×65px, alpha verified
- AC-C5 ✅ met — overflow ⋯ dropdown, alpha verified
- AC-C6 ✅ met — icon-only at <tabCount×36px, alpha verified
- AC-C7 ✅ met — overflow click = mode switch, alpha verified
- AC-C8 ✅ met — intercept pruning resolved by Phase D AC-D1, regression tests in `47fe67082`

**Phase D (PR #2477)**:
- AC-D1 ✅ met — intercept mirror line-start mention pruning, regression tests `47fe67082`
- AC-D2 ✅ met — WorkspaceTabBar automated web regression (full/overflow/icon-only), vitest
- AC-D3 ✅ met — ApprovalPanel + ActivityBar automated regression, vitest
- AC-D4 ✅ met — filter by feature/thread/stale, alpha 8/8 PASS
- AC-D5 ✅ met — batch approve/reject with inline guard, alpha verified (select-all scoped to filteredItems)
- AC-D6 ✅ met — v2 admission matrix: F231 ready, Limb dropped, F168/KF parked (operator verdict)
- AC-D7 ✅ met — materialized index gate: dual threshold documented, 4 adapters < 5 trigger

**Phase E (PR #2487)**:
- AC-E1 ✅ met — F231 adapter maps ProfileUpdateProposal → ApprovalItem (jump-only), cloud R3 clean
- AC-E2 ✅ met — Hub displays F231 items with orange "Profile" badge + filter chip, alpha 4/4 PASS
- AC-E3 ✅ met — tests: mapping, stale, empty user, requesterCatId, detail fields, cardMessageId, socket event, filter/badge regression

**Phase A–E Summary: 25/25 AC met, 0 unmet, 0 deleted, 0 cvo_signed_off.**

**Phase F (AC-F1~F8):**
- AC-F1~F8 ✅ met — SettledApprovalItem + GET /api/approval-hub/settled + Redis settled ZSet + Hub 历史 tab + SettledHistoryCard; @gpt52 APPROVE + Codex cloud R1 P2 fixed + CI ✅

**Phase G (AC-G1~G5):**
- AC-G1 ✅ met — F128 listSettled() with DEFAULT_LIST_LIMIT bypass + tests (10/10)
- AC-G2 ✅ met — F225 listSettled() via listSettledByUser delegation
- AC-G3 ✅ met — Redis listSettledByUser ZREVRANGE + pipeline + double-check (8/8 Redis tests)
- AC-G4 ✅ met — atomic CAS_AND_SETTLE_LUA (status CAS + ZREM + ZADD in one Lua call)
- AC-G5 ✅ met — backfill script, DRY RUN default, 6398 default (prod explicit override)

**Phase H (AC-H1~H8):**
- AC-H1 ✅ met — F231ApprovalAdapter.listSettled() delegating to listSettledByUser, SettledApprovalItem mapping
- AC-H2 ✅ met — IProfileUpdateProposalStore interface + InMemory implementation (collect() with optional sort comparator)
- AC-H3 ✅ met — CAS_FINALIZE_AND_SETTLE_LUA + CAS_REJECT_AND_SETTLE_LUA in redis-profile-update-lua-scripts.ts, atomic ZADD settled
- AC-H4 ✅ met — RedisProfileUpdateProposalStore.listSettledByUser() via ZREVRANGE loadFromIndex
- AC-H5 ✅ met — ApprovalPanel outcome filter (✅通过/❌拒绝 toggle) + Clear button + empty state
- AC-H6 ✅ met — SettledHistoryCard "查看" button using planTeleport (scrollNow → scrollToMessage; navigateTo → pushThreadRouteWithHistory)
- AC-H7 ✅ met — 14/14 F231 adapter tests pass (7 new listSettled tests)
- AC-H8 ✅ met — backfill-f231-settled-index.mjs: dry-run default, --execute writes, sanctuary guard (4/4 tests pass)

## Reflection Capsule

