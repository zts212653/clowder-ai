---
feature_ids: [F143]
related_features: [F050, F002, F126, F127]
topics: [architecture, agent-hosting, protocol-abstraction, transport, runtime-contract, a2a]
doc_kind: spec
created: 2026-03-27
---

# F143: Hostable Agent Runtime — 统一宿主抽象

> **Status**: spec | **Owner**: Ragdoll Opus 4.6 | **Priority**: P1

## Why

我们已有 7 个 AgentService provider（Claude/Codex/Gemini/DARE/OpenCode/A2A/Antigravity），每个都是各自造轮子——各自解析不同的事件格式、各自处理 session resume、各自注入 MCP config。接一个新 agent = 写 ~450 行适配代码（Service + EventTransformer + 测试）。

team experience：
> "以后对接某些 agent 是不是就可以不用我们写那么多适配代码？而是他们符合某些要求就能接入？"
> "本地接任何一个，无论是 CLI 的 Agent，还是比如说别人是 WebSocket 写的那种 Agent……我们是不是得抽象一套什么样的东西给我们自己用？"

playground 分支的 ACP 实现验证了"配置接入"的可行性（填表 → 自动 probe → agent 可用），但它是 Clowder 自研协议，不是行业标准。我们需要设计一套**不锁定某个协议、但能让符合契约的 agent 配置接入**的宿主抽象。

## What

### Phase A: 内核骨架与接口集

定义内核对象与跨切面管线接口 + 架构决策文档：

1. **AgentDescriptorV1**：sparse static capability descriptor（6 轴 + 2 模块）
2. **RunHandleV1**：内核 run 控制面（events / sendControl / cancel / close）
3. **Supervisor 接口**：timeout / liveness / failure classification / kill policy
4. **ProvisioningPipeline**：Discovery → Runtime 之间的降级管线（→ ProvisionedRunSpec）
5. **ProcessModel**：派生执行分类（headless / task / interactive）

北向 `AgentService.invoke()` 不动，作为 façade 保留。

### Phase B: 首批新栈 provider

选 2 个代表性 provider 在新栈上实现：

1. **ACP-style local agent**（stdio JSON-RPC 双向，如 agent-teams / opencode acp）
2. **A2A remote agent**（HTTP/SSE，已有 A2AAgentService 可迁入）

验证新内核能同时 hold "session" 和 "task" 两种 runtime contract。

### Phase C: Hub UI 接入表单 + 自动 probe

让team lead/用户在 Hub 上填表接入新 agent：

1. **必填**：名称 + 接入类型（Local Command / Remote A2A）+ 入口
2. **自动 probe**：探测 binding → 拿到 capabilities → 推荐配置
3. **高级选项**：cwd / env / model profile / permission policy / tool bridge

目标：**符合宿主契约的 agent，配置接入零代码**。

### Phase D: 现有 provider 渐进迁入

按价值排序，逐步把现有 provider 迁入新栈：
- 老 provider 先补 static descriptor（不改逻辑）
- 挑 1-2 个代表性 provider（如 DareAgentService）迁入
- parser/transformer 维持 provider-specific，不抢着统一

## Acceptance Criteria

### Phase A（内核骨架）
- [ ] AC-A1: `AgentDescriptorV1` 类型定义完成，包含 invocationShape/controlChannel/resume/permissions/toolBridge/modelOverride 6 轴
- [ ] AC-A2: `RunHandleV1` 接口定义完成，包含 events/sendControl/cancel/close
- [ ] AC-A3: `Supervisor` 接口定义完成，复用现有 spawnCli/ProcessLivenessProbe 逻辑
- [ ] AC-A4: `HostedAgentService` 壳实现，将 RunHandle 桥接到 AgentService.invoke()
- [ ] AC-A5: ADR-023 完成并批准
- [ ] AC-A6: `ProvisioningPipeline` 接口 + `ProvisionedRunSpec` 类型定义完成
- [ ] AC-A7: `ProcessModel` 派生分类定义（headless/task/interactive），含与 Descriptor 轴的映射规则

### Phase B（首批新栈 provider）
- [ ] AC-B1: ACP-style local agent 可通过新栈接入并完成单轮对话
- [ ] AC-B2: A2A remote agent 可通过新栈接入并完成单轮对话
- [ ] AC-B3: 两种 runtime contract（session / task）均可正常 resume/cancel

### Phase C（Hub UI 接入表单）
- [ ] AC-C1: Hub Settings 提供"添加外部 Agent"表单
- [ ] AC-C2: 创建后自动 probe 并展示 capabilities
- [ ] AC-C3: 新 agent 无需写代码即可被 @mention 调用

### Phase D（渐进迁入）
- [ ] AC-D1: 所有现有 provider 补 static AgentDescriptorV1
- [ ] AC-D2: ≥2 个现有 provider 迁入新栈（保持功能完整）

## Dependencies

- **Evolved from**: F050（External Agent Onboarding——L1/L2 接入经验是本 feature 的输入）
- **Related**: F002（A2A 内部协作——F143 下的一种 remote runtime contract）
- **Related**: F126（Limb Control Plane——类似的抽象模式：ILimbNode / Registry / Capability / Lease）
- **Related**: F127（Cat Instance Management——动态创建猫 + provider profile 是 F143 的配置底座）

## Risk

| 风险 | 缓解 |
|------|------|
| 过度抽象导致复杂度上升 | Phase A 只定义类型，不重写现有 provider |
| 行业标准演进导致返工 | 内核不绑定协议名（不叫 ACP/A2A），对外缝线像标准 |
| 现有 CLI adapter 在迁移中退化 | 铁律：spawnCli() 不拆散，先复用再提升 |
| AgentDescriptor 字段膨胀 | V1 只 6 轴，3+ agent 需要才加新轴 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 四维可组合模型：Transport × Binding × RuntimeContract × EventAdapter | 两猫 + GPT Pro 共识（Part 3 综合） | 2026-03-27 |
| KD-2 | Supervisor 独立成 sidecar，不藏进 transport | battle-tested 的 liveness/timeout 逻辑不能被"通用化"吃掉 | 2026-03-27 |
| KD-3 | 先统一控制面，不统一 parser | 控制面乱了全平台出血，parser 脏一点没关系 | 2026-03-27 |
| KD-4 | ResumeKind 多类型，不用 boolean | resume 至少有 4 种语义（provider_session/stream_redelivery/host_replay/opaque_token） | 2026-03-27 |
| KD-5 | AgentService.invoke() 保留为北向 façade | 上层路由器/UI/IM gateway 继续吃这个接口 | 2026-03-27 |
| KD-6 | 外部 agent 分两档：Hostable（零代码）vs Legacy（需 adapter） | 不幻想所有 CLI 都自然归一 | 2026-03-27 |
| KD-7 | ProvisioningPipeline 是跨切面降级管线，不是第五维度 | MCP/skills/prompt/hooks/env 都是 provisioning 载荷，不参与 runtime 正交组合 | 2026-03-27 |
| KD-8 | ProcessModel（headless/task/interactive）从 Descriptor + runtime topology 派生，不独立成维度 | 从 controlChannel + transport locality（本地/远程）组合推导，不增加组合爆炸 | 2026-03-27 |

## Review Gate

- Phase A: 架构级——猫猫讨论 → team lead拍板（ADR-023 审批）
- Phase B-D: 跨 family review
