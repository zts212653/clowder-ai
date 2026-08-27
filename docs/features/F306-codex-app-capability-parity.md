---
feature_ids: [F306]
related_features: [F143, F146, F173, F183, F197, F223, F246, F254, F281, F284, F286, F291, F296, F299]
topics: [codex, app-server, capability-parity, runtime, approvals, workspace, marketplace, semantic-events, bubble-pipeline]
doc_kind: spec
created: 2026-08-25
description: "让 Clowder AI 持续消费 Codex App 的高价值原生能力，同时把状态、权限与用户入口收敛到家里已有的跨 provider 产品边界。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-26T07:06:00-07:00
cvo_signoff: "2026-08-25 — sourceMessageId 0001787714882198-000142-8a5d102a：把‘Clowder AI 的 Codex 体验持续对齐 Codex App’确立为正式产品承诺；立一个很薄的 Codex App Capability Parity Feature，并统一复用 Codex App 与 Clowder AI 已有概念。"
tips_exempt: "Phase A lands protocol and census seams only; Goal, Review, and approval tips must wait for the first real Phase B/C user surface, as required by this feature's Tips Contribution."
---

# F306: Codex App Capability Parity — 原生能力对齐，不复制第二套产品

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cells: `identity-session`, `bubble-pipeline`, `approval-index`, `hub-action-surface`, `plugin`, `mcp-surface-governance`

Map delta: `update required` — 本轮同步扩展 `bubble-pipeline` cell，明确 provider adapter、semantic event、单一 projector 与 raw-payload fail-closed 边界。

Why: F306 是跨 owner 的对齐承诺、能力分级和端到端验收 Feature；provider/session、审批、Workspace、能力市场与 MCP 的 canonical truth 继续由现有 Feature 和 ownership cells 持有，不建立 Codex 专属 control plane、第二套 store 或第三份 capability manifest。

## Why

Clowder AI 已经用 Codex app-server 跑通真实对话、continuity、freshness、取消与部分结构化事件，但operator在 Codex App 里能直接使用的 Goal、Review、审批路由、permission profile、结构化 plan/diff、能力发现等原生能力，进入家里后仍大量消失。结果不是“猫不会做”，而是operator失去了确定、可见、可恢复的控制：例如 app-server 向 Host 请求确认时，家里没有交互面，只能自动拒绝，再用 developer instructions 解释为什么上游的 `user rejected MCP tool call` 并不代表人真的拒绝。

本 Feature 的价值目标是：**Clowder AI 中的 Codex 体验持续跟上 Codex App 的高价值原生能力；对齐发生在用户旅程和语义上，不靠逐个 endpoint 追数，也不在家里复制一套 Codex-only 产品架构。** headless 是承载模式，不是能力降级理由；能力是否可用由实测协议、权限和产品入口共同决定。

operator experience：

> “咱不要制造出太多分叉的概念，能对齐到 Codex App 和猫咖的就复用对齐。”
>
> “希望能够把能力尽量对齐 Codex App。”
>
> “把‘Clowder AI 的 Codex 体验持续对齐 Codex App’确立为正式产品承诺，而不是以后零散补 endpoint。”
>
> “把其他的 Provider 的一些概念一起统一收掉，家里的抽象做好。”
>
> “现在老是泄露的一些蓝色气泡，原始 JSON 糊到用户脸上……”

## Current State / 现状基线

### 可复现协议基线

- 2026-08-25 在 `codex-cli 0.149.1` 上实跑 `codex app-server generate-json-schema -o <dir>`：stable 为 **95 client requests / 75 server notifications / 10 server requests**。
- 同版本加 `--experimental`：**150 / 75 / 11**。experimental 数量不是产品承诺，只有具名用户旅程、成熟度证据和显式 opt-in 才能进入实现范围。

### 家里已经接上的真实能力

- 当前发出的 app-server requests 只有 7 种：`initialize`、`thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/steer`、`turn/interrupt`。
- `thread/start|resume` 已传 `model`、`cwd`、`sandbox`、`approvalPolicy`、`developerInstructions`、`config`、`serviceTier`；reasoning effort 通过 app-server 进程 config 生效。`approvalPolicy` 不是未接能力。
- app-server thread id 是 provider session binding；Clowder AI `ThreadStore`、message/custody/continuity truth 没有被替换。F296 已消费 provider-native compaction observation，F254 已消费安全边界/freshness。
- `CodexAppServerEventMapper` 已识别 item/turn 生命周期、`turn/plan/updated`、错误与 token usage；但跨 provider 的 `AgentMessageType` 仍主要收敛为 `system_info`，plan/diff/review/guardian 等高价值结构没有完整产品语义。
- 现有 `CODEX_THREAD_ITEM_CENSUS` + build checker 会对 18 种 ThreadItem 漂移变红；它是扩展协议 drift guard 的正确落点，不另建 runtime manifest。

### Phase A checkpoint（2026-08-25）

- PR [#3984](https://github.com/zts212653/clowder-ai/pull/3984) 已以 `b791268d3cafd0a9dcaac6bea36eb69b8b8db7ca` 合入 main；非作者 Opus 5 对 exact HEAD `5eccf28dab9463b4f89d5b18a1a50fb523f47add` 完成三向 mutation review 并放行。
- Command Thread 在 landed main 上重新安装 lockfile 依赖后复跑 API build：installed `codex-cli 0.149.1` 为 stable `95/75/10`、experimental `150/75/11`、delta `55/0/1`、ThreadItem `18`；目标测试 **53/53 PASS**。
- 协议 census、完整 stable-method disposition matrix、typed rejection 与 single-writer guard 已 landed；`approvalsReviewer` 只在 `thread/start|resume` 写入，`outputSchema` 只在 `turn/start` 写入，`personality` 不透传。
- **Checkpoint 仍为 partial**：AC-A2 尚无 GitHub CI 强制 installed-Codex census，Codex 缺席时 pinned method fallback 不是独立真相源；AC-A3 只有 typed adapter seam，没有 production journey writer。Phase B 未启动。
- `main=landed`，`live=dormant`：本次涉及 API 加载面，但未获得 runtime restart/activation 授权，也未尝试激活。

### 跨 provider semantic event 基线（2026-08-26）

- Codex、Claude、Gemini 与 ACP 各自有 provider-specific raw parser，这是协议边界，不等于前端各自拥有一套 renderer。它们已经汇入共享 `AgentMessage` / `AgentService` port，再由共享 Web socket、`useAgentMessages`、BubbleEvent/reducer 与 `ChatMessage` 渲染；仓内没有独立 TUI renderer。
- 当前归一化仍偏粗：多个 provider 的 structured activity 被塞进 `system_info` JSON，由 `useAgentMessages` 中 active/background 等镜像分支再次判断。历史上 `thinking`、`context_presentation_receipt`、`context_continuity`、Kimi `provider_capability` 等内部 payload 都曾因此成为蓝色 raw-JSON 气泡。
- PR [#3809](https://github.com/zts212653/clowder-ai/pull/3809) 已落地 structured protocol fail-closed 与 foreground/background 对称 guard；这守住“不把未知内部 JSON 当消息”的底线，但尚未把高价值语义事件与所有消费路径收成单一 registry/projector。

### 关键缺口

- `turn/start` schema 已提供 `model`、`effort`、`personality`、`approvalsReviewer`、`sandboxPolicy`、`serviceTier`、`outputSchema` 等 override。Phase A 已建立窄 typed seam：sticky controls 由 thread boundary 单写，`outputSchema` 由 turn boundary 单写；但 `approvalsReviewer` / `outputSchema` 仍无 production journey writer，`personality` 明确不传。
- `approvalsReviewer` 原生支持 `user` / `auto_review` / legacy `guardian_subagent`，并配有 `permissionProfile/list`、guardian review notifications 与 `thread/approveGuardianDeniedAction`；家里还没有面向用户的路由和状态投影。
- 对 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、legacy approval request，Host 当前统一 decline/deny；MCP approval compatibility request 返回特殊 decline token；其他未知 server request 返回 `-32601`。`RuntimeCapabilityDescriptor.canAskHumanSync` 已表达能力维度，但没有真实问人通道。
- `codex-app-approval-routing.ts` 把 `approvalSurface: 'unavailable'` 写进 prompt 代偿控制层缺口。这是当前最硬的 P0 切片：在交互面可用前不能删；交互面完成后也不能继续让文本层冒充权限真相。
- Goal、Review、thread fork/list/compact、model/provider capabilities、account/rate limits、skills/apps/plugins/marketplace/MCP 等均由 stable schema 暴露，但“上游存在”不自动等于“家里应该全接”。

## Product Contract / 统一边界

### 一个薄 Feature，多个既有 owner

| 能力问题 | canonical owner / 复用落点 | F306 的职责 |
|---|---|---|
| provider transport、thread/session binding、跨 provider service port | F143 + `identity-session` | 维护 parity contract；不新建 Codex control plane |
| provider raw event → semantic activity → bubble projection | F143 AgentService + F183 `bubble-pipeline` | 交付 Codex source adapter 与跨 provider acceptance；不把 app-server notification 或 Codex wire type 立成全局 UI contract |
| 运行时 approval-shaped request | F246 `approval-index` + provider-neutral AgentService 交互扩展 | 交付 Codex adapter 与端到端旅程；不新建第二个 Approval store |
| 非审批型 ask-human / elicitation | provider-neutral AgentService/RunHandle 能力 + 当前 thread 的 in-context surface | 补真实通道并以 `canAskHumanSync` 实测投影；不命名 Codex-only Broker |
| Goal / Review / plan / diff / warning / guardian 状态呈现 | F223/F284 `hub-action-surface` | 定义 source adapter 与用户旅程；Workspace shell 不归 F306 |
| skills/apps/plugins/marketplace/MCP | F146 能力市场 + `plugin` + F286 `mcp-surface-governance` | 把 Codex 作为一个 provider source 接入；不造第二个市场 |
| permission profile / model / effort / service tier / account status | 既有 Cat Settings、capability descriptor、F291 speed/session owner | 对齐上游字段与可用性；不复制一份 Settings truth |
| freshness / continuity / trajectory | F254 / F296 / F299 | 只做 regression 与联调，不接管 owner |

### Parity disposition 不是第三份 manifest

F306 维护一份**可生成、可审计的交付矩阵**，每项只能处于以下一种 disposition：

- `native`：语义与上游一致，Clowder AI 直接消费；
- `adapted`：上游能力映射到家里已有跨 provider contract/surface；
- `delegated`：由 F146/F246/F284 等 canonical owner 交付，F306 做端到端 acceptance；
- `deferred`：有价值但尚无具名旅程或成熟度不足；
- `unsupported_by_policy`：与家里权限、安全、SSOT 或产品边界冲突；
- `experimental_opt_in`：只在显式实验环境开放，不进入默认 parity 承诺。

这份矩阵只引用 app-server schema/negotiation 与 Clowder AI canonical capability truth，不参与 runtime 配置，不成为第三个 capability registry。

### 明确不造什么

- 不以“95 个 request 接了多少”当完成率；用户旅程与 canonical 语义优先于 endpoint 数。
- 不新建 `Codex Native Control Plane`、`Runtime Interaction Broker` 或 Codex 专属事件总线。
- 不把 Codex app-server notification 直接宣布为全家标准；标准是家里按用户 claim 定义的 provider-neutral semantic event。
- 不用 LLM/skill 在运行时猜 JSON 应该渲染成什么，也不让未知 structured payload 回退为蓝色原始 JSON 气泡。
- 不复制 ThreadStore、Approval Hub、Workspace、Plugin/Marketplace、MCP registry、Settings 或 account truth。
- 不用上游 `review/start` 代替 Clowder AI 的独立 merge-gate reviewer；native review 是产品能力，不是跨个体审查凭证。
- 不让上游 `personality` 覆盖 Clowder AI L0 identity/persona；若开放，只能在身份硬边界内作为兼容字段。
- 不默认接 raw filesystem/process/project/realtime/remote-control 等宿主级能力；它们需要单独用户旅程、安全边界与授权。
- 不因 headless 而自动降权，也不因 app-server 能力存在而扩大授权。

## Delivery / Thread Orchestration Contract

operator sources：`0001787715648448-000187-88875ef3`、`0001787716300810-000201-4d23c6c9`、`0001787716631943-000214-27675686`。F306 采用“一个指挥塔、多个 execution thread”的明确拓扑。

**Command Thread truth**：当前 thread `[thread-id]`（`F306 app server 全量对接`）就是唯一 F306 指挥塔；本 invocation 的 `@codex-sol` 是指挥与最终 Vision Guard，不在这里编写实现。execution thread 可以由另一平行 invocation 的 `@codex-sol` 担任 code author；两者同 cat identity，但不共享上下文、球权或责任记录，必须通过 final-only 回报交接 landed truth。

- **F306 Command Thread** 是唯一指挥 thread 与最终 Vision Guard。它持有产品承诺、spec、parity matrix、scope、跨 owner 依赖、Phase 启停 checkpoint、execution 回报验收和最终 Alpha acceptance。
- **Command Thread 不做实现**：不在其中创建 implementation worktree，不直接修改生产代码，也不把 design/research/implementation/review 混成一条长执行链。
- **Sol author、异猫 review**：coding 默认交给独立 execution thread 的平行 `@codex-sol`；它按实际 diff 的五轴风险从 Opus 5、Terra、Kimi 中选择一位非作者 reviewer。同一个体不得 self-review，Command Thread 的 Sol 也不能把 Vision Guard 冒充成独立代码 review。
- **一个 execution thread = 一个独立可交付切片**。每个切片写清 scope、文件/模块、交付物、验收条件与 reviewer；共享文件或依赖链不能强行并行。
- execution thread 默认 `reportingMode=final-only`：自主完成实现、targeted tests、非作者 review、merge；闭环前不向 Command Thread 发送过程噪音，合入后只回一次带 commit/PR/test/review evidence 的最终总结。
- Command Thread 消费 final-only 回报后，核对结果是否仍满足“对齐 Codex App、复用 Clowder AI 既有概念、不扩大授权”，再决定下一 Phase；**上一 checkpoint 未关闭，不自动启动下一 Phase**。
- 最终完成不由任一 execution thread 自报。只有 Command Thread 汇总所有 Phase 的 landed truth、真实 app-server Alpha evidence 与残余 unsupported/deferred disposition 后，才执行 F306 Vision Guard。

这套拓扑是交付编排，不新增产品 runtime、workflow store、role taxonomy 或架构 stage。

## What

### Phase A: 协议基线与零新 RPC 参数对齐

- 把 stable/experimental schema census、CLI version、成熟度与 disposition 生成流程固定为可重跑证据；扩展现有 app-server protocol census checker，而非新建 manifest。
- 先处理已调用 `turn/start` / `thread/start|resume` 上的参数 parity：区分 thread-sticky、turn override、Cat identity 保留和 provider rejection fallback。
- 让 `approvalsReviewer`、`outputSchema` 及真正有现成 consumer 的 per-turn controls 进入 typed request；`model`、`effort`、`sandbox`、`approvalPolicy`、`serviceTier` 的既有路径不得回归或出现双 writer。
- 未被 Clowder AI 用户旅程消费的字段只进入 matrix，不为了“齐全”透传。

### Phase B: Provider-neutral Runtime Interaction

- 在既有 AgentService/RunHandle 边界补一个窄、provider-neutral 的 server-request ↔ human-response contract；approval、elicitation、request-user-input 等保持各自 allowed decisions、schema、thread/turn/item/request correlation，不压成一个布尔按钮。
- approval-shaped request 通过 F246 的 producer/adapter 边界投影到现有 Approval Hub 与当前 thread；非 approval ask-human 留在当前 thread 的 in-context interaction surface，并可由现有 Workspace attention pattern 召回，不能把 F246 泛化成所有提问的 store。
- `user` / `auto_review` / `guardian_subagent` 路由与 guardian denied override 由上游原生语义驱动；Clowder AI 只增加授权、来源、状态和响应 surface，不重新定义一套 reviewer taxonomy。
- pending 用户状态默认持久化；若 app-server process/restart 已使原 request 不可回答，记录必须终态化为 stale/invalidated，按钮失效，禁止 ghost approval 或盲重放。
- 交互面未 live 前继续 fail-closed；live 后删除 `approvalSurface: unavailable` 的文字代偿，并用真实 surface capability 区分 `user_rejected` 与 `confirmation_unavailable`。
- 若 rejection/cancel surface 收集结构化 why，必须复用 F281 的 exact-subject feedback contract；F306 不自建 feedback store，不把一次拒绝泛化为猫或能力评价。

### Phase C: Goal、Review 与结构化运行体验

- Goal：接入 `thread/goal/set|get|clear` 与 updated/cleared events，在 Clowder AI thread 内提供非 slash-only 的可见入口、当前状态与恢复语义。
- Review：接入 `review/start`、review mode/items/results 的结构化呈现；UI 明示“Codex native review”，不得冒充 merge-gate 独立 reviewer。
- Structured activity：把 plan、diff、reasoning summary、warning/deprecation、guardian/auto-review、model reroute/safety 等事件按 claim 扩展现有 provider-neutral semantic-event contract；provider-specific wire event 在 adapter 边界内结束，不再把所有高价值状态降级成不可区分的 `system_info(task_progress)`。
- Projection：active/background/hydration/callback/replay 只消费一个 semantic event registry/projector；未知 structured payload、字段不合法或 projector throw 一律 fail-closed 并保留诊断，不得回退为 raw JSON 气泡。明确的人类可读 system notice 继续可见。
- Controls/status：在现有 Settings/Thread/Workspace 中呈现 model/provider capability、permission profile、account/rate-limit 等确有用户决策价值的状态；每项都必须有 owner、freshness 和 unavailable 语义。
- Thread lifecycle：fork/list/compact 等只通过 Clowder AI thread/session binding 适配；provider thread id 永远不替代家里的 ThreadStore 与 message truth。

### Phase D: 能力生态与持续 parity

- 把 Codex `skills/list`、apps、plugins、marketplace、MCP status/OAuth/resource/tool 等作为 F146/F202/F286 的 provider source 接入；安装、授权、secret、resource lifecycle 仍走家里的单一产品入口。
- 每次 Codex CLI 升级先生成 schema delta，按 disposition 识别新增、删除、deprecated 与实验能力；未知 variant 在 CI fail-loud，产品不自动启用。
- 在 Alpha 以真实 app-server 完成 Goal、Review、human interaction、structured event、capability-source 五类旅程；不以 mock 通过替代 live provider acceptance。
- 只有“某个可选能力值不值得保留/调参/下线”且有明确 consumer 时才另走 eval-design；协议、权限、路由、状态机与 parity drift 都是确定契约，用 test/lint/guard 验证。

## User Journey

### Primary Journey: 在 Clowder AI 使用 Codex App 的原生控制力

- **Scope unit**: thread
- **Actor**: operator
- **Entry**: 一个绑定 Codex provider 的 Clowder AI thread
- **Flow**:
  1. operator从 Clowder AI 既有 Thread/Workspace/Settings 入口看到当前 Goal、模型/effort/permission 路由与可用能力；不用切回交互式 CLI，也不要求记 slash command。
  2. operator设置 Goal 或发起 Codex native Review；状态与结果留在同一个 Clowder AI thread/object 上，重开页面仍可理解。
  3. 运行中出现 approval 或 question 时，当前 thread 立即展示 exact request、来源、所需权限、allowed decisions 与失效条件；全局 attention surface 只做同一 canonical request 的投影。
  4. operator回答后，同一 app-server turn 继续；若 process/restart 已使请求失效，系统诚实显示 stale/invalidated，不伪装为人拒绝，也不盲重放副作用。
  5. plan、diff、guardian/review、warning、model reroute 等结构化状态先成为家里的统一语义事件，再进入既有 Workspace；provider wire type 不泄漏到 UI，也不被压成一段不可追踪文本。
  6. 查看/安装 Codex skill/app/plugin/MCP 时，进入家里统一能力市场和授权边界；不会遇到第二套 Codex-only 设置页。
- **Success evidence**: Alpha 真实 app-server 录屏/截图 + exact thread/turn/request correlation + restart rehearsal + generated schema/CI receipts
- **Non-goals**: 不镜像 Codex App 全部 UI；不开放无具名旅程的 host filesystem/process/project/remote-control；不让 native review 通过 merge gate。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | invocation | headless/background cat | provider capability 与授权不因 `-p` 降权；同步人类不可达时保持 typed unavailable/fail-closed | carrier fixtures + Alpha headless run |
| S2 | runtime request | operator | Approval Hub 与原 thread 指向同一 request，settle/restart 后无 ghost action | persistence + restart + UI tests |
| S3 | capability | operator | Codex source 出现在 F146 统一市场，安装/授权/禁用仍由家里 canonical lifecycle 决定 | provider-source contract + Settings/Workspace screenshot |
| S4 | message stream | operator | provider 发出未知或仅供内部消费的 structured event 时，live/F5/background/replay 都不出现蓝色 raw JSON；只有注册过的人类可读 projector 产生可见输出 | 历史 leaked-payload fixtures + path-symmetry guard + Alpha live/F5 capture |

## Acceptance Criteria

### Phase A（协议基线与参数 parity）

- [x] AC-A1: 一条可重跑命令记录 installed Codex CLI version、stable/experimental request/notification/server-request counts 与 method delta；`0.149.1` baseline 可由非作者复现为 `95/75/10` 和 `150/75/11`。证据：PR #3984、Opus 5 独立 schema 复跑、Command Thread landed-main build。
- [ ] **AC-A2 partial**: 扩展现有 `check-codex-app-server-protocol-census` / `CODEX_THREAD_ITEM_CENSUS` 路径，使 stable method 或 ThreadItem 新增/删除/rename 会在 build/CI fail-loud；不存在第二份 runtime capability manifest。installed build 的 exact-set guard 已闭合；Codex 缺席时 method fallback 仍非独立源，GitHub CI 也未强制 `CAT_CAFE_REQUIRE_INSTALLED_CODEX_CENSUS=1`。
- [ ] **AC-A3 partial**: typed request fixtures 证明现有 model/effort/sandbox/approvalPolicy/serviceTier 单一 writer 不回归，并按旅程接上 `approvalsReviewer`、`outputSchema` 与选中的 per-turn fields；upstream rejection 被诚实呈现而非静默吞掉。single-writer、typed seam 与 honest rejection 已闭合；production journey writer 尚不存在。
- [x] AC-A4: parity matrix 每个 stable client/server method 都有唯一 disposition、owner、maturity 与验证 ref；endpoint 数不作为完成百分比。证据：PR #3984 的现有 census fixture + fail-loud matrix validator。
- [x] AC-A5: F306 Command Thread 只持有指挥与 Vision Guard；Phase A 的每个实现切片均在独立 execution thread + worktree 中完成，并以 `final-only` 携 exact commit/PR/test/review evidence 回报。fixture/人工核验能证明 Command Thread 未直接承载生产代码实现，且未过 checkpoint 不会启动下一 Phase。证据：execution thread `[thread-id]`、final receipt `0001787718918542-000289-00a871e8`。

### Phase B（Provider-neutral Runtime Interaction）

- [ ] AC-B1: 至少 Codex approval、request-user-input 与 elicitation 三类 fixtures 通过同一个 provider-neutral interaction port，保留原始 allowed decisions 与 exact thread/turn/item/request identity；非 Codex provider 可实现同一 port，无 Codex-only product store/type hierarchy。
- [ ] AC-B2: approval-shaped request 只由 F246 adapter 投影，原 thread 与 Approval Hub 精确指向同一 canonical request；非 approval question 不被伪装成 ApprovalItem。
- [ ] AC-B3: `user`、`auto_review`、`guardian_subagent` 与 guardian override 至少各有一条 contract fixture；Clowder AI surface 不重新解释 upstream decision，也不把 native review 当 merge-gate reviewer。
- [ ] AC-B4: real-provider Alpha 证明回答可恢复同一 turn；restart/transport loss 证明 pending request 终态化为 stale/invalidated、按钮不可点击、无副作用重放。user rejection 与 confirmation unavailable 有不同 reason code 和可见文案。
- [ ] AC-B5: 真实交互面 live 后，`approvalSurface: unavailable` prompt compensation 被删除或只在 capability 实测 unavailable 时生成；test 证明文本提示不能覆盖 runtime truth。
- [ ] AC-B6: 若 surface 收集 rejection/cancel why，F281 exact-subject contract、TTL=0 episode truth、consumer 与 invalidation evidence 齐全；否则 UI 不伪装成已采集反馈。

### Phase C（Goal、Review 与结构化体验）

- [ ] AC-C1: Goal set/get/clear 与 updated/cleared event 在 Clowder AI thread 中形成持久、可刷新、可恢复的单一旅程；CLI slash 不是唯一入口。
- [ ] AC-C2: native `review/start` 的开始、进行、结果与失败在 Workspace 可追踪，并有 copy/guard 明确它不满足跨个体 merge gate。
- [ ] AC-C3: plan、diff、guardian/auto-review、warning/deprecation、model reroute/safety 等选中事件进入 provider-neutral discriminated semantic-event union；至少三个非 Codex adapter negative fixtures 证明没有把 Codex wire type 泄漏成全局产品概念，provider provenance 只作为 metadata 而非渲染开关。
- [ ] AC-C4: model/provider capability、permission profile、account/rate-limit 等每个上线 surface 都标注 authoritative source、freshness 与 unavailable 状态；无 source 时 fail-closed，不从本地 config 猜 upstream capability。
- [ ] AC-C5: thread fork/list/compact 的 adapter tests 证明 provider thread id 只做 binding，Clowder AI ThreadStore/message/custody/continuity 仍是 canonical truth。
- [ ] AC-C6: active foreground、background、hydration/F5、callback/replay 共用一个 semantic event registry/projector；以历史 `thinking`、`context_presentation_receipt`、`context_continuity`、`provider_capability` payload 为 fixtures，证明未注册/不合法 structured payload 与 projector throw 均 fail-closed、绝不 `JSON.stringify` 成用户气泡，同时显式 human-readable system notice 仍可见。新增 semantic kind 漏接任一路径时，type/test/structural guard 必须变红。

### Phase D（能力生态与持续 parity）

- [ ] AC-D1: Codex skills/apps/plugins/marketplace/MCP 作为 provider source 进入 F146/F202/F286 既有 lifecycle；没有第二套 install、grant、secret、enable/disable 或 marketplace store。
- [ ] AC-D2: Codex CLI version upgrade 在 enable 前产出 schema delta + disposition review；unknown/deprecated/experimental method 默认不启用，且有一条 fixture 证明 drift 会阻断 rollout。
- [ ] AC-D3: Alpha 真实 app-server 完成 Goal、Review、human interaction、structured event、capability-source 五类旅程，并附 exact version、截图/录屏、restart 与 error-path evidence；mock-only 不得关闭 AC。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “不要制造出太多分叉的概念，能对齐到 Codex App 和猫咖的就复用对齐” | AC-A2, AC-A4, AC-B1, AC-B2, AC-C3, AC-D1 | ownership review + schema/contract negative fixtures | [ ] |
| R2 | “希望能够把能力尽量对齐 Codex App” | AC-A3, AC-B3, AC-C1–C5, AC-D3 | real-provider Alpha journeys | [ ] |
| R3 | 把持续 parity 立成产品承诺，而不是零散补 endpoint | AC-A1, AC-A4, AC-D2 | versioned census + disposition delta gate | [ ] |
| R4 | 立一个很薄的 Capability Parity Feature | AC-B2, AC-C5, AC-D1 | canonical owner/source map + no-duplicate-store tests | [ ] |
| R5 | headless 不应因缺 slash/interactive CLI 而失去本可支持的能力 | AC-B4, AC-C1, AC-D3 | headless carrier + Clowder AI surface UAT | [ ] |
| R6 | “这个 thread 来当 F306 的指挥 thread 以及最后愿景守护 thread；执行拆出去” | AC-A5 | thread topology + final-only receipts + phase checkpoint audit | [x] |
| R7 | “把其他 Provider 的一些概念一起统一收掉”；蓝色气泡不能再把原始 JSON 糊到用户脸上 | AC-C3, AC-C6 | provider-negative + historical leak fixtures、single-registry/path-symmetry guard、Alpha live/F5 | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有可由非作者执行的命令、fixture、截图/录屏或 real-provider 路径。
- [x] 用户可见需求已映射到 Primary/Supporting Journeys；生产 UI 实现前仍需通过 Architecture + Experience Design Gate。

## Mechanism Selection（ADR-031）

| Claim | 选中机制 | 验证 / consumer |
|---|---|---|
| schema、参数、权限、路由、状态机、SSOT 与 drift 是确定契约 | test / lint / structural guard | protocol census、adapter fixtures、restart/authorization tests；merge gate 消费 |
| structured event 可见性、raw JSON fail-closed 与各消费路径对称性是确定契约 | discriminated union / exhaustive typecheck / fixture / structural guard | `bubble-pipeline` consumer；历史泄漏 payload + active/background/hydration/callback/replay guard |
| app-server 延迟、server-request 等待、事件吞吐与稳定性是运行健康 | logs / metrics / traces | F153 + in-context request status；不默认挂 Eval Hub |
| 是否值得接某个 deferred/experimental 能力是不确定效用 | 仅具名 consumer + keep/tune/sunset 决策时另走 eval-design | F306 owner/operator；本 kickoff 不创建空 Eval domain |
| 猫猫如何做 parity triage | convention / feature checklist | parity disposition + owner map；不是强制补齐所有机制 |

## In-context Observability

```yaml
in_context_observability:
  primary_surface: "当前 Clowder AI thread 的 Goal/Review/interaction card + Workspace typed activity；每条绑定 exact provider thread/turn/item/request"
  why_not_dashboard_only: "审批、提问、guardian/review 与 unavailable 状态需要在用户正做决定的位置出现；事后 dashboard 不能恢复或安全终止当前 turn。"
  deep_dive_surface: "F153 logs/metrics/traces + F299 invocation trajectory + versioned schema delta"
  noise_dedup_policy: "同一 provider request 只有一个 canonical lifecycle；Thread、Approval Hub 与 Workspace 只投影，按 request identity 去重，terminal 后不再提醒。内部 structured event 未注册或 projector 失败时只留诊断，不生成用户气泡。"
```

## Tips Contribution（F244）

- Phase B/C 第一个用户 surface 合入时，新增 1 条场景 tip：在 Clowder AI 中处理 Codex Goal / Review / approval，不要求记 slash command。
- F146 provider source 合入时复用能力市场现有引导，只补“来源为 Codex、授权仍由 Clowder AI 管理”的差异说明，不生成第二组安装 tips。
- tips 必须指向真实 Thread/Workspace/Settings 入口；在入口尚未 live 前不提前发布。

## Dependencies

- **Evolved from**: F143（provider-neutral AgentService/RunHandle）、F254（app-server freshness carrier）、F296（provider continuity/compaction）与 F299（invocation trajectory）。
- **Blocked by**: 无外部 Feature blocker；Phase B 的 Design Gate 必须与 F246 owner 对齐 approval projection，Phase D provider source 必须由 F146/F202/F286 owner 接受其 canonical 边界。
- **Related**: F146（能力市场）、F223/F284（Hub/Workspace surface）、F246（Approval Hub）、F281（human disposition feedback）、F291（Codex speed/session setting）、F286（MCP lifecycle governance）。

## Risk

| 风险 | 缓解 |
|---|---|
| 以 parity 为名镜像 95 个 endpoint，范围失控 | disposition matrix 按旅程、maturity、owner 分级；endpoint 数不是完成率 |
| Codex wire type 泄漏成 provider-specific 产品架构 | AgentService provider-neutral port + F183 `bubble-pipeline` semantic projection + negative adapter fixtures |
| 只靠逐个 fail-closed 补丁，新增 event 或平行消费路径再次漏出蓝色 JSON | 单一 semantic event registry/projector；exhaustive union + 历史 payload + active/background/hydration/callback/replay 对称 guard |
| Approval Hub 被泛化成所有 ask-human 的第二个 store | 只接 approval-shaped projection；非 approval interaction 留在原 thread canonical lifecycle |
| 自动 decline 改成过宽授权 | 先保留 fail-closed；每类 allowed decision、principal、scope、restart invalidation 都有 contract test |
| 上游 review 被误当 merge-gate | UI copy + structural guard + AC-C2 明确双边界 |
| provider personality 覆盖猫猫身份 | L0 identity 是硬边界；personality 默认 unsupported_by_policy，除非 Design Gate 证明兼容 |
| stable schema 名义稳定但产品成熟度不足 | schema maturity 与 official/real-provider evidence 双门；experimental 默认 opt-in/off |
| Prompt 代偿长期残留形成双真相 | AC-B5 让 runtime capability 成为唯一条件，live 后删除静态代偿 |
| 用户可见 pending 在 restart 后成为幽灵按钮 | TTL=0 lifecycle + stale/invalidated terminal + no replay contract |
| Command Thread 下场做实现，愿景守护与局部交付混成同一视角 | AC-A5 + final-only execution threads；指挥塔只做 scope/checkpoint/acceptance，代码必须在子 thread + 独立 worktree |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 正式承诺“Codex 体验持续对齐 Codex App”，但按用户旅程而非 endpoint 数验收 | operator 明确选择长期 parity；数字追齐会制造无价值范围 | 2026-08-25 |
| KD-2 | F306 是薄 umbrella；canonical ownership 留在 F143/F146/F246/F284/F286 等既有边界 | 同时满足“统一”和“不制造分叉概念” | 2026-08-25 |
| KD-3 | approval 与 ask-human 分开落位：前者复用 F246 projection，后者补 provider-neutral channel | approval Hub 不能泛化成所有交互；Codex-only Broker 也不可接受 | 2026-08-25 |
| KD-4 | Phase 0 优先接现有 `turn/start` 参数与真实 approval surface，不先扩新 RPC 数 | 价值高、协议面小；当前 prompt 代偿已证明控制层缺口 | 2026-08-25 |
| KD-5 | 复用现有 protocol census；不新建 capability manifest | 家里与上游均已有 negotiation/capability truth，第三份会漂移 | 2026-08-25 |
| KD-6 | native `review/start` 不满足跨个体 merge gate | provider 自审与家里独立 reviewer 的信任边界不同 | 2026-08-25 |
| KD-7 | F306 设唯一 Command Thread + 最终 Vision Guard，所有实现拆到 `final-only` execution threads | 指挥视角必须独立于局部实现；执行自主闭环后再由指挥塔做 Phase checkpoint | 2026-08-25 |
| KD-8 | execution thread 的 code author 默认是平行 `@codex-sol`，reviewer 按难度从 Opus 5 / Terra / Kimi 选择 | 保留 Sol 的 coding ownership，同时用 thread 隔离和非作者 review 分离指挥、实现、审查责任 | 2026-08-25 |
| KD-9 | Codex notification 不成为全家标准；各 provider raw stream 在 adapter 内收敛为家里的 semantic event，再由 F183 单一 projector 决定可见输出 | 复用现有 AgentService/Bubble Pipeline，既统一概念又保留协议真实差异；从根上阻止 raw JSON fallback 与 foreground/background 漂移 | 2026-08-26 |

## Review Gate

- **Command Thread**：只审批 scope、依赖、Phase 启停与 landed evidence；不承担代码 author/reviewer 身份。每个 execution thread 以 `final-only` 自主走完实现、targeted self-check、非作者 review 与 merge，再回报一次。
- **Kickoff**：复用 Opus 5 对同一事实基线与架构边界的审查；本提交只把其 blocking corrections 和 operator 决策落为 canonical spec，不重复召 reviewer。
- **Phase A**：协议/参数确定契约，targeted schema/request tests + 一个非作者 exact-HEAD review。
- **Phase B**：权限、持久化、restart 与用户交互跨域，必须完成 Architecture + Experience Design Gate，并由非作者审 approval/authorization contract。
- **Phase C**：先以本 discussion + `bubble-pipeline` cell 为 Architecture Design Gate 输入；实现必须证明 typed semantic union、单一 registry/projector、历史 payload fail-closed 和非 Codex adapter negative fixtures，再按实际 diff 选择非作者 reviewer。
- **Phase D**：按实际代码 diff 的行为/数据/安全/契约风险选择 reviewer；真实用户 surface 合入后走 Alpha UAT。
