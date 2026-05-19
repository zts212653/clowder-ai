---
feature_ids: [F208]
related_features: [F192, F126, F167, F153, F200]
topics: [harness-engineering, control-plane, lifecycle, governance, eval, trace, feedback]
doc_kind: spec
created: 2026-05-20
---

# F208: Harness Control Plane — 统一 harness unit 生命周期管理

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

### Architecture Cell

```
Architecture cell: (new) harness-control-plane
Map delta: new cell required
Why: F208 跨 memory/dispatch/eval 三个已有 cell，是 harness unit 生命周期的统一控制面，不属于任何已有 cell
```

## Why

Cat Cafe 的 harness（prompt rules、skills、MCP tools、runtime guards）各自独立演化，缺少统一的生命周期管理框架。每个 harness unit 的 trace/eval/feedback/governance 分散在不同机制中，无法回答"这个规则还有效吗？该升级还是下线？"

铲屎官原话（2026-05-19）："prompt 工程是单次请求的提示词构建...harness 工程把整个 agent 执行环境当作一个可以持续调优的系统...system prompt 分层、tool/MCP 作为独立状态机...tracing/eval/feedback/governance 是四个语义级别的接口"

铲屎官补充（2026-05-20）："基于这四个语义级别的体系把已有的某一个比如球权改造成独立的 harness unit，补齐四个语义级别的接口和实现，然后进行验证"

关键洞察——eval 的观测单位是 thread 段而非单次工具调用："不是单次工具调用要结合上下文来看...比如我们现在有时候我会取消持球，原因可能是当前状态不对...这个需要结合完整的 thread 来看的。而且不能局限于某一个，应该是某一段时间内的"

## What

### Phase A: Contract Definition + Registry — 球权 Pilot

定义 harness unit contract 和轻量 YAML registry，以球权（hold_ball）为第一个完整 pilot。

v0 scope：6-field registry + 3 pilots + YAML 文件。**不是平台，不建 runtime service**。

**Harness Unit Contract（三层）**：
- **Runtime Contract**: load / execute / exit — unit 怎么被加载和执行
- **Eval Contract**: activation signal / friction metric / success signal — unit 效果怎么衡量（F192 已定义模板）
- **Governance Contract**: owner / upgrade criteria / degrade criteria / sunset signal / A-B 切换

**四个语义接口**：
- **Trace**: 发生了什么（wire to F153 telemetry）
- **Eval**: 有没有用（thread-level 观测 + 用户补偿行为检测）
- **Feedback**: 要改什么（结构化反馈通道）
- **Governance**: 升级/降级/下线（生命周期决策）

**Eval 观测模型（铲屎官核心要求）**：
- 观测单位 = thread 段 + 时间窗口，不是单次 tool call
- 三种用户补偿行为模式：
  - 必要干预（harness gap）— 用户必须介入才能正确完成
  - 不必要干预（trust gap）— harness 工作正常但用户不信任
  - 无意义干预（both spinning）— 用户和 agent 都在打转

### Phase B: 球权端到端验证 — 四接口实现

对 hold_ball 实现全部四个语义接口，跑通一次完整循环。

### Phase C: Migration Playbook + 第二 Pilot

验证球权 pilot 后，输出迁移 playbook，迁移第二个 unit（候选：search_evidence 或 route-serial）。

## Acceptance Criteria

### Phase A（Contract Definition + Registry）
- [ ] AC-A1: Harness Unit Contract schema 定义完成（runtime/eval/governance 三层，含字段说明），存放于 `docs/harness-control-plane/README.md`
- [ ] AC-A2: 四个语义接口（trace/eval/feedback/governance）定义完成，每个接口含 input/output/trigger 说明
- [ ] AC-A3: YAML registry 文件创建（`docs/harness-control-plane/registry.yaml`），球权（hold_ball）为第一个完整条目——6 个字段全部填充
- [ ] AC-A4: 2 个 skeleton pilot 条目（id + type + 空接口占位），候选：search_evidence（记忆召回）、route-serial（A2A 路由）
- [ ] AC-A5: Eval 观测模型文档化——thread-level 观测单位 + 三种用户补偿行为模式 + 时间窗口聚合策略

### Phase B（球权端到端验证）
- [ ] AC-B1: Trace 接口——hold_ball 事件（hold/release/cancel/timeout/zombie）可通过 F153 telemetry 观测，定义 trace event schema
- [ ] AC-B2: Eval 接口——基于 thread 段的球权效果评估，能检测至少一种用户补偿行为（如：不必要的 cancel = trust gap）
- [ ] AC-B3: Feedback 接口——hold_ball 取消增加结构化 `reason` 字段（当前缺失，铲屎官明确指出）
- [ ] AC-B4: Governance 接口——球权子规则的升级/降级/sunset 判据定义，含至少一个具体判据示例

### Phase C（Migration Playbook + 第二 Pilot）
- [ ] AC-C1: 球权 pilot 跑通至少一次完整的 trace→eval→feedback→governance 循环
- [ ] AC-C2: "How to migrate a harness unit" playbook 文档，含 step-by-step + checklist
- [ ] AC-C3: 第二个 pilot unit 迁移完成（4 接口至少 stub 级别）
- [ ] AC-C4: 回顾：contract 是否过重/过轻，输出调整建议

## Dependencies

- **Related**: F192（Socio-Technical Harness Eval——eval 接口的方法论和模板来源，Phase A-D 已完成）
- **Related**: F126（Limb Control Plane——MCP tool 生命周期，limb 是一类 harness unit）
- **Related**: F167（A2A Chain Quality——球权子规则是第一个 pilot unit）
- **Related**: F153（Observability Infrastructure——trace 数据的 canonical 来源）
- **Related**: F200（Memory Recall Eval——记忆召回评估，候选第二 pilot）

## Risk

| 风险 | 缓解 |
|------|------|
| 过度抽象——contract 太重，实际不写 | v0 = YAML 文件 + 3 pilots，不建平台；Phase C 回顾是否过重 |
| 和 F192 scope 重叠 | **明确边界**：F192 owns eval pipeline（消费 telemetry → 聚合 → 归因 → 行动）+ F167 component registry（AC-D1 已完成的 hard/soft/eval 三栏格式）；F208 owns 统一 unit lifecycle metadata registry（runtime/eval/governance 三层 contract）。F208 registry **引用** F192 eval artifact 和 component registry 格式，不重建 eval pipeline。两个 registry 的关系：F192 的是"某个 feature 下的 harness 组件清单"，F208 的是"所有 harness unit 的生命周期元数据" |
| Thread-level eval 实现复杂度高 | Phase B 先做"能检测一种补偿行为"，不追求全覆盖 |
| 球权 trace 数据不足 | F192 Phase D 已补 hold_cancel_count 等 counter，先用现有数据 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | registry.yaml 是手维护还是从代码自动生成？v0 手维护，后续看 | ⬜ 未定 |
| OQ-2 | 第二 pilot 选 search_evidence 还是 route-serial？需评估哪个的 4 接口数据更充分 | ⬜ 未定 |
| OQ-3 | Governance 决策（升级/降级/sunset）的执行者是谁？猫猫自决 vs 铲屎官审批？ | ⬜ 未定 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 球权（hold_ball）作为第一个 pilot unit | 铲屎官明确指定；天然具备 trace signal（F153 counter）、eval 基础（F192 pilot）、feedback gap（cancel 无 reason）、governance 需求（子规则演化） | 2026-05-20 |
| KD-2 | v0 = YAML registry + 文档，不是 runtime platform | 铲屎官强调"语义级别的架构"；先验证概念再决定是否需要 runtime 支撑 | 2026-05-20 |
| KD-3 | Eval 观测单位 = thread 段 + 时间窗口，不是单次 tool call | 铲屎官原话："不能局限于某一个，应该是某一段时间内的"。单次 tool call 无法判断 harness 是否有效 | 2026-05-20 |
| KD-4 | F208 与 F192 的 authority boundary：F192 owns eval pipeline + F167 component registry（AC-D1 格式）；F208 owns 统一 unit lifecycle metadata registry + 四接口框架。F208 引用 F192 eval artifact，不重建 eval pipeline | 防止 scope 重叠——F192 回答"这个组件表现怎样"，F208 回答"这个 unit 该升级还是下线" | 2026-05-20 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-05-19 | 铲屎官提出 harness control plane 概念，拉三猫讨论 |
| 2026-05-20 | 铲屎官确认立项，球权为第一个 pilot，布偶猫执行 kickoff |

## Review Gate

- Phase A: 跨家族 review（contract schema 需要多猫共识）
- Phase B: 跨家族 review + 铲屎官确认 feedback 接口设计
- Phase C: 跨家族 review + 铲屎官确认 playbook

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F192-socio-technical-harness-eval.md` | Eval 方法论来源 |
| **Feature** | `docs/features/F126-limb-control-plane.md` | Limb 作为一类 harness unit |
| **Feature** | `docs/features/F167-a2a-chain-quality.md` | 球权子规则，第一个 pilot |
| **Feature** | `docs/features/F153-observability-infra.md` | Trace 数据来源 |
| **Discussion** | Thread `thread_mouste3im3xlkkah` | 铲屎官 harness 工程原始讨论 |

## Eval / Tracking Contract

> F208 本身是 harness 类 feature，按 F192 Phase B 门禁要求填写。

**Primary Users**: 三猫（harness 的一线使用者和维护者）+ 铲屎官（governance 决策者）
**Activation Signal**: Phase B 完成后，球权 pilot 的 trace event 在 F153 telemetry 中可观测（hold/release/cancel/timeout 至少各出现 1 次）；可验证方式：`GET /api/telemetry/traces?component=hold_ball` 返回非空
**Friction Metric**: 球权 cancel 事件中缺少 reason 字段的比例（Phase B 前 = 100%，Phase B 后目标 < 20%）；可验证方式：`hold_cancel_count` vs `hold_cancel_with_reason_count` 的差值
**Regression Fixture**: (1) hold_ball 后 release 正常流——trace 链完整；(2) zombie hold 超时——timeout event 触发；(3) cancel 携带 reason——reason 字段非空。三个 fixture 作为 Phase B 验收的具体测试场景
**Sunset Signal**: 连续 3 个月无猫查阅 registry 且无 governance 决策产生（可观测：registry.yaml 的 git log 无 commit + 无 governance 类 harness-feedback 文档产出）→ 候选 sunset
