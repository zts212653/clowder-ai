---
feature_ids: [F100]
related_features: [F042, F086, F038, F102]
topics: [skills, sop, governance, self-improvement, knowledge-management, mode-c, knowledge-evolution]
doc_kind: spec
created: 2026-03-11
updated: 2026-03-16
---

# F100: Self-Evolution — 猫猫自我进化机制

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1
> Phase 1 完成：行为层 skill（A/B/C 三模式触发规则）
> Phase 2 完成：三模式知识对象化（A 守护记录 + B 流程提案闭环 + C 知识蒸馏验证 + 五级阶梯 + 元认知）
> Phase 3 待建：可观测层 — **blocked on F102 close**，需基于 F102 终态重新定义

## Why

三个缺口：
1. team lead有 ADHD，聊 feat 时 scope 无限发散，猫猫不主动提醒"要不要拆？"
2. 猫猫被反复纠正同类错误，不主动提改 SOP/skills/家规
3. **（team lead追加）** 猫猫只从错误中学习，不从有价值的经验中成长——比如帮team lead分析医学报告、法律探讨、deep research，这些知识/方法论没有沉淀机制

根因：P2 说猫猫是共创伙伴，但只落地了"被动执行"，没有"主动护栏 + 主动改进 + 主动成长"。

## What

一个 skill 三个模式：

### Mode A: Scope Guard（防御）
- 发现team lead讨论偏离当前 feat 愿景时，温柔提醒"要不要拆？"
- 4 信号判断法：不服务愿景 / 新旅程 / 新依赖 / 验收说不清
- 同一 phase 最多提醒两次

### Mode B: Process Evolution（防御→改进）
- 触发：memory ≥2 次同类错误 / team lead纠正可泛化 / SOP 流程缺口 / review 系统性问题
- 5 槽提案模板 + 4 硬护栏 + 最小杠杆排序

### Mode C: Knowledge Evolution（进攻→成长）
- 触发：deep research 产出可复用知识 / 专业领域讨论形成方法论 / 跨域协作发现可迁移框架
- 三问判断（复用性 + 非显然性 + 衰减性），满足 ≥2 个才沉淀
- 4 槽提案模板：Discovery / Value / Form / Summary
- 沉淀形式：memory（轻量）→ skill（方法论）→ docs/research（完整报告）

## 设计决策

1. **一个 skill 三模式** — 本质都是"主动感知 + 主动行动"
2. **不发明新沉淀库** — 路由到现有真相源
3. **L0 只加一句许可** — 三模式都提到，细节放 skill
4. **Mode C 是team lead追加** — 原设计只有 A+B（防御），team lead指出格局太小

## Discussion

- Thread: `thread_mmlv4v2oq6dxefr6`（Ragdoll + Maine Coon GPT-5.4 讨论 A+B 模式）
- team lead追加 Mode C（知识进化）：不只从错误学，也从有价值的经验成长

## Deliverables

### Phase 1
- [x] `cat-cafe-skills/self-evolution/SKILL.md` (147 行，三模式)
- [x] `cat-cafe-skills/manifest.yaml` 注册（11 triggers）
- [x] `SystemPromptBuilder.ts` L0 digest 许可句（含三模式）
- [x] 三猫 symlinks（claude/codex/gemini）

### Phase 2
- [x] `docs/decisions/015-knowledge-object-contract.md` — ADR-015 Knowledge Object Contract
- [x] `docs/scope-guard-log.md` — Mode A Scope Guard Log
- [x] `evals/mode-c/TEMPLATE/` — Mode C Eval Ledger 结构（cases/judge/summary）
- [x] `cat-cafe-skills/self-evolution/SKILL.md` 升级（228 行，含三机制闭环+五级阶梯+元认知）
- [x] `cat-cafe-skills/manifest.yaml` 新增 6 triggers（共 17）
- [x] `SystemPromptBuilder.ts` L0 digest 更新（Episode→蒸馏→Eval）

## AC

- [x] Mode A: Scope Guard 有触发信号表 + 频率限制 + 出口表
- [x] Mode B: Process Evolution 有提案模板 + 硬护栏 + 杠杆排序
- [x] Mode C: Knowledge Evolution 有三问判断 + 沉淀形式表 + 提案模板
- [x] L0 digest 一句许可覆盖三模式
- [x] 三猫都能加载 skill
- [x] 不造新沉淀库

---

## Phase 2: 三模式知识对象化设计（2026-03-12）

> 来源：四源调研 Round 1（基础设施）+ Round 2（Mode C 灵魂）+ 三猫收敛讨论

### 现状评估

Phase 1 完成的是**行为层**——三猫什么时候该守 scope（A）、该演化流程（B）、该沉淀知识（C）。调研证实方向没走歪。

**三模式都只做了一半**：Phase 1 教猫"什么时候触发"，缺"触发之后产出什么、怎么验证有效、怎么逐步成熟"。

### Mode A Phase 2: Scope Guard 对象化

Phase 1 状态：4 信号判断 + 频率限制 + 出口表。

Phase 2 补齐：
- **Scope Guard Log** (`docs/scope-guard-log.md`)：每次触发记录 `{date, feat_id, signal_type, action_taken, outcome}`
- **发散模式识别**：累积 ≥3 次同一 feat 触发 → 自动建议team lead拆 feat
- **Scope Guard 效果追踪**：guardian 成功率（提醒后team lead确实聚焦 vs 忽略），用于调节触发灵敏度
- **知识对象**：Scope Guard 的经验纳入五级阶梯（哪些信号组合最有效 → Method Card）

### Mode B Phase 2: Process Evolution 对象化

Phase 1 状态：5 槽提案模板 + 4 硬护栏 + 最小杠杆排序。

Phase 2 补齐：
  - `{proposal_id, trigger_type, target(SOP/skill/rule), status(proposed/accepted/rejected/superseded), impact_assessment}`
- **提案→落地闭环**：accepted 的提案必须关联到具体 commit/PR，不能停在"提了"
- **提案效果验证**：落地 30 天后自动触发 replay check——改了这条规则后，同类错误还出现吗？
- **知识对象**：有效的 Process Evolution 提案纳入五级阶梯（L2+ 的流程改进 → Skill Draft）

### Mode C Phase 2: Knowledge Evolution 对象化

Phase 1 状态：三问判断 + 4 槽提案模板 + 沉淀形式表。

Phase 2 补齐（核心，来自四源调研 + 三猫讨论）：

**三机制闭环**：
```
Episode Card（原料）→ Dual Distillation（蒸馏成品）→ Eval Ledger（证明净增益）
```

   - 保留 6 类协作 context：任务情境 / 证据地图 / 推理转折 / 人类提示点 / 边界与克制 / 后续动作
   - 特别保留 **Collaboration Pivots**（human cue → AI interpretation → effect → transferable lesson）
   - 触发条件（满足任两条）：高风险领域 / 输入 ≥2 类 / 人类明确认可 / 结构化方法产出 / 有效边界控制

2. **Dual Distillation**：每张 Episode Card 蒸馏成两种形态之一
   - **Skill Draft** (`skills/drafts/*/SKILL.md`)：重复步骤稳定的流程型任务
   - 高风险领域一律默认 Method Card

3. **Eval Ledger** (`evals/mode-c/<knowledge-id>/`)：Replay A/B 验证知识净增益
   - 最小可信 case 数：5（3 只够 smoke test）
   - 必须覆盖 3 类：标准成功 / 边界应升级 / 冲突反例
   - A/B 卫生规则：同模型版本 + 同 prompt skeleton + 低温固定采样 + 同 judge rubric + paired comparison

### 三模式共享：五级知识成熟度阶梯

所有三个模式的产出物共享同一套成熟度阶梯：

| Level | 形态 | 晋升条件 | 降级/冻结 |
|-------|------|----------|-----------|
| **L0 Episode** | 原始记录 | 模板完整，已分离可迁移/不可迁移 | 不降级 |
| **L1 Pattern** | 草稿 | ≥2 个相似 episode（180天内），或人类要求；5Q ≥ 7/10 | 一次性特例 → rejected |
| **L2 Draft** | Method Card / Skill Draft | smoke gate ≥3 cases（≥2/3 通过）；promotion gate ≥5 cases（≥3/5 通过，覆盖 3 类） | 最近 3 次 <50% → 退 L1 |
| **L3 Validated** | 正式 method/skill | ≥6 uses，≥2 agents，≥80%，无 critical breach | 最近 5 次 <60% → 退 L2 |
| **L4 Standard** | 团队标准 | ≥12 uses，最近 10 次 ≥90%，CVO 批准 | 1 次高风险越界 → freeze |

**双车道**：常规车道（标准数字）+ 长尾/高风险车道（`long_tail: true`，允许长期停 L2/L3）

### 三模式共享：知识层级分工

| 层级 | 角色 | 禁止 |
|------|------|------|
| Episode | 个案级证据底稿（A/B/C 的原料） | — |
| Method / Skill | 蒸馏后的复用资产（成品） | — |
| memory | 轻量索引/指针 | 禁止复制 Method 正文 |
| lessons-learned | 失败导向教训库 | 禁止塞入成功案例 |

### 三模式共享：元认知（运营级自知之明）

- 不信单次口头自信度（evidence: confidence-accuracy 负相关 r=-0.40）
- 用滚动域内可靠度 `(successes+1)/(trials+2)` + Wilson 下界
- 三信号路由：domain_reliability + evidence_completeness + self_reported_confidence
- 高风险域 action_confidence < 0.85 → 只做结构化分析 + 明确升级

### 三模式共享：Knowledge Object Contract

基于 ADR-011 通用 frontmatter，给知识对象加可选 `knowledge` 块（Maine Coon提议，6+2 核心字段先行）：

```yaml
knowledge:
  artifact_type: episode | method | skill | proposal | eval | lesson | log
  domain: development | medical | legal | product | ops | general
  knowledge_type: declarative | procedural | analytical | metacognitive
  scope: agent-local | team-shared
  trust_level: experimental | tested | validated | production
  lifecycle: draft | active | deprecated
  provenance:
    author_type: agent | human | collaborative
  source_refs: []
```

静态元数据进 frontmatter，动态状态（last_used, approval_status, hit_count）走事件流，不污染 git history。

### 落地路径

F100 的终态 = 行为层 + 知识对象化 + 验证闭环，面向终态设计，分步实现：

| Phase | 内容 | 状态 |
|-------|------|------|
| **Phase 1: 行为层** | self-evolution skill 三模式（A/B/C 触发规则） | done |
| **Phase 2: 知识对象化** | A: Scope Guard Log + 发散识别 / B: Proposal Log + 落地闭环 + 效果验证 / C: Episode Card + Dual Distillation + Eval Ledger / 共享: 五级阶梯 + 元认知 + knowledge contract + shared knowledge 分离 | done |
| **Phase 3: 可观测** | 事件 envelope + Knowledge Dashboard — **blocked on F102 close，需重新定义**（见下方 Phase 3 说明） | blocked |

### 关键认知更新

- **以前**：F100 是一个会提醒/会反思的 skill
- **现在**：F100 是"进化入口 + 知识对象生产线"的上游；F038 是下游的 discovery/router
- **以前**：Mode C = "值得沉淀就记下来"
- **现在**：三模式统一 = "先记录（Episode），再蒸馏（Method/Skill），再验证（Eval Ledger），用五级阶梯治理成熟度"

> "Mode C 不是把经历记下来，而是把 episode 抽成方法，再用 replay 证明它真有增益。先把三张卡片跑起来，别急着给三只猫装 PPO 发动机。" — GPT Pro

---

## Phase 3: 可观测层 — 待 F102 close 后重新定义（2026-03-16）

### 原设计回顾

Phase 3 原设计（立项于 2026-03-12，F102 之前）：
- **Event Envelope**：OpenTelemetry 兼容事件（7 种：skill_discovered / skill_loaded / memory_injected / memory_promoted / evolution_proposed / evolution_approved / evolution_reverted）
- **Knowledge Dashboard**（4 屏）：Capability Catalog / Memory Radar / Evolution Changelog / Graph View

### 为什么需要重新定义

F102（记忆组件 Adapter 化重构）在 F100 Phase 3 原设计之后立项并大幅推进，已建成：
- `evidence.sqlite` + FTS5 + sqlite-vec 向量增强 — 项目知识的存储/检索基座
- `search_evidence` 统一检索入口（scope/mode/depth 三维参数）
- 自动 edges 提取（frontmatter 交叉引用）+ memory invalidation 机制
- `docs_count / last_rebuild_at / backend` 可观测指标
- MCP 工具两层收敛方案（统一入口 + drill-down）

F100 Phase 3 原设计中的多个组件与 F102 存在重叠或依赖：

| F100 Phase 3 原组件 | F102 覆盖情况 |
|---|---|
| Capability Catalog（能力目录搜索） | `search_evidence` + `evidence_docs` 已可检索 |
| Memory Radar（热点/冲突/重复） | `edges` + `needs_review` invalidation 部分覆盖 |
| Event Envelope（7 种 OTel 事件） | 当前 3 猫规模下 ROI 存疑 |

### 计划

1. **Blocked on F102 close** — 等 F102 Phase D 剩余 AC 全部闭合（D6/D11/D12/D15~D17/D19）
2. **重新评估** — 基于 F102 终态能力，重新定义 Phase 3 交付物：
   - 哪些原设计组件已被 F102 覆盖（可删）？
   - 哪些需要在 F102 基座上增量构建（Dashboard UI / 事件流）？
   - 跑一段时间真实使用后，"可观测"到底缺什么？
3. **可能的瘦身方向** — Phase 3 大概率不需要 4 屏 Dashboard + OTel，更可能是：
   - 一个 CLI 命令输出知识库概览（knowledge status）
   - F100 知识对象（Episode/Method/Eval）在 `evidence.sqlite` 中的索引集成
   - 简单的 hit_count / last_used 统计（Phase 2 设计中提到的"动态状态走事件流"）

### F100 × F102 关系

```
F100 Self-Evolution（生产线上游）
  ├─ Phase 1: 行为层 — 什么时候触发 ✅
  ├─ Phase 2: 知识对象化 — 产出什么、怎么验证 ✅
  └─ Phase 3: 可观测层 — 看得见、查得到 ← blocked on F102

F102 Memory Adapter（存储/检索基座）
  ├─ Phase A~C: SQLite + FTS5 + 向量 ✅
  └─ Phase D: 激活 — 清理 + 数据源 + 协议 + 提示词 ← in-progress

关系：F102 是 F100 Phase 3 的基础设施层。
F100 Phase 2 产出的知识对象（Episode/Method/Eval）需要被 F102 索引才能"可观测"。
```
