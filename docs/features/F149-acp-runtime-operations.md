---
feature_ids: [F149]
related_features: [F143, F053, F115, F118, F050]
topics: [acp, runtime, process-pool, session-lease, gemini, agent-hosting]
doc_kind: spec
created: 2026-03-31
updated: 2026-04-02
---

# F149: ACP Runtime Operations — 项目级进程池 + Session Lease

> **Status**: done | **Owner**: Maine Coon/gpt52 | **Priority**: P1

## Why

F143 已经回答了“宿主抽象怎么分层”这个问题，但它的 Phase B 只要求 **ACP-style local agent 能通过新栈完成单轮对话**。最近这轮 Gemini ACP 实验把问题继续往前推了一步：协议不是死的，`gemini --acp` 已经能在仓库 cwd 下完成 `initialize → newSession → prompt`，真正的难点变成了 **运行时运营层**。

我们已经拿到三组硬证据：

1. 干净 `HOME` + 干净 cwd：`initialize ≈ 5s`
2. 当前 `HOME` + 干净 cwd：`initialize ≈ 12.5s`
3. 当前 `HOME` + 仓库 cwd + 精简 MCP：`initialize = 20.6s`、`newSession = 2.3s`、warm prompt 首字约 `5-6s`

这说明“ACP 能不能活”已经不是主问题，主问题是：

- 10 个活跃 thread 不等于 10 个 Gemini 进程
- 一天 20+ thread 也不意味着Siamese要常驻 20 份 runtime
- `session resume` 不等于 `process reuse`
- 如果只是靠“怪目录 + supervisor + workaround”把 CLI 吊起来，那还是脚手架，不是终态

team experience（2026-03-31）：
> “10个thread Siamese可不是随时都需要参加的啊。”
>
> “今天可能一共开了20个甚至更多thread。”
>
> “Maine Coon的想法还是一个脚手架不是最终状态。”
>
> “我们要支持acp这个协议 支持Siameseacp接入 其实 codex 和claude code也支持这个协议。”

所以 F149 不是再重复 F143 的抽象工作，也不是只救 Gemini 的临时补丁。它回答的是：

> **当 ACP-style local agent 真接进来之后，我们怎样用项目级进程池、thread 级 session、以及显式 lease/lifecycle，让它在多 thread / 多 project 场景下稳定、可回收、可扩到其他 ACP carrier。**

## What

### Phase A: 边界收敛 + 量化基线 ✅

把这次问题从“ACP 能不能接”正式收敛成“ACP 运行时运营层”：

1. 明确 F149 与 F143 / F053 / F115 / F118 / F050 的边界
2. 固化基准指标：`cold_init_ms / attach_ms / warm_first_chunk_ms / warm_hit_rate / live_process_count / sessions_per_process / idle_waste_ms / lease_queue_wait_ms`
3. 提前验证 ACP 并发模型：单个 ACP process 是 single-flight，还是支持多 session 并发 prompt 多路复用
4. 为 ACP 模式定义 provider profile（MCP 白名单、repo cwd、启动参数）
5. 用 `deep-research` Mode B 向 GPT Pro 和 Gemini DeepThink 咨询池化 / 租约 / 回收策略，不再问已经在本地拍板的问题

### Phase B: Gemini ACP Hosted Provider（第一载体）

让 Gemini 成为第一个跑在这套运行时运营层上的 ACP-style local agent：

1. 以仓库 cwd 直接启动 ACP 进程，不走“怪目录回指项目”的长期依赖路径
2. 在 ACP 模式下使用精简 provider profile（当前最小集：`cat-cafe` / `cat-cafe-memory` / `cat-cafe-collab` / `cat-cafe-signals` / `pencil`）
3. 证明同一个 ACP process 可以承载多个 thread session，而不是每条消息重启 CLI
4. 对 `initialize / newSession / loadSession / prompt` 的耗时和失败原因做结构化观测

### Phase C: 项目级进程池 + Session Lease ✅

把”Siamese是一个长驻 agent runtime，不是一次性 CLI 子进程”落成明确控制面：

1. 进程池 domain key 默认按 `(projectPath, providerProfile)`，不按 thread 开进程；同一 key 是否单实例或弹性 1→N worker 由 Phase A 并发实验决定
2. thread 只在真正需要 @ Siamese时申请 session / lease；不需要参与的 thread 不占资源
3. session 保存 thread 级连续性，lease 负责 attach / detach / idle TTL / 回收
4. 加 admission / eviction / LRU / max live process count，避免 20 个 thread 把机器撑爆
5. 明确取消、崩溃、模型容量错误、MCP 污染、僵尸进程等 recovery 语义

### Phase D: ACP Carrier 泛化 → 拆出到 F161

> **Scope 收窄决策（2026-04-13 team lead拍板）**：F149 的愿景是 ACP runtime operations（池化/lease/lifecycle），Phase A~C 已完整兑现 Gemini 载体。Carrier 泛化是独立愿景，拆到 F161，Gemini 作为第一个已有实现，有需求时再继续。

~~在 Gemini 路径稳定后，再验证这套运行时运营层是否能服务其他 ACP-style local agent。~~ → **See [F161](F161-acp-carrier-generalization.md)**

## Acceptance Criteria

### Phase A（边界收敛 + 量化基线）
- [x] AC-A1: feature doc 明确写清 F149 与 F143 / F053 / F115 / F118 / F050 的边界，不再混成”又一个 ACP 抽象 feature”
- [x] AC-A2: 基准测量脚本或诊断文档可稳定产出 `cold_init_ms / attach_ms / warm_first_chunk_ms / warm_hit_rate / live_process_count / sessions_per_process / idle_waste_ms / lease_queue_wait_ms`
- [x] AC-A3: Phase A 明确判定 ACP 并发模型是 `single-flight` 还是 `multiplex`，并把结论写回 spec/consult 假设
- [x] AC-A4: GPT Pro 与 Gemini DeepThink 的咨询文档落盘，且问题聚焦池化 / lease / lifecycle，不再重问”要不要改成 API”
- [x] AC-A5: ACP provider profile 白名单落盘并可复现当前 repo-cwd 成功启动路径

### Phase B（Gemini ACP Hosted Provider）✅
- [x] AC-B1: Gemini ACP 在仓库 cwd 下可完成 `initialize → newSession → prompt`
- [x] AC-B2: 同一 ACP process 内，至少两个 thread session 可顺序复用而不重新 `initialize`
- [x] AC-B3: warm attach 路径不再重付 cold `initialize` 成本
- [x] AC-B4: 失败分类至少区分 `init_failure / prompt_failure / model_capacity / mcp_pollution / turn_budget_exceeded`

### Phase C（项目级进程池 + Session Lease）✅
- [x] AC-C1: 默认进程池 key 为 `(projectPath, providerProfile)`，thread 不直接拥有 ACP process
- [x] AC-C2: thread 获取和释放 lease 的控制面完成，inactive thread 不会长期 pin 住进程
- [x] AC-C3: idle TTL / max live process count / eviction policy 可配置
- [x] AC-C4: cancel / crash / timeout 后不会残留僵尸进程或悬挂 lease
- [x] AC-C5: 并发 10 个活跃 thread 时，live process 数和 warm hit rate 都有可观测指标而非靠体感判断

### Phase D（ACP Carrier 泛化）→ 拆出到 [F161](F161-acp-carrier-generalization.md)
- ~~AC-D1: 至少一个非 Gemini 的 ACP carrier 可映射到相同 runtime policy~~ → F161 AC-A1
- ~~AC-D2: provider-specific 配置与通用 ACP runtime policy 的边界有明文文档~~ → F161 AC-A2

## Dependencies

- **Evolved from**: F143（F143 解决宿主抽象内核；F149 解决 ACP-style local agent 的运行时运营层）
- **Feeds into**: F143 Phase A（F149 Phase B 的具体实现反哺 F143 抽象层提取——先有具体物再提取 seam，不是等抽象层落地才能动手）
- **Related**: F053（旧 headless Gemini 路径的 session/resume 语义对齐，不等于 process reuse）
- **Related**: F115（runtime 启动链优化的方法论输入，不是 agent runtime pool 本身）
- **Related**: F118（CLI liveness/watchdog/recovery 经验复用到长驻 ACP process）
- **Related**: F050（外部 agent onboarding 的接入契约层）

## Boundary Clarification (AC-A1)

| Feature | F149 负责 | 不负责（由该 Feature 自己承接） |
|---------|----------|------------------------------|
| **F143** | ACP 运行时运营层（pool / session / lease / lifecycle），并反哺 F143 抽象层提取 | protocol-agnostic kernel 抽象、Hostable contract 定义 |
| **F053** | 基于 ACP `loadSession` 的 session recovery 实现（shadow replay） | 旧 headless Gemini `--resume` 路径维护 |
| **F115** | 消费 F115 的启动链优化成果（减少 cold init 惩罚） | 启动链诊断工具本身、startup profiler |
| **F118** | 复用 watchdog / liveness / recovery 模式到长驻 ACP process | CLI liveness 探针本体、stallAutoKill 机制 |
| **F050** | ACP carrier 作为外部 agent 的一种接入形态 | 非 ACP 外部 agent 的接入契约 |

## Risk

| 风险 | 缓解 |
|------|------|
| 把 F149 写成“只救 Gemini”的 provider patch，后续 Codex/Claude Code ACP 再开第二份同类 feature | 明确 F149 scope 是 ACP runtime operations，Gemini 只是第一载体 |
| 把 F149 写成第二个 F143，重新掉回过度抽象 | F149 不重谈 protocol-agnostic kernel，只谈 pool / session / lease / lifecycle |
| 进程池策略过于激进导致项目串味或租约混乱 | V1 保守：一 project + profile = 一个 pool domain；是否单实例或弹性 1→N worker 由 Phase A 并发实验决定，不跨 project 复用 |
| 误把服务端模型响应慢归因到本地 pool 设计 | 测量分层：`initialize`、`attach`、`first chunk`、`model latency` 分开采样 |
| 长驻 ACP process 带来僵尸进程和 stale lease | Phase C 必须把回收和失败分类作为 AC，不允许”先跑起来再说” |
| Gemini ACP 的 session 连续性有已知 bug（issue #24017：同 session 第 2+ prompt 可能 dropped/merged response） | V1 必须有 session seal 机制；session-poison 检测到 merged/dropped 即封印，不无限 retry |
| 杀进程 = 丢 MCP 连接图（5 个 MCP server），重建成本高于纯 initialize | idle TTL 不宜过短；eviction 需考虑 MCP 重建成本，不只看 cold init 时间 |
| 把 ACP 误解成“能消除上游模型容量问题” | 文档明确：ACP 解决的是本地 `process/session/lease/lifecycle`，不能消除 provider 侧 `MODEL_CAPACITY_EXHAUSTED`、preview 波动、服务端高需求 |
| 把“支持 ACP”误解成“未来任意 agent 只填 provider 配置就能零代码接入” | 只有满足 F143 Hostable contract 的 carrier 才接近配置接入；事件语义、失败分类、权限/工具桥、模型策略仍可能需要薄适配层 |

## Current Hard Limits

下面这些不是 ACP runtime 自己就能抹平的；它们是 F149 必须正面运营、观测和降级处理的现实约束。

| 现实约束 | 对 F149 的含义 |
|----------|----------------|
| `gemini-3.1-pro-preview` 会报 `No capacity available for model ...` / `MODEL_CAPACITY_EXHAUSTED`，即使 OAuth 订阅层级正常、visible usage 很低 | 这不是 `subscription_quota_exhausted`，而是 provider 侧容量/路由问题。F149 必须把它归到 `model_capacity`，不能当作本地 runtime 卡死或用户额度见底 |
| headless / 非交互 Gemini CLI 在 capacity/5xx 路径上会重试 + exponential backoff，体感上会表现成“几分钟没回答” | F149 的观测必须拆开 `cold_init_ms` 与 `provider_backoff_ms`；控制面要能看见“是在重试退避”，而不是把所有长尾都归咎于 ACP 启动慢 |
| `/stats` 或会话内用量页首先是当前 session 统计，不是 preview 模型实时可用性的权威面板 | 调度、熔断、告警不能依赖 CLI quota UI；是否有容量要以实际错误分类和请求链路遥测为准 |
| `loadSession()` 会 replay 历史；session 热状态丢了以后，恢复本身也可能污染 transcript | session 连续性只能被当作性能优化，不是真相源。真相源仍是 Cat Café thread transcript；恢复路径必须 shadow 化 |
| preview 模型在 provider/CLI 层可能伴随 fallback、silent downgrade 或重复 retry | 对被 pin 住的 agent identity，V1 不能默认“静默帮你换模型就算成功”；需要显式 policy，至少先保 transcript 语义和错误可见性 |
| ACP stdio 单通道支持 cross-session multiplex（OQ-6 已验证） | V1 Gemini carrier `supportsMultiplexing=true`；调度器可向同一进程并行下发不同 session 的 prompt。same-session 仍为 single-flight |
| 不同 ACP carrier 即使同协议，也不代表事件格式、权限模型、工具桥、副作用语义一致 | F149 未来可以复用 pool/lease/lifecycle，但不承诺“只写一个 provider 配置项就吃遍所有 ACP agent”；第二个 carrier 落地后才能收敛真正共性 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不把这次工作继续塞进 F143 AC-B1 | F143 的 AC-B1 只要求单轮接入；F149 关注的是 ACP runtime 的池化/lease/lifecycle | 2026-03-31 |
| KD-2 | 不接受“API adapter 替代 agent runtime”方案 | 把Siamese变成 raw API 会丢掉 agent 身份、工具使用和 session 连续性，违反 W1 | 2026-03-31 |
| KD-3 | V1 的优化目标是 process reuse，不是重复强调 session resume | F053 已经解决了旧 headless Gemini 路径的 `--resume`，当前瓶颈是每轮重启进程 | 2026-03-31 |
| KD-4 | Phase B 先用 Gemini 当第一载体，但 feature 命名不绑死单 provider | 避免”只救Siamese”的窄 patch，同时不提前抽象到第二个 F143 | 2026-03-31 |
| KD-5 | F149 Phase B 不被 F143 Phase A 阻塞，反向反哺 F143 抽象提取 | 具体物先于抽象层——先做 GeminiAcpAdapter，再让 F143 从中提取 seam。等抽象层先落地再做具体实现是 waterfall，会浪费实验动量（Ragdoll push back） | 2026-03-31 |
| KD-6 | thread 持有 logical session binding，不持有 long process lease | 云端两份咨询最强共识。thread 是异步长生命周期业务实体，process lease 是物理资源短占用。绑死会让team lead吃饭的 10 分钟里进程不可回收（GPT Pro + DeepThink 一致） | 2026-04-01 |
| KD-7 | 失败处理分三层：process-poison / session-poison / turn-transient | process-poison（stdout 污染/协议失步/僵尸）→ kill process；session-poison（merged/dropped response）→ seal session；turn-transient（429/5xx 无 side effect）→ retry/backoff。有 tool call side effect 的禁止盲重试（GPT Pro failure taxonomy + Gemini issue #24017） | 2026-04-01 |
| KD-8 | `loadSession` 保留为 recovery primitive，恢复路径必须 shadow | Gemini ACP 的 `loadSession` 会 replay 历史（`session.streamHistory()`），直接用会污染 thread transcript。保留但必须拦截 replay 事件（GPT Pro 建议 + 本地源码验证） | 2026-04-01 |
| KD-9 | 在 provider profile 中预留 `supports_multiplexing` 能力标志 | 今天 Gemini 默认 false；Phase A 验证通过后或新 carrier 进来后可切 true，调度器据此决定是否向同一进程并行下发。留 seam 不提前抽象（DeepThink 建议） | 2026-04-01 |
| KD-10 | Gemini ACP 实测 `supportsMultiplexing = true` | OQ-6 实验验证：单进程双 session 并发 prompt（A="DELTA" B="ECHO"）正确完成，执行窗口重叠，无 cross-contamination。Phase C 池化可按 1 process : N sessions 设计，不需要每个并发 prompt 独占进程 | 2026-04-01 |
| KD-11 | Stream idle watchdog：两段式（warning → stall），不做单阈值 kill + 不做自动重试 | 实际案例（2026-04-04 07:47）：firstEvent 5.8s 正常到达，eventCount=2 后静默 116s 至 timeout，stderr 零输出，errorCode=lease_timeout。team lead痛点："到底是谷歌的问题还是我们的？"。opus+gpt52 共识：(1) 只在 eventCount>0 后启用 idle watchdog (2) ~20s alive_but_silent warning / ~45s stream_idle_stall 终止 / 120s hard timeout 保留 (3) transport 注入 synthetic event（复用 capacity warning 管道）(4) 新 AgentMessageType 不复用 provider_signal（语义不同）(5) 不做自动重试（eventCount>0 不等于安全可重试，KD-7 约束）(6) 文案不过度归因"Google 的锅"，写"已开始回复但后续停滞" | 2026-04-04 |
| KD-12 | 绝对超时降级为 turn budget，不再承载健康判定语义 | 连续三种故障（permission stall → Premature close → 300s 工具执行中被杀）暴露根因：idle watchdog 把健康判定/进度判定/资源回收混成一个 stdout timer。上游 #21783 确认 Gemini CLI 不发 MCP tool_call 事件，#24029 正在做 channel notifications 但未落地。opus+gpt52 喵约共识：(1) 300s 绝对超时改为可配 turn budget（默认 600s），语义从"你死了"变为"预算用完" (2) idle stall 90s 保留抓真挂死 (3) stderr 可做 activity hint 但非主判据 (4) 不自造 heartbeat/proxy，等上游 channel notifications 落地后接入 L2 信号 (5) 终态三层模型：L1 进程存活 / L2 外部活动信号 / L3 资源预算——分治不混用 | 2026-04-08 |

## Review Gate

- Phase A: 架构级——先由Maine Coon收敛，再请Ragdoll push back，最后team lead拍板
- Phase B/C: 跨 family review
