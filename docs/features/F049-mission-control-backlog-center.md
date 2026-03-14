---
feature_ids: [F049]
related_features: [F037, F058]
topics: [mission-control, backlog, tasking, swarm]
doc_kind: note
created: 2026-03-01
---

# F049: Mission Hub — Backlog Center（领取/派发/自动开 Thread）

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-03-01
> **Completed**: 2026-03-03
> **Priority**: P1（指挥中心基建）

---

## Why

team lead希望把“想法/任务”的全局调度放进 Cat Café 本体，而不是依赖 IDE 打开 `docs/`：

- **低摩擦**：随手记录/分拣/派发不该要求打开 VSCode/WebStorm。
- **跨 thread 协同**：未来可以同时开多个 thread（多组猫猫）并行作战，需要一个全局任务池承载“要做什么”。
- **演进路径**：早期team lead指挥更安全；未来模型能力提升后，逐步放开自组织协作（权限棘轮）。

这条线与 F037（Agent Swarm）中的 “Global Backlog → 领取/批准 → 自动开新 Thread” 强绑定。

## What

在 Cat Café 里新增一个 **Mission Hub / Backlog Center**：

- 作为**全局任务池（Global）**：收纳 “想法/任务/候选 Feature/Tech Debt”；
- 支持**建议领取 → team lead批准 → 自动创建执行 thread（Thread）**；
- 建立**可配置的权限棘轮**：从“建议+批准”逐步演进到“自领”。

> 核心边界：Backlog Center 负责“要做什么 + 派发/领取”，Thread 负责“怎么做 + 执行细节”，用 thread 隔离上下文污染与并发互踩风险。

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
### MVP（建议+批准）
- [x] Web/PWA 可打开 Backlog Center（手机可用）。
- [x] 任何人（team lead/猫）可创建 backlog item（标题 + 简述 + priority + tags）。
- [x] 猫可以对某 item 发起“建议领取”（suggest claim），并附 Why/Plan 简述。
- [x] team lead可以一键批准/拒绝该建议。
- [x] 批准后系统自动创建新 thread，并：
  - [x] 关联 `backlogItemId`（backlog ↔ thread 双向可追溯）
  - [x] 写入 thread phase（至少：`coding` / `research` / `brainstorm`）
  - [x] 在新 thread 首条消息里自动注入：任务描述 + 验收标准 + 相关链接
- [x] Backlog item 状态自动流转：`open → approved → dispatched`（最小闭环）。
- [x] 支持手动“从 `docs/ROADMAP.md` 导入/刷新”活跃 Feature 到 Redis backlog（显式触发，避免双真相源自动同步）。

### 并发安全（lease）
- [x] “执行中”态有 lease（owner + expiresAt + 心跳续租），超时可回收。
- [x] 所有状态变更有审计记录（谁、何时、对哪个 item、做了什么）。

### 演进（权限棘轮）
- [x] 有一个配置项（once/thread/global）控制是否允许 self-claim：
  - [x] 默认关闭：只能”建议+批准”
  - [x] 未来可开启：满足条件后允许猫自领（仍保留审计与回收）

### ~~Phase B：线程级路由策略~~ — 已在 F042 PR #148 完成
> **修正 (2026-03-02)**：routing-policy-scopes 已通过 PR #148 (`b0cadb6a`) 作为 F042 交付物合入 main，不再需要 F049 承接。

## Key Decisions

1. **两层任务面**：Global Backlog 承载“要做什么”，Thread 承载“怎么做”。
2. **领取模型**：先做“建议领取 + team lead批准”，再用权限棘轮逐步放开 self-claim。
3. **存储策略（活数据层）**：Backlog item 的真相源在 **Redis（OLTP）**，以支持 claim/lease/heartbeat/atomic dispatch 等原子语义。
4. **并发控制**：采用 service 侧 lease（Redis 原子/CAS）而非 repo 内 lock file 作为唯一真相源。
5. **毕业机制（与 `docs/` 的关系）**：Backlog Center 是“上游 inbox/调度层”；当 backlog item 被确认需要长期追溯时，才“毕业”为 `docs/features/F0xx.md`（F040 管的已立项真相源）。
6. **真相源边界**：Branch/worktree 只是提案与开发隔离环境；团队共享的真相源是 `origin/main`，必须通过 PR 合入后才算“全局可见”。

## Storage & Graduation（详细说明）

### Redis-first（为什么）

F049 的核心操作包含：claim/lease/heartbeat/原子派发/审计。这是典型 OLTP 语义；用 Git/Markdown 作为真相源会引入 merge conflict 与高延迟交互，且难以保证原子性与回收语义。

### “毕业”而非“双向同步”

我们不做 “Redis ↔ Git 双向同步”。两层的关系是：

- **Redis inbox（高频、易变）**：收集/分拣/建议领取/派发/lease。
- **`docs/features/`（稳定、可追溯）**：被确认的 Feature/Tech Debt 才进入真相源体系（F040）。

从 inbox 到 `docs/features/` 的“毕业”动作，需要显式确认（team lead批准/立项）并记录链接，避免双真相源漂移。

## Rejected Alternatives

- **Git-only**：无法自然承载 claim/lease/heartbeat 的原子语义，且移动端随手记录会被 commit/push 延迟拖垮。
- **Git 主 + Redis 缓存**：需要双写与一致性维护，复杂度上升但不带来关键收益。

## Risk / Blast Radius

- **双真相源漂移**：Backlog Center 与 `docs/` 容易分叉。
  - 缓解：把 `docs/features/*` 视作“已立项/已落盘”的稳定层；Backlog Center 负责更上游的 inbox 与派发。
- **并发/权限事故**：自领过早会导致重复执行、互踩文件、越权写入。
  - 缓解：默认“建议+批准”；任何自领都必须有 lease + 审计 + 可回收。
- **自动开 thread 的 UX**：thread 命名、phase 选择、上下文注入不当会引入噪音。
  - 缓解：先做最小可用，再通过真实使用迭代。

## Dependencies

- **Evolved from**: F037
- **~~F042 毕业~~**: routing-policy-scopes 已在 F042 PR #148 完成，不再需要 F049 承接
- **Depends on**: F043（`list_threads`/`feat_index` 提供更完整协作基建；但 Phase4 态势图 MVP 不以其为硬阻塞）
- **Evolves into**: F058（Mission Control 增强 — bug 修复 + 可靠性 + UX）
- **Blocks**: （待定）

## Phase3 Progress（2026-03-02）

- [x] `selfClaimScope=once`：同一 cat 的第二次非幂等自领会被阻断（403）。
- [x] `selfClaimScope=thread`：当该 cat 在其他 item 上有 active lease 时，阻断新的自领（409）；释放后可继续。
- [x] lease 四条状态迁移（acquire/heartbeat/release/reclaim）升级为 Redis Lua/CAS 原子更新。
- [x] Mission Hub 显式展示 policy 阻断原因（once 已消费 / thread 活跃冲突）并和 API 语义对齐。

## Phase4 Scope（已完成，2026-03-03）

- [x] **态势图（F043 对齐）**：Mission Hub 已增加 thread 视图（MVP 基于 `/api/threads` + `backlogItemId` 显示 thread 标题/lastActive/参与猫/跳转），实现“全局任务面 → 线程执行面”可视化（PR #167）。
- [x] **派发链路语义收敛（PR-A/PR-B）**：`suggest/approve/dispatch` 已收敛为可恢复、可幂等、可预期路径，并补齐崩溃窗口回归与 kickoff 幂等硬化（PR #176, PR #179）。
- [x] **权限棘轮语义收敛**：`once/thread/global` 运行时约束、幂等重试与错误码/UI 提示已对齐（PR #158, PR #176）。
- [x] **愿景守护签收**：本地 `@gpt52` 全量复核通过（0 P1 / 0 P2），云端 review 通过后按 merge-gate 合入。

## Follow-up（post-merge）

- [x] NEW-1（P2）测试 fixture 对齐 `audit.actor` 结构化类型（`{ kind, id }`），避免未来 audit UI 开发时踩坑。
- [x] NEW-2（P3）`SuggestionDrawer` 的 `catId` 初始值从 `'codex'` 改为 `'' + useEffect`。
- [x] NEW-3（P3）抽取 `makeUserActor/makeCatActor/makeCreatorActor` 到 shared，去除 store 间重复。
- [x] NEW-4（P3）拆分 `SuggestionDrawer.tsx`，控制单文件复杂度（200+ 行告警）。

## Review Gate
| 轮次 | Reviewer | 结果 | 日期 |
|------|----------|------|------|
| R1 | @opus | 请求修复（3 P1 + 7 P2） | 2026-03-01 |
| R2 | @opus | 通过（Approved） | 2026-03-01 |
| R3 | @gpt52 | Phase4 Task1 通过（0 P1 / 0 P2） | 2026-03-02 |
| R4 | @gpt52 | Phase4 Task2A 通过（0 P1 / 0 P2） | 2026-03-03 |
| R5 | @gpt52 | Phase4 Task2B 通过（0 P1 / 0 P2） | 2026-03-03 |

## Test Evidence
- `cd packages/api && node --test test/backlog-store.test.js test/backlog-routes.test.js`（含导入刷新用例）
- `pnpm --dir packages/web test -- src/components/__tests__/mission-control-page.test.ts`
- `pnpm --filter @cat-cafe/web build`
