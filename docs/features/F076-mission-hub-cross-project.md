---
feature_ids: [F076]
related_features: [F049, F058, F070]
topics: [mission-hub, cross-project, dispatch, reflux, command-center, client-governance]
doc_kind: spec
created: 2026-03-07
---

# F076: Mission Hub 跨项目作战面板 + 甲方项目治理引擎

> **Status**: phase-2-done | **Owner**: Ragdoll
> **Evolved from**: F049（Mission Control MVP）+ F058（Mission Hub 增强）+ F070（Portable Governance）

## Why

### 核心痛点（team lead采访 2026-03-07）

猫猫团队不只做 cat-cafe 自己的项目，还会被派遣到外部甲方项目（如 studio-flow）。
这类项目的管理痛点与自研项目截然不同：

1. **甲方不知道自己要什么** — 给的 PRD 往往是让 AI 写的"许愿清单"，看似完整实则空洞（缺 AC、缺边界、缺优先级）
2. **需求膨胀** — 甲方把"企业管理系统"所有模块一股脑塞进来（登录、工作台、客户、审核、团队、统计...），每个"一点"的工作量天差地别
3. **没有完成确信** — 自研项目 AC 自己定，心里有数；甲方项目的 AC 在甲方脑子里，你写的可能和他想的不一样
4. **救火员困境** — "当猫猫救火员的时候如何才能高质量完成任务？"

### team experience

> "甲方根本就不知道自己想要啥...他给了一个他的 claude 写的需求 prd...一个不懂编程的人带着大猫猫传来一份不知道如何形容的 prd"
>
> "和自己的项目那种全盘掌控的感觉完全不一样！现在就感觉乱七八糟的"

## What

### 产品定位

**甲方项目治理引擎** — 不只是看板，是"需求翻译 + 渐进交付"双引擎 + Mission Hub 可视化面板。

### 两大能力

**能力 1: 需求翻译官（Need Audit Pipeline）** — 多猫讨论收敛 2026-03-07

核心洞察（gpt52）：**第一步不是拆 feat，而是先降级。** 把 PRD 从"看起来完整的需求文档"降级为"待验证的意图包"。

关键升级（GPT Pro 外部咨询）：**"写得清楚" ≠ "是真的"。** certainty 必须拆成 clarity + groundedness，加 Source tag 硬门禁（AI 推断的不能直接进 Build Now）。

**Need Audit Pipeline v2**（6 阶段，含 GPT Pro 四刀升级）：

| 阶段 | 做什么 | 输出 |
|------|--------|------|
| 0. Frame | 谁拍板/为什么现在做/成败看什么/时间预算/现有流程/每条说法来源 | Sponsor Map + Goal Statement |
| 1. Downgrade + Intent Extraction | PRD → claim backlog（不叫 feature backlog）。6 槽 Intent Card + Source tag（Q/O/D/R/A）+ 粒度门禁 | Translation Matrix |
| 1.5 Domain Pass | 术语表 / 核心对象 / 状态机 / 数据源 / 边界 | Domain Model |
| 2. Validity Triage | 五维评分（clarity/groundedness/necessity/coupling/size-band）→ 5 类 | 分类标注 |
| 3. Resolution Design | 约束式确认题 / 证据请求 / 样本请求 / 低保真原型 / sponsor 升级 | Clarification Queue |
| 4. Slice Planning | Learning Slice（校正理解）/ Value Slice（业务闭环）/ Hardening Slice（加固） | Slice Ladder |

Triage 5 类：**Build Now** / **Clarify First** / **Validate First**（AI 推断、看似清楚但未锚定） / **Challenge** / **Later**

Source tag 硬门禁：Q=客户口述 / O=现场观察 / D=现有文档 / R=法规合同 / **A=AI 推断（不能进 Build Now）**

Intent Card 槽位（v2）：actor / context-trigger / goal / object-state / success_signal / non_goal + metadata(source_tag, decision_owner, confidence, dependency_tags)

8 类风险检测信号：动词空心 / 角色缺失 / 数据源不明 / 成功信号缺失 / 边界缺失 / 依赖隐藏 / AI 假具体 / 范围膨胀

**GPT Pro 外部咨询关键洞察**（2026-03-07）：
- "First version is MVP learning device, not MVP feature set" — 第一版的目的是校正团队对需求的理解，不是交付最多功能
- "Sentences are specific, decisions are not" — 定义 AI 假具体性：AI 写的句子看起来很具体，但背后的决策（谁拍板、数据来源、边界条件）完全未锚定
- **Provenance 升级路径**：A→Q（甲方确认）/ A→O（现场观察）/ A→D（找到文档）/ A→R（法规依据）
- **方法论谱系**：Volere, BABOK, IEEE 29148, INCOSE, ATDD/Three Amigos, User Story Mapping, Impact Mapping, JTBD

详见：

**能力 2: 渐进式交付引导（Incremental Delivery）**
- 大愿景 → 最小可验证切片（纵切业务链，不横切模块）
- 每个切片有明确 AC
- 做完给甲方看 → 甲方在实物前才知道自己真正要什么
- 反馈 → 调整 → 下一个切片

### Mission Hub UX 整合方案

> **重要决策 (2026-03-07 team lead反馈)**：F076 的 UI **不是**独立面板/dashboard，必须**集成到现有 Mission Hub 的 Tab 体系**中。
>

**现有 Mission Hub 风格**（参考截图）：
- 暖色调浅背景（cream/beige），非深色 dashboard
- Tab 结构：功能列表 | 告示面板 | ...
- 左侧：Feature 列表（F0xx），带状态徽章（执行中/暂停/已完成）
- 右侧：详情面板（建议详情 / Suggestion Detail）
- 状态栏：待审议 / 执行中 / 已完成 计数

**新 UX 方案（team lead拍板 + 二次追问 2026-03-07 20:52）**：

1. **导入外部项目** — Mission Hub 新增「导入项目」按钮
2. **项目 Tab** — 每个导入的外部项目成为一个新 Tab（如 "studio-flow"），与现有「功能列表」「告示面板」并列
3. **Tab 内 Backlog 对齐** — 进入外部项目 Tab 后，首先展示**该项目的 backlog**（复用 Mission Hub 的 feature 列表风格），实现跨项目 backlog 可视化对齐
4. **Need Audit 功能内嵌** — 在外部项目 Tab 内，逐步添加治理功能

**关键决策：外部项目 Tab 内同时具备两层能力**（team lead追问 20:52）

**回答：兼容！** 外部项目 Tab 内是 **Mission Hub 原有能力 + Need Audit 新能力** 的融合，不是只有 Need Audit。

| 层级 | 能力 | 来源 | Tab 呈现 |
|------|------|------|----------|
| **基础层：Mission Hub 原有** | Feature 列表 + 状态徽章 | 读取外部项目 ROADMAP.md | Sub-tab「功能列表」 |
| **基础层：Mission Hub 原有** | 告示面板 / Suggestions | 复用 SOP 告示牌能力 | Sub-tab「告示面板」 |
| **基础层：Mission Hub 原有** | 导入 Backlog | 从外部项目 ROADMAP.md 导入 feat 状态 | Header「导入 Backlog」按钮 |
| **基础层：Mission Hub 原有** | 状态筛选（待审议/执行中/已完成） | 复用筛选组件 | Status bar |
| **治理层：Need Audit 新增** | 需求追踪（Intent Card 列表 + Source tag） | Need Audit Pipeline | Sub-tab「需求追踪」 |
| **治理层：Need Audit 新增** | 治理健康度 | Triage 统计 | Sub-tab「治理健康度」 |
| **治理层：Need Audit 新增** | 风险预警 | 8 类风险信号 | Sub-tab「风险预警」 |
| **治理层：Need Audit 新增** | 切片计划 | Slice Planning | Sub-tab「切片计划」 |

**Sub-tab 结构**：功能列表 | 告示面板 | 需求追踪 | 治理健康度 | 风险预警 | 切片计划

**设计原则**：
- ✅ 延续 Mission Hub 暖色调 + 列表/详情 布局
- ✅ Tab 切换自然过渡，不割裂
- ✅ 外部项目拥有 Mission Hub 全部原有能力（不降级）
- ✅ Need Audit 功能作为额外 sub-tab 增量添加
- ✅ 右侧详情面板展示 Intent Card 详情（替代 Suggestion Detail）
- ❌ ~~独立深色 dashboard~~ — 初版 wireframe 已废弃

**不做的**:
- C（猫猫派遣状态）：大概率都是Ragdoll，不需要独立面板
- E（项目数据回流）：项目信息不进家门。只回流**知识工程经验**（方法论沉淀），不回流项目数据。"家不是工作的地方"

### 案例参考：studio-flow

`/home/user/studio-flow` — 典型甲方项目：
- 27+ features（SF-001 ~ SF-027），企业管理系统全模块
- 甲方9点验收基线 → BACKLOG feature 映射
- SF-025 Gap Fix Batch：6 个模块塞一个 feat（登录、工作台、客户、审核、团队、数据）
- 251 tests，Sprint 0/0.5/1/B 分层
- 已部署 cat-cafe governance（CLAUDE.md, AGENTS.md）
- **观察到的问题**：SF-025 是巨兽 feat、甲方"一点"粒度差异大、缺乏需求合理性挑战

**studio-flow 资源盘点 (2026-03-07 跨线程)**：

通过跨线程协作（studio-flow Ragdoll盘点），获取到以下甲方素材清单：
- **6 个 PRD 文件**：PRD-V1.md (744行, 10模块), PRD-V2.md (474行, 甲方逐条反馈+修改), PRD-V3.md (198行, 甲方口述补充), PRD-V4.md (101行, 后期优化项), PRD-V5.md (43行, UI/动效/细节), PRD-V6.md (22行, 最终修改)
- **25 features** (SF-001 ~ SF-027, 跳过 SF-013/SF-016)
- **甲方验收 9 点基线**：覆盖登录安全→工作台看板→客户管理→审核流→团队管理→统计报表→系统设置→响应式→通知
- **Trial Run 价值**：PRD-V1 最适合做 Need Audit Pipeline 首次试跑（内容最完整，且后续 PRD 可作为"甲方反馈"的真实参照）

## Dependencies

- **Evolved from**: F049/F058（Mission Hub 基座）
- **Related**: F070（治理回流与 dispatch 边界）
| 依赖 | 关系 |
|------|------|
| F049 Mission Control MVP | Evolved from — 单项目任务调度基座 |
| F058 Mission Hub 增强 | Evolved from — Feature-centric 两 Tab 架构 |
| F070 Portable Governance | Related — 治理数据 + dispatch 路径 |
| F070 Phase 3 (reflux) | Blocked by F076 — reflux 设计依赖本 feat 确定的面板和回流边界 |

## Architecture

Five-layer architecture: Ingestion → Audit Workbench → Planning Bridge → Mission Hub View → Pattern Reflux

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: Need Audit Pipeline — Stage 0~3 全流程可执行，输出 Intent Cards + Triage 结果 — **Phase 1 (Stage 0-2) + Phase 2 (Stage 3 Resolution Design) ✅**: 完整 pipeline 含 ResolutionStore + 5 种 resolution path + 澄清队列 UI
- [x] AC-2: Translation Matrix — 甲方原文 → Intent Card → Source tag → Triage 状态实时展示 — **Phase 1 ✅ (PR #304)**
- [x] AC-3: Risk Detection — 8 类信号自动/半自动检测 + 风险预警面板 — **Phase 2 ✅**: RiskDetectionService 8 启发式 + RiskPanel 前端 + detect-risks API + risk-summary API
- [x] AC-4: Governance + Delivery Health — triage 进度/Build Now 数量/open questions/slice 完成度/测试 — **Phase 1+2 ✅**: GovernanceHealth 含 triage distribution + resolution progress + slice progress
- [x] AC-5: Pattern Reflux — 方法论经验沉淀（不含项目数据）。接口对齐 F070 Phase 3 — **Phase 2 ✅**: RefluxPatternStore + reflux-routes API + RefluxCapture UI（仅方法论，不含项目数据）
- [x] AC-6: Slice Planning — Learning/Value/Hardening 三类切片 + 纵切业务链 — **Phase 2 ✅**: SliceStore + slice-routes API + SliceLadder UI（纵切 + reorder + status transition）

## Risk

- Scope 膨胀风险：跨项目治理与 Mission Hub 本体迭代容易互相挤压，需维持分阶段交付与回归门禁。

## Discussion Log

F076 经历了完整的多阶段讨论过程（2026-03-07 全天）：

### Phase 1: team lead采访 + 产品定位
- 5 轮 Q&A，从"跨项目面板"演化为"甲方项目治理引擎"
- 核心痛点提炼：甲方不知道自己要什么 / 需求膨胀 / 没有完成确信 / 救火员困境

### Phase 2: 多猫独立思考 + 讨论收敛
- **Opus 独立思考**：三阶段审计管线 + 5 个模糊检测启发式 → `opus-independent-thinking.md`
- **GPT-5.2 独立思考**：强调"降级优先" + Source tag + 粒度门禁 + 五维评分
- **收敛会议**：6 共识 + 5 分歧逐项解决 → `meeting-notes.md`
- GPT-5.2 Phase 5 review：+2 guardrails（展示治理产物不是原始数据；起步半自动不是全自动判断）

### Phase 3: GPT Pro 外部咨询
- team lead创建咨询文档，带 5 个问题给云端 GPT Pro
- GPT Pro 回复 ~250 行，含学术引用（Volere, BABOK, IEEE 29148 等）
- Opus 评估 7 个建议：5 采纳 / 2 延迟
- Pipeline v1 升级为 v2：+Stage 0(Frame) / +Stage 1.5(Domain Pass) / clarity+groundedness 拆分 / +Stage 3(Resolution Design)
- 详见 `gpt-pro-consultation.md`

### Phase 4: Opus + GPT-5.2 架构定稿
- GPT-5.2 直接读原始文档（不只看 Opus 转述），提出 +3 层需要
- 含：对象模型 / Intent Card v2 schema / 状态机 / 决策权矩阵 / 8 风险信号 / 方法论谱系

### Phase 5: studio-flow 跨线程资源盘点
- 跨线程协作请 studio-flow Ragdoll盘点所有甲方 PRD 素材
- 获取：6 PRD 文件 / 25 features / 9 点验收基线 / 试跑建议

### Phase 6: UX 方向修正
- team lead看了初版 wireframe（深色 dashboard 风格）→ **否决**
- team lead拍板新方案：集成到现有 Mission Hub Tab 体系（导入项目 → 新 Tab → Backlog 对齐 → Need Audit 内嵌）
- 设计原则：延续暖色调 + 列表/详情布局，不割裂
