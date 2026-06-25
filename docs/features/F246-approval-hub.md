---
feature_ids: [F246]
related_features: [F128, F225, F193, F168, F231]
topics: [approval, hub, cvo-gate, cross-thread, cqrs, proposal]
doc_kind: spec
created: 2026-06-20
---

# F246: Approval Hub — 统一审批中心底座

> **Status**: done（2026-06-22）| **Owner**: Ragdoll/Ragdoll (opus-46) | **Priority**: P2

Architecture cell: platform-infra（subcell: `approval-index`）
Map delta: 新 cell — Hub 通过 feature adapter 实时聚合（query aggregation）各 feature 的 operator 审批项 + Hub UI panel。不维护独立 index，at-read-time 直查 canonical stores。
Why: operator 审批散落在各 thread（F128/F225/F193），operator不在对应 thread 就看不到。需要跨 thread 统一入口。

## Why

> operator experience（2026-06-20）："要是我没看thread呢？ 或者是我在thread a 但是b的猫找我审批呢？"
> "现在f128 和 f225 都有富文本需要我审批的东西笑死但是很多猫可能反馈operator忘记点了！"
> "我感觉这种thread内的点击审批似乎需要有个event中心。。能让我看到 点击跳转到对应thread等等等"
> "这个应该是底座 底座上是f168 193 128 225 这些可能涉及到需要我审批的"

## Current State / 现状基线

N/A — 全新能力。F246 之前不存在统一审批中心。各 feature（F128/F225/F193）的审批卡片分散在各自的 thread 消息流中，operator必须逐个 thread 翻找，无统一入口，无计数，无过期提醒。

### 痛点

1. **审批被困在 thread 里** — operator不在对应 thread 就看不到审批卡片
2. **审批散落多 feature** — F128/F225 各自做了审批卡片，operator不知道总共多少待批
3. **忘记审批** — 卡片埋没在 thread 消息流里，无人提醒
4. **没有审批中心** — 需要逐个 thread 翻

### 不是什么

- **不是把所有跨线程通讯变成审批** — F193 绝大多数场景（FYI/协调）继续自动投递，只有极少数任务分配类走审批
- **不是泛化 F168 Decision Queue** — F168 是 action queue（多 actor + 多态 action），底座是 approval queue（actor=operator + binary approve/reject），是 sibling concept 不是 parent-child
- **不是 push notification** — Hub 是 pull surface，push channel（iOS/邮件/webhook）独立问题

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

### Admission Criteria（接入资格三条件，AND）

> **eligibility ≠ v1 inclusion**：满足三条件 = 有资格接入底座。v1 是 scope 控制（MVP 先做 F128/F225/F193 E3），不是资格排除。F231 等满足条件但 v1 不接，纯粹是排期。（Maine Coon R1 P2-1）

| # | 条件 | 说明 | 反例 |
|---|------|------|------|
| 1 | actor = operator | 必须operator本人审批 | 猫间协调（FYI/ACTION）→ 自动投递 |
| 2 | binary outcome | approve / reject（可选 modify） | F168 acknowledge/resolve/waive → 多态 action |
| 3 | 跨 thread 需求 | 审批可能在operator不在的 thread 产生 | operator主动发起的操作 |

### Census（全量审批点）

| Feature | 审批项 | 接入 |
|---------|--------|------|
| F128 | propose_thread | **v1** |
| F225 | session_handoff | **v1** |
| F193 E3 | cross_thread_dispatch (任务分配) | **v1** |
| F168 | community direction | Sibling（不迁 v1） |
| F231 | propose_profile_update | **v2** |
| Knowledge Feed | 知识条目审核 | ❌ Parked（operator） |
| Limb | pair_approve | ❌ Dropped（operator） |

## What

### Phase A: Feature Adapters + Hub Panel (MVP) ✅

> **v1 架构选择（opus-48 R1 blocking 修正）**：v1 只有 3 个 canonical stores，采用 **query aggregation**（Hub 读取时直接查 canonical stores）而非 materialized CQRS index。优势：零一致性问题（always fresh）、无 backfill/phantom/reconciliation 复杂度、少写代码。v2+ store 数增多时可引入 materialized index。

- **ApprovalItem 接口**（统一 DTO，adapter 输出格式）：
  - `ownerUserId` — 审批项归属用户（Hub 按 userId 过滤，防跨用户泄露）
  - `sourceFeatureId` — 来源 feature（限 allowlist：`F128` / `F225` / `F193`，v1 硬编码）
  - `sourceThreadId`, `sourceMessageId` — 原始位置（跳转用）
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
| `fyi` | 看一眼 + 知道了 | "shared 改了请 rebuild" | ❌ 自动投递 |
| `coordinate` | 协调自己的节奏 | "你卡我了请 ack" / "请 rebase" | ❌ 自动投递 |
| `investigate` | 只读调查 | "main 上有你 feature 的 stray 文件" | ❌ 自动投递 |
| `assign_work` | 开 worktree 写代码 | "这个 bug 归你修" | ✅ Approval Hub |

- [x] **AC-B1**: F193 E3 `assign_work` 类卡片审批走底座 → Hub 可见
- [x] **AC-B2**: F193 E3 `fyi`/`coordinate`/`investigate` 类不产生 ApprovalItem（有 fixture 测试证明）
- [x] **AC-B3**: effect-class 由发送猫在 cross-post 时声明，不由底座推断
- [x] **AC-B4**: **接收侧不变量**（Maine Coon R2 P2）：`fyi`/`coordinate`/`investigate` 自动投递**永远不是开工授权**。接收猫只能知会/协调/只读调查；写代码必须有 `assign_work` 的 approved DispatchProposal 或 operator 直接指令。接收侧 prompt 注入 effect-class 标签 + 行为约束。Fixture：imperative wording（"请修这个 bug"）+ non-assign effect-class（`fyi`）= 不触发 ApprovalItem + 接收侧不授权 coding

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

## Dependencies

- **Evolved from**: N/A（全新底座能力，起源于 F193 E3 讨论中operator发现审批散落问题）
- **Related**: F128（propose_thread adapter）/ F225（session_handoff adapter）/ F193（dispatch adapter）/ F231（profile_update v2 adapter）/ F168（community ops — sibling concept, operator parked）
- **Blocked by**: none
- **Evolves to**: materialized CQRS index（条件触发：adapter 数 >5 AND p95 >250ms，见 AC-D7）

## Risk

| 风险 | 缓解 | 结果 |
|------|------|------|
| adapter fan-out 延迟随 feature 数增长 | AC-D7 双阈值 gate（>5 adapters AND p95 >250ms） | 4 adapters，阈值未触发，continue query aggregation |
| filter 引入"可见集 ≠ 全集"状态分裂 | LL-087 plan-time invariant table + batch scoped to filteredItems | Phase D alpha 8/8 PASS 覆盖边界场景 |
| F128 就地审批降级审批能力 | AC-A4 强制全量 overrides 或跳转 | Maine Coon R2 P2 守住 |
| 跨用户数据泄露 | ownerUserId 过滤 + adapter 按 userId 查询 | AC-A7 + AC-A8 |

## Close Gate Report

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
- AC-B4 ✅ met — receiver invariant enforced (prompt injection + fixture), alpha verified

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

**Summary: 25/25 AC met, 0 unmet, 0 deleted, 0 cvo_signed_off.**

## Reflection Capsule

