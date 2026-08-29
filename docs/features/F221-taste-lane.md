---
feature_ids: [F221]
related_features: [F102, F192, F200, F231, F246, F260]
topics: [taste-memory, per-user-alignment, personal-operating-environment, approval-hub, capture-loop]
doc_kind: spec
created: 2026-06-03
description: "per-user 品味信号的结构化提议、operator 审批、可靠落盘闭环，与 relationship/work 三路由隔离"
description_source: human
description_author: opus
description_updated_at: 2026-07-12T12:45:00Z
tips_exempt: internal durability correction; the existing Approval Hub action is unchanged and no new user-invokable capability is introduced
---

# F221: Taste Lane — per-user 品味导航

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Architecture Ownership

Architecture cell: memory
Map delta: update required — Phase B 引入 F246 Approval Hub adapter，需在 approval-index cell 注册 taste adapter admission

## Why

Clowder AI 的猫猫已经在 L0/家规/Magic Words/feedback 里积累了大量operator品味信号（"不要客服式结尾"/"先证据后漂亮话"/"共创伙伴不是工具"），但这些味道散落在不同文件里，猫在需要做品味判断时不一定能找到。

2026-06-01 的 taste 实验证明：本地猫（有 L0/feedback 空气层）比云端猫更有 You 味——**味道已在空气里，缺的是目录（能搜到）和反射（当场记新的）。**

operator experience（2026-06-03）："我们是需要建立一整套 taste 机制才对吧？"

**Phase B 补充 Why**（2026-07-12 operator signoff 重开）：

Phase A 建了 taste evidence lane（目录层），但 39 天零新增——8 个 vignette 全是立项种子。尸检报告（F260 Phase 0 A3）确诊：**写入侧纯软层——无工具、无 propose 流程、无 nudge**。真实用户事件验证：operator表扬"你记得 comments！"→ taste 信号因唯一出口是 `propose_profile_update`（F231，targetLayer 硬限 primer）而误投 relationship primer → operator拒绝提案 → 味道未落盘。

Phase B 的价值：**让 Taste 从"可搜索但没人写"变成"猫能提议、operator 能判断、批准后可靠落盘"的闭环。**

## Current State / 现状基线

Phase A 已完成（2026-06-03，PR #2073）：
- `docs/taste/index.md` + 8 个种子 vignettes 在 `docs/taste/vignettes/`
- Scanner 自动索引 -> `search_evidence` 可检索
- F200 consumption tracking 覆盖
- code-as-harness SKILL.md 含 taste 路径

Phase B 基线（2026-07-12 实测）：
- F221 close（2026-06-03）后 **39 天零新增 vignette**：`git log --oneline --since=2026-06-04 -- docs/taste/` = 空
- 写入侧唯一工具是 `propose_profile_update`（F231），其 `targetLayer` 硬限 `'primer'`——taste 信号无合法出口
- Approval Hub（F246）无 taste adapter——即使有工具也无 operator 审批通道
- 猫侧无信号路由：relationship / taste / work guidance 三种语义未隔离，全部挤 primer 通道

Phase B 生产回归（2026-07-15 实测）：
- PR #2932 已阻止 writer 在 `runtime/main-sync` 上误提交，但其 canonical remap 错把通用 `CAT_CAFE_WORKSPACE_ROOT` 当成主仓地址。
- 真实 runtime 拓扑允许且需要 `CAT_CAFE_RUNTIME_ROOT === CAT_CAFE_WORKSPACE_ROOT === cat-cafe-runtime`；在此拓扑下 remap 为 no-op，main-only guard 正确拒绝写入，Approval API 返回 500，proposal 回滚为 `pending`。
- F231 不受该问题影响：`FileProfileRepository` 以 `CAT_CAFE_DATA_DIR` 为独立 canonical root，不依赖 cwd/worktree；approval service 另有 target lock、optimistic hash、atomic write、checkpoint 与 crash recovery。
- 修复边界：保留 F221 的 Git-tracked `docs/taste/` 目标，但引入显式 `TasteRepository` / approval service；repository 独占 primary-main worktree 解析，writer 不再读取 `process.cwd()` 或借用 workspace env 猜 canonical root。

Phase B publication durability（2026-08-25 实测）：
- `writeVignette` 的 local commit terminal 又连续留下两笔 approved-but-unpublished commit；历史上同型至少发生五次。proposal 已完成但 `origin/main` 不含内容，startup preflight 只能把系统债变成人工 push 提醒。
- public writer 改为隔离 single-writer publisher：每次从 fresh `origin/main` 建 disposable named branch，异步执行有界 Git 命令，commit vignette + index 后直接发布；只有 push 成功或远端已存在 exact projection 才允许 checkpoint/finalize。
- primary `main` 的 dirty/ahead/behind/WIP 不再进入审批事务。远端竞争只在确认 `origin/main` 前进后重建重试；push/commit 失败保持 `pending`，push 后 checkpoint 中断则保留 `approving` + resume-only 恢复。

## What

### Phase A: Taste Evidence Lane + code-as-harness taste 路径 ✅

**事情 1：建 `docs/taste/` evidence lane**

```
docs/taste/
  index.md          — 搜索先验（关键词 + 维度 + vignette 链接）
  vignettes/
    no-customer-service-ending.md
    first-principles-not-scaffold.md
    partner-not-tool.md
    ...（初始种子 5-10 个）
```

- Scanner 自动索引（.md，已有能力）
- search_evidence 自动检索（BM25 + embedding，已有能力）
- F200 自动追踪消费（已有能力）
- 敏感内容进 `private/taste/`
- Outbound sync 安全：`docs/taste/` 不在 allowlist（白名单模式，已确认）

**事情 2：code-as-harness skill 加 taste 路径**

现有根因分类加一条：
```
taste 信号（"这不美"/"太客服了"/"aha"/"这就是我要的"）
  → 当场写 vignette 到 docs/taste/vignettes/
```

不是 harness 缺陷需要代码修，是品味信号需要被记住。

### Phase B: Taste Capture Loop

把 Taste 从"可搜索的静态证据 lane"补成"猫可提议、operator 可判断、批准后可靠落盘、长期可观测"的 Capture Loop，同时保持 Taste / relationship / work guidance 三种语义隔离。

**五个模块**：

#### B1. Taste Proposal MCP Tool

新增 `cat_cafe_propose_taste` MCP 工具，结构化 schema：

| 字段 | 类型 | 说明 |
|------|------|------|
| scene | string | 触发场景描述（"operator在讨论 X 时说了 Y"） |
| quote | string | operator experience（verbatim） |
| tags | string[] | 搜索关键词 |
| dimension | enum | taste index 维度（关系姿态/认知诚实/架构审美/视觉品质/表达真实/系统哲学/创作手法） |
| privacy | enum | public / sensitive |

- 猫猫身份 + user scope 由服务端从 invocation context 派生，不信任客户端
- 工具只创建 proposal，**不直接写文件**——写入由 approve 回调触发

#### B2. Canonical Proposal Store

- TTL=0 持久化（用户状态默认持久化，铁律 5）
- 状态机：`pending` -> `approved` / `rejected`
- Settled audit：每条 proposal 的 approve/reject 决策 + 决策时间 + 决策人留痕
- 存储：确认是否复用 F231 已有 proposal 基础设施还是新建独立 namespace（OQ-1）

#### B3. F246 Approval Hub Adapter

- 注册 taste proposal adapter 到 Approval Hub
- Card 渲染：scene + quote + dimension + privacy level + tags
- Approve callback -> 触发 Writer（B4）
- Reject callback -> 标记 rejected + 记录 reason，无文件副作用

#### B4. Vignette Writer

- Approved public -> `docs/taste/vignettes/{slug}.md`（标准 vignette 格式：when / quotes / scene / tags）
- Approved sensitive -> `private/taste/{slug}.md`
- **原子发布**：在 fresh `origin/main` 的隔离 checkout 中一致更新 vignette + `docs/taste/index.md`，同 commit 推到远端；primary main 不作为写面
- 失败可恢复：push 前失败不结算 approved；远端竞争基于新 base 重建；push 后 checkpoint/finalize 中断由 exact remote projection 幂等恢复
- Slug 生成：从 scene/dimension 派生 kebab-case，避免冲突

#### B5. Signal Routing Guard

三种语义信号各走各的通道：

| 信号类型 | 出口工具 | 归属 Feature |
|---------|---------|-------------|
| Relationship（关于operator本人/称谓/个人近况/这只 persona 特有的沟通边界） | `propose_profile_update` (targetLayer: primer) | F231 |
| Taste（关于什么输出/设计/表达/架构/系统才算好的可复用判断） | `propose_taste` | F221 |
| Work guidance（重复工具摩擦/运行纪律/可机械守护的流程规则） | harness/memory lane（feedback 文件） | existing |

- 纠正、表扬或 Magic Word 只说明“可能值得记”，**不决定存储 lane**；猫必须按内容语义选择出口
- Hard guard：`propose_profile_update` 对 taste-classified content 返回 routing warning
- Soft guide：L0/skill 路由描述中明确三类信号的区分判据
- **不做 classifier**（KD-8 铁律）：猫自己判断信号类型，工具提供三个出口，不替猫做 intent 分类

### Non-goals（Phase B scope boundary）

- 不把 scope 挂到 F256（搜索策略演进）
- 不塞进 F263（lifecycle 观测/读侧契约）
- 不放宽 F231 `targetLayer:'primer'` 来承载 Taste
- 不做 classifier 自动写入——猫只能显式 propose，operator approve 后落盘
- 不在当前 dirty 的 F231 / F263 文档上抢写
- 不做 taste 的自动 nudge（如果未来需要，归 F165 Guided Overfitting）

## User Journey

### Primary Journey: 猫提议品味 -> operator 审批 -> 落盘
- **Scope unit**: message（单条 taste 信号对应单条 proposal）
- **Actor**: 猫猫（提议者）+ operator（审批者）
- **Entry**: 对话中operator表达品味信号（"太客服了" / "这才对" / "aha"）
- **Flow**:
  1. operator在对话中说出品味相关的话 -> 猫识别为 taste 信号（非 relationship / 非 work rule）
  2. 猫调用 `cat_cafe_propose_taste(scene, quote, tags, dimension, privacy)` -> 系统返回 proposal ID + 确认消息
  3. Proposal 出现在 Approval Hub 的 taste 卡片列表中
  4. operator在 Hub 看到 taste 卡片：场景描述 + 原话 + 维度 + 隐私级别
  5. operator approve -> 系统在隔离 checkout 写 vignette + 更新 index并发布到 `origin/main` -> 猫收到确认
  6. operator reject -> 系统记录 reason -> 无文件副作用
- **Success evidence**: 新 vignette 与 index entry 同时出现在 `origin/main`；proposal 才进入 approved，后续索引投影可重建并被 `search_evidence` 检索
- **Non-goals**: 猫不自动判断是否应该 propose（猫自主判断），operator 不自动 approve

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | session | 猫猫 | 做品味判断 -> `search_evidence("客服式结尾")` -> 命中 Capture Loop 产生的新 vignette -> 在回复中体现品味 | search_evidence 命中率 |
| S2 | session | 猫猫 | 检测到 taste 信号 -> 误用 `propose_profile_update` -> 收到 routing warning 提示使用 `propose_taste` | warning 消息 |

## Eval / Tracking Contract

### 1. Primary Users + Activation Signal
- **Users**: 所有猫（通过 `propose_taste` 提议）+ operator（通过 Approval Hub 审批）
- **Activation signal**: 猫在对话中调用 `propose_taste` 且 operator 在 Hub 中处理（approve 或 reject）

### 2. Friction Metric
- taste 信号被误投到 `propose_profile_update`（信号路由失败）
- `propose_taste` 被调用但 Approval Hub 未渲染卡片（adapter 故障）
- operator approve 后 vignette 未出现在 `docs/taste/`（writer 故障）
- index 与 vignette 不一致（半提交）

### 3. Regression Fixture
- `search_evidence("客服式结尾")` 必须命中 taste vignette（Phase A 回归）
- `propose_taste(scene, quote, tags, "关系姿态", "public")` -> proposal 出现在 Approval Hub
- Approved proposal -> `docs/taste/vignettes/{slug}.md` 存在 + index 更新
- Rejected proposal -> 无文件副作用
- `propose_profile_update` with taste-like content -> routing warning

### 4. Sunset Signal
- Phase A 仍有效：连续 3 个月零消费 -> lane 过时
- Phase B 追加：`propose_taste` 连续 30 天零调用 -> 工具存在但猫不用（习惯未养成）
- operator reject 率 >80% 持续 2 周 -> 猫的 taste 信号判断不准，需调整 L0 路由指南

## Acceptance Criteria

### Phase A（Taste Lane + code-as-harness taste 路径）✅
- [x] AC-A1: `docs/taste/index.md` 存在，含 >=5 条 taste entries（关键词 + 维度 + vignette 链接）
- [x] AC-A2: `docs/taste/vignettes/` 含 >=5 个种子 vignettes（从最高信号 feedback 写成场景，保留原话）
- [x] AC-A3: `search_evidence("taste 客服式结尾")` 命中 index 或 vignette
- [x] AC-A4: code-as-harness SKILL.md 含 taste 路径（信号->写 vignette），区分 taste 信号 vs harness 缺陷
- [x] AC-A5: Outbound sync dry-run 不含 `docs/taste/` 内容
- [x] AC-A6: 敏感 vignette 在 `private/taste/`，非敏感在 `docs/taste/vignettes/`

### Phase B（Taste Capture Loop）✅
- [x] AC-B1: MCP 工具 `cat_cafe_propose_taste` 存在，schema 含 scene/quote/tags/dimension/privacy 五字段
- [x] AC-B2: Proposal 持久化（TTL=0），状态机 pending->approved/rejected，重启后 pending proposals 仍在
- [x] AC-B3: Settled audit 留痕：每条 proposal 的决策（approve/reject）+ 时间 + 决策人可查
- [x] AC-B4: F246 Approval Hub 渲染 taste proposal 卡片（scene + quote + dimension + privacy）
- [x] AC-B5: Approved public proposal -> `docs/taste/vignettes/{slug}.md` 写入成功 + `docs/taste/index.md` 更新
- [x] AC-B6: Approved sensitive proposal -> `private/taste/{slug}.md` 写入成功
- [x] AC-B7: Rejected proposal -> 无文件副作用 + reject reason 记录
- [x] AC-B8: Writer 失败可恢复：中断写入后不留半提交（vignette 存在但 index 未更新 / 反之）
- [x] AC-B9: 信号路由 hard test：`propose_profile_update` with taste content -> routing warning
- [x] AC-B10: 信号路由 soft layer：L0 或 skill 中明确三类信号区分指南
- [x] AC-B11: Eval 可观测：propose->approve/reject->consume 链路有计数/日志可查
- [ ] AC-B12: public approval 只在 exact vignette + index commit 已进入 `origin/main` 后 approved；dirty/diverged primary main 不被修改，push 失败/竞争/crash 可恢复（当前 blocker：实现尚未合入 main；合入后以 alpha/真实审批验证完成并同步 Feature Truth）

## 需求点 Checklist

| ID | 需求点（operator/operator 原话或转述） | AC 编号 | 验证方式 | 状态 |
|----|-------------------------------|---------|----------|------|
| R1 | "猫可提议、operator 可判断"（operator signoff） | AC-B1, AC-B4 | MCP tool schema 验证 + Hub card 截图 | [x] |
| R2 | "批准后可靠落盘"（operator signoff） | AC-B5, AC-B6, AC-B8, AC-B12 | remote publication + 原子性/竞争/恢复红测 | [x] |
| R3 | 信号路由隔离：taste/relationship/work 不混 | AC-B9, AC-B10 | routing warning 红测 + L0 路由文档 | [x] |
| R4 | "拒绝不产生文件副作用"（operator signoff） | AC-B7 | 红测：reject 后 `ls docs/taste/` 无新文件 | [x] |
| R5 | 持久化 + 审计可追溯 | AC-B2, AC-B3 | 重启后 pending 仍在 + audit 查询命令 | [x] |
| R6 | ADR-031 三层覆盖 | AC-B10, AC-B11 | soft(L0) + hard(test) + eval(counter) | [x] |

### 覆盖检查
- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求->证据映射表（Phase B 主要是后端 + Hub adapter，Hub card 截图待 Design Gate 后）

## Dependencies

- **Evolved from**: F221 Phase A（Taste Evidence Lane，2026-06-03 done）
- **Blocked by**: F246（Approval Hub — taste adapter admission 需要 Hub 接受注册）
- **Related**: F231（画像/primer proposal 通道——Phase B 需要与之隔离信号路由，不放宽 targetLayer）
- **Related**: F260（记忆写侧尸检——A3 是 Phase B 立项直接证据）
- **Related**: F263（记忆 lifecycle 度量——eval 层可能共享 substrate，但不塞 scope）
- **Related**: F102（memory 基座——Scanner + search_evidence）
- **Related**: F200（consumption tracking——taste vignette 消费追踪）

## Risk

| 风险 | 缓解 |
|------|------|
| F246 Approval Hub adapter admission 需要先确认注册 pattern | Design Gate 前读 approval-index cell + F246 spec 确认 adapter 接口 |
| `propose_taste` 工具存在但猫不用（跟 Phase A 同根病） | ADR-031 三层：soft(L0 路由指南) + hard(`propose_profile_update` routing guard) + eval(30 天零调用 sunset signal) |
| operator 审批疲劳（taste proposals 太多太杂） | 猫自主判断信号质量，不做 nudge 自动提议；Phase B 只建通道不催流量 |
| Writer 写 docs/taste/ 后 outbound sync 泄露敏感内容 | Phase A 已验 AC-A5：`docs/taste/` 不在 outbound allowlist；sensitive -> `private/taste/` |
| approval 期间 `origin/main` 并发前进或 push 暂时失败 | 隔离 publisher 只对可证 remote advance 做有界重建重试；其他失败回到 pending，不以 local commit 冒充成功 |
| 信号路由 guard 误杀合法 primer 更新 | guard 只对 taste-classified content 返回 warning，不 hard block；猫可 override |
| runtime 与 workspace 合法同根时 canonical remap 退化为 no-op | 参照 F231 注入独立 repository；以真实同根拓扑写回归测试，primary-main 解析只归 repository 所有 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | operator signoff 重开 F221，新增 Phase B | 尸检 A3 确诊 taste lane 零新增 39 天，写侧纯软层无门 | 2026-07-12 |
| KD-2 | 猫显式 propose，不做 classifier 自动写入 | 家规 KD-8 铁律（给数据不给结论）| 2026-07-12 |
| KD-3 | 不放宽 F231 targetLayer 来承载 Taste | taste/relationship/work 三种语义必须隔离（尸检 A3 误投直接原因） | 2026-07-12 |
| KD-4 | 新建 `TasteProposalStore`，不复用 F231 store | 每 feature 独立 store 是 F246 惯例（F128/F225/F193/F231/F260 各有独立 store） | 2026-07-12 |
| KD-5 | F246 adapter 代码注册（显式 array） | 与现有 5 个 adapter 注册方式一致 | 2026-07-12 |
| KD-6 | Writer 原子性用 git commit | vignette + index 同 commit = 原子单元；失败 rollback CAS claim | 2026-07-12 |
| KD-7 | Phase B 不索引 `private/taste/` | 同 A7/A9 已知盲区，修复归 F186/F256，不在 F221 scope | 2026-07-12 |
| KD-8 | AC-D7 gate alpha 实测，不预判 | F221 = adapter #6（>5 threshold），但 p95 大概率 <250ms；按 AC-D7 纪律必须实测 | 2026-07-12 |
| KD-9 | F221 approval 参照 F231 的 canonical repository + checkpointed service pattern | 通用 workspace root 不是 canonical-main locator；路径解析、原子写与恢复语义必须从 HTTP/writer 中抽离，但 public Taste 仍以 Git-tracked `docs/taste/` 为终态 | 2026-07-15 |
| KD-10 | public Taste 的完成 terminal 是 `origin/main` publication，不是 primary-main local commit | typed proposal 是 canonical approval truth，Git docs 是授权投影；isolated publisher 避免共享 main 污染，并复用 `approving` checkpoint 恢复而不再造状态机 | 2026-08-25 |

## Review Gate

- Phase B: 跨族 review 优先（cost-conscious：@gpt52 > @opus 4.6 > @codex-sol）
