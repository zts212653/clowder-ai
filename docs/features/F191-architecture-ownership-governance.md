---
feature_ids: [F191]
related_features: [F042, F088, F102, F124, F152, F167, F175, F183, F185]
topics: [architecture, governance, ownership-map, skills, ci, quality-gate]
doc_kind: spec
created: 2026-05-07
---

# F191: Architecture Ownership Governance — 架构归属地图与 Map Delta 门禁

> **Status**: done | **Owner**: Maine Coon/Maine Coon | **Priority**: P1

## Why

team lead在 2026-05-07 追问：老项目不断加新需求时，我们到底是在补锅，还是在按第一性原理找正确坐标系？

F183 / F185 的成功路径不是继续修症状，而是先梳理现有模块架构，暴露多 truth source、多写入口、多语义混用等技术债，再设计新的归一坐标。反过来，F124 x F088 也提醒我们：架构归一不是把所有东西强行抽象到一层，归一的是对话内核和设备语义，不是 connector transport。

当前 SOP 缺一层轻量但稳定的架构归属机制：新增 Feature 开工前需要知道“我属于哪条现有架构线；本次有没有改变这条线”。如果每个 Feature 都重新画架构图，会变成补锅式重复劳动；如果完全不声明归属，又会继续长出并行 store / queue / router / adapter。

本 Feature 建立 `Architecture Ownership Map`：它不是每个 Feature 填一张表，而是全家共享的架构归属索引。普通 Feature 只引用已有 cell；只有改边界、找不到归属、或代码锚点 stale 时才触发重审。

## What

### Phase A: Ownership Map PoC（per-cell 真相源）

新建 `docs/architecture/ownership/`，采用 per-cell 文件而非单个巨大表，避免所有 Feature 同时修改同一文件。

与现有 `docs/architecture/2026-05-05-architecture-views.md` 的关系：`architecture-views` 是叙事性架构图谱快照，用来讲清系统全貌；`ownership/` 是路由性归属索引，用来判断新 Feature 应扩展哪条架构线。两者互补，不互相替代；cell 可以引用架构图谱作为背景，但不得重复维护图谱内容。

首版 cells：

| Cell | Canonical anchors | 说明 |
|------|-------------------|------|
| `transport` | F088 / F124 | IM / connector / first-party client 的消息语义边界 |
| `memory` | F102 / F152 | evidence store / scanner / bootstrap / library memory |
| `dispatch` | F175 / F185 / ADR-034 | invocation queue / busy gate / fairness invariant |
| `bubble-pipeline` | F183 | message bubble identity / single writer / reducer |
| `action-plane` | ADR-029 / F162 | 企业动作、CLI executor、ActionService |
| `identity-session` | F032 / F088 / F183 | 顶层身份/会话归属格；Phase A 必须拆出 `identity-agent` / `identity-connector` / `identity-bubble` subcells，并写清三者不能互相吞并 |
| `callback-auth` | F174 | callback auth lifecycle / scope / resilience |

每个 cell 固定包含：

```markdown
---
cell_id: dispatch
title: Dispatch / Queue
summary: Invocation queue、busy gate、fairness、priority 与外部 wake 执行。
canonical_features: [F175, F185]
code_anchors:
  - packages/api/src/...
doc_anchors:
  - docs/features/F185-dispatch-busy-gate-unification.md
static_scan_hints: [InvocationQueue, QueueProcessor, busy, priority]
cited_by: []
---

# Dispatch

## Canonical Owner

## Use This When

## Extend By

## Do NOT Unify With

## Static Scan Hints
```

`cited_by` 先作为显式字段进入 PoC，用来记录哪些 Feature / PR 引用或更新过该 cell。首轮不自动追加，避免在地图尚未校准前引入 merge hook 复杂度。

README 总索引不作为手写真相源。Phase A 直接定为由 cells frontmatter 生成，避免总索引变成新的热点冲突和腐烂源。

### Phase B: Skills 激活入口（最小小切）

把 map 接入日常 SOP，但不制造大表格劳动。

1. `feat-lifecycle` Design Gate 增加硬问：

   ```markdown
   Architecture cell: {ownership cell id}
   Map delta: none | update required | new cell required
   Why: 一句话
   ```

   答不出来不是“回去填表”，而是 Phase 0 架构发现未完成。

2. `writing-plans` header 增加同一组三字段。普通增量应写 `Map delta: none`，不得重复画架构图。

3. `request-review` 增加 reviewer 视角：PR 是否新建了并行 store / queue / router / adapter；`Map delta: none` 是否与 diff 一致。

4. `quality-gate` 先只要求报告 map delta，不做静态 hard block。

### Phase C: Mechanical Checks（warning-only）

增加 warning-only 脚本，先暴露盲点，不阻塞开发：

- ownership cell 引用的 `code_anchors` 是否存在
- Feature spec / plan 中声明的 `Architecture cell` 是否存在
- PR diff 新增 `Store|Queue|Router|Adapter|Dispatcher|Binding` 等架构名词但没有声明 `Architecture cell` 时给 warning

该阶段不让 CI 判断架构是否正确，只检查机械不变量。误报样本稳定后，才能讨论是否接入 `pnpm check` / `pnpm gate` 的 hard fail。

### Phase D: Trial & Close

选择 1-2 个真实后续 Feature 试跑，不做假 PoC：

- 普通增量能否只引用 cell、不改 map
- 新边界是否能触发 `Map delta: update required`
- 找不到归属时是否自然进入 Phase 0
- reviewer 是否能用 map 快速发现“另起炉灶”或“过度归一”

如果试跑证明 map 是错误抽象（分类过度、作者普遍答不出 cell、或 reviewer 认为 map 没减少认知负担），则不升级 ADR / CI hard gate；把结果收敛为 lessons-learned，并重新选择坐标系。

试跑后再决定是否升 ADR、是否把 warning 脚本接入 CI、是否自动维护 `cited_by`。

## Acceptance Criteria

### Phase A（Ownership Map PoC）
- [x] AC-A1: `docs/architecture/ownership/` 存在，包含 per-cell 文件和 README，不使用单个巨大共享表作为唯一真相源
- [x] AC-A2: 首版 7 个 cell 覆盖 `transport` / `memory` / `dispatch` / `bubble-pipeline` / `action-plane` / `identity-session` / `callback-auth`
- [x] AC-A3: 每个 cell 包含 `Canonical Owner` / `Use This When` / `Extend By` / `Do NOT Unify With` / `Static Scan Hints`
- [x] AC-A4: 每个 cell frontmatter 包含 `cell_id` / `title` / `summary` / `canonical_features` / `code_anchors` / `doc_anchors` / `static_scan_hints` / `cited_by`
- [x] AC-A5: F124 x F088 的反归一边界进入 `transport` cell，明确“归一消息内核和设备语义，不归一 connector transport”
- [x] AC-A6: `identity-session` 明确拆出 `identity-agent` / `identity-connector` / `identity-bubble` subcells，并在 `Do NOT Unify With` 写死三者边界
- [x] AC-A7: README 总索引由 cells frontmatter 生成，不手写维护 ownership 真相源

### Phase B（Skills 激活入口）
- [x] AC-B1: `feat-lifecycle` Design Gate 增加 `Architecture cell` / `Map delta` / `Why` 三字段
- [x] AC-B2: `writing-plans` plan header 增加同一组三字段
- [x] AC-B3: `request-review` 增加 architecture ownership review checklist
- [x] AC-B4: `quality-gate` 增加 map delta 报告项，但不做 hard block
- [x] AC-B5: `pnpm sync:skills` 已运行，HOME-level skill symlink 同步完成

### Phase C（Mechanical Checks）
- [x] AC-C1: warning-only 脚本能检测 stale `code_anchors`
- [x] AC-C2: warning-only 脚本能检测不存在的 `Architecture cell`
- [x] AC-C3: warning-only 脚本能提示新增架构名词但缺少 cell 声明的 diff
- [x] AC-C4: Phase C 不做 semantic architecture judgment，只检查机械不变量

### Phase D（Trial & Close）
- [x] AC-D1: 至少 1 个真实 Feature 使用 `Architecture cell` + `Map delta` 试跑
- [x] AC-D2: 试跑后记录是否有漏 cell / 错 cell / 过度归一 / 另起炉灶未被发现
- [x] AC-D3: 基于试跑结果决定是否接入 hard CI、自动 `cited_by`、或升 ADR
- [x] AC-D4: 若试跑证明 map 是错误抽象，记录 lessons-learned，不升级 ADR / CI hard gate

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “老项目 + 新需求”不能继续瞎累积架构 | AC-A1~A7, AC-B1~B4 | spec + skill review | [x] |
| R2 | 不是每个 Feature 重新填表 / 重新画图 | AC-A1, AC-A7, AC-B1, AC-B2 | 普通增量写 `Map delta: none` | [x] |
| R3 | 只在真正需要时触发重审 | AC-B1, AC-D1~D4 | 真实 Feature 试跑 | [x] |
| R4 | 防止 map 腐烂 | AC-A4, AC-A7, AC-C1 | stale anchor check + generated README | [x] |
| R5 | 防止大家抢同一个大文件冲突 | AC-A1 | per-cell 文件结构 | [x] |
| R6 | 涉及 harness：skills / quality gate / CI / prompts | AC-B1~B5, AC-C1~C4 | diff + review | [x] |
| R7 | 47 的 `cited_by` 想法可以试，但不能首轮过度自动化 | AC-A4, AC-D3 | PoC 字段 + 后续决策 | [x] |
| R8 | 让 46 帮忙 review 方向 | Review Gate | 46 review 记录 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式

## Dependencies

- **Evolved from**: F042（提示词与 Skills 三层信息架构，SOP / skill 注入路径）
- **Evolved from**: F183（Architecture Map + single writer 的成功范例）
- **Evolved from**: F185（Dispatch/busy gate 分层归一的成功范例）
- **Related**: F088 / F124（Transport 与反归一边界）
- **Related**: F102 / F152（Memory / scanner 扩展范例）
- **Related**: F177（fallback layer warning-only 检查可作为脚本模式参考）

## Risk

| 风险 | 缓解 |
|------|------|
| 退化成每个 Feature 填表 | 只要求三字段；普通增量写 `Map delta: none`，不改 map |
| 单文件热点冲突 | per-cell 文件结构；README 由 frontmatter 生成 |
| CI 误报淹没开发 | Phase C warning-only，先收集误报再决定 hard fail |
| map 变成死文档 | code anchors + Feature 引用 + review checklist 三层激活 |
| 过度归一 | 每个 cell 必须写 `Do NOT Unify With` |
| `identity-session` 变成万能筐 | 拆出 `identity-agent` / `identity-connector` / `identity-bubble` subcells，并写死不可互相吞并 |
| `cited_by` 维护变成人工负担 | 首轮仅字段化；自动追加等试跑后再决定 |
| map 本身是错误抽象 | PoC 允许失败；失败时沉淀 lessons-learned，不升级 ADR / CI hard gate |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Ownership map 使用 per-cell 文件，不使用单个巨型表 | 避免所有 Feature 抢同一个共享文件；只有同一架构边界变更才产生真实冲突 | 2026-05-07 |
| KD-2 | Feature 只声明 `Architecture cell` + `Map delta`，普通增量不重画架构 | 防止“架构治理”变成新表格劳动 | 2026-05-07 |
| KD-3 | CI 首轮只做机械 warning，不做语义判断 | 架构正确性需要 Design Gate / review，CI 只查 stale anchor / missing cell 等机械不变量 | 2026-05-07 |
| KD-4 | `Do NOT Unify With` 与 `Canonical Owner` 同级 | 同时防“瞎累积”和“瞎抽象” | 2026-05-07 |
| KD-5 | 47 的 `cited_by` 收进 PoC，但自动维护不进首轮 | 反向引用有价值，但自动 merge hook 在地图未稳定前过重 | 2026-05-07 |
| KD-6 | README 总索引由 cells frontmatter 生成 | 避免 README 成为新的热点冲突和腐烂源 | 2026-05-07 |
| KD-7 | PoC 失败也是有效结果 | 如果 map 导致过度分类或没有降低 review 成本，应沉淀教训而不是升级治理负担 | 2026-05-07 |
| KD-8 | Phase D 试跑选择 F187，并新增 `thread-navigation` cell | F187 是真实 in-progress feature；它不应被强塞进 identity/bubble/transport，试跑证明首版 7 格漏了 thread 组织语义，不是 map 抽象失败 | 2026-05-07 |
| KD-9 | Phase D 后不升级 hard CI / 不自动追加 `cited_by` / 不升 ADR | 仅 1 个 trial 且暴露漏 cell；先保持 warning-only 与字段化，等更多真实 feature 校准边界 | 2026-05-07 |

## Review Gate

- Kickoff spec: Ragdoll Opus 4.6 review（按team lead要求“让 46 帮你看看”）
- Phase A: Maine Coon author，46 review；如 47 参与实现，Maine Coon负责 code-quality review
- Phase B: Maine Coon author，46 review
- Phase C: Maine Coon author，46 review
- Phase D: Maine Coon author，46 review
- Phase B/C: 涉及 skill / CI / hook 改动，必须跨猫 review
- Close: Sonnet 愿景守护通过（非 author、非 Phase A-D reviewer）
