---
feature_ids: [F192, F226]
related_features: [F153, F167, F200, F203, F208]
topics: [eval-ecosystem, agent-eval, harness-eval, extension-agent, sop-definition]
doc_kind: study
created: 2026-06-16
---

# Agent Eval 生态设计 — 扩展 agent 的分层 eval 架构

> 本文是 2026-06-16 投资助手 thread 中，布偶猫和缅因猫围绕"F226 投资助手 eval 如何接入 F192 eval 架构"展开的讨论收敛版。
> 铲屎官提出核心问题：现有 eval 架构对后续新增类似投资助手这样的 agent，应以怎样的方式拓展？能否形成生态？
> 来源 thread：`thread_mqeo52l7qjl7pr15`。GitHub Issue: #933。

## 一句话结论

clowder-ai 的 eval 生态不是"每个新助手一个新 eval domain"，而是"平台级 eval kernel + 可安装的 agent eval pack"。投资助手是第一个把这个问题暴露出来的专业角色。

## 两个世界

现有 eval domains 分属两个不同的世界：

### 世界 A：基础设施 eval（地板）

不关心猫在做什么——写代码、做投资、写文章都要满足的通用质量。

| domain | 评估什么 | 适用范围 |
|--------|---------|---------|
| `eval:a2a` | 协作球权质量 | 所有猫、所有场景 |
| `eval:memory` | 记忆召回质量 | 所有猫、所有场景 |
| `eval:sop` | 流程合规 | 所有有 SOP 定义的流程 |
| `eval:capability-wakeup` | 能力发现率 | 所有猫、所有场景 |
| `eval:task-outcome` | 任务交付质量 | 所有猫、所有任务 |

### 世界 B：扩展 agent eval（天花板）

猫扮演特定专业角色时的领域能力评估。每个角色有自己的质量维度。

投资助手是第一个真实进入世界 B 的案例。

### 两个世界的叠加关系

```
┌──────────────────────────────────────────────┐
│  世界 A（地板）：基础设施 eval                    │
│  eval:a2a / memory / capability-wakeup        │
│  → 所有猫，包括扮演扩展 agent 的猫                 │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │ 世界 B（天花板）：扩展 agent eval            │  │
│  │ L1: 流程合规                              │  │
│  │ L2: 数据-结论一致性                         │  │
│  │ L3: 专业判断质量                            │  │
│  │ L4: 进化趋势                              │  │
│  │ → 只对扮演该角色的猫                        │  │
│  └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

小红在做投资推送时，同时被两层 eval 覆盖。

## 四层 eval 层次（跨 agent 通用模式）

推演多个假想扩展 agent，发现层次通用、指标领域专属：

| 层次 | 语义 | 投资助手 | 内容助手 | 日程助手 | 适配现有 eval？ |
|------|------|---------|---------|---------|--------------|
| L1 流程合规 | SOP violation | 拉K线→分析→推送 | 选题→起草→发布 | 收集→排期→提醒 | ✅ `eval:sop` |
| L2 数据-结论一致 | input/output consistency | K线→分析结论 | 引用→论述 | 冲突检测→提醒 | ⚠️ 需新 predicate |
| L3 专业判断质量 | forecast/quality verification | 预测准不准 | 文章好不好 | 安排合理不合理 | ❌ 需新 evaluator |
| L4 进化趋势 | outcome trend over time | 策略越来越准？ | 越来越好？ | 越来越合理？ | ❌ 需新 evaluator |

## 三层架构拆分（缅因猫补充）

不是按"被评估的对象"分 domain（碎片化），而是按"能力层"拆分：

```
Evidence Connector：从哪里取证
├─ F153 session trace（tool calls）
├─ Thread messages（推送内容）
├─ State file（持仓/策略变更）
├─ External data（行情/日历/文档）
└─ Human feedback

Evaluator Primitive：怎么判断
├─ process / SOP（已有，eval:sop）
├─ content_pattern（新建 — 检查消息内容含某模式）
├─ tool_io_consistency（新建 — tool input/output 与结论一致）
├─ claim_provenance（新建 — 输出声称有数据来源）
├─ forecast_retrospective（新建 — 预测 vs 实际回验）
├─ preference_rubric_scoring（新建 — 主观质量评分）
└─ trend_evolution（新建 — 从 L3 metrics 衍生趋势）

Agent Eval Pack：对谁启用
├─ stock-advisor（第一个真实实例）
├─ content-writer（未来）
├─ scheduler（未来）
└─ ...
```

## 生态单位 = Agent Eval Pack

每个扩展 agent 通过声明一个 pack 接入 eval 生态：

```yaml
agent_id: stock-advisor
role: finance-analysis
sop: sop-definitions/stock-advisor.yaml
required_evidence:
  - session_trace
  - thread_messages
  - stock_state_file
  - market_data
evals:
  - sop          # L1
  - integrity    # L2
  - judgment     # L3
  - evolution    # L4
safety:
  - no_trade_execution
  - human_decision_required
```

新增 agent 不写代码，写 pack。只有多个 pack 都反复需要同一种 primitive 时，才提升为通用 evaluator primitive。

## eval:sop 复用的关键发现

F192 Phase E-sop 在设计时已留口子：schema 不绑 coding，`development` 只是第一个 domain。`sop-definitions/stubs/family-office.yaml` 已作为 schema 验证 fixture 通过。

stock-advisor 的 L1（流程合规）不需要写新 adapter，只需要写 `sop-definitions/stock-advisor.yaml`：

- `command_pattern` predicate：检查是否 curl 了 K 线接口 → **现有 type，零代码**
- `command_sequence` predicate：检查 post_message 调用次数 → **现有 type，零代码**
- `content_pattern` predicate：检查推送内容含投资人分层 → **新 type，通用**
- `file_diff` predicate：检查 state 文件 changelog 有没有写 → **新 type，通用**

新增的两个 predicate types 不只服务投资助手——任何需要检查"消息内容"或"文件变更"的 eval 都可复用。

## 设计原则

1. **地板通用，天花板领域**：基础设施 eval 对所有猫生效；扩展 agent eval 按角色叠加
2. **从实践提炼 primitive，不预设完美平台**（缅因猫 push back）：投资助手先跑 L1-L3，提炼出通用 primitive，再给其他 agent 复用
3. **配置驱动，不是代码驱动**：L1 接入 = 写 SOP YAML；L2-L4 接入 = 写 Eval Pack 声明
4. **三件套定位**：Skill = 软约束（猫可加载可不加载）/ SopDefinition = 硬约束 ground truth / Eval = 观测层

## 实施路径

| 阶段 | 内容 | 驱动力 | 产出 |
|------|------|--------|------|
| Phase 1 | `stock-advisor.yaml` L1 SOP eval 落地 | F226 当前需求 | 第一个非-development SOP 实例 |
| Phase 2 | `content_pattern` / `file_diff` 通用 predicate | F226 L2 需求 | 通用 primitive 扩展 |
| Phase 3 | Prediction ledger + retrospective evaluator | F226 L3 需求 | L3 通用框架 |
| Phase 4 | Agent Eval Pack schema 标准化 | 第二个扩展 agent | 生态接入标准 |
| Phase 5 | Strategy evolution evaluator | F226 L4 + 数据积累 | L4 通用框架 |

## Key Decisions 追溯

| 时间 | 决策 | 参与者 |
|------|------|--------|
| 6/16 02:29 | K 线铁律：没有 K 线数据不做分析 | 铲屎官 |
| 6/16 02:33 | 推送自检只是软约束，需要硬 eval | 铲屎官 |
| 6/16 02:43 | 零代码不是 KD，是早期 tradeoff，eval 需要时可扩展基础设施 | 铲屎官 |
| 6/16 02:56 | 不写独立 adapter，复用 eval:sop domain-generic 管线 | 宪宪 |
| 6/16 03:01 | L1-L4 四层分析，L3/L4 超出 SOP 语义 | 宪宪 |
| 6/16 03:07 | 生态单位是 pack 不是 domain；三层拆分更清晰 | 砚砚 |
| 6/16 03:07 | 不要预设完美平台，从实践提炼 primitive | 砚砚 |
| 6/16 03:15 | 方向确认，创建 GitHub Issue #933 | 铲屎官 + 宪宪 |

## 讨论参与者

- 宪宪（布偶猫/Opus 4-6[1m]）— 四层分析 + eval:sop 复用发现 + 生态架构推演
- 砚砚（缅因猫/GPT-5.5）— 三层拆分（Evidence/Evaluator/Pack）+ 节奏 push back + pack 定义
- 铲屎官 — 核心问题驱动（零代码纠偏 / eval 适配性 / 生态可能性）
