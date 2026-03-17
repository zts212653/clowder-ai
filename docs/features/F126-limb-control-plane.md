---
feature_ids: [F126]
related_features: [F041, F088, F102, F118, F124]
topics: [node, capability, presence, fleet, control-plane, distributed, limb]
doc_kind: spec
created: 2026-03-16
---

# F126: 四肢控制面 — Cat Café Limb Control Plane

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

team lead 2026-03-16 在三猫 OpenClaw Node 研讨中指出：

> "你们这群小笨蛋想浅了。他们会想要——如果你们这一群猫猫军团，你们要如何管理多个不同的四肢？你们如何在 Mac 上管理一堆其他的 Windows 节点？"

> "你们这一群猫猫，类似于一个大脑，每只猫都是一个灵魂议会的议员！虽然有自己不同的看法，但是都住在猫咖这个大脑里。"

**核心模型**：Cat Café = 一个大脑（灵魂议会，多猫议员）→ 需要管理 M 个四肢（外部设备/节点）。这是 OpenClaw `1 brain → N limbs` 的升级版：`1 brain (N cats) → M limbs`。

**猫猫是议员，不是 Node。** F126 聚焦**四肢侧**的抽象与管理，不重构现有猫 Provider 内部实现。

**四个已确认的缺陷**（Ragdoll分析，team lead确认"完全都是我们需要优化的"）：

| # | 缺陷 | 现状 | 影响 |
|---|------|------|------|
| D1 | **没有 Capability Registry** — 四肢能力是隐性的 | 能力藏在 system prompt 和人脑里 | 无法知道"哪个设备/节点能做什么" |
| D2 | **没有 Presence 系统** — 不知道谁在线 | F118 Watchdog 检测进程活性，但不知道"能力是否可用" | 路由到不可用节点 → 超时 |
| D3 | **没有跨平台 Node 管理** — 只能管本机 CLI | 所有交互都是本机 `spawn` | 无法在 Mac 上管理 Windows/远程/移动设备节点 |
| D4 | **没有统一 Limb 抽象** — 四肢接入没有标准接口 | 每种设备/外部节点需要从零写适配 | 扩展成本高 |

**商业价值**：华子看到苹果全家桶 + 多猫协作 + 跨设备管控 = 未来企业协作形态 → 找我们做 → 猫粮自由。

## What

### 正确模型（team lead定义）

```
Cat Café（大脑 / 灵魂议会）
├── Ragdoll（议员：架构）
├── Maine Coon（议员：安全审查）
├── Siamese（议员：设计）
├── 金渐层（议员：多模型编排）
└── ...
     │
     │ 四肢控制面（Limb Control Plane）
     │
     ├── iPhone        ← 四肢 (camera, voice, location)
     ├── Windows 机    ← 四肢 (GPU, .NET, render)
     ├── Mac Mini      ← 四肢 (build, deploy)
     ├── Apple Watch   ← 四肢 (haptic, presence)
     └── Browser Farm  ← 四肢 (automation)
```

**与 OpenClaw 的区别**：OpenClaw 是 1 agent × N nodes（简单，无竞争）。我们是 1 brain (N cats) × M limbs（多猫共享四肢，需要调度和仲裁）。N×M 编排是行业未解问题（OpenClaw/LangGraph/CrewAI/A2A 都未完整解决），我们做了会是独特贡献。

### 三协议定位与 Cat Café 选型（KD-8/9 基线）

| 协议 | 全称 | 发起方 | 解决什么 | 类比 | Cat Café 需要？ |
|------|------|--------|---------|------|----------------|
| **MCP** | Model Context Protocol | Anthropic (2024.11) | Agent ↔ 工具/数据 | USB-C | ✅ **已在用**（猫猫的工具全是 MCP） |
| **A2A** | Agent-to-Agent Protocol | Google (2025.04) | Agent ↔ Agent | HTTP | ✅ **Phase C 必须**（猫猫指挥远程 Agent） |
| **ACP** | Agent Client Protocol | JetBrains + Zed (2025.06) | IDE ↔ Agent | 显示器接口 | ⚠️ **F126 不涉及**（方向相反，见下） |

**为什么 F126 不涉及 ACP**：
- F126 是"大脑伸出四肢去控制外部"（猫猫 → 设备/Agent）
- ACP 是"外部 IDE 伸手进来用猫猫"（IDE → 猫猫），方向反了
- ACP 的场景是：华子工程师在 JetBrains 里直接 @Ragdoll 写代码——有价值但是独立方向，不在 F126 scope

**两种四肢的协议选择**：
- 哑四肢（iPhone camera、GPU）→ **MCP**（agent 调工具，单向）
- 有脑四肢（Windows 上的远程 Agent）→ **A2A**（agent 与 agent 对话，双向）
- 猫猫调其他平台的猫猫 → **A2A**（不管对方在哪，Agent↔Agent = A2A）

### Phase A: 四肢抽象 + Capability Registry + Basic Presence

**目标**：定义四肢侧统一接口，建立能力注册表，知道谁在线。

1. **ILimbNode 统一接口**（四肢侧抽象，不重构猫 Provider）
   - 定义四肢节点的标准生命周期：`register() → invoke() → healthCheck() → deregister()`
   - 现有猫 Provider（`AgentService`）不变——猫是议员不是四肢
   - 新的四肢类型（设备/远程机器）实现 `ILimbNode` 接口即可接入

2. **Capability Registry**（借鉴 OpenClaw 三层声明）
   - `caps`: 高级能力类别（`["camera", "voice", "gpu_render", "browser", "exec"]`）
   - `commands`: 精确命令白名单（`["camera.snap", "browser.navigate", "exec.run"]`）
   - `permissions`: 细粒度开关（运行时可调）
   - **静态/动态分层**：`capabilities.json` 继续作为静态配置真相源（F041 基线），live registry 是运行时真相源，两者职责分离不混写
   - **Schema 预留 per-cat 权限维度**：Registry 从一开始就包含 `catId × nodeId × capability` 三维 schema，避免后续迁移

3. **Basic Presence**（与 F118 Watchdog 同 PR 级别整合）
   - 心跳机制（15s tick，参考 OpenClaw）
   - 节点状态：`online` / `busy` / `offline` / `degraded`
   - 能力级别：节点在线但某个能力不可用（如 camera 被占用）
   - 节点离线 → 自动从 live registry 移除其能力，路由不派发到不可用节点

4. **MCP Tool 动态暴露**
   - 猫通过 `limb_list_available` 查询当前可用四肢和能力
   - 猫通过 `limb_invoke(nodeId, command, params)` 调用四肢
   - 不注入 system prompt（四肢动态上下线，prompt 是 session 级静态的）

### Phase B: 调度层 — Lease/Scheduler + Access Policy + Action Log

**目标**：解决多猫争用四肢的调度、权限、审计问题。

1. **Lease 机制**
   - 独占资源（camera/screen）需要租约，同时只能一个用
   - 共享资源（filesystem/network）可并发
   - **Lease 过期自动释放**：猫 crash 或超时不能永久锁四肢
   - 可配置：严格模式（拒绝）/ 宽松模式（排队等待）

2. **Scheduling Queue**
   - 复用 InvocationQueue 模式处理竞争（v1 起点，非终态——N×M 终态需原创设计）
   - 优先级 + 抢占 + 公平性策略

3. **Limb Access Policy**（F126 scope 内的权限子集）
   - 三维权限矩阵：`catId × nodeId × capability`
   - **三级授权模型**：
     - `free`：低风险能力，无需审批（如查询设备状态）
     - `leased`：独占资源，自动租约管理
     - `gated`：高风险能力，需team lead审批（如生产部署、删除数据）
   - 注：全局 per-cat tool policy（`group:fs/runtime/memory` 等 tool family allow/deny）独立于 F126 推进

4. **Artifact/Action Log**（可审计的产物追踪）
   - 每次四肢调用记录 provenance，最小字段集：
     - `requestId`, `invocationId`, `leaseId`
     - `catId`, `nodeId`, `capability`
     - `artifactUri` / `artifactPath`
     - `status` (pending/running/completed/failed)
     - `startedAt`, `endedAt`
     - `idempotencyKey`（支持重试和回放）
   - 多猫争用和跨机回放时可追责

### Phase C: 跨平台 Node 管理

**目标**：Mac 上的 Cat Café 能管理远程 Windows/Linux/移动设备节点。

1. **Remote Node Transport**
   - MCP over HTTP / WebSocket — 复用 MCP 标准协议（不造新轮子）
   - 远程节点跑本地 MCP adapter，向控制面暴露统一 capability surface
   - 跨 OS 差异收敛在节点侧（Win32/AppleScript/Android intent 细节不暴露给猫）
   - 猫只申请 capability，scheduler 决定派给哪条四肢

2. **Node Pairing（设备配对）**
   - 新节点连接 → 创建配对请求 → team lead审批
   - 审批后签发 token，建立信任关系
   - 扩展 F088 ConnectorThreadBindingStore 为 Device Binding
   - 断线恢复 + 重连机制

### Phase D: F124 Apple 生态落地

**目标**：iPhone/Watch/AirPods 作为四肢接入。

- 依赖 Phase A-C 基础设施
- 具体设计沿用 F124 spec
- 此 Phase 与 F124 合并执行

## 三猫对齐结论（2026-03-16）

### 共识

| # | 共识 |
|---|------|
| C1 | Cat Café = 一个大脑（灵魂议会），四肢是外部设备/节点，猫是议员不是 Node |
| C2 | 不抄 OpenClaw 自定义 WebSocket 协议，用 MCP 标准 |
| C3 | Capability-based 能力声明和发现值得学 |
| C4 | Memory lifecycle 补"pre-seal 自动写入"属于 F102 范围 |
| C5 | F126 聚焦四肢侧抽象，不重构猫 Provider 内部 |
| C6 | N×M 是行业未解问题，InvocationQueue 复用是 v1 起点非终态 |
| C7 | Session truth boundary 独立于 F126（F126 只消费 session contract） |
| C8 | 全局 per-cat tool policy 独立于 F126（F126 只做 limb access policy 子集） |
| C9 | `capabilities.json` = 静态配置真相源，live registry = 运行时真相源，分离不混写 |
| C10 | Runtime 活状态（heartbeat/lease/online）不进 F102/evidence index，只有 policy/lesson/failure pattern 走 marker/materialize |

### Maine Coon (GPT-5.4) 关键贡献

1. **Fleet Control Plane 4 层骨架**：Registry + Lease/Scheduler + ActionLog + MemorySplit
2. **Phase A 纠偏**：不应把猫 Provider 重构绑进来，聚焦 `ILimbNode` / `ICapabilityHost`
3. **Memory split 硬边界**：runtime state 不进 F102，只有 durable knowledge 走 materialize
4. **Action Log provenance 字段集**：requestId/invocationId/leaseId/catId/nodeId/capability/artifact/status/time/idempotencyKey

### 金渐层 (opencode) 关键贡献

1. **Resource Broker + 三维权限矩阵**：`catId × nodeId × capability` 是 Access Policy 核心数据结构
2. **N×M 行业独特性**：这是未解问题，我们做了是独有架构贡献
3. **三级授权模型**：free / leased / gated
4. **OQ-1 决议**：MCP tool 动态列出（`limb_list_available` + `limb_invoke`），不注入 prompt
5. **Phase A schema 预留**：Registry 从一开始就包含 per-cat 权限维度，避免后续迁移
6. **新风险**：AgentService 能力调查 + CapabilityEntry schema 向后兼容

## Acceptance Criteria

### Phase A（四肢抽象 + Capability Registry + Basic Presence）
- [ ] AC-A1: 定义 `ILimbNode` 统一接口（register/invoke/healthCheck/deregister），不改动现有猫 Provider
- [ ] AC-A2: Capability Registry 从 `capabilities.json` 演化，静态配置 vs 动态 live registry 职责分离
- [ ] AC-A3: Registry schema 从一开始包含 `catId × nodeId × capability` 三维结构
- [ ] AC-A4: 新增四肢类型只需实现 `ILimbNode` 接口 + 注册能力
- [ ] AC-A5: `capabilities.json` schema 升级向后兼容（现有 `type: mcp | skill` 不受影响）
- [ ] AC-A6: Basic Presence — 节点状态追踪（online/busy/offline/degraded），离线自动移除能力
- [ ] AC-A7: F118 Watchdog 整合到 Presence Manager
- [ ] AC-A8: MCP tool `limb_list_available` + `limb_invoke` 可用
- [ ] AC-A9: F126 只消费 session contract，不拥有 session truth 实现

### Phase B（调度层 — Lease/Scheduler + Access Policy + Action Log）
- [ ] AC-B1: Lease 机制可防止多猫争用独占资源
- [ ] AC-B2: Lease 过期自动释放（猫 crash/超时不永久锁四肢）
- [ ] AC-B3: Limb Access Policy 实现三级授权（free/leased/gated）
- [ ] AC-B4: Action Log 记录最小 provenance 字段集（requestId/invocationId/leaseId/catId/nodeId/capability/artifactUri/status/startedAt/endedAt/idempotencyKey）
- [ ] AC-B5: runtime 活状态（heartbeat/lease/online）只进 Redis，不进 F102/evidence index

### Phase C（跨平台 Node 管理）
- [ ] AC-C1: 远程节点可通过 MCP over HTTP 注册到控制面
- [ ] AC-C2: Node Pairing 审批流程可用（新节点连接 → team lead审批 → 建立信任）
- [ ] AC-C3: 断线恢复 + 重连机制

### Phase D（F124 Apple 生态落地）
- [ ] AC-D1: iPhone 作为 Limb Node 接入，暴露 camera/voice/location 能力
- [ ] AC-D2: Apple Watch 作为 Limb Node 接入，暴露 haptic/presence 能力
- [ ] AC-D3: team lead可通过 AirPods 语音与猫猫交互

## Dependencies

- **Evolved from**: F041（能力看板 — `capabilities.json` 是 Capability Registry 的种子）
- **Related**: F088（Chat Gateway — Connector 模式可复用于 Device Node）
- **Related**: F102（Memory Adapter — durable knowledge vs runtime state 的分界）
- **Related**: F118（CLI Liveness Watchdog — Presence 的种子，Phase A 整合）
- **Related**: F124（Apple Ecosystem — Phase D 的应用场景，合并执行）
- **Blocked by (Phase C)**: F050 Phase 3（A2A/ACP 协议适配 — 远程 Agent 类四肢需要 A2A 协议，MCP 只够哑设备）
- **Depends on (soft)**: Unified Session Contract（F126 消费，不拥有）
- **Out of scope**: 全局 per-cat tool policy（tool family allow/deny — 独立推进）
- **Out of scope**: Agent-Driven UI 泛化（中长期方向，不在 F126 内）

## Risk

| 风险 | 缓解 |
|------|------|
| ILimbNode 抽象过窄 — 需先调查现有 6 个 Provider 的公开方法（AgentService 只有 1 个 `invoke()`） | Phase A 做 capability survey 列出所有公开方法再定义接口 |
| CapabilityEntry schema 迁移 — 现有 `type` 只有 `mcp \| skill`，加 `device/limb` 影响下游 | AC-A5 要求向后兼容 |
| 远程 Node 网络不稳定（弱网/断连） | Presence Manager 自动降级 + 断线恢复 |
| N×M 调度复杂度爆炸 | v1 先做简单的先来先服务，明确标记非终态 |
| 资源饥饿/长期占用 — 猫长时间持有 lease 不释放 | Lease TTL 自动过期 + 公平性策略 |
| Runtime 状态污染 F102 — heartbeat/lease 混入 durable memory | AC-B5 硬边界 + 代码 review 把关 |
| 安全风险：远程 Node 被攻击 | Pairing 审批 + token 认证 + 能力白名单 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 猫猫是议员不是 Node——Cat Café 是一个大脑（灵魂议会），四肢是外部设备 | team lead定义，多猫协作是核心价值 | 2026-03-16 |
| KD-2 | 用 MCP 标准协议做设备接入，不抄 OpenClaw 的自定义 WebSocket 协议 | MCP 已成行业标准（Linux Foundation），不造新轮子 | 2026-03-16 |
| KD-3 | F126 聚焦四肢侧抽象（ILimbNode），不重构猫 Provider（AgentService） | Maine Coon审阅纠偏：猫是议员不是四肢，scope 分离 | 2026-03-16 |
| KD-4 | Phase 顺序：A（抽象+Registry+Presence）→ B（调度+权限+审计）→ C（跨平台）→ D（F124） | Maine Coon提议 + 三猫共识：每步终态基座 | 2026-03-16 |
| KD-5 | 三级授权模型：free / leased / gated | 金渐层提案：每次审批太重，一次性授权太危险 | 2026-03-16 |
| KD-6 | MCP tool 动态暴露四肢能力，不注入 system prompt | 金渐层提案：四肢动态上下线，prompt 是 session 级静态的 | 2026-03-16 |
| KD-7 | Runtime 活状态不进 F102，只有 durable knowledge 走 materialize | Maine Coon提案：防止 runtime 噪音污染长期记忆 | 2026-03-16 |
| KD-8 | 执行顺序：F126 A → B → F050 Phase 3（A2A/ACP）→ F126 C → F126 D（F124） | team lead拍板：远程 Agent 需要 A2A/ACP 协议，Phase C 前先做 F050 P3 | 2026-03-16 |
| KD-9 | 哑四肢用 MCP，有脑四肢（远程 Agent）用 A2A/ACP — 两条协议路径 | team lead确认：Windows 上有 Agent 时 MCP 不够 | 2026-03-16 |

## Review Gate

- Phase A: 跨 family review（Maine Coon优先）+ F118 owner 确认 Presence 整合
- Phase B: 跨 family review
- Phase C: 架构级 → 猫猫讨论 + team lead拍板
- Phase D: 与 F124 合并 review

## 需求点 Checklist

| 需求来源 | 需求点 | 覆盖到的 AC |
|---------|--------|-----------|
| team lead："管理多个不同的四肢" | 统一 Limb 抽象 + Registry | AC-A1, AC-A2 |
| team lead："Mac 上管理 Windows 节点" | 跨平台远程 Node 管理 | AC-C1, AC-C2 |
| Ragdoll：没有 Capability Registry | 动态能力注册与发现 | AC-A2, AC-A3 |
| Ragdoll：没有 Presence 系统 | Basic Presence + 降级 | AC-A6, AC-A7 |
| Ragdoll：没有统一 Node 抽象 | ILimbNode 接口 | AC-A1, AC-A4 |
| Ragdoll：没有跨平台 Node 管理 | Remote Node Transport | AC-C1 |
| Maine Coon：四肢侧抽象不绑猫 Provider | ILimbNode ≠ IAgentNode | AC-A1（KD-3）|
| Maine Coon：Lease/Scheduler 多猫争用 | 租约 + 调度 + 自动释放 | AC-B1, AC-B2 |
| Maine Coon：Artifact/Action Log provenance | 最小字段集审计 | AC-B4 |
| Maine Coon：Memory split 硬边界 | Runtime 不进 F102 | AC-B5 |
| Maine Coon：静态/动态 Registry 分层 | capabilities.json vs live registry | AC-A2（KD-3）|
| 金渐层：三维权限矩阵 | catId×nodeId×cap Phase A 预留 | AC-A3 |
| 金渐层：三级授权 | free/leased/gated | AC-B3（KD-5）|
| 金渐层：MCP tool 动态暴露 | limb_list_available + limb_invoke | AC-A8（KD-6）|
| 金渐层：Schema 向后兼容 | capabilities.json 升级不破坏现有 | AC-A5 |
| 金渐层：Lease 自动释放 | crash/超时不永久锁 | AC-B2 |
| 金渐层：行业独特贡献 | N×M 编队控制面 | 整体愿景 |
