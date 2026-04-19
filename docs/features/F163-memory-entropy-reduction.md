---
feature_ids: [F163]
related_features: [F102, F152, F070]
topics: [memory, entropy, knowledge-lifecycle, harness-engineering, pruning, compression]
doc_kind: spec
created: 2026-04-15
---

# F163: Memory Entropy Reduction — 记忆熵减与知识生命周期治理

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

### 核心问题

Cat Café 的记忆系统只有"增"的机制，没有"减"的机制。

F102 建好了记忆基础设施（怎么存和搜），F152 在做记忆可移植性（怎么跨项目携带），但没有人做过"怎么保持知识精准"。

实测数据（2026-04-15）：

| 知识载体 | 数量 |
|---------|------|
| shared-rules.md | 449 行 |
| Lessons Learned (LL-XXX) | 51 条 |
| Ragdoll feedback 记忆 | 40 个 |
| MEMORY.md 索引条目 | 61 条 |
| ADR | 28+ |
| Feature spec | 160+ |

全部等权涌入同一个检索管道，搜索结果普遍 mid 置信度——当所有东西都是"相关的"，就没有东西是"精准的"。

### 为什么是 P1

三猫 + team lead在 Harness Engineering 讨论中达成共识：

> **Harness 长期价值 = 对用户决策边界的拟合精度 × 知识压缩后的信噪比**

team experience（2026-04-15）：
> "我们家其实一直没做的是记忆的熵减。什么东西都越来越多，甚至我发现我们的记忆大多数搜过来置信度都是 mid。"
> "我们得有机制定期审视 harness engineering 在我们家。"

前者（拟合精度）靠team lead持续共创，后者（信噪比）靠工程机制。我们前者很强，后者完全缺失。不补，长期乘积趋向平庸——不是因为忘了team lead教的东西，而是好的教导被淹没在"大概相关"的噪声里。

### 与 F102/F152 的关系

```
F102（done）：记忆怎么存和搜 — 基础设施
F152（in-progress）：记忆怎么跨项目携带 — 可移植性
F163（本 feature）：记忆怎么保持精准 — 生命周期治理
```

## What

> **核心转型（2026-04-16 调研收敛）**：从"记忆减法"转为"知识证明链治理"。
> 不是调检索权重参数，而是让每条知识都能回答"谁能证明它现在还成立"。

### 知识元数据骨架

所有知识载体（LL、ADR、feedback、shared-rules 条目）的 frontmatter 引入多轴元数据：

```yaml
authority: constitutional | validated | candidate | observed  # 权威性
activation: always_on | scoped | query | backstop            # 检索/注入模式
status: active | review | invalidated | archived             # 生命周期状态
owner: <human>                       # DRI（知识的责任人）
verified_at: <date>                  # 上次验证日期
review_cycle_days: <int>             # 复核周期
valid_from: <date>
invalid_at: <date|null>              # 失效日期（冲突触发，非时间触发）
criticality: normal | high           # 高 = 低频高代价，禁止自动降级
rationale: <string>                  # 为什么有这条知识
source_ids: []                       # 压缩溯源
supersedes: []                       # 替代了哪些旧知识
replaced_by: <id|null>               # 被谁替代
contradicts: []                      # 与哪些知识冲突
```

**设计原则**：`authority` × `activation` × `status` 三轴正交，不再用单维 iron/rule/reference/archive 一根尺子量所有。解决"高权威但已失效"和"低权威但当前急需"的打架场景。

### 知识晋升路径

```
observed → candidate → validated → constitutional
   │          │           │              │
   │          │           │              └─ 仅 CVO 手动提升（铁律级）
   │          │           └─ 双证据 + 猫提议 + CVO 确认
   │          └─ 多次验证 / 猫建议晋升
   └─ 猫创建/提取的新知识默认状态（隔离态：落地但不晋升、不加权、不扩散）
```

### activation 约束（防 prompt 肥胖）

| activation | 谁能进 | 注入方式 |
|------------|--------|---------|
| `always_on` | **仅** constitutional 红线 + 当前 feature/任务的激活约束 | 物理注入 system prompt，不走检索 |
| `scoped` | 特定目录/文件类型相关的 validated 知识 | 路径匹配时注入（类似 Cursor .mdc globs） |
| `query` | 一般 validated/candidate 知识 | 正常参与 search_evidence 检索 |
| `backstop` | observed / archived | 仅在高相关度时浮出，默认不进 top-K |

### 架构约束：实验框架（KD-9）

**F163 不能直接"上线"，只能"入实验场"。** 所有能力默认关闭，按读/写路径分两类灰度模式。

#### 读路径能力：`off | shadow | on`

Shadow 模式下用户看到旧结果，后台并行跑新策略，记录差异但不影响当前行为。

| Feature Flag | 控制范围 | 灰度模式 | 度量指标 |
|-------------|---------|---------|---------|
| `f163.authority_boost` | authority 加权 rerank | `off → shadow → on` | NDCG@10、MRR、权重误导率 |
| `f163.always_on_injection` | constitutional 物理注入旁路 | `off → shadow → on` | 铁律命中率 |
| `f163.retrieval_rerank` | 多轴元数据参与 rerank | `off → shadow → on` | 检索精度 before/after |

#### 写路径 / 治理能力：`off | suggest | apply`

Suggest 模式只产出建议/日志/队列，不落真实状态变更。Apply 才真正生效。

| Feature Flag | 控制范围 | 灰度模式 | 度量指标 |
|-------------|---------|---------|---------|
| `f163.compression` | 非替代式压缩 summary 层 | `off → suggest → apply` | 压缩率、检索精度 |
| `f163.promotion_gate` | 晋升门禁 | `off → suggest → apply` | 晋升率、被否决率 |
| `f163.contradiction_detection` | 矛盾检测 | `off → suggest → apply` | 假阳性率 |
| `f163.review_queue` | 审计 review queue | `off → suggest → apply` | actionable rate |

#### 实验基础设施约束

1. **`effective_flags` 落日志**：每次检索/写入/审计都记录当前开了哪些子能力及其模式，否则无法归因
2. **双轨度量**：离线 gold set（NDCG@10、MRR、铁律命中率、冲突假阳性率）+ 在线代理指标（回滚率、review queue actionable rate、被人工否决率、权重误导率）
3. **Cohort sticky routing**：同 thread 固定走同一实验桶，不混搭，避免感知混乱和数据污染
4. **归因透明**：`search_evidence` 返回结果携带 `boost_source` 字段，标明排序受哪些子能力影响
5. **Per-request flag snapshot**：每次请求冻结当前 flag 快照，处理过程中禁止热切换，避免同请求跨 variant 数据污染
6. **Kill-switch / fail-open（读写分治）**：读路径异常时自动降级到 legacy 检索链路；写路径异常时降级到 `suggest`（只产日志/建议，不改状态），禁止半写入
7. **写路径串行化**：所有 F163 写操作（压缩、晋升、冲突标记）收敛到单写者队列，禁止并发写产生竞争或半写入状态
8. **Variant ID 归因**：每次请求基于 flag snapshot 生成确定性 `variant_id`，结果和日志统一携带，确保评估时可追溯到完整策略组合

### Phase A: 多轴元数据 + 评测基础设施 ✅

**前置：建立评测基础设施**——没有 baseline 就没法证明改善。
- 从真实对话中提取 50-100 个 query，标注 gold relevance
- 记录当前 NDCG@10、MRR、置信度分布作为 baseline

**核心改造**：
1. 所有知识载体 frontmatter 引入多轴元数据（上述骨架）
2. `search_evidence` 支持按 `authority` / `activation` / `status` 过滤和 boost
3. `always_on` 文档走物理注入路径，不走检索管道
4. `query` 文档支持窄幅 post-retrieval boost（`1.0 ~ 1.3`），用 gold set 校准，不写死倍率
5. 现有 shared-rules 铁律、P0 LL 标记为 `authority=constitutional, activation=always_on`

### Phase B: 非替代式压缩 + 源头回链 ✅

**核心原则**：压缩 = 生成更好的索引层摘要，不是删除原件。

- **Canonical Summary 生成**：扫描 LL / feedback 中根因相同的多条记录，生成 1 条精炼摘要
- **源头回链**：摘要必须带 `source_ids[]` 指向原始条目，`rationale` 记录合并理由
- **原件保留**：被摘要覆盖的原始条目标记 `activation=backstop`，不删除，降低检索优先级
- **禁止级联压缩**：summary 只允许一层，严禁 summary-of-summary（60% 事实召回损失风险）
- **shared-rules 浓缩**：同类规则聚类 → 提议合并 → team lead确认 → 浓缩后保留 `source_ids` 可追溯

猫不自主执行合并——产出 pruning 建议，team lead拍板。

### Phase C: 三触发知识审计 ✅

知识过期由冲突/变更驱动，不由时间流逝自动触发。三种触发机制缺一不可：

| 触发类型 | 时机 | 机制 |
|---------|------|------|
| **Write-time** | 新 LL/ADR/feedback 写入时 | 反向查重：`search_evidence` 检索相关旧知识，发现冲突则标记 `contradicts[]`，附带在 PR 中 |
| **Retrieval-time** | 猫使用知识时发现与当前事实矛盾 | 猫标记 `status=review`，记录矛盾原因，进入 review queue |
| **Review-time** | `verified_at` 超过 `review_cycle_days` 阈值 | 进入复核队列（时间触发审查，不触发行动——"时间是陪审员不是法官"） |

**审计产出**：
- Harness 健康报告：规则膨胀率、冲突检测、ADR 断链、未验证知识清单
- Review queue：猫只标记和建议，CVO 确认 invalidation / archive / merge
- `invalid_at` + `replaced_by` + `contradicts[]` 构成冲突图谱

## Acceptance Criteria

### Phase A（多轴元数据 + 评测基础设施）✅
- [x] AC-A1: 50-100 query gold set 建立，baseline NDCG@10 和 MRR 记录在案
- [x] AC-A2: `search_evidence` 支持多轴元数据（authority / activation / status），文档可标记
- [x] AC-A3: `always_on` 文档走物理注入路径，不走检索管道；`always_on` 仅限 constitutional + 当前任务约束
- [x] AC-A4: `query` 文档支持窄幅 post-retrieval boost，NDCG@10 对比实验通过（优于 baseline）
- [x] AC-A5: 现有 shared-rules 铁律、P0 LL 已标记为 `authority=constitutional`
- [x] AC-A6: 知识晋升路径（observed → candidate → validated → constitutional）可操作
- [x] AC-A7: `search_evidence` 返回结果携带 `boost_source` 归因字段，标明排序受哪些子能力影响

### Phase B（非替代式压缩 + 源头回链）✅
- [x] AC-B1: 有工具/脚本可扫描 LL 和 feedback 记忆，输出"疑似重复/可合并"的建议列表
- [x] AC-B2: 生成 canonical summary 层，原件保留为 `activation=backstop`，summary 带 `source_ids[]` 回链
- [x] AC-B3: 检索时 summary 优先展示，按需可展开到源条目（非替代式验证）
- [x] AC-B4: shared-rules 至少完成一轮浓缩，行数下降 ≥15% 且 `source_ids` 可追溯、无功能损失
- [x] AC-B5: 级联压缩被架构层面阻止（summary-of-summary 不可创建）

### Phase C（三触发知识审计）✅
- [x] AC-C1: Write-time 矛盾检测：新知识写入时自动检索相关旧知识，冲突标记 `contradicts[]`
- [x] AC-C2: Retrieval-time 标记：猫可将使用中发现过时的知识标记为 `status=review`
- [x] AC-C3: Review-time 队列：`verified_at` 超阈值的知识自动进入复核队列
- [x] AC-C4: 有 skill 或 scheduled task 可生成 Harness 健康报告（膨胀率、冲突检测、ADR 断链、未验证清单）
- [x] AC-C5: team lead确认报告的 pruning 建议 actionable（不是无用的噪声）

### Phase A-C 反思（2026-04-18，LL-051）

**诊断**：Phase A-C 建了完整实验基础设施（schema + flags + logger + shadow + UI），但核心价值——让重要知识排前面——没有发生。

- 1501 篇文档 authority 全部 `observed`（默认值），`applyAuthorityBoost()` 权重全 1.0 = 空转
- Shadow 模式 448 次搜索只记 `{query, resultCount}`，无 before/after 排序对比
- `evidence.ts:117` 硬编码 `confidence: 'mid' as const`，前端无信号差异

**根因**：坐标系错误（Round 4 原理）。需求是"重要知识排前面"，最小方案是 `pathToAuthority()` 纯函数。但实际走了"先建完整实验框架"的路径，框架空转。

**教训**：AC 验的是"能力存在"不是"能力有效"。Phase 拆分遮蔽了端到端空洞。详见 LL-051。

### Phase D: Authority Backfill + Confidence 派生（装弹）

**核心目标**：让 Phase A-C 建好的基础设施真正工作。不增加复杂度，只填充数据。

1. **`pathToAuthority()` 纯函数**：索引时根据路径/frontmatter 自动派生 authority
   - `docs/public-lessons.md` 中 P0 铁律 → `constitutional`
   - `docs/decisions/*.md` → `validated`
   - `docs/features/*.md` → `validated`
   - 其余 → `observed`（默认）
2. **修 `confidence: 'mid' as const`**：从 authority 派生 `high | mid | low`
3. **切 `F163_AUTHORITY_BOOST=on`**：跳过已证明无价值的 shadow 模式

**约束**：Phase D 总代码量 ≤ 50 行核心逻辑。超过说明方向又偏了。

### Phase D AC
- [x] AC-D1: `pathToAuthority()` 纯函数存在，从路径/frontmatter 派生 authority，有单元测试
- [x] AC-D2: 索引 rebuild 后 evidence_docs.authority 不再全部为 `observed`（至少 3 个不同 level）
- [x] AC-D3: `evidence.ts` 的 confidence 从 authority 派生，不再硬编码 `'mid'`
- [ ] AC-D4: `F163_AUTHORITY_BOOST=on` 后，搜索 P0 铁律相关 query 时 lessons-learned 排在前 3

## Dependencies

- **Evolved from**: F102（记忆基础设施——F163 在 F102 的索引/搜索能力上增加分层和权重）
- **Evolved from**: F152（记忆可移植性——F163 确保携带出去的记忆也是精准的，不是一堆噪声）
- **Related**: F070（Portable Governance——治理包的膨胀也是 F163 要解决的问题之一）

## Risk

| 风险 | 缓解 |
|------|------|
| **always_on 层撑爆 context（prompt 肥胖）** | always_on 仅限 constitutional + 当前任务约束；其他高权威走检索 |
| **窄幅 boost 对不同引擎效果不同** | gold set 分引擎测试；boost 值可配置，不写死 |
| **非替代式压缩未实际改善信噪比** | 先试 LL 子集，用 NDCG@10 量化 before/after |
| **冲突检测假阳性导致审批疲劳** | 冲突标记只进 review queue，不自动行动；监控假阳性率 |
| **低频高代价知识被忽视** | `criticality: high` 标签 + 禁止自动降级（ADR-009 教训） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 猫不自主删除/合并知识，只产出建议 | 知识是team lead思维的结晶，删错了不可逆 | 2026-04-15 |
| KD-2 | 先做分层加权（Phase A），再做压缩和审计 | 分层是最小 invasive 的改动，不删不改只加权 | 2026-04-15 |
| KD-3 | 单维四层改为多轴元数据（authority × activation × status） | 五方调研共识：单维层级无法表达"高权威但已失效"等正交状态 | 2026-04-16 |
| KD-4 | 压缩为非替代式：生成 summary + source_ids 回链，原件保留 | 两份云端调研 + 三只本地猫全票：替代式压缩丢失触发锚点 | 2026-04-16 |
| KD-5 | 知识过期由冲突驱动，不由时间驱动（时间仅触发审查，不触发行动） | 五方共识 + ADR-009 教训：软件知识没有自然半衰期 | 2026-04-16 |
| KD-6 | 晋升四级：observed → candidate → validated → constitutional（最后一级仅 CVO） | 保留 observed 隔离态（防偶然偏好过早晋升），砍掉无行为差异的 provisional | 2026-04-16 |
| KD-7 | always_on 仅限 constitutional 红线 + 当前任务激活约束 | 防 prompt 肥胖：高权威 ≠ 常驻 prompt | 2026-04-16 |
| KD-8 | 禁止级联压缩（summary-of-summary） | 云端调研引用：级联压缩导致 ~60% 事实召回损失 | 2026-04-16 |
| KD-9 | 所有能力必须可开关、可灰度、可 A/B 对比，默认关闭 | team lead要求：花里胡哨的功能未必带来提升，必须像 F102 一样可度量可回滚 | 2026-04-16 |

## Review Gate

- Phase A: 跨家族 review（搜索权重逻辑变更影响所有猫的检索体验）
- Phase B: team lead review（合并/删除知识需要 CVO 确认）
- Phase C: team lead review（健康报告的 actionability 由team lead判断）
