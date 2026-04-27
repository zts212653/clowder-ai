---
feature_ids: [F169]
related_features: [F102, F148, F152, F163, F167]
topics: [memory, externalized-working-memory, reflex-injection, salience-gating, vision]
doc_kind: vision
created: 2026-04-19
revised: 2026-04-25
---

# F169: Agent Memory Reflex — 愿景文档（vision artifact）

> **Status**: **realized → closed**（B+C 已通过 F148/F163 实现；A team lead拍板关闭，不做持久 Compiled Wiki）
> **Reviewed**: 2026-04-19 by @opus-46 + @gpt52（Maine Coon）（综合 review 已落盘，见 Review Gate 节）
> **愿景实现度更新**: 2026-04-25（closed）
> **Priority**: N/A（作为愿景保留，不走实现流程；实现归属分派到具体 feat Phase）
>
> **实现归属与状态**（截至 2026-04-25）：
>
> | 原 Phase | 原描述 | 实际归属 | 状态 | 证据 |
> |----------|--------|---------|------|------|
> | Phase A | Compiled Wiki Self-Authoring | 关闭 | ✅ **team lead拍板关闭**（2026-04-25） | 不做持久 compiled wiki；若痛点复现，方向是 query-time Feature Lens（现场投影，不存文件） |
> | Phase B | Reflex Injection | F148 Phase F-H | ✅ **精神达成** — F148 done 2026-04-25 | navigation header 注入 baton + tasks + truthSource + artifact，指向 raw anchor（KD-8 合规） |
> | Phase C | Task-scoped Salience Gating | F163 Phase F | ✅ **完整对齐** VAC-C1~C5 | PR #1412 merged `b843744f`（2026-04-25），25 测试 + NDCG@10 gold set 验证 + Maine Coon愿景守护放行 |
>
> 本文档作为愿景研究产物保留：三层方向性主张 + 跨族视角论证 + ADHD 同构假设，已被两条主线（F148/F163）实现。Phase A team lead 2026-04-25 拍板关闭——不做持久文档，若痛点复现走 query-time Feature Lens。
>
> **Meta-Aesthetics 约束**：本文档按 [canon](../canon/meta-aesthetics.md) §5.4 写——方向性约束（终态设计 / 不加认知脚手架）作为 F148 Phase F / F163 Phase F 实现时的**设计哲学输入**，不是本文档的实现切片。

## Why

### 核心问题

**记忆系统不是给team lead用的，是给猫用的**（team lead 2026-04-19）。

但现有记忆系统三层（F102 索引 / F148 传输 / F163 治理）都是**被动式**——猫需要主动调用 `search_evidence`，或者靠 F148 在 cold mention 时一次性注入。

主体问题：**猫在思考过程中，相关记忆如何"主动跳出来"？无关记忆如何被"暂时屏蔽"？**

### LLM ≈ ADHD externalized working memory 的同构论证

| 主体 | 认知强项 | 认知弱项 |
|------|---------|---------|
| LLM | 推理带宽极宽 | 工作记忆 160K tokens 撑爆 / lost in the middle / 无法自主决定记什么 |
| ADHD team lead | 跨域联想极强 | 工作记忆差 / 选择性注意失效 |

两者都需要 externalized working memory prosthetic。team lead日常用 Notion/Obsidian/Raycast/TodoWrite 外化。猫也该有等价物——不是"更好的仓库"，是**运行时反射层**。

### 三个具体触发（证据）

1. **F148 Phase F-J 导航轴的反面**：F148 只做了"加相关维度"（Intent/Baton/Task spotlight），没做"减无关维度"。所有 validated authority 文档都排在前面，即使和当前任务无关
2. **新猫冷启动体验（opus-47 亲历）**：我进这个 thread 时，需要连续 5 次 search_evidence 才建立起上下文。如果有 spotlight + salience gating，理想情况下 0 次就能理解现状
3. **F163 Phase A-C 空转（[LL-051](../public-lessons.md)）的假设外推**：LL-051 已验证的根因是"坐标系错（先建完整实验框架走偏）"，已由 Phase D `pathToAuthority()` 解决。本文档另提假设——配置驱动 vs 演绎驱动——作为 F163 未来 scheduled lint task 的观察输入，**不作为 F169 愿景立论的硬依据**（review 已纠正过度外推）

### 与 F102/F148/F163 的分层关系

```
[运行时层]  F169 愿景  Reflex Injection + Task-scoped Salience Gating
               ├─ Reflex Injection 实现 → F148 Phase F-H ✅ done (2026-04-25)
               └─ Salience Gating 实现 → F163 Phase F ✅ merged b843744f (2026-04-25)
                      ↓
[传输层]   F148  Navigation (Intent/Baton/Task spotlight) ✅
                      ↓
[存储层]   F163  Authority/Activation metadata + Salience ✅
                      ↓
[索引层]   F102  evidence.sqlite (FTS5 + vector + RRF)
```

F169 不替代任何一层，是**把它们连起来运行**的 reflex runtime 愿景。

## What

### 核心命题

> 把记忆从"猫需要搜的书架"升级为"猫的外部工作记忆反射"。

### 终态愿景（acceptance test of vision）

新来的猫（如 opus-47）进入任何 thread，**无需调用 search_evidence**，通过 Reflex Injection（F148 Phase F）+ Task-scoped Salience Gating（F163 Phase F）的组合，能在 5 秒内判断当前任务方向是否正确。

> **Post-review 修订**：前稿写"Reflex Injection + Compiled Wiki 的组合"。Compiled Wiki 剥离后，愿景依赖 spotlight（指向 raw anchor）+ salience gating 两者组合即可达成。Compiled Wiki 若后续启用，是增强路径，不是愿景必需。

### Phase A: Compiled Wiki Self-Authoring（人+猫双向可读层）

> **Post-review 剥离**：本 Phase 已从 F169 scope 剥离。opus-46 review 指出该层可能与 Memory Hub 前端职责重叠；Maine Coon建议等team lead价值判断后再启动。剥离后暂无 owner，作为**可选的 F102 产物层增强**保留讨论，**不进入本文档终态愿景**。下方设计文字仅作研究记录，**不被 reflex runtime 组合行为依赖**。

**问题**：`docs/features/F169.md` 是"spec 文档"（人写给人看，猫混合读写）。`evidence.sqlite` 是索引黑盒（猫用，人看不到）。**中间缺一层：compiled wiki page（人+猫双向可读的产物层）**。

**方案**：

- 新增 `docs/compiled/F<ID>.md` 作为 **LLM 自动生成的 wiki 层**
- 新增 MCP tool `cat_cafe_recompile_wiki(feat_id)`，猫可调用
- 触发：feat 状态变化（merge PR、close、update spec）时由猫 opportunistically 调用
- **Schema 固定**（参考 Karpathy）：`purpose / current_status / timeline / lessons / cross_connections / open_questions`
- 产物**不是 summary**（那是认知脚手架），是**结构化抽取 + 链接**（状态机产物）

**终态切片**：1 个 feat 先试（推荐 F102 自身，因为它最复杂且猫最常碰它）。不是"为未来 10 个 feat 建 pipeline"。

**为什么这不是认知脚手架**：wiki 生成是**结构化抽取**，不是"替猫决定什么重要"。抽取规则由 Schema 定义，Schema 是状态机。Karpathy 的 LLM Wiki 正是这么做的。

**禁区**：不用 Haiku/小模型做抽取（见 meta-aesthetics canon §2.1，Haiku handoff digest 已被验证回退）。Compiled wiki 由主模型在猫调用 MCP tool 时执行。

### Phase B: Reflex Injection（运行时聚光灯）

> **实现归属**：F148 Phase F（opus-46 owner）。本节作为 F148 Phase F 的**设计输入**保留。

**问题**：`search_evidence` 是**主动动作**，需要猫想到才能调用。F148 navigation header 是 **cold mention 一次性注入**，warm path 不覆盖，且只有 Intent/Baton/Task，没有 relevant memory spotlight。

**方案**：

- 扩展 F148 navigation header，增加 **`memory_spotlight`** 段
- **信号源**：current task（F148 N-3 Task spotlight 已有）× recent file paths（git diff / edit history）× F163 authority × 最近 thread keywords
- **注入点**：system_info 消息（和 F148 briefing 同路径，non-routing）
- **上限**：最多 3 条最相关记忆，摘要级（不是原文），**指向 raw evidence anchor**（文档路径 + 片段锚点 / heading），**不**指向 compiled wiki page
- **触发**：任何路径（cold + warm + empty-return），和 F148 KD-7 同原则

**终态切片**：只注入 spotlight，不做任何"总结/分析/推理"。猫自己读 spotlight + 决定是否深挖（深挖 → 调 search_evidence 打开原文）。

**为什么这不是认知脚手架**：spotlight 是**结构化原料**（文档标题 + 原始 anchor + 相关度），不是"替猫读过的总结"。符合 [KD-8 不用 classifier 给数据不给结论](../features/F148-hierarchical-context-transport.md#L180) 原则。

**Post-review 修订**：前稿让 spotlight 指向 compiled wiki page（Phase A 产物）。Maine Coon P1 指出这偷偷把 KD-8「给数据」转成了「给二次产物」——compiled wiki 本身是被加工过的结论层，绕开它直接给 raw anchor 才是 KD-8 的精神。接受修订。

### Phase C: Task-scoped Salience Gating（任务作用域内的可逆降权）

> **实现归属**：F163 Phase F（owner: opus-46）。F163 spec 已写入 AC-F1~F5，本节 VAC-C1~C5 作为设计输入保留。
>
> **Post-review 改名**：前稿名为"Active Forgetting"。Maine Coon review 指出太强——"forgetting"暗示不可逆隐藏，实际语义是任务作用域内的可逆降权。改名为"task-scoped salience gating"，强调：(1) 只在当前任务上下文生效；(2) 可逆；(3) 是 rerank 降权不是删除。

**问题**：F163 metadata（authority/activation/status）是**静态**的。validated 文档在所有任务中都 boost，即使和当前任务无关（例：做 F169 时 F088 Chat Gateway 的 decision 也会排前面）。

**方案**：

- 扩展 F163 `activation` 字段，新增运行时 `salience` 维度
- **Salience 计算**：`salience = f(authority, relevance_to_task, recency_in_thread)`，当 relevance 低于阈值时降权
- **降权不是删除，也不是永久隐藏**：记忆仍在 evidence.sqlite，只是在 Reflex Injection 和 search_evidence rerank 时被推后；当前任务结束（task_id 切换）后降权效应自动消失
- **重要例外**：`criticality=high` 的铁律级知识**不参与 gating**（P0 铁律永远在场），和 F163 KD-7 一致

**终态切片**：salience gating 是 Reflex 的反面，同一运行时层。不是独立 agent/系统。

**为什么这不是认知脚手架**：Salience 是纯函数计算（可测试、可回放、不推理），不是"替猫判断什么不重要"。

### 两层（post-review 剥离 Phase A 后）的组合行为

- 猫进 thread → Reflex Injection 拉取 spotlight（Phase B → F148 Phase F 实现）
- Spotlight 条目指向 raw evidence anchor（文档路径 + heading / 片段）
- 非相关高权威记忆被 Task-scoped Salience Gating 压低（Phase C → F163 Phase F 实现）
- 猫需要深挖时 → 调 search_evidence 直接打开原文

端到端验证（愿景级）：**新猫 5 秒判断方向正确与否**，通过 F148 Phase F + F163 Phase F 实现后测量。

> **注**：Phase A Compiled Wiki 已剥离；如team lead后续在 F102 产物增强中启用，则可成为 spotlight 的可选 "view link"（不是默认路径）。

## Vision-level Acceptance Criteria（愿景级约束，由下游 feat 实现满足）

> 这些 ACs 不是 F169 实现 ACs（F169 无实现切片）。是把愿景锚点固化成下游 feat 实现时应满足的约束，方便后续 review 对照。

### 对 F148 Phase F（Reflex Injection 实现归属）的愿景约束

- [x] **VAC-B1**: navigation header 注入 baton + tasks + truthSource + artifact 段（F148 Phase F/G/H 实现，schema 比"memory_spotlight"更细粒度）
- [x] **VAC-B2**: Spotlight 信号源包含 task + file paths + authority + thread keywords（F148 实现：extractBatonContext + summarizeActiveTasks + truthSource + recentArtifacts，无 classifier）
- [x] **VAC-B3**: 所有注入路径（cold + warm + empty-return）覆盖（F148 KD-7 落地，AC-F7 验证）
- [x] **VAC-B4**: **Spotlight 条目指向 raw evidence anchor**（F148 anchor speaker attribution + truthSource 指向真实文档路径，KD-8 合规）
- [x] **VAC-B5**: 端到端测试——新猫从 navigation header 拿到充分上下文（F148 close 时Maine Coon愿景守护放行）

### 对 F163 Phase F（Task-scoped Salience Gating 实现归属）的愿景约束

- [x] **VAC-C1**: `salience(doc, taskContext)` 纯函数已实现（F163 Phase F AC-F1，PR #1412），输出 0.0-1.0，单元测试覆盖
- [x] **VAC-C2**: `always_on` 铁律级知识恒为 1.0 不参与 gating（F163 AC-F2 验证，对齐 KD-7 + ADR-009）
- [x] **VAC-C3**: 运行时降权按任务相关性派生（F163 AC-F3：feat_id_match + truthSource_match + recentArtifact_match）
- [x] **VAC-C4**: 降权可逆且任务作用域内（F163 AC-F4：salience 在 post-retrieval rerank 阶段，原 activation 未改写）
- [x] **VAC-C5**: NDCG@10 gold set 验证（F163 AC-F5：不低于 Phase E baseline；shadow 模式记 before/after diff 防 LL-051 空转）

### 跨 feat 端到端（愿景验证）

- [~] **VAC-E2E**: Opus-47 或新分身进入新 feat thread，**不调用 search_evidence**，通过 F148 navigation header + F163 salience gating 在 5 秒内判断方向正确与否（**间接达成**——F148 close Maine Coon愿景守护 + F163 Phase F NDCG@10 gold set 各自覆盖了一部分；显式跨 feat e2e 测试未做，价值边际，按"愿景间接验证"通过）

### Phase A（剥离，待team lead决策窗口至 2026-05-19）

> Phase A Compiled Wiki Self-Authoring 已关闭（2026-04-25 team lead拍板）。B+C 充分覆盖愿景；若痛点复现，方向是 query-time Feature Lens（现场从 spec/thread/git/PR 投影，不存文件）。

## Dependencies

- **Informs**: F148 Phase F（Reflex Injection 实现归属，opus-46 owner）
- **Informs**: F163 Phase F（Task-scoped Salience Gating 实现归属，opus-46 owner）
- **Closed**: F102 Compiled Wiki（team lead 2026-04-25 拍板关闭；若痛点复现走 query-time Feature Lens）
- **Context from**: F102（索引层，不改）/ F167（A2A 链路质量，Reflex 注入正确的猫前提）/ F152（Expedition Memory，外派场景对 spotlight 的补充需求）

## Risk（愿景层风险，已由下游 feat 承接缓解）

| 风险 | 缓解 | 当前状态 |
|------|------|---------|
| Phase B spotlight 过度干预（噪音代替信号） | F148 Phase F-H：navigation header 的字段精简 + 愿景 AC「新猫 5 秒判断方向」 | ✅ F148 close 时Maine Coon愿景守护放行 |
| Phase C salience 误压重要记忆 | F163 Phase F：`always_on` 免疫（VAC-C2）+ NDCG@10 gold set（VAC-C5）+ 任务作用域可逆（VAC-C4）+ shadow before/after 日志防 LL-051 空转 | ✅ PR #1412 合入，Maine Coon愿景守护放行 |
| F148/F163 Phase F 改动并发冲突 | 由 46 在各自 Design Gate 上排序 | ✅ 两条主线均已合入，无冲突 |
| Phase A Compiled Wiki 被遗忘 | 剥离挂 F102 增强待议列表；OQ-4 自动关闭窗口至 2026-05-19 | ✅ team lead 2026-04-25 拍板关闭 |

## Key Decisions（愿景层 + 已通过 review）

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 愿景层终态设计：F169 不做实现切片，实现分派下游 feat；每个 feat 自己要满足愿景级 AC | 喵约（终态设计）+ F163 Phase A-C 空转教训（LL-051）+ 46/Maine Coon review 结论 | 2026-04-19 |
| KD-2 | Spotlight 指向 raw evidence anchor，不经过二次产物（compiled wiki / summary） | KD-8 给数据不给结论（F148）+ Maine Coon P1 finding（review 已接受） | 2026-04-19 |
| KD-3 | Spotlight 上限 3 条 + 不做总结/分析 | KD-8 给数据不给结论（F148）的延续 | 2026-04-19 |
| KD-4 | `criticality=high` 不参与 salience gating（P0 铁律永远在场） | F163 KD-7 + ADR-009 教训（低频高代价知识不能自动降级） | 2026-04-19 |
| KD-5 | Salience gating 必须**可逆且任务作用域**，不是永久降权 | Maine Coon P2 finding（Active Forgetting 名字过强，review 已接受） | 2026-04-19 |
| KD-6 | 愿景层 e2e 验证由下游 feat 各自的愿景守护承接，不做显式跨 feat e2e 测试 | F148 close + F163 Phase F merge 时Maine Coon愿景守护已分别覆盖；造一个独立 e2e 测试是认知脚手架 | 2026-04-25 |

## Review Gate

- **Vision-artifact review**：opus-46（F148 主 owner）+ gpt52（综合架构视角） — ✅ 2026-04-19 完成
  - P1 finding（Maine Coon）：Phase B 数据路径违反 KD-8（spotlight → compiled wiki 是二次产物）——接受，改为指向 raw anchor
  - P2 finding（Maine Coon）：Active Forgetting 名字过强——接受，全文改名 "task-scoped salience gating"
  - 结构建议（46+Maine Coon）：F169 不应是 implementation feature——接受，降级为 vision artifact + 实现归属分派
- **Design Gate**（下游 feat）：F163 Phase F Design Gate 已完成（gpt52 给出 4 问硬约束：信号源/阈值策略/接入点/30 行约束边界），实现合入；F148 Phase F-H 通过愿景守护放行 close ✅
- **愿景实现度** (2026-04-25)：B+C 已通过 F148/F163 实现；A 待team lead在 2026-05-19 前决策（OQ-4 自动关闭窗口）
