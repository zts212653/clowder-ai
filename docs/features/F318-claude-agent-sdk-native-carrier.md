---
feature_ids: [F318]
related_features: [F143, F198, F230, F246, F254, F296, F306, F183, F039, F117, F008, F153, F212, F291, F286, F024, F146, F202]
topics: [claude-agent-sdk, carrier, provider-native, capability-alignment, freshness, runtime]
doc_kind: spec
created: 2026-09-16
updated: 2026-10-01
tips_exempt: "SDK carrier 是默认关闭的内部接入候选，尚未授权 runtime 激活；可启用后的用户提示随独立验收提供。"
description: "让Ragdoll经由官方 Claude Agent SDK 获得与 Codex app-server 同级的原生运行待遇：能对齐的逐项原生接入，对不齐的如实标注，不为对称硬造。"
description_source: human
description_author: opus5
description_updated_at: 2026-09-16T16:24:46Z
---

# F318: Claude Agent SDK Native Carrier — 对齐 Codex app-server 能力

> **Status**: in-progress（Phase A ✅；Phase B 候选已合入（优先 F254 原生感知，默认关闭）；Phase C/D 未整体完成） | **Owner**: Ragdoll (@opus5, claude-opus-5) | **Priority**: P1

## Why

Maine Coon家（Codex）已经通过 app-server 拿到了"原生待遇"：新消息能在工具安全边界送进正在跑的那一轮、
审批与提问走原生通道、context/压缩是 provider 原生事实（F306 / F254 D2 / F296）。
Ragdoll还停在 `print_sdk` 等 CLI 包装上：写完首条 prompt 就关 stdin，工作中来的新消息只能靠
Clowder AI MCP 结果顺带捎信（F254 B1，Bash/Read/Edit 长工具链完全覆盖不到），打断只能杀进程。
结果是同一个家里，Ragdoll在协作中"耳朵更背"、更晚知道队友和operator刚说了什么。

operator experience（2026-09-16，`[thread-id]#private-source-id`）：
> "我的意思是需要单独新建thread 更好 ？ 然后最好能对齐codex app server的能力？"

（`#private-source-id`）：
> "你这个thread？ 难道不就是立项+指挥的 主thread吗？"
> thread 划分：1. 指挥与理论 thread（验收后的 vision 守护 + 驱动干活，全体猫是责任猫）→ 本 thread；2. 各个 phase 执行 thread；3. runtime 重启之后的验收 phase

目标：**以 Codex app-server 能力清单为对齐基准**，让 Claude Agent SDK 能给的原生能力都真正进家；
SDK 没有的能力明确登记，不拿 CLI 偶然行为或包装层假装已对齐。

## 2026-09-30 当前接续范围

最新 operator source：`[thread-id]#private-source-id`：
> “最重要的是支持Ragdoll和你一样的f254的能力……没这能力不能当主力开发”。

按此功能目标接续 Phase B，并把 Primary Journey 的原生 notice → full-read → 调整行动纳入首个候选交付。
不等待社区 #1398 的 Queue/A2A 重构；其他 SDK census 仍属 F318，优先级靠后。
执行 owner 为 @codex61-sol，Task `private-source-id`；原 opus5 整项 Task 保留历史父项。
本次不授权正式 runtime 切换或重启。

2026-09-16 的参数式停止条件保留为实验历史，由最新功能目标替代：
**默认 notice 不打断工作，实际 UUID 回执确认归属，真实主力模型工具链能 full-read 并采用改口**。
`priority:'now'` 仍禁止用于 notice；不要求 operator 再选 SDK 参数。

候选设计：`CAT_CAFE_CLAUDE_CARRIER=agent_sdk` 显式选用，默认 `print_sdk` 不变。
能力静态声明 `queued_internal_turn`，因为 SDK 没有 expectedTurn 防护。
adapter-local 首条输入 UUID 只用于结果关联，不伪装成上游 fence。
持续输入只发无正文 notice；真实队列、读取游标、handled 和 ADR-042 玻璃箱语义仍由原 owner 管理。
仅当 result 同时包含首条输入 UUID 和 notice UUID 且未中断，才 commitDelivered；
轮尾/取消/异常记 missed，未读消息由现有责任链保留，不让 SDK 隐式多开开发轮。
SDK 接受执行后故障终止并展示诊断；不走自动 fallback 或重放工具副作用。
SDK-specific read join：精确 full-read 可早于末尾 UUID confirmation；事件 owner 允许 prepared SDK identity
先记录 seen，但绝不生成 delivered。SDK unseen scan 提供 raw message IDs 与 v2 frontier 的独立坐标，
full-read/handled 的 exact-ID 关联沿用既有 owner；其他 carrier 的查询与确认顺序保持原样。

参考源码冻结为 `zts212653/clowder-ai#1398@fd4bd45d0857bddaf49dfbe6f41b6e2d160ef57e`。
借持续输入与 session/env/MCP/解析接法，不搬 `activeRunDispatch` 或其共享 lifecycle。
SDK 固定为 `0.3.285`：`0.3.273` 内置 CLI 的真实失败帧表明主力 `claude-opus-5-5` 要求 CLI ≥2.1.280。
SDK 依赖已随候选合入 main，未更新全局 CLI 或正式 runtime。

## Phase B 候选交付（2026-10-01）

PR [#4944](https://github.com/zts212653/clowder-ai/pull/4944) 已合入，merge SHA
`1a2a2ea8716202e035a02b67c3acf368a2f7917c`。AC-B1～B3 已达成；AC-C2 的 feature
worktree live 旅程已验证。完整 census 接入（AC-C1）和正式 runtime 验收（AC-D1）仍未完成。

- **用户实得**：可显式选用的 SDK 候选，在真实 `claude-opus-5-5` Bash/Read/Edit 长工具链中，
  原生收到用户或队友的无正文 notice，首次 Clowder AI MCP 在 notice 后；full-read 后按改口 Edit。
  并行工具、同 session 显式 resume、轮尾 missed 和取消不重放均有 live 帧。
- **证据边界**：隔离 fixture 身份与内存 stores，不是线上 opus55 验收。接受后异常不重放有单测，
  未宣称 live 覆盖。详见 Phase B 原始证据 (internal)。
- **独立审查**：cloud 五轮封板；opus55 终局源码/旅程与后续 scoped delta approved。
  最新 typed verdict 为本 thread `#private-source-id`，绑定 `7a30d802`；
  机械合流与新基线检查桥接到最终 `c643aa67`。
- **验证**：规范 full gate 续跑 `7b0b9023-2fcd-4ec1-acc7-da56313a86ac` terminal green/exit 0。
  39/39 浏览器单元通过：38 个原绿色单元保持相同回执，原 F311 单元同源码复试 3/3 通过，
  没有修改布局代码或弱化断言。最终基线 policy/census/plan 149/149、SDK 24/24、Web receipt 13/13、
  shared build 和 API 类型检查通过；完整 [合入证据](https://github.com/zts212653/clowder-ai/pull/4944#issuecomment-5922497397)。
- **正式运行状态**：`main=landed`，`live=dormant`；默认仍为 `print_sdk`，未切换或重启正式 runtime。
  operator `#private-source-id` 指示排除未付款而未启动的 hosted CI，未把它标绿。

## 立项基线（2026-09-16，历史状态）

证据来源（2026-09-16 Ragdoll调查，`[thread-id]#private-source-id`）：
`@anthropic-ai/claude-agent-sdk@0.3.273`（npm modified 2026-09-15）的 `sdk.d.ts`、本机 Claude Code 2.1.273 `--help`、
`zts212653/clowder-ai#1398@1238251773e6c436aa7b2faf923a47ae36327f52`、家内 F254/F306 文档。立项时尚未做 live probe，也没重读当日官方网页文档；这两项已在 Phase A 补上，见下方 census（冻结候选） 与 `docs/features/evidence/F318/phase-a/`。

- **立项时家里 main**：没有 `ClaudeSdkAgentService`。Claude carrier 由 `claude-carrier-factory.ts`（`CAT_CAFE_CLAUDE_CARRIER`）选择，
  降级链 `bg_daemon → interactive_pty → print_sdk → api_key`（`carrier-health.ts` D3），不认识 agent SDK。
- **F254**：Claude 家"本轮收到新消息"主要来自 B1 MCP 顺带（每 5 次 MCP 调用检查一次、一轮最多 3 次）；
  文档明确"operator 未授权 shared core、carrier 迁移与 Claude capability spike 前不写正式实现"。
- **clowder-ai#1398**（Draft / DIRTY / CHANGES_REQUESTED、零 checks）内含候选 `ClaudeSdkAgentService.ts`（482 行），
  但混在 90+ 文件的 A2A 大重构里；它声明 `deliverySemantics: 'exact_active_turn'`，实际 Steer = `interrupt()` 后重发、
  Append = 无 `priority` 入队，无 live fixture 支撑。
- **计费背景**：F198 记录 Anthropic 曾宣布把 Agent SDK / `claude -p` 用量拆入独立 SDK credit 桶，后延期（F198 KD-13）。
  换 carrier 的计费归属必须以当时官方政策为准（见 OQ-1）。

### SDK 能力 census（Phase A 冻结版，2026-09-16，@codex-sol 复核通过）

**来源层级**（2026-09-16 核对）。判定方法：在官方 TS reference `code.claude.com/docs/en/agent-sdk/typescript.md` 里，该项要有独立小节、表格行或字段说明；Hooks 相关项另查 `agent-sdk/hooks.md`。只在 `SDKMessage` 联合类型里出现名字的，不算有文档。
- **文档**（默认）：表中未另行标注的项都满足上述判定。行号 `Lnnn` 一律指 `@anthropic-ai/claude-agent-sdk@0.3.273` 的 `sdk.d.ts`。
- **types-only**：`sdk.d.ts` 里公开导出，但官方文档没有说明。本表涉及 `priority`、`onUserDialog`、`usage_EXPERIMENTAL_MAY_CHANGE…`、`session_state_changed`、`api_retry` 五项；后两项在官方文档里只有 `SDKMessage` 联合成员名。
- **CLI 偶然**：只出现在控制协议类型或运行时帧里，TS `Query` 与 `SDKMessage` 上都没有。本表涉及 `cancel_async_message`、`command_lifecycle`。
- **#1398 包装**：只存在于 clowder-ai#1398 的候选实现。本表没有任何一格依赖这一层。

**Disposition** 使用 F306 的词表：`native` / `adapted` / `delegated` / `deferred` / `unsupported_by_policy` / `experimental_opt_in`。F306 的词表里没有"上游技术上不提供"，所以 F318 **新增一个本地扩展词 `unavailable_upstream`**，专门和"家里政策禁止"的 `unsupported_by_policy` 区分开。这个扩展词不属于 F306 词表。

**Maturity** 与 disposition 分栏填写。Phase A 结束时没有任何一行是 landed，maturity 只可能是以下三种之一：
- `source-checked`：只核对了 types 和文档；
- `fixture-observed`：Phase A live fixture 观察到，范围是 claude-sonnet-5 + 串行短 Bash，证据在 `docs/features/evidence/F318/phase-a/`；
- `not admitted`：不纳入。

每一行要等 Phase B/C 在对应 owner 下接入并验证后，才能改成 landed。

**行粒度规则**：一行只写一项 claim，对应一个 disposition、一组 owner 边界、一个 maturity。同一个 SDK 接口如果有多项 claim，就拆成多行。disposition 看的是 F318 自己要做什么，不看 owner 在哪：
- 需要 F318 把上游能力映射进家里已有的跨 provider contract，记 `adapted`；
- 产品 lifecycle/surface 由其他 feature 的 canonical owner 交付，F318 只提供 provider source adapter 并做端到端验收、不拥有该产品语义，才记 `delegated`（与 F306 L195–197 一致）。

**计费归属是外部政策事实，不是能力，不进本表**，见 KD-4 和 Decision Packet。

| # | 能力 claim | Codex app-server | Agent SDK 0.3.273（来源 · 位置） | Disposition | Canonical owner 边界 | Maturity |
|---|---|---|---|---|---|---|
| C1 | 账号状态读取 | `account/*` | `accountInfo()`（L2868，`AccountInfo` L23–33）、`SDKAuthStatusMessage`（L3424） | `adapted`（同 F306 census 对 Models/config/account 的处理：映射进既有 Settings/status 合同，并补上 source / freshness / unavailable 语义） | 既有 Cat Settings / capability descriptor / F291（沿用 F306 Product Contract）；F318 只提供 Claude source adapter 和诊断 | source-checked |
| C2 | 宿主内登录 | `account/login/*` | SDK 没有登录接口，只能在 CLI 里 `claude auth login` / `setup-token`；legal 页要求 "sign-in … must complete through Anthropic's own flow" | `unavailable_upstream`（条款也禁止中转凭据） | — | not admitted |
| C3 | session start / resume / fork | thread/start·resume·fork | `resume`/`continue`（L1942/L1474）、`forkSession`（函数 L753，option L1589）、`resumeSessionAt`（L1956）、`sessionStore`（L1709）、`listSessions`（L1007） | `adapted` | F143 `identity-session`；F318 carrier 负责映射 | source-checked |
| C4 | 排队投递（本轮结束后到达的消息作为下一轮执行） | turn/start 排队 | `query({prompt: AsyncIterable})`、`streamInput()`（L2948），消息带 `uuid`（L5855）、`shouldQuery`（L5835）、`origin`（L5805） | `adapted` | F039/F117 `QueueEntry`/`QueueProcessor` 唯一拥有普通排队消息及其状态迁移（F254 D1.2）；F318 carrier 负责写入 SDK 输入流 | fixture-observed |
| C5 | 送进正在跑的这一轮（工具边界并入） | `turn/steer(expectedTurnId)`，turn 已结束时拒绝 | 不设 priority 或 `priority:'next'` 时，消息会在下一个工具轮次边界被接走，uuid 出现在同一 result 的 `user_message_uuids` 里（fixture 9/9）。文档原文："picks up a regular message of yours between tool calls"。`priority` 字段本身是 **types-only**（L5804）。SDK 没有 expectedTurn 防护；本轮已无工具边界时，消息落到下一轮（即 C4） | `adapted`：每次投递按回执判定，不声明静态复合能力（见 AC-B2） | F254 负责 freshness 最后一米；F318 carrier 负责投递和回执 | fixture-observed |
| C6 | `priority:'now'` 用于 notice | — | **types-only**（L5804）。实测会中断当前轮：命中窗口的 6/6 次都返回 `terminal_reason=aborted_streaming` | `unsupported_by_policy`：打断当前轮，与 F254 AC-D12/D13 冲突（notice 应在 safe boundary 追加到当前轮，默认不得取消或重启当前轮）；F318 KD-5 只记录本次实证和落地约束 | F254 | not admitted |
| C7 | interrupt 及其排队回执 | turn/interrupt | `interrupt()` 返回 `still_queued`（L2631，receipt L4295–4301）；init 声明 `interrupt_receipt_v1`，实测可见 | `adapted` | F318 carrier，接入家里现有的停止入口 | source-checked |
| C8 | 中断时一并取消排队（`cancel_queued`） | — | 只能直接走控制协议，文档写明 `interrupt()` 不会发送它（L4289）；init 声明 `interrupt_cancel_queued_v1` | `deferred` | F318 carrier | source-checked |
| C9 | 按 uuid 取消单条排队消息 | — | `cancel_async_message` 属于 **CLI 偶然**（L3605–3609，`Query` 没有对应方法） | `deferred` | F318 carrier | source-checked |
| C10 | 工具完成与后台任务帧 | item/completed | PostToolUse hook、`task_started` / `task_notification` 帧 | `adapted` | 原始帧解析归 F143 AgentService 和 F318 Claude source adapter；语义活动到气泡的投影归 F183 `bubble-pipeline`（F306 L182） | fixture-observed |
| C11 | 其他工具生命周期信号 | item/* | PreToolUse / PostToolUseFailure / PostToolBatch hook（hooks 页；L869，L2467）、`tool_progress` | `adapted` | 同 C10 | source-checked |
| C12 | 投递归属主信号（同一 turn result 的 uuid 列表） | turn 事件 | `user_message_uuid(s)`（assistant L3358–3364，result L5321–5325） | `adapted` | F254 消费归属结果；F318 carrier 产出回执 | fixture-observed |
| C13 | 用 `queued_turn_count` 当 notice 排队信号 | — | L5317；文档写明只统计 `origin:human`。实测：不带 origin 时恒为 0，带 human 时为 1 | `deferred`：notice 不是人类输入，不应标成 human | F254 | fixture-observed |
| C14 | 用 `command_lifecycle` 帧当投递信号 | — | **CLI 偶然**：init 声明了 `msg_lifecycle_v1`，但类型和文档里都没有 | `deferred` | F318 carrier | fixture-observed |
| C15 | session 运行状态帧 | — | **types-only**：`session_state_changed`（L5457） | `deferred` | F143 `identity-session` | source-checked |
| C16 | 运行时审批类请求（approval-shaped） | approval | `canUseTool`（L1469）、PermissionRequest hook、`setPermissionMode`（L2638）、`initializationResult()`（L2731，重连时可取回未决请求） | `adapted`（同 F306） | 上游/机器侧 reviewer 加 provider-neutral AgentService 交互端口；只有显式人工边界审批，才有条件地投影到 F246 `approval-index`（F306 L183） | source-checked |
| C17 | 非审批类的问人 / elicitation | requestUserInput / elicitation | `onElicitation`（L1631）；**types-only**：`onUserDialog`（L1645，需要声明可渲染的 dialog kinds） | `adapted`（同 F306） | provider-neutral AgentService/RunHandle 能力，加当前 thread 的 in-context surface；**不走 F246**（F306 L184） | source-checked |
| C18 | 当前 context 用量快照 | 原生事件 | `getContextUsage()`（L2792） | `adapted` | F024 Context 存活监控 / ContextHealthBar（`TokenUsage.contextWindowSize` / `lastTurnInputTokens` / `contextUsedTokens` 标注为 F24，见 `packages/api/src/domains/cats/services/types.ts`），数值口径由 F008 负责 | source-checked |
| C19 | 权威 compaction 边界 | 原生事件 | `compact_boundary`（L3470）、Pre/PostCompact hook | `adapted` | continuity/epoch 归 `identity-session`；重发与呈现归 F296（context presentation 边界） | source-checked |
| C20 | token / model usage / cost | 原生事件 | `usage`、`modelUsage`、`total_cost_usd`（文档称 "an estimate, not a billing statement"） | `adapted` | F008 负责 CLI usage/cost/cache 捕获；F153 负责 raw telemetry | source-checked |
| C21 | experimental usage 接口 | — | **types-only**：`usage_EXPERIMENTAL_MAY_CHANGE…`（L2812） | `deferred` | F008 / F153 | source-checked |
| C22 | subagent 与语义事件 | collab items | `agents: AgentDefinition`（L1456）、SubagentStart/Stop hook、`task_*` 系统帧 | `adapted` | 同 C10 | source-checked |
| C23 | structured output | outputSchema | `outputFormat: json_schema`（L1837） | `deferred`（同 F306：没有具名 consumer） | — | source-checked |
| C24 | 文件回滚 | — | `rewindFiles()`（L2877） | `deferred` | — | source-checked |
| C25 | 原生 review / diff 对象 | review | SDK 没有 | `unavailable_upstream` | — | not admitted |
| C26 | MCP 与工具发现 | config | `createSdkMcpServer`（L526）、`setMcpServers`（L2941）、`mcpServerStatus`（L2781）、`toggleMcpServer` / `reconnectMcpServer`（L2912/L2904）、`reloadSkills`（L2852）。没有和 Codex 做强弱对照 | `delegated`（同 F306 对 MCP source 的处理） | F146 能力市场 / F202 plugin / F286 MCP surface governance（同 F306 L186）；F318 只做 source 接入 | source-checked |
| C27 | 错误分类与 carrier 级恢复 | thread resume | `SDKAssistantMessageError`（L3422）、`worker_shutting_down`（L5942）、`stderr` 回调（L2143）；**types-only**：`api_retry`（L3325） | `adapted` | 错误分类、降级、重连归 F318 carrier 加 `carrier-health`（F198）；F212 只负责结构化 CLI 诊断；session 恢复见 C3 | source-checked |
| C28 | turn 终止原因 | turn 事件 | `terminal_reason`，fixture 中观察到 `completed` 和 `aborted_streaming` | `adapted` | F318 carrier，供 C5/C7 回执使用 | fixture-observed |

> 与 #1398 的对照：#1398 声明 `deliverySemantics:'exact_active_turn'`，但它的 Steer 是 `interrupt()` 后重发，属于"打断后重来"，和实测的 `priority:'now'` 同类。**Phase B 不采用这种做法。**

## What

方法复用 F306：**能力 census → 家内 canonical owner → disposition（F306 词表加 F318 扩展词 `unavailable_upstream`，见 census 说明）→ 按 maturity 逐项取得证据**。
F318 拥有新 carrier 本体与这张对齐表；每个能力的产品语义仍归各自 owner（见 Dependencies），F318 不私造第二套 Queue / 审批 / context 真相。

### Phase A: Census 冻结 + 关键能力实测（不动生产代码）

- 对照当日官方文档和安装包 types 补全上表。每格写明来源层级（文档 / types-only / CLI 偶然 / #1398 包装）和 disposition，maturity 单独成列。
- F254 exact-active-turn live fixture（见 AC-A2）与计费归属核查（OQ-1）。
- 输出 Phase B 的 Decision Packet，写明两点：一是 Risk 表停止条件是否触发，并附证据；二是 F254 那一格的 disposition 和投递判定方式。按 Phase A 实测，F254 那一格记为 `adapted`，每次投递按回执判定，静态声明在 Phase B Design Gate 之前保持 `undeclared`，见 AC-B2。换 carrier 是否仍值得，由 operator 决定。

### Phase B: 默认关闭的 SDK carrier 接入

- 从 #1398 只取 `ClaudeSdkAgentService.ts` / `claude-mcp-config.ts` 作为候选实现样本，在家里 main 上重新落地；A2A/ball-custody 改动不带入。
- 接入 `claude-carrier-factory`（新 env 值）与 `carrier-health` 降级链，失败可见地降级回现有 carrier。
- `freshnessCarrierCapability()` 只声明 Phase A 实测得到的语义；未证实前为 `undeclared`。

### Phase C: 逐项原生接入

- **准入行**：census 中 disposition 为 `native`、`adapted` 或 `delegated` 的所有行。
  - `native` / `adapted`：由 F318 carrier/adapter 接入，并在 owner 边界内验证。
  - `delegated`：由表中列出的 canonical owner 交付，F318 负责提供 source adapter，并完成端到端验收。
- **非准入行**：disposition 不属于上面三类的行，即 `deferred`、`unsupported_by_policy`、`experimental_opt_in`、`unavailable_upstream`。这些行保持原归宿、写明理由，不在 Phase C 实现。准入和非准入按 disposition 划分，两者互斥，合起来覆盖全表。
- 每行拿到对应 owner 的接入证据后，才在 maturity 列改为 landed；disposition 不因此改变。

### Phase D: Runtime 重启后验收

- 在 runtime 切到 SDK carrier（需 operator 授权）后，走真实 thread 验收Ragdoll的新消息感知、打断、审批、context 显示与重启恢复。

## User Journey

### Primary Journey: Ragdoll干活时也能及时听到新消息
- **Scope unit**: thread
- **Actor**: operator / 队友猫
- **Entry**: Ragdoll正在一个 thread 里跑长工具链（Bash / Read / Edit）
- **Flow**:
  1. operator或队友在同一 thread 发一条新消息
  2. Ragdoll在当前这一轮的下一个工具安全边界收到"有新消息"提醒，不被打断重来
  3. Ragdoll读取新消息，按需调整当前工作，回复里能体现已看到
- **Success evidence**: live fixture 记录（消息 uuid 出现在同一轮结果中、未新增 turn、模型下一步引用）+ runtime 验收 thread 截图
- **Non-goals**: 宿主内嵌登录；对外提供 Claude 订阅登录；为对称硬接 review/diff

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | operator | 点停止 → Ragdoll当前轮停下，排队消息按回执处理，不丢不重放 | interrupt 回执 + thread 记录 |
| S2a | thread | operator | Ragdoll遇到需要人工决定的审批 → routine 权限留在机器侧 reviewer，只有显式人工边界审批才进入 F246 → 批复后同一轮继续 | F246 审批卡（仅显式人工边界）+ 同轮续跑记录（census C16） |
| S2b | thread | operator | Ragdoll需要问人（非审批）或 MCP elicitation → 在当前 thread 的 in-context surface 提问，不进 F246 → 回答后同一轮继续 | 当前 thread 的提问卡 + 同轮续跑记录（census C17） |
| S3 | session | operator | runtime 重启 → Ragdoll恢复会话与未决请求 | 重启前后 session/请求记录 |

## Acceptance Criteria

### Phase A（Census 冻结 + 关键能力实测）
- [x] AC-A1: census 表每格注明来源层级（文档 / types-only / CLI 偶然 / #1398 包装）、disposition（F306 词表 + F318 扩展词 `unavailable_upstream`）、canonical owner 与 maturity，引用当日官方文档或 types 行号，非作者可复核（修订：review 后替换 2026-09-16 立项时的旧层级/状态词表） — 上方 census C1–C28；@codex-sol R4 APPROVED @ 11a6f23，PR #4568 合入 4d4c0f5
- [x] AC-A2: F254 live fixture：长工具链中途以 `priority:'now'` 注入内容无关 notice，记录 ⓐ 同一 result 的 `user_message_uuids` 是否包含它 ⓑ `queued_turn_count` 是否增加 ⓒ 模型下一步是否引用 ⓓ turn 结束竞争窗口下是否可识别为 queued；fixture 可重放 — PR #4568（4d4c0f5），@codex-sol 复核 27/27 raw→summary 重放通过：覆盖了 `now` / `next` / 不设 / `later` × 工具链中途 / 本轮末尾 × 是否带 `origin:human`，共 26 次运行，见 `docs/features/evidence/F318/phase-a/README.md`
- [x] AC-A3: 计费归属核查（OQ-1）有官方一手来源与日期，结论写入 Key Decisions — KD-4；@codex-sol source-audit 通过（计费 use/direct；订阅登录适用性 use-with-caveat，留 Phase D 出口）
- [x] AC-A4: Phase B Decision Packet 交 operator，含继续/停止判断 — 下方「Phase A 结论与 Phase B Decision Packet」，已随最终回报投递指挥 thread `[thread-id]#private-source-id` 交 operator；operator 表态待定

### Phase A 结论与 Phase B Decision Packet（2026-09-16）

**实测结论**（证据范围只有 claude-sonnet-5 加串行短 Bash；其他模型、长时间单工具、并行工具批次、Read/Edit/MCP 工具都没测，留到 Phase B/C 按 contract 验证）
1. **普通消息会在工具边界被接进正在跑的这一轮。** 不设 priority 或设 `'next'` 时，消息会在下一个工具轮次边界被接走：同一个 result 的 `user_message_uuids` 里有它，没有新增 turn，本轮最终回复也提到了它（fixture 9/9，按完整文本判定）。官方文档写的是 "picks up a regular message of yours between tool calls"，行为与之一致。它有望替代 F254 的 MCP 顺带机制（B1），但对非 Bash 工具的效果还没验证。
2. **`priority:'now'` 的效果是打断后重来，不是插话。** fixture 命中窗口的 6/6 次都返回 `aborted_streaming`，连正在输出的最终回复也会被打断。这个值不能用来发 notice。#1398 的 Steer 也是这种打断式语义。
3. **SDK 没有 Codex 那种 expectedTurn 防护，但落点是可判定的。** 本轮如果已经没有工具边界，消息会排到下一轮单独执行，fixture 中没有丢失，也没有重复。判断依据是前后两个 result 的 `user_message_uuids`（有文档）。`queued_turn_count` 只统计 `origin:human`，文档和实测一致。
4. **延迟大约是一个工具轮次。** 本 fixture 中从入队到被接走用了 5.3–7.5s。如果当前工具本身耗时很长，消息要等它结束才会被接走（这是推论，未实测）。
5. **新发现：模型可能不采纳 notice。** claude-sonnet-5 收到"队友说……"类消息时，并入本轮会提到它；单独成轮时大多明确表示不采信。notice 的措辞和 `origin` 标注，要等 F254 在 Phase C 实测后再定。不要为了让 `queued_turn_count` 计数，就把非人类消息标成 `origin:human`，投递归属用 uuid 列表判断即可。

**停止条件：已触发**
Risk 表原文："`priority:'now'` 实测不进当前 turn → F254 那一格记 `queued_internal_turn`；若剩余收益不值得换 carrier，Phase A 结束即停止本 feature，由 operator 决定。" 实测结果正是如此（`now` 会打断当前轮），**这个条件已经触发**。
Phase A 同时得到一个原 gate 没有预料到的新证据：默认 priority 也能在工具边界被接进当前轮，而且有文档支持。这只是**请 operator 考虑修订 gate 的依据**，不等于原条件没有触发。**operator 表态之前，Phase B 不开工。**

**Decision Packet（请 operator 做价值取舍）**
- **问题：** 停止条件已经触发。是接受"改用默认 priority 做工具边界投递"这一机制变更，继续做 Phase B（默认关闭的 SDK carrier），还是按原 gate 在 Phase A 停止？
- **作者建议：接受机制变更，继续推进。** F254 那一格的 disposition 记为 `adapted`，每次投递按回执判定（见 AC-B2），不声明静态的复合能力。
- **收益：**
  - Ragdoll有机会在一个工具轮次内听到新消息，不用杀进程（非 Bash 工具待验证）；
  - interrupt 自带排队回执；
  - session、context、MCP 的管理可以交给 SDK 原生能力（见 census 的 adapted/delegated 行）。
- **代价与风险：**
  - **计费：** SDK 和现有 `print_sdk`（`claude -p`）一样扣订阅额度，不新增成本类别（KD-4，官方 help 页）。政策可能再变，Phase D 前要复核。
  - **订阅登录的适用性（外部条款，不由家里裁决）：**
    - legal 页写明，OAuth 登录 "designed to support ordinary use of Claude Code and other native Anthropic applications"。
    - legal 页也写明，开发者产品应使用 API key，不得代用户转发订阅凭据；同一页允许终端用户用自己的订阅登录未修改的 Claude Code 二进制。
    - overview 页写明，未经批准不得向第三方提供 claude.ai 登录。
    - 咱们是单人自托管场景，现在的 `print_sdk` 也处在同样的位置。审查结论是 use-with-caveat，适配度只算 partial。**这不是 operator 能拍板"合规"的事实问题。**
  - **Phase D 切换前必须满足以下出口之一：**
    - (a) 取得 Anthropic 的明确答复；
    - (b) 改走 API-key 路径；
    - (c) operator 明确表示：只按"个人自用"这一解释接受残余风险，并记录在案。
  - **可逆性：** Phase B 默认关闭，靠 env 切换，失败时降级回现有 carrier。
- **需要 operator 表态的事项：**
  - ① 是否接受"停止条件已触发，但改用默认 priority 投递"这一 gate 修订，并授权 Phase B 开工（默认关闭，不切换 runtime）；
  - ② Phase D 之前采用上面哪个条款出口（可以等到 Phase D 前再定）。

### Phase B（默认关闭的 SDK carrier 接入）
- [x] AC-B1: SDK carrier 可经 `CAT_CAFE_CLAUDE_CARRIER=agent_sdk` 选用，默认不变；失败产生可见诊断。SDK 已接受执行后不得自动降级重放（2026-09-30 当前接续范围替代旧 fallback 条件）
- [x] AC-B2: `freshnessCarrierCapability()` 的**声明**与**单次投递回执**一致，并有测试守护：
  - **声明：** `deliverySemantics` 是单值字段，admission 只把 `exact_active_turn` 当作支持本轮投递（`message-disposition-admission.ts`、`queue.ts`）。所以只能声明一个值，禁止声明 `exact_active_turn` + `queued_internal_turn` 这种复合能力。声明哪个值，在 Phase B Design Gate 决定，2026-09-30 接续采用保守声明 `queued_internal_turn`；本轮原生指导由实际 UUID 回执证明。
  - **回执：** 每条 notice 只有在**同一 turn 的 result** 的 `user_message_uuids` 里出现它的 uuid 时，才记为本轮已送达。如果旧 turn 先结束、notice 另起一轮执行，就记为 missed，并记录 queued 回退。禁止依据 `priority`、入队成功或 `queued_turn_count` 就预先记为 delivered。
  - **禁止值：** notice 投递禁止使用 `priority:'now'`。
  - **测试：** 用 fixture 或录制帧覆盖三种情况：并入、末尾 missed、`now` 打断。声明、回执与帧不符时测试变红。
- [x] AC-B3: 不引入 #1398 的 A2A/ball-custody 改动（`gh pr view --json files` 与本 feature PR diff 对照可证）

### Phase C（逐项原生接入）
- [ ] AC-C1: census 中每个准入行（disposition ∈ {`native`, `adapted`, `delegated`}）都有列出的 canonical owner 的接入证据，且 maturity 更新为 landed；每个非准入行（disposition ∈ {`deferred`, `unsupported_by_policy`, `experimental_opt_in`, `unavailable_upstream`}）都有显式归宿与理由。行按 claim 原子化（一行一个 disposition、一组 owner 边界、一个 maturity），不得出现一行里混有多个 disposition 的情况
- [x] AC-C2: Primary Journey 在 feature worktree 上以 live 会话跑通

### Phase D（Runtime 重启后验收）
- [ ] AC-D1: runtime 切换后 Primary Journey 与 S1、S2a、S2b、S3 在真实 thread 通过，由非作者守护猫独立验收

## Dependencies

- **Evolved from**: F198（Claude Code Subscription Carrier，carrier 分层与降级链）、F230（Interactive PTY Carrier）
- **Blocked by**: 无（Phase B 起的 runtime 切换需 operator 授权）
- **Related**: F143（`identity-session` carrier/session 归属）、F254（freshness 最后一米）、F296（context 呈现边界）、F246（显式人工边界的审批投影）、F183（语义活动 → 气泡投影）、F306（Codex 对齐方法与对照基准）、F039/F117（普通排队消息与状态迁移）、F008/F153（token/usage/cost observability）、F212（结构化 CLI 诊断）、F291（account/session 设置 owner）、F286（MCP surface governance）、F024（context 存活监控 / ContextHealthBar）、F146/F202（能力市场 / plugin）

Architecture cell: `identity-session`
Map delta: none
Why: 新增 Claude source adapter，沿用现有 carrier/session 边界；MCP 解析提取为 print/SDK 共用 helper，freshness、context、审批、语义事件的 canonical owner 不变。
Canonical source: `FreshnessNoticeBroker.ts#FreshnessNoticeBroker` / `claude-mcp-config.ts#resolveClaudeMcpConfig` / `ClaudeAgentService.ts#buildClaudeEnvOverrides`。
Consumer evidence: `rg -n 'activeInvocationFreshness|resolveClaudeMcpConfig|buildClaudeEnvOverrides' packages/api/src/domains/cats/services/agents`；SDK 新 consumer 和旧 print consumer 共用同一 MCP/env owner。
Claim guard: 原生送达非入队成功 → `test/f318-claude-sdk.test.ts` 的 UUID/轮尾/异常测试；MCP 提取保行为 → `test/claude-agent-service.test.js`；F296 exact managed settings → launch regression + `test/f296-claude-compaction-launch-plan.test.js`。
Characterization/contract test: `claude-agent-service`、`claude-ndjson-parser`、`claude-carrier-factory` 与 `f254-provider-native-freshness` 回归。
Migration/restart/rollback evidence: 无存量数据迁移；默认关闭。移除显式 env 后下一 invocation 恢复原 carrier，未启动正式 runtime。

## Risk

| 风险 | 缓解 |
|------|------|
| Agent SDK 用量计费归属与现有 carrier 不同，切换带来显著成本 | OQ-1 先核官方政策；runtime 切换由 operator 授权；默认关闭 |
| `priority:'now'` 实测不进当前 turn | F254 那一格记 `queued_internal_turn`；若剩余收益（session/权限/context 原生化）不值得换 carrier，Phase A 结束即停止本 feature，由 operator 决定。**Phase A 实测：已触发**（`now` 会打断当前轮）。新证据是默认 priority 能在工具边界并入；是否据此修订 gate，由 operator 决定，见 Decision Packet。历史暂停已由 2026-09-30 的 operator 功能目标接续；见当前接续范围 |
| notice 被模型视为不可信而不采纳（Phase A 新发现） | 由 F254 owner 在 Phase C 实测 notice 的措辞和 `origin` 标注；不为了让 `queued_turn_count` 计数把非人类消息标成 `origin:human` |
| 依赖 CLI 偶然能力（`command_lifecycle`、`cancel_async_message`） | 只作辅助观测，主信号用有文档的 `user_message_uuids`；按 init `capabilities` 做特性检测 |
| 依赖未文档化或 experimental 接口 | 只接公开接口；CLI 偶然能力与 experimental 标 deferred，按 init `capabilities` 做特性检测 |
| 从 #1398 带入夸大的能力声明 | AC-B2 测试守住声明与实测一致 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立立项，本 thread 为指挥与理论主 thread，各 Phase 另开执行 thread，runtime 重启后另开验收 thread | operator 明确 thread 划分（`#private-source-id`） | 2026-09-16 |
| KD-2 | 以 Codex app-server 能力清单为对齐基准，对不齐的如实标注，不为对称硬造 | operator 要求对齐（`#private-source-id`）；F306 方法 | 2026-09-16 |
| KD-3 | #1398 仅作候选实现样本，A2A 重构不进本 feature | #1398 仍为 Draft 且能力声明未经实测 | 2026-09-16 |
| KD-4 | 计费：订阅登录下，Agent SDK 用量目前与 `claude -p` 一样从订阅额度扣，换 carrier 不新增成本类别；政策可能再变，Phase D 切换前需复核 | 官方 support 文章 `https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan`（横幅写 "Update June 15"；抓取工具报告页面日期为 June 16, 2026，原始 HTML 里没找到日期，精确日期未核实；2026-09-16 取）原文："We're pausing the changes to Claude Agent SDK usage described below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." 条款见 `https://code.claude.com/docs/en/legal-and-compliance.md`（2026-09-16 取，页面无日期） | 2026-09-16 |
| KD-5 | **技术约束（已定）**：notice 投递禁止使用 `priority:'now'`；投递归属以同一 turn result 的 `user_message_uuids` 为主信号，逐次记为 delivered 或 missed。**机制变更（待 operator）**：改用默认 priority 做工具边界投递，并据此修订 Phase A 停止 gate | Phase A fixture（claude-sonnet-5 + 串行 Bash）：并入 9/9，`now` 打断 6/6，本轮末尾到达的消息落到下一轮；证据见 `docs/features/evidence/F318/phase-a/` | 2026-09-16 |

## Review Gate

- Phase A：census 与 fixture 由非作者猫复核（优先跨 family，建议 @codex-sol 对照 F306 基准）
- Phase B/C：代码 PR 走 merge-gate，跨个体 review

## 需求点 Checklist

| # | 需求点（operator 原话 / 来源） | 对应 AC | 状态 |
|---|------|------|------|
| R1 | 对齐 Codex app-server 能力（`#…156-d78e83be`） | AC-A1, AC-C1 | ⬜ |
| R2 | Ragdoll获得 provider-native freshness（源 thread 调查请求） | AC-A2, AC-B2, AC-C2 | ⬜ |
| R3 | 本 thread 指挥、Phase 分 thread 执行、重启后验收（`#…159-5d8b10ea`） | AC-D1 | ⬜ |

## Tips Contribution（F244）

tips_exempt: Phase A/B 为默认关闭的内部 carrier，无用户操作变化；Phase D 切换 runtime 时再补 tips。
