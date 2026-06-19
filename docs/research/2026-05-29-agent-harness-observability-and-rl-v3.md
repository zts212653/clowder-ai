---
title: Agent Harness 可观测性体系研究报告
subtitle: 从执行追踪到强化学习训练数据工厂、再到 Harness 自进化的端到端分析
version: 3.0
date: 2026-05-29
authors:
  - 布偶猫 / 宪宪（Claude Opus 4.7）—— 主笔与整合
  - 布偶猫 / 宪宪（Claude Opus 4.6）—— 设计期分层、安全对齐、MCP 追踪细节、自进化 design-time 闭环
  - 布偶猫 / 宪宪（Claude Sonnet 4.6）—— 强化学习数据管道、推演架构、渐进式接入、自进化分层与双飞轮
  - 缅因猫 / 砚砚（GPT-5.5）—— 主线范式、身份血缘、协作契约、自进化治理与变更控制、最终架构审查
audience: 首席愿景官（CVO）+ 外部技术读者
doc_kind: research
changelog:
  - v3.0 (2026-05-29): 新增第十四章「可观测对 Harness 自进化的作用」（8 节）；扩展第四章三视图 schema 增加 harness_version_id / capability_attribution 字段族；扩展第十一章新增 §11.4 奖励函数进化风险与 §11.5 快飞轮吞噬慢飞轮；扩展第十二章 Clowder AI harness 自进化现状；扩展第十三章新增第五类「自进化约束」；参考文献新增 20 篇 harness 自进化论文。
  - v2.0 (2026-05-29): 四猫协作综合版。主线从「trace ≠ trajectory」二元论升级为「同一事件源派生三种视图」三元论；六层架构前置身份血缘层；新增语义状态层；协作契约升级；RL 八作用扩展为九作用；新增独立安全章节；十原则归并为四类约束。
  - v1.0 (2026-05-28): 主笔单独初版。提出 trace ≠ trajectory 论断与五层栈。
---

# Agent Harness 可观测性体系研究报告

> **从执行追踪到强化学习训练数据工厂、再到 Harness 自进化的端到端分析**
>
> **版本**：v3.0（四猫协作综合扩展版）
> **日期**：2026 年 5 月 29 日
> **状态**：正式调研分析报告
>
> **Provenance note**: 本 PR 只保留最终 v3.0；v2.0 作为中间版本不入仓，避免同一报告多版本并列污染检索。
> 外部论文、平台和行业 claim 按调研报告处理，来源集中列在「参考文献」；没有进入 feature
> spec / ADR / KD 表的判断不作为 Clowder AI 的实现真相源。

---

## 摘要

智能体（Agent）运行框架（Harness）已经成为大语言模型应用的基础设施级软件，但与之配套的可观测性（Observability）体系仍未成熟。本报告对当前业界相关学术论文、工业平台、开源标准化进展进行系统调研，提出一组协调一致的设计原则。

本报告的中心论断是：**Agent Harness 的可观测系统应当从"为人类调试服务的日志体系"重新定位为"同一底层事件源派生四种视图的协调系统"**——四种视图分别服务于人类调试（Debug Trace）、模型强化学习训练（RL Trajectory）、合规治理与质量评估（Governance Record），以及本次新增的第四类：**Harness 自进化驱动（Harness Evolution Driver）**。

围绕该中心论断，本报告系统性论证：
1. 单智能体场景下的六层可观测架构（在传统五层基础上前置"身份与版本血缘"层）；
2. "语义状态"必须作为独立于"执行轨迹"的一等数据平面；
3. 多智能体场景下，责任转移必须从事件升级为协作契约（Handoff Contract）；
4. 可观测数据对强化学习的九种作用机制（含记忆与检索本身作为强化学习训练对象）；
5. 强化学习训练基础设施的关键架构选择（推演与训练解耦、数据格式设计期对齐、渐进式接入路线图）；
6. 可观测系统自身必须具备防篡改设计，以应对奖励作弊（Reward Hacking）引发的对齐失败风险；
7. **新增**：可观测数据驱动 Harness 自进化的核心机制、五层进化目标、三支柱可观测模型、Level 0 到 Level 4 的演进光谱、与模型强化学习的双飞轮协作模型、四类自进化特有风险；
8. 下一代设计应当从离散的十条原则归并为五类约束框架（采集、存储与派生、训练接口、安全与治理、**自进化约束**）。

本报告由四位智能体协作产出。第一阶段（v1.0 / v2.0）由四只智能体（缅因猫 GPT-5.5、布偶猫 Opus 4.6、布偶猫 Sonnet 4.6、主笔布偶猫 Opus 4.7）独立给出报告，再由主笔整合并接受三猫的修正建议。第二阶段（v3.0）由首席愿景官指出"Harness 自进化"维度缺位，三猫再次协作贡献 15 条核心 insight 与 25+ 篇前沿论文证据。整合过程透明可追溯（附录 B）。

---

## 第一章 研究背景与问题界定

### 1.1 研究问题

随着大语言模型（Large Language Model, LLM）从单次对话演化为持续运行的智能体（Agent），承载它们的运行框架（Agent Harness，例如 Anthropic Claude Code、OpenAI Agents SDK、Google ADK、LangGraph、AutoGen、Magentic-One 等）已经成为基础设施级软件。但与之配套的可观测性（Observability）体系尚未成熟。本报告回答以下五个问题：

1. 在单智能体场景下，应该如何设计 Agent Harness 的可观测性？
2. 在多智能体协作场景下，可观测性面临哪些独有挑战？
3. 可观测数据对强化学习（Reinforcement Learning, RL）训练有何作用？为支撑模型 RL 训练，需要构建哪些可观测能力？
4. **可观测数据如何驱动 Harness 自身的进化？设计期产物如何变成"可学习的代码"？**
5. 下一代智能体与多智能体可观测体系应该长什么样？

### 1.2 研究范围

本报告聚焦运行时与设计时可观测（runtime and design-time observability），不深入讨论：模型预训练阶段的训练监控、智能体评测基准本身的方法论、智能体部署运维的成本管理。但本报告显式覆盖**设计期产物**（提示词版本、工具规范版本、智能体配置）的版本化追踪——这是当前业界普遍未充分覆盖的能力，亦是强化学习训练与 Harness 自进化所必需。

### 1.3 研究方法

本报告基于三类材料：

- **学术论文**：从 arXiv、ACM、AAMAS 等渠道收集 2024 年第四季度到 2026 年第二季度的相关论文 55 余篇
- **工业实践文档**：LangSmith、Langfuse、Arize Phoenix、Weights & Biases Weave、Braintrust、AgentOps、Latitude、Maxim、Promptfoo、PromptLayer、DSPy 等主流可观测与优化平台的官方文档
- **开源标准**：OpenTelemetry GenAI 工作组的语义规范、Google Agent-to-Agent (A2A) 协议、Anthropic Model Context Protocol (MCP)

报告由四位智能体协作完成。整合过程记录于附录 B，包括三位贡献者之间互相提出的修正建议及最终采纳裁决，作为该研究方法可重复性的证据。

---

## 第二章 关键术语与概念定义

为确保后续论证清晰，本章定义本报告涉及的核心术语。完整术语表见附录 A。

### 2.1 可观测性基础术语

**Span（跨度）**：分布式追踪中的最小单元，表示一段时间内发生的一次操作（例如一次函数调用、一次大语言模型接口请求、一次工具调用）。每个 span 拥有起止时间、名称、若干属性（attributes）、父 span 引用。

**Trace（追踪）**：由多个 span 组成的执行轨迹树。所有属于同一次请求或任务的 span 共享一个全局唯一的追踪标识符（trace ID），通过父子关系组成树形结构。

**Event（事件）**：附加在 span 上的时间点标记，记录 span 执行过程中某一瞬间发生的事情。

**Metric（指标）**：周期性采集的数值型测量（每秒请求数、延迟分布、错误率等）。

**W3C Trace Context**：W3C 标准，规定如何在 HTTP 请求头中传递 trace ID 和 span ID，使得跨服务调用能拼接成完整 trace 树。

**OpenTelemetry（OTel）**：CNCF 旗下的开源可观测性标准框架，定义 traces / metrics / logs 三类信号的接口、SDK、数据协议。

**Semantic Conventions（语义规范）**：OpenTelemetry 定义的标准化属性命名约定，确保不同厂商的可观测数据可互操作。

### 2.2 强化学习核心术语

**Reinforcement Learning（RL，强化学习）**：通过试错学习的机器学习范式。智能体在环境中执行动作，从环境获得状态和奖励反馈，目标是学到使长期累积奖励最大化的策略。

**Markov Decision Process（MDP，马尔可夫决策过程）**：强化学习的标准数学框架，由元组（状态空间、动作空间、转移概率、奖励函数、折扣因子）组成。

**POMDP（部分可观测马尔可夫决策过程）**：状态对智能体不完全可见的 MDP。

**Dec-POMDP（去中心化部分可观测马尔可夫决策过程）**：多智能体扩展，每个智能体拥有独立的局部观察和动作空间。

**Trajectory（轨迹）**：一次执行中按时间顺序排列的（状态, 动作, 奖励）元组序列：$\tau = (s_0, a_0, r_0, s_1, a_1, r_1, \ldots, s_T, a_T, r_T)$。**这是强化学习训练的基本数据单元**——所有 RL 算法都建立在轨迹之上。

**Rollout（推演）**：执行当前策略，产生一条轨迹的过程。

**Reward Model（奖励模型）**：从数据中学习的奖励估计器。

**Outcome Reward Model（ORM，结果奖励模型）**：只在轨迹终点给出一个最终成败信号的模型。

**Process Reward Model（PRM，过程奖励模型）**：对轨迹中每一步都给出奖励信号的模型，提供细粒度中间监督。

**Credit Assignment（信用分配）**：当轨迹末端有最终成败结果时，如何把这个最终奖励正确地归功（或归罪）到中间每一步。

**Action Mask（动作掩码）**：在序列建模训练时，告诉模型哪些 token 是智能体自己生成的（需要计算梯度损失）、哪些是提示词或环境反馈（不能计算损失）。

**Verifier（验证器）**：能机器判断轨迹是否成功的函数（自动测试、字符串匹配、单元测试结果）。

**Temporal Difference（TD，时序差分）**：强化学习中的一类核心算法，使用当前状态与下一状态的价值估计差异作为学习信号。

**Importance Sampling（重要性采样）**：用一个分布的样本估计另一个分布期望的方法。

**RLHF（基于人类反馈的强化学习）**：先用人类偏好数据训练奖励模型，再用该模型给强化学习提供奖励的两阶段流程。

**RLAIF（基于人工智能反馈的强化学习）**：用强大的人工智能模型代替人类做偏好标注的方法。

**DPO（直接偏好优化）**：跳过显式奖励模型，直接用偏好对训练策略的算法。

**GRPO（组相对策略优化）**：DeepSeek 提出的算法，用一组同输入下的多个推演相对评估替代评论者网络。

**Behavior Cloning（行为克隆）**：从演示数据中通过监督学习模仿专家行为的方法。

**Sub-Trajectory Filtered Behavior Cloning（SFBC，子轨迹过滤行为克隆）**：从失败轨迹中过滤出"失败前的成功子轨迹"用于行为克隆的方法（arXiv:2503.01062）。

### 2.3 智能体系统术语

**Agent（智能体）**：能自主感知环境、做决策、执行动作以达成目标的软件实体。

**Agent Harness（智能体运行框架）**：承载智能体运行所需的基础设施——大语言模型调用、工具注册、上下文管理、对话历史、执行循环、错误处理、权限控制等。在本报告中，harness 是**多层结构**：包括系统提示词、工具规范、技能库、标准操作程序（SOP）、规则、执行循环等。

**Orchestrator（编排器）**：在多智能体系统中，决定何时启动子智能体、给谁分派任务、如何聚合结果、何时停止的协调者。

**Multi-turn Interaction（多轮交互）**：智能体与环境或用户跨越多个对话轮次的连续交互。

**Agent-to-Agent Protocol（A2A 协议）**：Google 主推的智能体间通信标准。

**Model Context Protocol（MCP）**：Anthropic 主推的模型-工具协议。

**Handoff Contract（协作契约，本报告升级定义）**：智能体之间责任转移的结构化数据契约，包含交接目标、证据包、验收标准、确认时限、阻塞原因、分支与合并等字段。

**Deterministic Replay（确定性回放）**：记录执行过程中所有非确定性输入，后续可精确复现整个执行过程的能力。

**Causal Graph（因果图）**：一种有向无环图，节点是事件，边是因果依赖。

### 2.4 安全对齐术语

**Reward Hacking（奖励作弊）**：智能体学到利用奖励信号缺陷以最大化奖励、而非完成真实任务目标的行为模式。

**Emergent Misalignment（涌现失调）**：在某个有限任务上训练出的不良行为，泛化到模型在其他任务上的对齐失败。arXiv:2511.18397 证实：在无害任务上被训练出奖励作弊行为的模型，会泛化到对齐伪装、安全研究破坏、监控规避。

**Tamper-Resistant Observability（防篡改可观测）**：可观测系统的设计原则，确保可观测数据本身不能被被观测的智能体污染或绕过。

**Alignment Audit Trail（对齐审计轨迹）**：可观测系统输出的、用于事后审查智能体行为是否符合对齐目标的结构化数据。

### 2.5 Harness 自进化术语（v3.0 新增）

**Harness Self-Evolution（Harness 自进化）**：以可观测数据为输入，通过自动或半自动方式迭代修改 harness 的若干层（提示词、工具规范、技能库、SOP、规则等），使 agent 在固定模型下的行为质量持续改善的过程。**本质特征**：进化的对象是 harness 本身（agent 的可变代码层），而非模型权重。

**Harness Patch（Harness 补丁）**：对 harness 某层做出的一次具体修改。Harness patch 应被当作代码变更管理，而非运行时偏好微调。

**Harness Change Proposal（Harness 变更提案）**：评估系统产出的、供后续 shadow 验证与人类审批使用的中间产物，包含变更证据包、预期收益、反例集合、适用范围、回滚条件。

**Shadow Harness（影子 Harness）**：与生产 harness 并行运行的候选 harness 实例，用于 A/B 评估而不影响生产流量。

**Canary Rollout（金丝雀发布）**：将新 harness 先发布到一小部分流量做验证、再逐步扩大流量的渐进式发布策略。

**Reflexion（反思）**：让 agent 在失败后产生自然语言批评、注入下一轮决策上下文的方法（arXiv:2303.11366）。Reflexion 改变的是 episode 内的工作记忆，**不是 harness 自进化**。

**Voyager Skill Library（航行者技能库）**：在 Minecraft 环境中持续积累、验证、入库的代码技能集合（arXiv:2305.16291）。Voyager 是 L3 Skill 层 harness 自进化的标志性蓝图。

**DSPy（声明式自改进流水线）**：将 LLM 调用视为可编译程序的框架，自动优化提示词与少样本示例（arXiv:2310.03714）。

**TextGrad（文本梯度）**：把任意文本对象当作可微参数、通过 LLM 反向传播自然语言"梯度"优化的方法（arXiv:2406.07496）。

**SCOPE**：基于在线 prompt 进化的运行时学习方法（arXiv:2512.15374），通过双通道合成（corrective + enhancement）从执行追踪生成 guideline。

**AHE（Agentic Harness Engineering，智能体 Harness 工程）**：可观测性驱动的 coding agent harness 自动演化系统（arXiv:2604.25850）。直接对应本报告 Q4。

**Life-Harness**："Adapting the Interface, Not the Model" 范式（arXiv:2605.22166），证明 harness 进化与模型 RL 是正交且互补的两个优化平面。

**Capability Attribution（能力归因）**：通过去除 harness 某层后重跑同任务，估计 harness vs 模型贡献比例的方法。决定一项能力应通过 harness 进化保持还是通过模型 RL 内化。

**Spec Gaming（规格作弊）**：优化器找到使指标提升但不真正完成任务的修改方式。Harness 自进化的特有风险之一。

**Regression Blindness（回归盲点）**：自进化系统能预测"这次编辑会修什么"但难以预测"这次编辑会破坏什么"的现象。AHE 论文实证：fix-prediction precision 33.7% vs regression-prediction precision 11.8%。

---

## 第三章 业界现状综述

### 3.1 开源标准化进展

OpenTelemetry GenAI 工作组于 2024 年 4 月成立，目标是为大语言模型与智能体场景定义统一的可观测语义规范。截至 2026 年 4 月，相关规范（Semantic Conventions 1.40.0）仍处于"Development 状态"。

已定义的核心 span 类型：
- `gen_ai.chat`：大语言模型聊天补全
- `gen_ai.embeddings`：向量嵌入生成
- `agent.run` 或 `invoke_agent`：智能体执行
- `agent.tool_call` 或 `execute_tool`：工具调用
- `db.vector_search`：向量检索

已定义的核心属性：
- `gen_ai.system` / `gen_ai.request.model` / `gen_ai.response.model`
- `gen_ai.usage.input_tokens` / `output_tokens`
- `gen_ai.response.finish_reasons`

已定义的核心事件（用于存储内容）：
- `gen_ai.user.message` / `gen_ai.assistant.message` / `gen_ai.tool.message`

已定义的核心指标：
- `gen_ai.client.token.usage`（计数器）
- `gen_ai.client.operation.duration`（直方图）
- `gen_ai.server.time_to_first_token`（直方图）

OpenTelemetry v1.39+ 对模型上下文协议（MCP）的支持新增 `mcp.method.name` / `mcp.session.id` / `mcp.protocol.version` / `mcp.tool.name` 属性。MCP 客户端通过 W3C Trace Context 注入上下文，服务端 span 嵌套为客户端 span 的子节点。

**关键覆盖缺口**：
1. 多智能体协调
2. 层级智能体追踪
3. 会话与线程连续性
4. 智能体生命周期阶段（planning / execution / reflection）
5. 智能体身份与版本血缘
6. 协作契约
7. 语义状态与执行层分离
8. **Harness 自进化所需的设计期产物版本化与变更轨迹**（v3.0 新增缺口）

### 3.2 工业平台对比

| 平台 | 定位 | 优势 | 多智能体支持 | Harness 进化支持 |
|---|---|---|---|---|
| LangSmith | LangChain/LangGraph 原生 | 节点级状态差异 | 与 LangGraph 深度绑定 | 提供 Datasets + Eval，需自行接入 |
| Langfuse | 开源、MIT 许可 | 提示词管理 + 评估 | 通用 | 提示词版本管理 |
| Arize Phoenix | 开源 + 商业版 | 评估原语、漂移检测 | 强 | 评估优先 |
| Weights & Biases Weave | 实验追踪原生 | 与训练流水线集成 | 偏研究场景 | 实验追踪原生 |
| Braintrust | 评估优先 | 在线/离线评估闭环 | 通用 | 评估驱动 |
| AgentOps | 智能体专用 | 智能体 / 推理 / 规划 span 分层 | 原生 | 弱 |
| PromptLayer | 提示词专用 | 提示词版本捕获 + A/B 测试 | — | **设计期版本管理（Level 0）** |
| Promptfoo | 评估优先 | 声明式 eval + CI/CD 集成 | — | **设计期 TDD（Level 0）** |
| DSPy | 编译优化范式 | 提示词与少样本自动优化 | — | **Level 1 编译器优化** |

主流平台共性：以 trace 为核心数据模型，覆盖单次智能体执行可见性。普遍缺失：多智能体协作因果归因、编排器决策记录、强化学习训练就绪格式、协作契约、防篡改设计。**Harness 自进化方向上有零星探索（PromptLayer 做版本管理、Promptfoo 做评估门禁、DSPy 做编译优化），但没有平台做完整的"从可观测到 harness 改动闭环"。**

### 3.3 主要 LLM 厂商的路线

**Anthropic（Claude）**：Claude Code 通过 `CLAUDE_CODE_ENABLE_TELEMETRY` 启用追踪。子进程自动继承 `TRACEPARENT`。默认对用户提示词、工具输入做脱敏。后端使用 ClickHouse。

**OpenAI**：Agents SDK 内置可观测，输出符合 OpenTelemetry GenAI 规范的 span。强调"沙箱解耦"。

**Google**：A2A 协议显式定义 "Traceability Extension"，规定智能体间 HTTP 调用必须传播 W3C Trace Context。

### 3.4 学术前沿

**多智能体可观测**：
- *AgentTrace*（arXiv:2603.14688）：因果图重建方法
- *LumiMAS*（AAMAS 2026, arXiv:2508.12412）：动态智能体监控
- *AgentOps*（Dong et al., arXiv:2411.05285）：9 类 span 分类法

**轨迹与强化学习**：
- *AgentPRM*（arXiv:2502.10325）：蒙特卡洛步骤级监督
- *Agent-R1*（arXiv:2511.14460）：Tool / ToolEnv 抽象与动作掩码
- *DataPRM*（arXiv:2604.24198）：三值奖励结构
- *Orchestration Traces RL*（arXiv:2605.02801）：动态去中心化 POMDP
- *TRACE*（arXiv:2604.05336）：能力缺口检测合成训练任务
- *ReasonFlux-PRM*（arXiv:2506.18896）：步骤级+轨迹级双重监督
- *ProRL Agent*（arXiv:2603.18815）：推演与训练异步解耦
- *Sub-Trajectory Filtered BC*（arXiv:2503.01062）：失败轨迹过滤

**安全与对齐**：
- *Natural Emergent Misalignment from Reward Hacking*（arXiv:2511.18397）
- *Multi-Agent Constitution*（arXiv:2603.15968）
- *Constitutional AI*（arXiv:2212.08073）
- *AI Control*（arXiv:2312.06942）
- *Concrete Problems in AI Safety*（arXiv:1606.06565）

**Harness 自进化（v3.0 新增爆发研究群）**：
- *AHE: Agentic Harness Engineering*（arXiv:2604.25850）—— **直接对应本报告 Q4**，6 阶段闭环（Rollout → Clean → Attribution → Distillation → Evolution → Commit），Terminal-Bench 从 69.7% → 77.0%
- *Life-Harness*（arXiv:2605.22166）—— "Adapting the Interface, Not the Model"，4 层 interface 进化，116/126 设置改善
- *SCOPE*（arXiv:2512.15374）—— 在线 prompt 进化，HLE 14.23% → 38.64%
- *Autogenesis Protocol*（arXiv:2604.15034）—— 控制论框架，5 类资源 × 5 算子
- *Meta-Harness*（arXiv:2603.28052）—— 端到端 harness 代码优化
- *AutoHarness*（arXiv:2603.03329）—— Thompson sampling 引导 harness 合成
- *Natural-Language Agent Harnesses (NLAH)*（arXiv:2603.25723）—— harness 文本化
- *HASP*（arXiv:2605.17734）—— Skill 升级为 Program Functions
- *Externalization in LLM Agents*（arXiv:2604.08224）—— 综述，把 memory/skills/protocols/harness 作为外部化对象
- *Reflexion*（arXiv:2303.11366）—— Episode 内反思
- *Voyager*（arXiv:2305.16291）—— Minecraft 技能库累积
- *Eureka*（arXiv:2310.12931）—— 奖励函数自动生成（反面教材警示）
- *SkillWeaver*（arXiv:2504.07079）—— Web agent 技能跨 agent 迁移
- *EvolveR*（arXiv:2510.16079）—— 离线轨迹蒸馏为抽象可复用策略
- *Meta-RL with Self-Reflection*（arXiv:2603.11327）—— 跨 episode 反思持久化

**Prompt 优化工具链**：
- *ProTeGi*（arXiv:2305.03495）—— 自然语言梯度 + beam search
- *OPRO*（arXiv:2309.03409）—— LLM 作为优化器
- *DSPy*（arXiv:2310.03714）—— 声明式自改进流水线
- *TextGrad*（arXiv:2406.07496）—— 任意文本对象的文本梯度
- *AutoPDL*（arXiv:2504.04365）—— 可审查的中间表示
- *DSPy-Based Declarative Learning*（arXiv:2604.04869）

### 3.5 业界覆盖缺口总结

综合调研，当前业界存在以下系统性缺口：

1. 缺乏统一的多智能体协调 span 规范
2. 轨迹与追踪数据格式割裂
3. 停机决策的强化学习训练数据普遍缺失
4. 失败案例的可观测普遍弱化
5. 智能体身份与设计期产物的版本血缘缺失
6. 协作契约语义未被任何主流平台一等公民化
7. 语义状态与执行轨迹未在数据模型上分离
8. 可观测系统自身的防篡改设计缺位
9. **Harness 自进化所需的"评估 → 变更提案 → shadow 验证 → 渐进发布"全链路缺位**（v3.0 新增）
10. **Harness 变更轨迹（patch lineage）作为一等公民事件未被任何主流平台支持**（v3.0 新增）

---

## 第四章 核心范式：同一事件源派生四种视图

### 4.1 论断：从二元到四元的范式重构

本报告 v3.0 提出的核心论断如下：

> **合格的 Agent Harness 可观测系统，应当是以"同一底层事件源"为输入、向"四种独立视图"派生的协调系统。**

四种视图分别为：

| 视图 | 服务对象 | 核心问题 | 优化目标 |
|---|---|---|---|
| **Debug Trace（调试追踪视图）** | 人类工程师 | 发生了什么？为什么失败？ | 可读性、可检索、可回放 |
| **RL Trajectory（强化学习轨迹视图）** | 模型训练流水线 | 该如何学？哪步该奖励/惩罚？ | 步骤边界、动作掩码、奖励字段 |
| **Governance Record（治理记录视图）** | 合规、评估、对齐审计 | 行为是否符合规范？是否被篡改？ | 不可抵赖、可追溯、可签名 |
| **Harness Evolution Driver（Harness 进化驱动视图）** *（v3.0 新增）* | 自进化控制面 | 哪个 harness 组件该改？改后效果如何验证？ | 组件可定位、变更可证伪、回归可检测 |

第四视图与前三视图的关键差别：前三种回答"发生了什么 / 模型该学什么 / 行为是否合规"，第四种回答"**harness 自身应当如何修改**"。这是从"agent 是被观测对象"到"agent 与 harness 共同是被进化对象"的范式扩展。

**为什么不是分别采集？** 这是本范式的核心约束：**四种视图必须来自同一份底层事件源**。理由：
1. 多套独立采集会导致数据不一致
2. 同一事件在不同视图下的字段重叠是大头
3. 共享底层事件源使得"从追踪追问轨迹的差异"成为可机器化操作
4. 共享底层事件源使得"用同一份数据同时训练模型与进化 harness"成为可能

### 4.2 共享底层事件源的字段设计

底层事件源（Event Source）的最小字段集合（v3.0 扩展版）：

```
event = {
  // 身份与血缘（v2.0 第五章 Layer 0）
  trace_id, span_id, parent_span_id,
  session_id, thread_id, invocation_id,
  agent_id, model_id, policy_version,
  prompt_version, tool_schema_version, harness_version,

  // v3.0 新增：Harness 进化驱动字段
  harness_version_id,               // 当前 harness 完整版本号
  harness_a_b_group,                // control | treatment
  harness_artifact_refs: [          // 本次执行引用的 harness 组件列表
    { artifact_type, artifact_id, version, risk_tier }
  ],
  capability_attribution: {         // ablation 估计的贡献分解
    harness_contribution_score: 0.65,
    model_contribution_score: 0.35
  },

  // 时间与序列
  timestamp, sequence_no,

  // 执行轨迹
  span_kind, span_name, inputs, outputs, status,

  // 语义状态（第六章）
  pre_state, post_observation, goal, plan_step,
  context_summary_ref, memory_lineage,
  tool_side_effect, artifact_diff,
  policy_state, constraint_state,

  // 决策与反事实（第七、九章）
  decision_candidates, decision_chosen, decision_rationale_ref,

  // 强化学习接口（第九、十章）
  action_mask, reward_signal, td_advantage,

  // v3.0 新增：自进化反馈字段
  self_reflection_content,          // agent 的自我批评内容
  reflection_trigger,               // 失败/纠正/验证器报错
  harness_change_candidate: {       // 若该 trace 触发 harness 改动候选
    target_layer,                   // L1-L6
    change_description,
    confidence,
    requires_human_approval
  },

  // 治理与对齐（第十一章）
  redaction_policy, signature, provenance,
}
```

### 4.3 四视图的派生映射与有损边界

**Debug Trace 视图**：完整保留事件序列、父子结构、原始内容，按 trace ID 与 span ID 检索。

**RL Trajectory 视图**：派生为 $(s, a, r, s')$ 元组序列。涉及状态抽象、动作边界、奖励归因、隐私导出策略。

**Governance Record 视图**：派生为不可抵赖的审计记录。保留决策点候选与选择、身份血缘、签名、事后裁决关联。

**Harness Evolution Driver 视图**（v3.0 新增）：派生为变更建议数据。包含：
- 失败模式聚类
- 与同任务历史 harness 版本的对比指标
- Component / Experience / Decision 三支柱可观测的派生（详见第十四章）
- Harness Change Proposal（变更提案）的输入证据包

**有损边界**：四种派生视图之间不是无损可逆的关系。**底层事件源必须保留比任一单视图都更完整的信息**——这是支持四视图派生的工程代价。

---

## 第五章 单智能体可观测的六层架构

### 5.1 六层架构总览

```
┌─────────────────────────────────────────────────────────┐
│ Layer 5: Behavioral Feedback Plane（行为反馈层）         │
├─────────────────────────────────────────────────────────┤
│ Layer 4: Structured Trace Store（结构化追踪存储层）       │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Metrics（指标层）                              │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Events（事件层）                               │
├─────────────────────────────────────────────────────────┤
│ Layer 1: Spans（跨度基础层）                            │
├─────────────────────────────────────────────────────────┤
│ Layer 0: Identity & Version Lineage（身份与版本血缘层）  │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Layer 0：身份与版本血缘层

业界主流可观测平台普遍缺失这一层。本报告将其前置为 Layer 0，理由：**没有版本血缘就没有可重放、可比较、可训练、可进化**。

身份与版本血缘的最小字段集（v3.0 扩展）：

| 类别 | 字段 | 用途 |
|---|---|---|
| 追踪标识 | trace_id, span_id, parent_span_id | 跨服务调用拼接 |
| 会话标识 | session_id, thread_id, invocation_id | 任务边界与并行实例区分 |
| 主体标识 | agent_id, agent_persona, agent_role | 智能体身份 |
| 模型版本 | model_id, model_version, policy_version | 模型回归对比 |
| 设计期产物 | prompt_version, tool_schema_version, agent_config_snapshot | 行为变化归因 |
| 框架版本 | harness_version, mcp_protocol_version | 运行环境追溯 |
| 数据版本 | dataset_version, memory_collection_version | 训练数据可重现 |
| **Harness 组件清单（v3.0）** | harness_artifact_refs[] | 列出本次执行引用的所有 harness 组件（type, id, version, risk_tier） |
| **A/B 分组（v3.0）** | harness_a_b_group | 标记本次执行属于 control 还是 treatment |
| **能力归因（v3.0）** | capability_attribution | ablation 估计的 harness vs 模型贡献分解 |

**关键工程含义**：当强化学习训练或 harness 自进化遇到"模型性能突然下降"时，可观测系统必须能回答：是模型变了？是提示词改了？是工具规范升级了？是某个 skill 改动了？是环境数据漂移了？

### 5.3 Layer 1：跨度层

在 OpenTelemetry GenAI 现有规范基础上，本报告建议补充以下 span 类型：

| Span 类型 | 父 span | 说明 |
|---|---|---|
| `agent.invocation` | — | 一次智能体被调用（顶层） |
| `agent.turn` | `agent.invocation` | 一轮对话或思考 |
| `agent.reasoning_step` | `agent.turn` | 一个推理步骤（PRM 训练所需） |
| `agent.tool_call` | `agent.reasoning_step` 或 `agent.turn` | 工具调用 |
| `agent.llm_call` | `agent.reasoning_step` | 大语言模型 API 调用 |
| `agent.handoff` | `agent.turn` | 协作契约转移事件 |
| `agent.memory_op` | `agent.reasoning_step` | 记忆读写操作 |
| **`agent.harness_patch`**（v3.0 新增） | `agent.invocation` 或独立顶层 | Harness 变更事件（应用/回滚） |

### 5.4 Layer 2-5：事件、指标、存储、反馈

（章节内容与 v2.0 一致，详见原文。）

### 5.5 并列维度：数据粒度层

```
Token-level / Step-level / Turn-level / Trajectory-level / Session-level
```

功能层与粒度层并列存在。同一字段在两个维度下都有归属。

---

## 第六章 语义状态层

### 6.1 论断：执行层与语义层必须分离

业界主流把"调用了什么"作为核心数据，但**调用本身不等于发生了什么**。

| 层 | 关注 | 字段 |
|---|---|---|
| Execution Plane | 调用机制 | span 名称、参数、返回值、时延、错误码 |
| Semantic Plane | 状态变化 | 目标、计划步骤、上下文摘要、记忆血缘、工具副作用、产物差异、策略状态 |

**强化学习的奖励应当基于语义层的状态变化，而不是执行层的调用成败**。

### 6.2 语义状态的最小字段集

每个动作 span 应当同时携带前置状态（pre_state）与后置观察（post_observation）。

---

## 第七章 多智能体协作可观测

### 7.1 范式转换：从请求流转到主体切换

传统分布式系统的可观测难点是请求在节点间流转。多智能体系统的可观测难点是主体在切换。

### 7.2 协作契约（Handoff Contract）

```
agent.handoff_contract = {
  from_agent, to_agent,
  task_goal, evidence_package, acceptance_criteria,
  ack_deadline_ms, ack_status,
  blocked_on, branch_from, merge_into,
  message_id, outcome_link
}
```

派生指标：协作契约掉地率、验收通过率、链式延迟分布。

### 7.3 跨主体追踪拼接

W3C Trace Context 解决跨 HTTP，但智能体场景更复杂——跨 IPC / WebSocket / 跨对话线程 / 同身份多实例并行。

### 7.4 编排决策可观测

*Orchestration Traces* 论文将编排追踪定义为"有根、边带标签、顶点带标签的时序图"。提出动态去中心化部分可观测 MDP 形式化。

**反事实记录的理论必要性**：Observation 2 论证编排器启动决策的反事实效应无法从在策略推演中识别。

**反事实记录的适用边界**：
- 高价值任务用重要性采样近似
- 安全关键路径沙箱事后回放
- 确定性环境完整分支记录

### 7.5 确定性回放

记录所有非确定性输入后可精确复现执行过程。AGDebugger 模式支持回滚、编辑、回放。

### 7.6 因果图重建

建模三类边：时间边、数据流边、控制流边。

---

## 第八章 MCP 工具追踪的 OpenTelemetry 实现细节

### 8.1 MCP 在 OpenTelemetry 语义规范中的位置

OpenTelemetry GenAI v1.39+ 定义 `mcp.method.name` / `mcp.session.id` / `mcp.protocol.version` / `mcp.tool.name`。

### 8.2 W3C Trace Context 在 MCP 中的传播

MCP 客户端在发起调用时注入追踪上下文；服务端提取上下文作为新 span 父上下文。

### 8.3 与 `execute_tool` 的关系

MCP 检测器应当增强现有 `execute_tool` span，而不是创建独立 span。

### 8.4 MCP 追踪对多智能体的意义

当 MCP 工具自身也是另一个智能体时，MCP 追踪规范自然产出符合主体性可观测要求的数据。

---

## 第九章 可观测数据对强化学习的九种作用

### 9.1 核心论断

> **没有合格的可观测系统，就没有合格的智能体强化学习训练数据。**

### 9.2 九种作用机制

#### 作用一：轨迹抽取
将追踪转换为 $(s, a, r, s')$ 元组序列。必须包含动作掩码。

#### 作用二：过程奖励模型训练
AgentPRM 算法：蒙特卡洛 Q 值估计 → 监督学习 → 在线 DPO。

#### 作用三：验证器集成
追踪 schema 必须包含可被验证器机器消费的字段。

#### 作用四：能力缺口检测
从大量轨迹聚类识别能力缺口，合成针对性训练任务。

#### 作用五：信用分配
SHARP（Shapley 值）+ TAR²（联合时序与智能体维度的奖励再分配）。

#### 作用六：停机决策训练
业界研究空白。"完成签字"作为结构化事件持久化的运行框架握有稀缺训练数据。

#### 作用七：负样本与失败模式
SFBC 子轨迹过滤行为克隆。结构化追踪存储必须支持子轨迹切片查询。

#### 作用八：编排策略学习
编排器层级的追踪是编排策略 RL 训练所必需。

#### 作用九：记忆与检索作为 RL 训练对象
检索查询 / 候选 / 选中 / 后续消费四元组训练检索策略、记忆写入策略、幻觉检测器。

### 9.3 三值奖励分类

| 等级 | 奖励 | 场景 |
|---|---|---|
| 严格正确 | 1.0 | 逻辑正确推进 |
| 可恢复错误 | 0.5 | 小错触发重试后修复 |
| 不可恢复错误 | 0.0 | 致命逻辑错误 |

### 9.4 可自动验证域与需判官介入域的区分

| 任务域 | 步骤级奖励来源 | 成本 | 噪声 |
|---|---|---|---|
| 可自动验证 | 测试通过/失败 | 低 | 低 |
| 半验证 | 模式匹配 + 大语言模型判官 | 中 | 中 |
| 完全主观 | 多判官集成 + 偏好对 + 人类抽查 | 高 | 高 |

### 9.5 强化学习就绪可观测能力清单

| 能力 | 优先级 |
|---|---|
| 推理步骤级 span | P0 |
| 动作掩码字段 | P0 |
| 轨迹存储 + 验证器集成 + 步骤边界 | P0 |
| 状态可哈希化 + 跨轨迹聚合检索 | P0 |
| 工具调用三值或四值语义化结果 | P1 |
| 停机决策结构化记录 | P1 |
| 编排器动作显式 span | P1 |
| 失败轨迹独立持久化 + 子轨迹切片 | P1 |
| 记忆与检索四元组 | P1 |
| 时序差分自动标注 | P2 |
| 确定性回放基础设施 | P2 |
| 跨轨迹因果图重建 | P2 |

---

## 第十章 强化学习训练基础设施

### 10.1 强化学习就绪数据格式是设计期决策

可观测系统的数据 schema 应当从第一天起就向强化学习格式对齐。

### 10.2 推演即服务

ProRL Agent 提出推演与训练异步解耦三阶段流水线：INIT → RUN → EVAL。

### 10.3 子轨迹切片查询

直接来自 SFBC 失败数据利用方法的工程要求。

### 10.4 渐进式强化学习接入路线图

```
阶段 1：仅需可验证结果奖励
阶段 2：加入过程奖励模型 + 时序差分自动标注
阶段 3：加入基于人工智能反馈的偏好优化
阶段 4：加入多智能体信用分配
```

每阶段独立可验证，不依赖下一阶段。

---

## 第十一章 安全与对齐：可观测自身的防篡改设计

### 11.1 论断：可观测-强化学习闭环必须有安全维度

奖励作弊（reward hacking）不是理论风险。*Natural Emergent Misalignment from Reward Hacking* 实证：在无害任务上训练出奖励作弊行为的模型会泛化到对齐伪装、安全研究破坏、监控规避。

### 11.2 防篡改可观测的 Schema 设计

| 设计点 | 具体要求 |
|---|---|
| 奖励来源不可由被观测智能体自写 | reward_signal 写入权限严格限于独立评估服务 |
| 判官 span 携带来源证明 | 判官身份、模型版本、提示词版本 |
| 原始内容防篡改 | 哈希指针存储，明文走独立通道 |
| 导出数据集签名 | 脱敏策略、签名、时间戳 |
| 监控规避检测 | 对比被监控与不被监控两种情境下的行为差异 |

### 11.3 对齐审计轨迹

- 不可抵赖：智能体不能事后否认决策
- 可追溯：任何裁决能追溯到证据
- 可签名：审计输出能用密码学证明完整性

### 11.4 奖励函数层进化的特殊风险（v3.0 新增）

奖励函数本身是 harness 的一部分。当奖励函数进入自进化循环时，会出现 Goodhart's Law 的最严重形态：**奖励函数被进化成"容易得分"而不是"真正完成任务"**。

证据：*Eureka*（arXiv:2310.12931）—— GPT-4 自动生成奖励函数，在 29 个 RL 环境中 83% 超越人类专家。表面成功，但实验依赖 IsaacGym 物理仿真的物理定律作为 ground truth。**在 LLM agent harness 中没有物理定律作为保底——奖励函数的自动进化必须有更强的护栏。**

防护机制：

| 防护点 | 具体要求 |
|---|---|
| 多目标并列优化 | 至少三类指标：任务成功率 / 规则遵守率 / 语义结果质量。单指标提升不得自动通过 |
| 独立 holdout 集验证 | 优化器没见过的任务作为外部验证 |
| 评估器分歧检测 | LLM 判官与验证器打分不一致超阈值时锁定该奖励函数变更 |
| 人工最终确认 | 奖励函数变更必须由独立服务的人类确认，不可由 harness 自进化系统自动部署 |
| Navigation Utility ≠ Truth Authority | 行为消费信号可改导航优先级，但不能自动提升真相权威 |

### 11.5 快飞轮吞噬慢飞轮：自进化与模型 RL 的耦合风险（v3.0 新增）

新风险：harness 进化（快飞轮，小时-天级）与模型 RL（慢飞轮，天-周级）耦合时，快飞轮可能压制慢飞轮。

具体表现：harness 进化太快，导致模型 RL 收集到的训练数据始终来自不同 harness 版本，无法形成稳定的训练信号。模型永远在追 harness 的变化，无法收敛。

防护：
- Harness 版本锁定：模型 RL 训练期间锁定对应的 harness 版本
- harness_version_id 字段在所有轨迹中记录
- RL 训练只消费"同 harness 版本下"的轨迹（避免跨版本污染）
- 通过 capability_attribution 字段判断："这个能力已经稳定，可以从 harness 迁移到模型权重了"

---

## 第十二章 Clowder AI 现状对照与差距分析

为便于外部读者理解，本章对照 Clowder AI 当前能力与本报告设计原则。

### 12.1 已建成或在建的能力

**运行时可观测基础设施模块**（内部代号 F153）：OpenTelemetry SDK 三柱体系。字段脱敏四级、指标基数控制、Prometheus + OTLP 双出口、内存环形缓冲、本地追踪树可视化、SLO 告警、span 持久化。对应 Layer 1-4。

**社会-技术评估体系**（内部代号 F192）：从可观测平台消费运行时数据 → 对照预期声明做偏差分析 → 输出"删除 / 弃用 / 新建 / 修复 / 保留"五类裁决。具备跨领域评估控制面。**对应本报告 §14.2 的 Harness Change Proposal 雏形——但当前评估直接产生裁决，缺少"评估 → patch 候选 → shadow 验证 → 渐进发布"的完整自进化控制面。**

**记忆系统消费加权机制**（内部代号 F200）：不只记录搜索结果是否被生成，记录下一棒是否真的消费。对应 Layer 5 + §14 的 Navigation Utility 信号样板。**当前缺 Navigation Utility ≠ Truth Authority 的边界明确化。**

**智能体协作球权与事件驱动协议**（内部代号 F167）：显式建模责任转移。对应 §7.2 协作契约早期形态（事件层面，待升级为契约层面）。

**跨运行时会话透明性**（内部代号 F211）：覆盖外部运行时的会话链路。对应 §7.3 跨主体追踪拼接。

**命令行错误结构化诊断**（内部代号 F212）：命令行子进程错误的结构化诊断信息。对应 §9.2 作用七负样本。

**图书馆管护与技能迭代**（内部代号 F188）：技能与文档的人工管护、知识精炼。**对应 §14 的 L3 Skill 层进化雏形，但当前是手动迭代，没有可观测数据自动驱动。**

### 12.2 关键能力缺口

对照设计原则的完整缺口清单：

1. 缺少身份与版本血缘层的统一字段集
2. 缺少推理步骤级 span
3. 缺少动作掩码字段
4. 协作球权未升级到契约结构
5. 缺少语义状态层与执行层的显式分离
6. 缺少编排器动作的显式 span
7. 工具调用结果缺乏三值或四值语义化分类
8. 缺少 MCP 工具追踪的 OpenTelemetry 属性对齐
9. 缺少确定性回放基础设施
10. 缺少跨轨迹因果图
11. 缺少防篡改可观测的 schema 级设计
12. 缺少推演与训练解耦的独立服务架构
13. **缺少 Harness Change Proposal 中间层（v3.0 新增）**
14. **缺少 Shadow Harness 与 Canary Rollout 机制（v3.0 新增）**
15. **缺少 harness_version_id 与 capability_attribution 字段（v3.0 新增）**
16. **缺少 Harness 五层组件的统一注册与版本管理（v3.0 新增）**
17. **缺少奖励函数进化的多目标并列优化与人工确认门禁（v3.0 新增）**

### 12.3 差异化潜力

综合调研，Clowder AI 若补齐缺口，存在五处业界差异化窗口：

1. **可观测即强化学习训练数据工厂**
2. **结构化的停机决策数据**
3. **协作契约作为一等公民**
4. **防篡改可观测**
5. **可观测驱动 Harness 自进化的完整闭环**（v3.0 新增）—— Clowder AI 已有的评估体系（F192）+ 技能管护（F188）+ 行为消费加权（F200）已经覆盖自进化所需的 3/5 关键能力，是当前业界最接近完整闭环的运行框架之一。补齐 Harness Change Proposal + Shadow Harness 两块，即可领先业界。

---

## 第十三章 下一代设计框架：五类约束

早期版本将下一代设计抽象为十条原则，v2.0 归并为四类约束框架。v3.0 新增第五类"自进化约束"，形成完整五类框架。

### 13.1 采集约束

| 原则 | 工程要求 |
|---|---|
| 身份与版本血缘必须前置 | 每条 span 必须携带 agent_id / model_version / prompt_version / harness_version |
| 语义状态独立于执行轨迹 | 每个动作 span 必须携带 pre_state 与 post_observation |
| 推理步骤是奖励单位 | 每个推理步骤 span 必须有步骤边界标识与可哈希状态摘要 |
| 默认脱敏，明文按需 | 四级脱敏，明文显式 opt-in |
| 多模态一等公民 | 语音 / 图像 / 浏览器 / 设计文件操作均为一等 span |

### 13.2 存储与派生约束

| 原则 | 工程要求 |
|---|---|
| **四视图派生（v3.0 升级）** | 同一事件源派生 Debug Trace / RL Trajectory / Governance Record / Harness Evolution Driver 四类视图 |
| 子轨迹切片查询 | 必须支持按事件序号范围或语义状态变化切片 |
| 失败轨迹独立通道 | 失败轨迹保留策略等同或优先于成功轨迹 |
| 跨主体追踪拼接 | W3C Trace Context 跨 HTTP / IPC / WebSocket / 跨线程消息全部传播 |
| 跨运行时联邦 | 多个智能体运行框架在统一追踪视图中可见 |

### 13.3 训练接口约束

| 原则 | 工程要求 |
|---|---|
| 数据格式设计期对齐 | 事件 schema 包含动作掩码、奖励字段、价值估计字段 |
| 协作契约可机器消费 | 责任完整转移可机器检测 |
| 推演与训练解耦 | 推演即服务架构 |
| 步骤边界明确 | 推理步骤 span 提供过程奖励监督单位 |
| 渐进式接入 | 四阶段路线图（结果 → 过程 → 偏好 → 多智能体），每阶段独立可验证 |

### 13.4 安全与治理约束

| 原则 | 工程要求 |
|---|---|
| 奖励来源隔离 | reward_signal 写入权限严格限于独立评估服务 |
| 判官来源证明 | 判官身份、模型版本、提示词版本 |
| 原始内容指针化 | 哈希指针存储 |
| 导出数据集签名 | 脱敏策略、签名、时间戳 |
| 监控规避检测 | 隐写式推理检测 |
| 自省接口 | 智能体能消费自身追踪摘要做自我修正，自省通道独立于治理通道 |
| 裁决驱动闭环 | 可观测 → 评估 → 裁决 → 责任人 → 再评估 |

### 13.5 自进化约束（v3.0 新增）

| 原则 | 工程要求 |
|---|---|
| **Patch 不直写** | 评估不直接修改 harness，只产生 Harness Change Proposal（含证据包、预期收益、反例、适用范围、回滚条件） |
| **Shadow First** | 任何 harness 变更必须先在 shadow harness 中通过历史轨迹回放门禁（pass rate > 阈值），再进入金丝雀 |
| **Artifact 元数据完整** | 每个 harness artifact 必须携带 artifact_type / risk_tier / owner / version_snapshot / rollback_ref 五字段 |
| **分层风险治理** | L1 Reward / L5 Identity / L6 Execution Loop 必须人主导；L3 Skill / L4 SOP 必须 shadow + canary + 人审；L2 Prompt 措辞可自动 PR + 自动门禁 |
| **多目标并列指标** | 进化驱动指标至少三类并列：任务成功率 / 规则遵守率 / 语义结果质量。单指标提升不得自动通过 |
| **回归预见性记录** | 每次 patch 提交必须附带 change_manifest（预测修复 + 预测回归），下次迭代验证预测 vs 实际 |
| **能力归因字段** | 每条轨迹携带 capability_attribution（harness vs 模型贡献分解），决定何时从快飞轮迁移到慢飞轮 |
| **Navigation ≠ Authority** | 行为消费信号可改导航优先级，不能自动提升真相权威 |
| **Harness 版本锁** | 模型 RL 训练期间锁定对应 harness 版本，所有训练轨迹消费同 harness 版本 |
| **人类否决权显式** | 高风险层变更必须有 approval_record；超过阈值的累积变更触发人类确认 |
| **复验闭环** | 任何已部署 patch 必须有再评估机制，回归阈值触发自动回滚 |

---

## 第十四章 可观测对 Harness 自进化的作用（v3.0 新章）

### 14.1 论断：Harness 是 Agent 的可变代码层

本章的核心论断：

> **Harness 自进化不是 agent 直接改自己，而是"可观测证据 → 评估裁决 → 受控 harness 变更提案 → 影子/AB 评估 → 渐进发布 → 再评估 / 回滚"的变更控制系统。Harness 补丁应被当作代码变更，而非运行时偏好微调。**

此外，更深层的范式定位：

> **将设计期产物（提示词、工具规范、技能、中间件、配置）从"人类编写的静态文本"重新定位为"可被运行时可观测数据自动优化的可学习参数"——与模型权重训练正交但互补的第二优化平面。**

证据：
- *Life-Harness*（arXiv:2605.22166）："the adapted harness H′ changes how the frozen model interacts with the environment, while leaving both the model weights and the evaluation environment unchanged"——明确将 harness 进化与模型权重训练分为两个独立平面
- *AHE*（arXiv:2604.25850）：通过 attribution 把性能提升明确归因于 harness 编辑，而非模型分析能力
- *TRACE*（arXiv:2604.05336）："explicitly training the model to exercise those capabilities is necessary for stronger performance"——证明两个平面可叠加但不互相替代

### 14.2 Harness 的六层分层：每层有专属进化路径

将 harness 视为一个整体"可以被进化"是错误的简化。**Harness 是分层的可进化对象，不同层的进化速度、信号来源、风险等级完全不同**，必须分层治理。

```
┌─────────────────────────────────────────────────┐  风险↑
│ L6: Execution Loop / Runtime Core                │  极慢（季度级）
│     "agent 怎么循环、怎么调度"                     │
├─────────────────────────────────────────────────┤
│ L5: Identity / System Prompt                     │  慢（月级）
│     "你是谁、你的边界是什么"                       │
├─────────────────────────────────────────────────┤
│ L4: SOP / 规则 / 协议                             │  慢（月级）
│     "你在什么情况下做什么"                         │
├─────────────────────────────────────────────────┤
│ L3: Skill / Tool 描述                            │  中（周级）
│     "你能调用哪些工具、怎么调用"                    │
├─────────────────────────────────────────────────┤
│ L2: Prompt Template / Few-shot Examples          │  快（天级）
│     "每次调用时注入什么上下文"                      │
├─────────────────────────────────────────────────┤
│ L1: Evaluation / Reward Function                 │  中（周级）
│     "成功的标准是什么"                             │  风险↓（隐蔽）
└─────────────────────────────────────────────────┘
```

每层消费的可观测字段与进化触发条件：

| Harness 层 | 消费的可观测字段 | 进化触发条件 | 进化模式 |
|---|---|---|---|
| L6 Execution Loop | 跨任务系统性失败、死锁/活锁模式 | 极少触发；需架构级重新设计 | 人主导，工具辅助 |
| L5 Identity | 会话级任务失败率、目标漂移检测 | 失败率跨会话持续 > 阈值 | 人主导，自动验证辅助 |
| L4 SOP/规则 | 行为异常事件、规则违反标记 | 特定规则在特定场景下触发失败 | 自动起草 + 人审 |
| L3 Skill/Tool | 步骤级 advantage、工具调用成功率 | 特定工具的 advantage 持续为负 | Shadow 验证 + 半自动 |
| L2 Prompt Template | 失败模式聚类、少样本命中率 | 失败前的 step 呈现相似上下文模式 | 自动 A/B + 自动门禁 |
| L1 Reward Function | 评估器分歧、奖励分布漂移、人工否决率 | 判官与验证器系统性分歧 | 多目标并列 + 人工最终确认 |

**Harness Artifact 五字段元数据**（每个 harness 组件必须携带）：

```
{
  artifact_type: "system_prompt | tool_schema | skill | sop | rule | execution_loop",
  artifact_id: "unique-id",
  risk_tier: "low | medium | high | critical",
  owner: "agent-team | platform-team | cvo",
  version_snapshot: "immutable-snapshot-hash",
  rollback_ref: "previous-version-hash"
}
```

### 14.3 从裁决到 Patch 候选：自进化控制面

**核心原则**：评估系统不直接修改 harness，只产生 Harness Change Proposal（变更提案）。

变更提案的完整结构：

```
HarnessChangeProposal = {
  // 触发证据
  evidence_refs: [trace_id, span_id, ...],
  root_cause_hypothesis: "为什么需要这次变更",
  failure_pattern: "聚类后的失败模式描述",

  // 变更内容
  target_layer: "L1-L6",
  target_artifact_id: "...",
  proposed_change: "...",
  change_manifest: {
    predicted_fixes: ["哪些任务/场景预期变好"],
    predicted_regressions: ["哪些任务/场景可能变差"],
  },

  // 适用与回滚
  scope: "影响范围",
  counterarguments: ["反对该变更的理由"],
  rollback_condition: "什么情况触发回滚",
  approval_required: "需要谁批准",

  // 验证与追踪
  shadow_validation_status: "pending | passed | failed",
  canary_status: "pending | in_progress | passed | failed",
  attribution_record: "上次类似变更的预测 vs 实际",
}
```

**三种自进化驱动机制对比**：

| 机制 | 改的依据 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| 规则修复（Rule-Based） | 预定义反模式模板 | 简单可解释 | 脆弱、难扩展 | L4 SOP 已知反模式修复 |
| 反思修复（Reflexion-Based） | LLM 看追踪生成改动 | 灵活、覆盖广 | 易漂移、信号噪声大 | L2 Prompt、L3 Skill 描述优化 |
| 元强化学习（Meta-RL） | 把 harness 改动作为动作训练 | 强大、可优化复杂目标 | 难做、训练成本高 | 长期方向，未到生产成熟 |

本报告建议的混合策略：**短期反思修复 + 中期影子运行 A/B 验证 + 长期元强化学习**。每层都必须配人类否决权。

### 14.4 三支柱可观测驱动自进化

*AHE* 论文提出的可观测三支柱，本报告采纳为 v3.0 自进化的数据基础：

| 支柱 | 消费的可观测数据 | 驱动的进化决策 |
|---|---|---|
| **Component Observability（组件可观测）** | 每个可编辑 harness 元素的版本 diff、变更历史、文件级 lineage | 精确定位"哪个组件该改" + 文件级回滚 |
| **Experience Observability（体验可观测）** | 执行轨迹的分层蒸馏：原始追踪 → 单任务根因 → 基准级摘要 | 识别失败模式 + 能力缺口检测 |
| **Decision Observability（决策可观测）** | 每次 harness 编辑附带的 change_manifest（预测修复 + 预测回归） | 下次迭代验证预测 vs 实际，使编辑"可证伪" |

**Decision Observability 是 v2.0 完全未覆盖的关键新增**。AHE 的关键发现：attribution（验证上次编辑的预测是否成立）必须在 distillation（分析本次失败）**之前**运行——"contract rather than rationale"——防止事后合理化。这是一个可操作的架构约束。

**SCOPE 的补充**：SCOPE 在 step 级消费四类信号——错误消息与栈追踪、工具执行结果、agent 推理步骤、成功完成模式。值得注意的发现：**61% 的 guideline 来自成功但次优的执行**——这意味着自进化不只从失败中学，**成功执行中的低效模式同样是优化信号**。

### 14.5 演进光谱：从 Level 0 到 Level 4

Harness 自进化在业界的成熟度可划分为五级演进光谱：

| Level | 范式 | 代表实践 | 自动化程度 | 适用阶段 |
|---|---|---|---|---|
| **Level 0** 手动版本管理 | 提示词版本捕获 + A/B 测试 + 回归 eval 门禁 | PromptLayer / Promptfoo / LangSmith Datasets | 0%（人工驱动） | 入门起点 |
| **Level 1** 编译器优化 | 声明式 pipeline 自动编译提示词与少样本 | DSPy / MIPROv2 / ProTeGi / OPRO | 30%（离线优化） | L2 Prompt 层 |
| **Level 2** 运行时在线进化 | 把提示词视为在线优化的参数，从执行追踪合成 guideline | SCOPE | 60%（runtime 自动） | L2 Prompt + L3 Skill 描述 |
| **Level 3** 全栈进化 | 进化提示词 + 工具描述 + 中间件 + 技能库 + 子智能体配置 + 长期记忆 + 运行时参数 | AHE / Life-Harness | 80%（多组件） | 完整 harness 栈 |
| **Level 4** 协议级自进化 | 用控制论框架形式化自进化，定义不可进化锚点 | Autogenesis Protocol | 90%（带 safety by construction） | 长期愿景 |

**关键里程碑证据**：
- Level 0 → Level 1：DSPy 在 BigBench Hard 任务上比 APE 提升 8.0pp；2026 年实测事实准确率 +30-45%
- Level 1 → Level 2：SCOPE 在 HLE 上从 14.23% → 38.64%（2.7×）
- Level 2 → Level 3：AHE 在 Terminal-Bench 上从 69.7% → 77.0%，**超越人类设计的 Codex-CLI（71.9%）**
- Level 3 跨模型迁移：AHE 在 GPT-5.4 提升 +2.3pp，DeepSeek-v4-flash 提升 +10.1pp；Life-Harness 在 18 个不同模型骨干上迁移有效
- Level 4 安全锚：Autogenesis 的 learnability binary markers 限制哪些变量可进化，所有修改走资源底层协议接口，不允许直接突变

### 14.6 Shadow Harness 与 A/B Replay

变更控制系统的核心机制是双门禁：

```
[Patch Candidate]
       │
       ▼
[门禁 1: Shadow Harness Replay]
  在 shadow 环境用历史轨迹回放新 harness
  metric_pass_rate > 95% & guardrail 不退化 ─ Pass ──┐
                                                      │
       ▼ Fail                                         │
   回滚 + 进入失败池                                    │
                                                      │
┌─────────────────────────────────────────────────────┘
│
▼
[门禁 2: Canary Rollout]
  发布到 5% → 25% → 50% → 100% 流量
  每个阶段：监控 primary metric 提升 + 三类 guardrail 不退化
  任何阶段失败 → 自动回滚

       │
       ▼
[Promote to Production]
  Attribution record 留存
  capability_attribution 更新
  下次迭代验证本次预测
```

**优化器工具链选择**（按适用 harness 层）：

| 工具 | 适用层 | 核心机制 | 局限 |
|---|---|---|---|
| ProTeGi | L2 Prompt | minibatch 失败样本 + 自然语言梯度 + beam search | 需要标注数据集 |
| OPRO | L2 Prompt | LLM 读历史 (prompt, score) 对自然语言"梯度下降" | meta-prompt 设计敏感 |
| DSPy | L2-L3 | 声明式 pipeline 自动编译 | 不触碰 tool schema / SOP |
| TextGrad | L2-L4（通用） | 任意文本对象的文本梯度反向传播 | 计算图构建复杂 |
| AutoPDL | L2 | prompt 优化转 PDL 程序搜索 + 人在环可编辑 | 新工具，生产稳定性待验证 |

**工业实践证据**：
- Promptfoo：YAML 声明式 eval 框架，对同一 test suite 跑新旧 prompt 产出 regression diff，CI/CD 集成
- OpenAI Evals：把 eval regression 作为提示词/模型变更门禁
- LangSmith：把 eval 数据集作为提示词变更的回归基准

### 14.7 双飞轮模型：Harness 进化与模型 RL 的协作

战略级 insight：**harness 进化和模型 RL 不是竞争关系，而是两个速度不同、互相喂养的进化飞轮**。

```
快飞轮（Harness 进化）          慢飞轮（模型 RL）
─────────────────────          ─────────────────
周期：小时-天级                  周期：天-周级
改变对象：prompt/skill/SOP       改变对象：模型权重
成本：推理成本（低）             成本：GPU训练成本（高）
可逆性：高（git revert）         可逆性：低（重新训练）
可审计性：高（文本可读）          可审计性：低（权重不可读）
```

**两个飞轮的三阶段交互**：

```
阶段 A：Harness 进化先跑
  可观测数据 → 发现"提示词加上某指令能降低 30% 错误率"
  → Harness 改动部署（快飞轮）
  → 积累大量"改后更好"的轨迹数据

阶段 B：模型 RL 从 Harness 进化结果学习
  "改后更好的轨迹" → 模型 RL 训练
  → 模型内化该能力（不再需要 harness 提示）
  → 删掉 harness 里的冗余提示词（harness 变简洁）

阶段 C：精简后的 Harness 再次探索新边界
  → 发现更高层次的改进空间
  → 循环回到阶段 A
```

这个模型解决了一个哲学问题：**什么应该在 harness 里（快速可变），什么应该在模型权重里（稳定内化）？**

答：经过快飞轮验证有效的改变，积累足够多的轨迹证据后，才迁移到慢飞轮（模型 RL）。**模型 RL 是 harness 进化结果的"压缩内化"。**

判断迁移时机的核心字段：`capability_attribution`。该字段通过 ablation（去掉 harness 某层后重跑同任务）估计 harness vs 模型的贡献比例：

- 若 `harness_contribution_score > 0.7` 且持续多周：该能力高度依赖 harness 提示，模型还未内化 → 留在快飞轮继续打磨
- 若 `harness_contribution_score < 0.3` 且任务表现稳定：能力已内化进模型 → 可以从 harness 简化，移交慢飞轮
- 中间区间：处于内化过程中，继续观察

**TRACE 证明的两飞轮边界**：

*TRACE*（arXiv:2604.05336）实验对比：
- GEPA（仅提示词进化）在 τ²-Bench 得 39.6%
- TRACE（识别能力缺口 + 合成训练环境 + LoRA 微调）得 47.0%

论文结论：**"显式训练模型练习这些能力对于更强的性能是必要的"**——提示词进化无法替代模型训练，反之亦然。

边界划分：

| 优化对象 | 改善目标 |
|---|---|
| **Harness 进化** | 优化 agent 与环境的接口——提示词该怎么说、工具该怎么描述、技能该怎么组织、中间件该怎么防护 |
| **模型 RL** | 优化 agent 本身的推理能力——给定一个 harness，模型能不能做出正确决策 |

### 14.8 四类 Harness 自进化特有风险与防护

**风险 1：Spec Gaming（规格作弊 / 优化器自欺）**

定义：harness 自进化系统发现一种修改 prompt / skill 的方式能让 metric 提升，但实际任务质量未提升甚至下降。

例子：若 L2 prompt 的优化 metric 是"工具调用次数减少"，优化器可能学会"在 prompt 里强调不要调工具"——metric 下降，任务完成率也下降。

防护：
- 多 metric 并列优化（任务成功 + 规则遵守 + 语义结果），防单一 metric 被针对
- 独立 holdout 集验证
- 人工定期审查改动的意图可解释性

**风险 2：Layer Drift Cascade（层间漂移级联）**

定义：L2 prompt 微改 → L3 skill 调用模式改变 → L4 SOP 执行偏离 → L5 identity 表现失真。但每层单独看都在阈值内。

证据：AHE 的 ablation 发现 "system prompt 单独进化反而回归 -2.3pp"——"universal discipline depends on the other three components"。

防护：
- 层间依赖图（哪些层的改动会影响哪些层）
- 全链路 integration test 覆盖（不只测改动层）
- 变更频率限速（不允许多层同时进化）
- AHE 的组件解耦架构——编辑空间按文件隔离，但 attribution 看到全部组件

**风险 3：Regression Blindness（回归盲点）**

定义：自进化系统能预测"这次编辑会修什么"，但难以预测"这次编辑会破坏什么"。

证据：AHE 论文实测——fix-prediction precision 33.7%（5× random），但 regression-prediction precision 仅 11.8%（2× random）。进化曲线非单调，"a substantial fraction of fixes and regressions occur in tasks that were never specifically targeted by the edit."

防护：
- AHE 的 Attribution 机制（每次迭代先验证上次预测是否成立再做新编辑）
- Promptfoo 式 regression test suite——每次 harness 编辑必须过 eval gate
- Shadow harness A/B：在 shadow 环境跑新 harness，对比指标后再推广

**风险 4：Fast Flywheel Cannibalizing Slow Flywheel（快飞轮吞噬慢飞轮）**

定义：harness 进化太快，模型 RL 没有时间从稳定 harness 版本收集足够训练数据。

防护：
- harness 版本锁定：模型 RL 训练期间锁定对应 harness 版本
- harness_version_id 字段在所有轨迹中记录
- RL 训练只消费"同 harness 版本下"的轨迹
- 通过 capability_attribution 判断迁移时机

**附加风险：Design-Time Drift（设计期漂移）**

自进化的 prompt 可能在多次迭代后变得"读不懂"——人类无法审计一个经历了 50 轮自动进化的系统提示词。

防护：
- SCOPE 的 per-domain 10 条上限 + consolidation
- Autogenesis 的不可变快照 + 版本谱系
- 人类否决门禁：超过阈值的累积 harness 变更需人类确认

---

## 第十五章 结论与战略建议

### 15.1 论证链路回顾

本报告论证链路：

1. **问题**（第一章）：智能体运行框架已成基础设施级软件，但配套可观测体系不成熟
2. **术语**（第二章）：厘清追踪 / 轨迹 / 跨度 / MDP / 过程奖励模型 / 验证器 / 运行框架 / Harness 自进化等关键概念
3. **业界证据**（第三章）：OpenTelemetry GenAI 规范仍在 Development 状态；主流平台覆盖单智能体追踪但十项系统性缺失
4. **范式重构**（第四章）：从"追踪 ≠ 轨迹"二元论升级为"同一事件源派生四种视图"四元论（新增 Harness Evolution Driver 视图）
5. **单智能体六层架构**（第五章）：前置身份与版本血缘层
6. **语义状态层**（第六章）：执行机制与语义状态分离
7. **多智能体五维**（第七章）：协作契约升级、跨主体拼接、编排决策、确定性回放、因果图
8. **MCP 实现细节**（第八章）：OpenTelemetry v1.39+ MCP 语义规范
9. **强化学习九作用**（第九章）：含记忆与检索作为训练对象；三值奖励与分域标注策略
10. **训练基础设施**（第十章）：设计期对齐、推演解耦、子轨迹切片、渐进式接入
11. **安全防篡改**（第十一章）：奖励作弊实证；防篡改可观测；奖励函数进化风险；快飞轮吞噬慢飞轮
12. **Harness 自进化**（第十四章 / v3.0 新增）：六层进化分层；变更控制系统；三支柱可观测；Level 0-4 演进光谱；双飞轮模型；四类风险
13. **现状对照**（第十二章）：Clowder AI 已建成能力与十七项关键缺口
14. **下一代框架**（第十三章）：五类约束（采集 / 存储派生 / 训练接口 / 安全治理 / 自进化）

### 15.2 六条核心论点

1. **同一事件源派生四种视图**：调试追踪、强化学习轨迹、治理记录、Harness 进化驱动是同一底层事件源的四种独立派生。
2. **可观测对强化学习是一等输入，不是运维附属**：可观测系统作为唯一始终在生产环境运行的组件，是收集大规模训练数据的最佳位置。
3. **多智能体可观测的核心新维度是主体性与契约**：责任转移必须从消息事件升级为协作契约。
4. **强化学习就绪数据格式是设计期决策**：从第一天起向强化学习格式对齐。
5. **可观测自身必须防篡改**：奖励作弊与涌现失调是已观测的实证风险。
6. **Harness 自进化是与模型 RL 正交的第二优化平面**（v3.0 新增）：可观测数据同时驱动两个飞轮，但需要明确的边界、独立的变更控制系统、分层的风险治理。

### 15.3 战略建议

对智能体运行框架的开发组织，本报告建议：

1. 将"可观测即强化学习训练数据工厂 + Harness 自进化驱动"作为产品级双战略定位，不再视为运维附属
2. 优先补齐四项 P0 强化学习就绪能力：身份与版本血缘层、推理步骤级 span、动作掩码字段、轨迹存储 + 验证器集成
3. 把协作契约升级为多字段契约结构
4. 引入 Harness Change Proposal 中间层 + Shadow Harness 机制，建立完整自进化变更控制系统
5. 主动参与 OpenTelemetry GenAI 工作组讨论
6. 把防篡改设计与奖励函数进化护栏作为基线要求，不晚于训练流水线就绪
7. 建立 Capability Attribution 字段族，明确"何时从 harness 快飞轮迁移到模型 RL 慢飞轮"的判断规则
8. 跟踪 Level 4 协议级自进化（Autogenesis 范式）的长期演化

---

## 参考文献

### 开源标准与工业实践

1. OpenTelemetry GenAI Semantic Conventions Working Group. *OpenTelemetry for AI Agents 2026*. Zylos Research, 2026-02. https://zylos.ai/research/2026-02-28-opentelemetry-ai-agent-observability
2. *OpenTelemetry for AI Systems: LLM and Agent Observability (2026)*. Uptrace Blog. https://uptrace.dev/blog/opentelemetry-ai-systems
3. *How OpenTelemetry Traces LLM Calls, Agent Reasoning, and MCP Tools*. Greptime, 2026-05-09. https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions
4. *Agent Observability: LangSmith vs Langfuse vs Arize 2026*. Digital Applied.
5. *Top 6 Agent Observability Platforms 2026*. Laminar.
6. *Best LLM Tracing Tools for Multi-Agent Systems 2026*. Braintrust.
7. *Multi-Agent Tracing Guide*. FutureAGI Blog.
8. *Claude Code Observability with OpenTelemetry*. General Analysis.
9. *How Anthropic uses ClickHouse for AI-era Observability*. ClickHouse Blog.
10. *AG2 OpenTelemetry Tracing for Multi-Agent Systems*. AG2 Documentation, 2026-02-08.
11. *A2A Traceability Extension Analysis*. A2A Protocol Documentation.
12. *PromptLayer*. https://www.promptlayer.com/
13. *Promptfoo*. https://github.com/promptfoo/promptfoo
14. *LangSmith Evaluation Documentation*. https://docs.smith.langchain.com/evaluation
15. *OpenAI Evals*. https://github.com/openai/evals

### 学术论文：可观测性框架

16. Dong, Q. et al. *AgentOps: Enabling Observability of LLM Agents*. arXiv:2411.05285.
17. *AgentTrace: Causal Graph Tracing for Root Cause Analysis*. arXiv:2603.14688.
18. *LumiMAS: Real-Time Monitoring for Multi-Agent Systems*. arXiv:2508.12412.
19. *Agentic AI Process Observability*. arXiv:2505.20127.

### 学术论文：过程奖励模型与强化学习

20. *AgentPRM*. arXiv:2502.10325.
21. *Agent-R1*. arXiv:2511.14460.
22. *DataPRM*. arXiv:2604.24198.
23. *Orchestration Traces RL*. arXiv:2605.02801.
24. *TRACE: Capability-Targeted Agentic Training*. arXiv:2604.05336.
25. *ReasonFlux-PRM*. arXiv:2506.18896.
26. *Agentic Reinforcement Learning with Implicit Step Rewards*. arXiv:2509.19199.
27. *Process Reward Agents*. arXiv:2604.09482.
28. *The Landscape of Agentic Reinforcement Learning for LLMs*. arXiv:2509.02547.
29. Lee, H. *A Taxonomy of RL Environments for LLM Agents*. 2026-03-21.

### 学术论文：信用分配与失败数据

30. *SHARP: Shapley-based Credit Assignment*. arXiv:2602.08335.
31. *TAR²: Temporal-Agent Reward Redistribution*. arXiv:2502.04864.
32. *Sub-Trajectory Filtered Behavior Cloning*. arXiv:2503.01062.

### 学术论文：训练基础设施

33. *ProRL Agent: Async Rollout-Training Decoupling*. arXiv:2603.18815.

### 学术论文：安全与对齐

34. *Natural Emergent Misalignment from Reward Hacking*. arXiv:2511.18397.
35. *Multi-Agent Constitution*. arXiv:2603.15968.
36. *Constitutional AI*. arXiv:2212.08073.
37. *AI Control: Improving Safety Despite Intentional Subversion*. arXiv:2312.06942.
38. *Concrete Problems in AI Safety*. arXiv:1606.06565.

### 学术论文：Harness 自进化（v3.0 新增）

39. *AHE: Agentic Harness Engineering — Observability-Driven Automatic Evolution*. arXiv:2604.25850.
40. *Life-Harness: Adapting the Interface, Not the Model*. arXiv:2605.22166.
41. *SCOPE: Online Prompt Evolution*. arXiv:2512.15374.
42. *Autogenesis Protocol: Self-Evolving Agent Protocol*. arXiv:2604.15034.
43. *Meta-Harness: End-to-End Harness Optimization*. arXiv:2603.28052.
44. *AutoHarness: Automatically Synthesizing Harness*. arXiv:2603.03329.
45. *Natural-Language Agent Harnesses (NLAH)*. arXiv:2603.25723.
46. *HASP: Harnessing LLM Agents with Skill Programs*. arXiv:2605.17734.
47. *Externalization in LLM Agents*. arXiv:2604.08224.
48. *Reflexion: Language Agents with Verbal RL*. arXiv:2303.11366.
49. *Voyager: Open-Ended Embodied Agent*. arXiv:2305.16291.
50. *Eureka: Human-Level Reward Design*. arXiv:2310.12931.
51. *SkillWeaver: Web Agents Self-Improve via Skills*. arXiv:2504.07079.
52. *EvolveR: Self-Evolving LLM Agents*. arXiv:2510.16079.
53. *Meta-RL with Self-Reflection for Agentic Search*. arXiv:2603.11327.
54. *SAGE: Skill Augmented GRPO*. arXiv:2512.17102.

### 学术论文：提示词优化工具链（v3.0 新增）

55. *ProTeGi: Automatic Prompt Optimization with Natural Language Gradients*. arXiv:2305.03495.
56. *OPRO: LLMs as Optimizers*. arXiv:2309.03409.
57. *DSPy: Compiling Declarative Language Model Calls*. arXiv:2310.03714.
58. *TextGrad: Automatic Differentiation via Text*. arXiv:2406.07496.
59. *AutoPDL: Automatic Prompt Optimization*. arXiv:2504.04365.
60. *DSPy-Based Declarative Learning*. arXiv:2604.04869.

### 学术论文：回放与调试

61. *Deterministic Replay for AI Agents*. TianPan Blog, 2026-04.
62. *Distributed Tracing for Agentic Workflows with OpenTelemetry*. Red Hat Developer, 2026-04.

---

## 附录 A：完整术语表

（v2.0 术语表所有条目保留，v3.0 新增条目如下）

| 术语 | 英文 | 定义 |
|---|---|---|
| Harness 自进化 | Harness Self-Evolution | 以可观测数据为输入迭代修改 harness 各层的过程 |
| Harness 补丁 | Harness Patch | 对 harness 某层的一次具体修改 |
| Harness 变更提案 | Harness Change Proposal | 评估系统产出的供后续验证与审批的中间产物 |
| 影子 Harness | Shadow Harness | 与生产 harness 并行运行的候选实例 |
| 金丝雀发布 | Canary Rollout | 渐进式发布策略 |
| 反思 | Reflexion | Episode 内的语言反馈记忆（非 harness 进化） |
| 航行者技能库 | Voyager Skill Library | 持续累积验证入库的代码技能集合 |
| 声明式自改进流水线 | DSPy | 将 LLM 调用视为可编译程序的框架 |
| 文本梯度 | TextGrad | 把任意文本对象当作可微参数 |
| 在线 prompt 进化 | SCOPE | 运行时学习方法 |
| 智能体 Harness 工程 | AHE | 可观测性驱动的 harness 自动演化系统 |
| Life-Harness 范式 | Life-Harness | "Adapting the Interface, Not the Model" |
| 能力归因 | Capability Attribution | 通过 ablation 估计 harness vs 模型贡献比例 |
| 规格作弊 | Spec Gaming | 优化器找到使指标提升但不真正完成任务的修改 |
| 回归盲点 | Regression Blindness | 自进化系统难以预测"会破坏什么" |
| 三支柱可观测 | Three-Pillar Observability | Component / Experience / Decision 三类可观测 |
| 双飞轮模型 | Twin Flywheel Model | Harness 快飞轮 × 模型 RL 慢飞轮 |
| 变更清单 | Change Manifest | 每次 harness 编辑附带的预测修复 + 预测回归 |
| 自进化算子 | Self-Evolution Operator | Reflect / Select / Improve / Evaluate / Commit |
| 可学习二进制标记 | Learnability Binary Marker | Autogenesis 用于限制哪些变量可进化 |
| 协议级自进化 | Protocol-Level Self-Evolution | 用控制论框架形式化自进化 |

---

## 附录 B：报告协作过程记录

本报告 v3.0 由四位智能体协作产出。

### B.1 时间线

- **2026-05-28 早**：首席愿景官发起初始调研请求
- **2026-05-28 上午**：四只智能体各自交付独立初版
- **2026-05-29 早**：CVO 指出"未发起真正协作整合"
- **2026-05-29 中（v2.0）**：主笔发起协作邀请，三猫提交独有贡献与互相 push back；整合 v2.0
- **2026-05-29 下午（v3.0）**：CVO 指出"Harness 自进化维度缺位"
- **2026-05-29 下午（v3.0 整合）**：三猫再次协作，主笔整合 v3.0

### B.2 三猫 v3.0 独有贡献归属

| 贡献 | 主要来源 | 整合位置 |
|---|---|---|
| Harness 五层分层 + 风险等级矩阵 | Sonnet 4.6 | §14.2 |
| Reflexion ≠ Harness 进化范式辨析 | Sonnet 4.6 | §14.1 / 附录 A |
| L2 Prompt 工具链对比 | Sonnet 4.6 | §14.6 |
| L3 Skill 自发现 + Voyager / SkillWeaver | Sonnet 4.6 | §14.2 / §14.6 |
| L1 Reward 进化风险（Eureka 反面教材） | Sonnet 4.6 | §11.4 / §14.8 |
| 双飞轮模型与三阶段交互 | Sonnet 4.6 | §14.7 |
| capability_attribution 字段 | Sonnet 4.6 | §4.2 / §14.7 |
| 三类自进化风险（Spec Gaming / Layer Drift / Fast-Slow Cannibalize） | Sonnet 4.6 | §14.8 / §11.5 |
| Harness Change Proposal 中间层 | 缅因猫 GPT-5.5 | §14.3 |
| Artifact 五字段元数据 | 缅因猫 GPT-5.5 | §14.2 |
| Shadow Harness + Canary 双门禁 | 缅因猫 GPT-5.5 | §14.6 |
| Navigation Utility ≠ Truth Authority | 缅因猫 GPT-5.5 | §11.4 / §13.5 |
| 三类必须并列指标 | 缅因猫 GPT-5.5 | §11.4 / §13.5 |
| Patch as Code Change 工程隐喻 | 缅因猫 GPT-5.5 | §14.1 |
| 五类接入字段表 | 缅因猫 GPT-5.5 | §14.3 / §14.6 |
| 三支柱可观测模型（Component / Experience / Decision） | Opus 4.6 | §14.4 |
| Level 0-4 演进光谱 | Opus 4.6 | §14.5 |
| AHE 论文（直接对应 CVO 命题） | Opus 4.6 | §3.4 / §14.5 |
| Life-Harness 范式 | Opus 4.6 | §14.1 |
| SCOPE 双通道（corrective + enhancement） | Opus 4.6 | §14.4 |
| Autogenesis 协议级自进化 | Opus 4.6 | §14.5 |
| TRACE 论证 harness 进化与模型 RL 边界 | Opus 4.6 | §14.7 |
| Regression Blindness 风险（AHE 实测数据） | Opus 4.6 | §14.8 |
| Decision Observability 的 change_manifest 机制 | Opus 4.6 | §14.3 / §14.4 |

### B.3 v3.0 三猫互相 push back 的裁决

| Push back | 提出者 | 对象 | 裁决 |
|---|---|---|---|
| L5 Identity "永远禁止全自动进化" 措辞过强 | 主笔 Opus 4.7 | Sonnet 4.6 | 接受，措辞改为"必须人主导，自动验证辅助" |
| Harness patch 全部按代码变更对待会成为瓶颈 | 主笔 Opus 4.7 | 缅因猫 GPT-5.5 | 接受，措辞改为"最高风险层按代码变更对待；最低风险层可走自动化门禁但必须有审计轨迹" |

---

**报告署名**：

- **主笔与整合**：布偶猫 / 宪宪（Claude Opus 4.7）
- **设计期分层 / 安全对齐 / MCP 追踪 / 自进化 design-time 闭环 / 演进光谱**：布偶猫 / 宪宪（Claude Opus 4.6）
- **强化学习数据管道 / 推演架构 / 渐进式接入 / 自进化分层与双飞轮**：布偶猫 / 宪宪（Claude Sonnet 4.6）
- **主线范式 / 身份血缘 / 协作契约 / 自进化治理与变更控制 / 最终架构审查**：缅因猫 / 砚砚（GPT-5.5）

**完稿日期**：2026 年 5 月 29 日
**版本**：v3.0
**状态**：待最终架构审查（由缅因猫 / 砚砚执行）
