---
feature_ids: [F306]
related_features: [F143, F146, F173, F183, F197, F223, F246, F254, F281, F284, F286, F291, F296, F299, F310]
topics: [codex, app-server, capability-parity, runtime, approvals, workspace, marketplace, semantic-events, bubble-pipeline]
doc_kind: spec
created: 2026-08-25
description: "让 Clowder AI 持续消费 Codex App 的高价值原生能力，同时把状态、权限与用户入口收敛到家里已有的跨 provider 产品边界。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-28T09:40:00-07:00
cvo_signoff: "2026-08-25 — sourceMessageId 0001787714882198-000142-8a5d102a：把‘Clowder AI 的 Codex 体验持续对齐 Codex App’确立为正式产品承诺；立一个很薄的 Codex App Capability Parity Feature，并统一复用 Codex App 与 Clowder AI 已有概念。"
---

# F306: Codex App Capability Parity — 原生能力对齐，不复制第二套产品

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `identity-session`, `bubble-pipeline`, `approval-index`, `hub-action-surface`, `plugin`, `mcp-surface-governance`

Map delta: `completed` — `identity-session` 已登记 invocation-bound runtime interaction，`bubble-pipeline` 已登记 provider adapter、semantic event、单一 projector 与 raw-payload fail-closed 边界；`approval-index` 已收正为“生产 command/file approval 由 upstream `auto_review` 决策，只有显式 `user` reviewer 的 canonical approval 才可投影”，其他 canonical owner 不变。

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
- `CODEX_THREAD_ITEM_CLASSIFICATIONS` 只保存 Clowder AI 真实 consumer 需要的语义分类，不再冒充上游 `ThreadItem` 全量镜像。未知 item 进入有界 runtime telemetry，未知 notification 只记录最长 64 字符的方法名、每次 invocation 最多 8 个，然后 graceful skip；普通 build 不读取或执行开发者 PATH 中的 Codex。

### Phase A checkpoint（2026-08-25，2026-08-28 收正闭合）

- PR [#3984](https://github.com/zts212653/clowder-ai/pull/3984) 已以 `b791268d3cafd0a9dcaac6bea36eb69b8b8db7ca` 合入 main；非作者 Opus 5 对 exact HEAD `5eccf28dab9463b4f89d5b18a1a50fb523f47add` 完成三向 mutation review 并放行。
- Command Thread 在 landed main 上重新安装 lockfile 依赖后复跑 API build：installed `codex-cli 0.149.1` 为 stable `95/75/10`、experimental `150/75/11`、delta `55/0/1`、ThreadItem `18`；目标测试 **53/53 PASS**。
- #3984 当时落下了完整 stable-method census/matrix、typed rejection 与 single-writer guard；#1409 随后证明把 installed Codex exact-set 塞进普通 build 是错误契约。家内 [#4035](https://github.com/zts212653/clowder-ai/pull/4035) 与公共 [clowder-ai#1412](https://github.com/zts212653/clowder-ai/pull/1412) 已删除 build coupling/full fixture，把协议检查收回显式 audit，并以缺席/旧版/新版六格构建独立性和 unknown-runtime resilience 重新关闭 AC-A2。
- `approvalsReviewer` 保持 `thread/start|resume` 单 writer。Phase B 首版把 live runtime-interaction surface 误等同为 human permission reviewer，生产写入 `user`；operator 在 source `0001787922379694-000126-d1bcfee4` 明确否决 routine script/command/file approvals 进入人面后，writer 已收正为 upstream `auto_review`。`outputSchema` 保持 `turn/start` typed seam，但没有具名 consumer，明确登记为 `deferred`，不为了勾框制造产品 writer；`personality` 继续 `unsupported_by_policy`。
- **Phase A checkpoint 已闭合**：AC-A1–A5 均有 landed evidence。协议全量数字是可复现调查快照，不是普通 build 或 rollout authority；consumer-owned parity register 见下表。
- `main=landed`；runtime 未因 #4035/#1412 重启，activation 保持 dormant。

> 2026-08-28 correction：上述 build-time exact-set census 是当时的 landed truth，不再是目标契约。clowder-ai #1409 已接受以 runtime resilience + explicit audit 取代 ambient-Codex build coupling；AC-A2、KD-5 与当前测试口径以下文为准。

### #1409 architecture preservation evidence

Architecture cell: `identity-session`, `bubble-pipeline`

Map delta: `none` — 本轮只收正既有 Codex provider adapter 的 build/runtime 边界，不新增 Store、Router、capability owner 或用户可见投影。

Why: unknown protocol data 继续由现有 adapter 与 F254 freshness observation seam 消费；安全请求继续复用同一个 `respondToCodexAppServerRequest` fail-closed policy。显式 audit 只生成即时调查输出，不成为 runtime authority。

Canonical source: `packages/api/src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts#boundedUnsupportedCodexAppServerNotificationMethod`, `packages/api/src/domains/cats/services/agents/providers/CodexAppServerEventMapper.ts#respondToCodexAppServerRequest`, `packages/api/src/domains/cats/services/agents/providers/codex-app-server-boundary.ts#classifyCodexProtocolItem`

Consumer evidence: `rg -n "boundedUnsupportedCodexAppServerNotificationMethod|onUnsupportedNotification|respondToCodexAppServerRequest|classifyCodexProtocolItem" packages/api/src packages/api/test` resolves the mapper through `CodexAppServerClient`, `CodexRuntimeInteractionRun`, `CodexAppServerSessionControl`, production `CodexAgentService`, and their contract tests.

Claim guard: ordinary build independence → `codex-app-server-protocol-resilience.test.mjs` + `verify:codex-build-independence`; unknown notification/item graceful observability and unknown request fail-closed → `codex-app-server-interaction.test.js` + `f254-provider-native-freshness.test.js`; each turns red on Codex execution, unbounded payload/cardinality, thrown unknown data, or permissive request handling.

### Phase B implementation checkpoint（2026-08-27，pre-merge）

- provider-neutral contract、Redis CAS/no-replay、session auth、canonical card、F246 adapter、Web pending/terminal/narrow 状态均已在独立 worktree 实现；F296 #4021 landed 后，Codex app-server production seam 已接入 exact audit owner、同一 port 与 run-local abort，不再阻塞 stdout read loop。
- Redis lifecycle 以 hash 字段保存状态，把 provider request 与 redacted terminal 当不透明 JSON；Lua 不再 decode/re-encode payload。读写路由均要求严格 owner identity，提交会栅栏并发 hydrate、409 后重新读取 canonical truth，URL elicitation 在契约与 renderer 两层只允许 `http|https`。
- app-server 只把与当前 provider thread、以及上游提供时的 turn 精确匹配的请求发布到交互 port；缺少必填坐标、foreign/stale turn 均 fail-closed。MCP elicitation 的上游 `turnId:null` 是独立 request identity 的诚实形状，会原样保留并以 exact thread 绑定。既有 `mcp_tool_call_approval_*` request-user-input 兼容请求继续走上游约定的 synthetic decline，不会被普通 question surface 接管。settle 前还会重新确认 exact canonical message/block 仍存活；删除后的旧引用只能终态化为 `confirmation_unavailable`。
- Installed Codex 0.149.1 把 request-user-input 的 `isBlocking` 声明为必填，但 schema 没有描述其更深语义。Phase B 保守地只承接 `isBlocking:true` 的 mid-run 主旅程；缺失或 `false` 在发布卡片前以 `-32602` fail-closed，不能静默伪装成阻塞请求。上游合法的 `options:[]` 会规范化成无预设选项的自由输入问题。
- MCP form 当前只承接 provider-neutral surface 可精确表达的 primitive/single-select schema；`format` 与 legacy `enumNames` 是 advisory metadata，接纳但不进入 canonical response schema。multi-select array 与 titled `oneOf` 会以 `-32602` fail-closed，不生成一张语义失真的卡片；merged Alpha 必须覆盖这条 real-provider error path。
- 运行时 waiter 的 deployment contract 是**每个 Redis namespace 只有一个 active API lifecycle writer**；它不会跨进程恢复或分发。违反该部署不变量时响应 fail-closed 为 `transport_lost`，直到未来有独立 Design Gate 引入分布式 owner lease/waiter routing，不能把多实例当作透明扩容。
- `user` / `auto_review` / `guardian_subagent` 保持上游原生 literal；`thread/approveGuardianDeniedAction` 固定为 upstream client request 并继续 delegated 到 F246，不伪装成人类 server request，也不冒充 merge-gate reviewer。
- F306 的 TS/MJS lifecycle、auth、composition、publisher、adapter 与 protocol resilience suites 已显式注册进 canonical `@cat-cafe/api test`；不再以手工运行、文件名或源码正则冒充 CI 覆盖。普通 API/root build 不运行 protocol audit；`pnpm --filter @cat-cafe/api audit:codex-protocol` 是显式、非阻塞 build 的 live snapshot 命令。
- `main=#4030 at 88b60136b`；2026-08-28 merged Alpha 已先在 `origin/main=d49e13ff0` 重放 question、历史 `user` reviewer approval、MCP elicitation、restart/no-replay 与 resumed execute。permission-funnel correction #4047 随后以 `d62021492` 落地，current-main Alpha `bdfcb48d8` 又完成 ordinary execute、resumed cross-directory read 与 genuine question→answer→same-turn resume；前两轮均未产生 RuntimeInteractionStore/原 thread/Approval Hub script approval。operator source `0001787933681490-000475-ed15c3ea` 同时纠正：Danger 模式允许猫在既有任务授权内跨目录工作，路径不等于权限；不可逆/圣域风险应由 effect/target 级结构性 guard 与 recoverability 守住，不能再造 workspace path jail。AC-B4/B5 据此仅关闭 Phase B interaction/no-human-prompt contract；Codex app-server native shell 当前没有 Clowder AI effect/target 级结构性拦截，安全边界不得从 Phase B fixture 外推，AC-C7 保持开放。旧 390px script-card 条件保持 superseded，不能冒充通过。main/Alpha 已验收；production runtime 仍为 `live=pending restart`，当前 deployment revision `69cdd42b7` 早于 #4047 merge `d62021492`。Phase A 的 ambient-Codex build residual 由 clowder-ai #1409 收正，不再追求 installed exact-set CI gate。
- Merged Alpha 首次真机探针确认 installed Codex 0.149.1 只在 Plan collaboration mode 暴露 `request_user_input`；Default mode 会诚实报告能力不可用。只有用户显式选择的 `#ideate` 才对 Codex app-server turn 投影 Plan preset；“≥2 猫且无显式 tag”产生的自动 `ideate` 只是并行独立思考的路由策略，不能静默升级成 provider 行为模式。installed-provider 连续 turn 探针确认该 preset 会写入 thread settings，且 Plan 下仍可执行命令：全新非显式 route 不发 override，任何 resumed 非显式 route 必须显式投影 Default，避免上一轮 Plan 泄漏；Clowder AI 只透传 `{ intent, explicit }`，不另存 Codex-only mode。该窄 seam 必须单独合入后重跑完整 merged Alpha，不能用直连 app-server 探针关闭 AC-B4/B5。

### 跨 provider semantic event 基线（2026-08-26）

- Codex、Claude、Gemini 与 ACP 各自有 provider-specific raw parser，这是协议边界，不等于前端各自拥有一套 renderer。它们已经汇入共享 `AgentMessage` / `AgentService` port，再由共享 Web socket、`useAgentMessages`、BubbleEvent/reducer 与 `ChatMessage` 渲染；仓内没有独立 TUI renderer。
- 当前归一化仍偏粗：多个 provider 的 structured activity 被塞进 `system_info` JSON，由 `useAgentMessages` 中 active/background 等镜像分支再次判断。历史上 `thinking`、`context_presentation_receipt`、`context_continuity`、Kimi `provider_capability` 等内部 payload 都曾因此成为蓝色 raw-JSON 气泡。
- PR [#3809](https://github.com/zts212653/clowder-ai/pull/3809) 已落地 structured protocol fail-closed 与 foreground/background 对称 guard；这守住“不把未知内部 JSON 当消息”的底线，但尚未把高价值语义事件与所有消费路径收成单一 registry/projector。

### Phase C implementation / acceptance checkpoint（2026-09-02，Closure 已闭合）

Phase C 不再是“尚未实现”。其终态 truth 必须分三层读取，禁止用代码存在替代 Alpha，也禁止用 Alpha 替代 production activation：

| 层 | 当前 truth | 证据 / 下一门 |
|---|---|---|
| **implemented** | #4083 以 `c418a1baefa9d859d92136eacdf007bf88c51535` 落地主体；#4174 以 `a8d4323b5b26bef4cad5e274589794fb4272d669` 收正 semantic surface ownership；唯一 Closure PR [#4213](https://github.com/zts212653/clowder-ai/pull/4213) 以 `b05c0f99a4a08577399ff91b8b1f4fdc69f45033` 合入，修复 scheduled-eval guard P1 假阳性、Goal/Review JSON mutation header 与 Workspace porcelain 首路径解析。 | PR final HEAD `90d19e7c9a0d381ae3ec58e85c9996ead5d0767b`；managed full `pnpm gate` PASS；非作者 Opus 5 exact-HEAD APPROVE `0001788330209029-000497-f173f5b4`，并以 `2539×3=7617` 组差分模糊核验最高风险 native shell effect/target 面，未发现破坏性放行回归。 |
| **Alpha-accepted** | **accepted**。fresh-main Alpha `4ff638b36827594fac094dbd3f3d8cf31dd6924b` 可证明包含 Closure merge；在隔离 `3011/3012/4111/6398` 完成 Goal / Native Review / Status / semantic events 的桌面与 390px 真实产品壳旅程、F5、整套服务重启、诚实错误态与 live/replay 对称性，并从 passive-runtime-shaped cwd 实跑 native-hook 允许/拒绝矩阵。 | 主旅程 thread `[thread-id]`；Goal clear/error thread `[thread-id]`；真实 review `360bb27a-0f5f-4af9-946a-b6d943286330`；真实 Codex session `01a060d4-f7c0-76d1-bf4b-872f5c31f367`。逐项 evidence 见 AC-C1～C7。 |
| **production-active** | **dormant / pending authorized restart or rollout**；Closure 与 Alpha 验收均未触碰 production runtime `3003/3004` 或 Redis `6399`。 | 只有 deployment revision 精确包含 Closure merge 且 production restart/health 另有授权证据时才可改为 active；Phase C checkpoint 不以 activation 为阻塞，也不得从 Alpha 反推 production truth。 |

AC-C1～C7 已按“implemented + merged-main Alpha-accepted”联合口径逐项关闭，Phase C checkpoint 可以诚实闭合；这不把整项 F306 标成 done，也不启动 Phase D。Phase D 必须从 Closure 合入后的 fresh main 在另一条 execution thread 串行开始。

### 关键缺口

- `turn/start` schema 已提供 `model`、`effort`、`personality`、`approvalsReviewer`、`sandboxPolicy`、`serviceTier`、`outputSchema` 等 override。Phase A 已建立窄 typed seam；Phase B permission-funnel correction 让所有 production app-server thread 写入 `approvalsReviewer=auto_review`。`outputSchema` 仍无具名 production consumer，`personality` 明确不传。
- `auto_review` 已成为 routine command/file permission 的 production reviewer；既有任务授权内的普通与跨目录工作都不得因路径边界降级成人工 raw-script 审批。legacy `guardian_subagent`、`permissionProfile/list`、guardian notifications 与 `thread/approveGuardianDeniedAction` 仍没有完整用户路由和状态投影，归 Phase C 的 Review/guardian 旅程。auto-review denial 不在 Phase B 自动升级成 operator 脚本审批。
- #4083 已把 repository-owned provider-neutral effect/target classifier 注入 managed Codex app-server / exec 的同步 `PreToolUse` 边界，并让 Claude sanctuary hook 复用重叠分类；#4213 已收掉合法 scheduled-eval read / exact remote-tracking refresh 被误杀的 P1，同时让危险 Node、HTTP mutation、SQLite write、未授权 ref rewrite 与圣域效果继续 fail-closed。merged-main Alpha 的 `9 allow executed / 6 deny not executed` 探针证明 current-main 执行前边界成立；历史 disposable sentinel probe 只保留为结构 guard 必要性的反例。
- main/Alpha 的 permission-funnel contract 已验收；Phase B 最后一次 production 核验时 runtime `69cdd42b7` 仍早于 #4047 merge `d62021492`，当时状态为 `live=pending restart`。Closure 不读取或重启 production，因此不能把该历史 revision 当作 2026-09-01 的 current deployment，也不能用 stale live 行为反推 merged code 回归。
- command/file approval、request-user-input 与 MCP elicitation 已进入 provider-neutral interaction port；没有 live port、foreign/stale request、未知 server request 与不支持 schema 继续 fail-closed。MCP approval compatibility request 仍保留上游 synthetic decline 语义。
- `codex-app-approval-routing.ts` 只在 genuine question/elicitation capability 实测 `unavailable` 时注入 `confirmation_unavailable` 说明；live interaction surface 不再用文字层覆盖 runtime truth。B4 已按 operator 决策改为“routine permission machine-review 无人类脚本卡 + genuine interaction lifecycle”验收，旧窄屏脚本卡确认已 supersede。
- Goal、Review、thread fork/list/compact、model/provider capabilities、account/rate limits、skills/apps/plugins/marketplace/MCP 等均由 stable schema 暴露，但“上游存在”不自动等于“家里应该全接”。

## Product Contract / 统一边界

### 一个薄 Feature，多个既有 owner

| 能力问题 | canonical owner / 复用落点 | F306 的职责 |
|---|---|---|
| provider transport、thread/session binding、跨 provider service port | F143 + `identity-session` | 维护 parity contract；不新建 Codex control plane |
| provider raw event → semantic activity → bubble projection | F143 AgentService + F183 `bubble-pipeline` | 交付 Codex source adapter 与跨 provider acceptance；不把 app-server notification 或 Codex wire type 立成全局 UI contract |
| 运行时 approval-shaped request | upstream `auto_review` + F246 `approval-index` + provider-neutral AgentService 交互扩展 | routine permission 留在 machine review；只为显式 human-boundary canonical approval 保留投影兼容，不新建第二个 Approval store |
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

#### Consumer-owned parity register

| Capability / claim | Disposition | Canonical owner | Maturity | Validation ref |
|---|---|---|---|---|
| Thread/turn core 与既有 model/effort/sandbox/approvalPolicy/serviceTier | `adapted` | F143 `identity-session` + AgentService | landed | `packages/api/test/codex-app-server-transport.test.js` |
| `outputSchema` current-turn constraint | `deferred` | 未来具名 structured-output consumer；typed seam 仍由 F306 守边界 | no named production consumer | `packages/api/src/domains/cats/services/agents/providers/CodexAppServerClient.ts#CodexAppServerRunInput`；`packages/api/test/codex-app-server-transport.test.js` |
| upstream `personality` | `unsupported_by_policy` | Clowder AI L0 identity/persona | blocked by identity policy | `codex-app-server-transport.test.js` negative fixture |
| 协议 audit、unknown item/notification 与安全 request | `adapted` | F306 explicit audit + F254 observation seam | landed | `audit:codex-protocol`；`verify:codex-build-independence`；`codex-app-server-protocol-resilience.test.mjs` |
| Skills/apps/plugins/marketplace/MCP source | `delegated` | F146/F202/F286 | admitted Phase D journey，not implemented | AC-D1–D3 |
| Raw host filesystem/process/project/realtime/remote-control | `unsupported_by_policy` | no owner without separate security journey | not admitted | Product Contract “明确不造什么” |

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

- 用显式 `audit:codex-protocol` 生成 installed CLI version、stable/experimental counts、method delta 与 ThreadItem 样本；命令只提供异步健康/调查证据，不进入普通 build，也不生成需要永久维护的全上游 registry。
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
  3. 运行中出现 routine command/file permission request 时，由 upstream `auto_review` 应用风险框架并批准或拒绝，不打断operator；既有任务授权内的跨目录工作不因路径不同就变成人审。只有真正需要新授权、不可逆/高影响动作或产品价值取舍时，才进入家里的 operator 决策面，而且必须用“动作、后果、可恢复性”描述，禁止把 raw shell 当审批语言。不可逆/圣域效果由 #4083 的 provider-neutral effect/target guard 与 recoverability 优先结构性阻断；Closure 只扩大具名只读/受约束入口，不放行 opaque execution。question/elicitation 仍在当前 thread 展示 exact request、来源、allowed decisions 与失效条件。
  4. operator回答后，同一 app-server turn 继续；若 process/restart 已使请求失效，系统诚实显示 stale/invalidated，不伪装为人拒绝，也不盲重放副作用。
  5. plan、diff、guardian/review、warning、model reroute 等结构化状态先成为家里的统一语义事件，再进入既有 Workspace；provider wire type 不泄漏到 UI，也不被压成一段不可追踪文本。
  6. 查看/安装 Codex skill/app/plugin/MCP 时，进入家里统一能力市场和授权边界；不会遇到第二套 Codex-only 设置页。
- **Success evidence**: Alpha 真实 app-server 录屏/截图 + exact thread/turn/request correlation + restart rehearsal + generated schema/CI receipts
- **Non-goals**: 不镜像 Codex App 全部 UI；不开放无具名旅程的 host filesystem/process/project/remote-control；不让 native review 通过 merge gate。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | invocation | headless/background cat | provider capability 与授权不因 `-p` 降权；同步人类不可达时保持 typed unavailable/fail-closed | carrier fixtures + Alpha headless run |
| S2 | runtime request | operator | routine permission 由 machine review 消化且不产生 Hub/script card；显式 human-boundary interaction 仍绑定原 thread canonical request，settle/restart 后无 ghost action | provider writer + persistence + restart + UI tests |
| S3 | capability | operator | Codex source 出现在 F146 统一市场，安装/授权/禁用仍由家里 canonical lifecycle 决定 | provider-source contract + Settings/Workspace screenshot |
| S4 | message stream | operator | provider 发出未知或仅供内部消费的 structured event 时，live/F5/background/replay 都不出现蓝色 raw JSON；只有注册过的人类可读 projector 产生可见输出 | 历史 leaked-payload fixtures + path-symmetry guard + Alpha live/F5 capture |

## Acceptance Criteria

### Phase A（协议基线与参数 parity）

- [x] AC-A1: 一条可重跑的显式命令 `pnpm --filter @cat-cafe/api audit:codex-protocol` 记录 installed Codex CLI version、stable/experimental request/notification/server-request counts、method delta 与 ThreadItem types；`0.149.1` 可复现为 `95/75/10` 和 `150/75/11`。该命令不属于普通 build。
- [x] **AC-A2 corrected by clowder-ai #1409**: 普通 API/root build 在 Codex 缺席、旧版、更新版三种 ambient 状态下均不执行或依赖 PATH 中的 Codex；未知 runtime item/notification 有界可观察并 graceful skip；未知 server request 与安全/权限路径显式 fail-closed。协议 audit 是显式健康检查，不维护 pinned 全协议 fixture，也不进入普通 build。
- [x] **AC-A3 corrected**: typed request fixtures 证明现有 model/effort/sandbox/approvalPolicy/serviceTier 单 writer 不回归；`approvalsReviewer` 生产 writer 固定为 upstream `auto_review`，与 runtime question/elicitation port 解耦。若 machine-review host 仍异常发出 raw command/file approval，adapter fail-closed `decline` 且不发布 human card；`outputSchema` 只保留 current-turn typed seam 并登记 `deferred`。
- [x] **AC-A4 scope corrected**: parity 只登记 Clowder AI 已实现、明确 deferred 或安全策略需要的 consumer-owned capability，并保留 owner/maturity/验证 ref；不再为每个上游 stable method 维护永久 disposition matrix。证据：本 spec 的 Consumer-owned parity register、`CODEX_THREAD_ITEM_CLASSIFICATIONS` 与显式 `audit:codex-protocol`。
- [x] AC-A5: F306 Command Thread 只持有指挥与 Vision Guard；Phase A 的每个实现切片均在独立 execution thread + worktree 中完成，并以 `final-only` 携 exact commit/PR/test/review evidence 回报。fixture/人工核验能证明 Command Thread 未直接承载生产代码实现，且未过 checkpoint 不会启动下一 Phase。证据：execution thread `[thread-id]`、final receipt `0001787718918542-000289-00a871e8`。

### Phase B（Provider-neutral Runtime Interaction）

- [x] AC-B1: 至少 Codex approval、request-user-input 与 elicitation 三类 fixtures 通过同一个 provider-neutral interaction port，保留原始 allowed decisions 与 exact thread/turn/item/request identity；非 Codex provider 可实现同一 port，无 Codex-only product store/type hierarchy。
- [x] AC-B2: 只有另经 Design Gate 授权的显式 `approvalsReviewer=user` 所产生的 anchored approval-kind canonical request 才可由 F246 adapter 投影；当前没有 production writer 选择它。生产 `auto_review` 路径的 routine command/file approval 不进入 RuntimeInteractionStore、原 thread 或 Approval Hub。非 approval question 不被伪装成 ApprovalItem。
- [x] AC-B3: `user`、`auto_review`、`guardian_subagent` 与 guardian override 至少各有一条 contract fixture；生产 app-server 单写 `auto_review`。machine-review host 若仍发 raw command/file approval 则 fail-closed、不降级成人类脚本卡；Clowder AI surface 不重新解释 upstream decision，也不把 native review 当 merge-gate reviewer。
- [x] **AC-B4 corrected by operator sources `0001787922379694-000126-d1bcfee4` and `0001787933681490-000475-ed15c3ea`**: current-main real-provider Alpha `bdfcb48d8` 在 `[thread-id]` 完成 ordinary execute（invocation `96c8ef37-cc9d-4376-b07e-4af21075ceaf`）与 resumed、显式授权、非破坏性的跨目录 `/etc/hosts` read（`26523350-4e0e-4e28-a542-796823eb7788`）；两轮均 succeeded，原 thread 零 runtime-interaction block，Redis 6398 按两个 turn invocation 反查 detail record 均为零，Approval Hub pending 前后保持同一 unrelated item、settled 零 F306。随后显式 Plan 轮发布 canonical question `ff3a9f1a-df5a-44a5-bf2c-ce84d7dfe239`，回答 `Alpha` 后同一 turn 输出 `F306_GENUINE_QUESTION_RESUMED Alpha`，Redis 状态 `answered` 且 `PTTL=-1`。既有 merged-Alpha restart/transport-loss 证据继续证明 stale/invalidated、按钮 inert、无副作用重放。本 AC 只关闭 interaction/no-human-prompt contract，不宣称 native shell effect safety 已完成：`derive-worktree-ports`、runtime sanctuary、community bootstrap fixtures `177/177` 与 governed MCP shell fixtures `30/30` 只证明各自声明的 surface；没有一项拦截 Codex app-server native shell。历史 disposable sentinel 删除仍是 upstream `auto_review` 批准并执行不可逆效果的反例，只撤销其 workspace-location 判据；AC-C7 承接 provider-neutral structural guard。真正人类决策只描述动作、后果与可恢复性。旧“390px script approval card 视觉确认”条件已被 supersede，不计作 waive/pass。main/Alpha accepted；production runtime `live=pending restart`。
- [x] AC-B5: 真实交互面 live 后，`approvalSurface: unavailable` prompt compensation 被删除或只在 capability 实测 unavailable 时生成；test 证明文本提示不能覆盖 runtime truth。证据：merged Alpha 的 approval/question/elicitation live records；`codex-app-server-interaction.test.js` 对 live port 不含补偿、无 port 才生成 `confirmation_unavailable` 的双侧断言。
- [x] AC-B6: 若 surface 收集 rejection/cancel why，F281 exact-subject contract、TTL=0 episode truth、consumer 与 invalidation evidence 齐全；否则 UI 不伪装成已采集反馈。

### Phase C（Goal、Review 与结构化体验）

- [x] **AC-C1 — implemented + Alpha-accepted**: #4083 已交付 Goal set/get/clear、updated/cleared observation、TTL=0 ThreadStore CAS、Settings 入口和 reload/unavailable tests；#4213 Red→Green 修复 JSON `Content-Type`。merged Alpha 主旅程在 `[thread-id]` 设置 objective 与 `12000` budget，F5 和整套服务重启后仍可读；disposable `[thread-id]` 又对真实 native session `01a060ef-727d-7322-bd83-1c26b14aa27e` 完成 set/get/clear，clear 后 Goal 为 `null`，updated/cleared observations 为 `0000001788332758-000002-3fbe014f` / `0001788332758551-000003-79a3d79f`。
- [x] **AC-C2 — implemented + Alpha-accepted**: #4083 已交付四类 `review/start` target、Workspace action、bounded durable projection、terminal self-contained/truncated contract 和“不替代独立 merge-gate”copy；#4213 修复 Review JSON header。merged Alpha 真实 review `360bb27a-0f5f-4af9-946a-b6d943286330` 完成 started→mode-entered→terminal，F5 与服务重启后仍显示同一 terminal summary；无 native binding 的 disposable 旅程返回 `409 NATIVE_SESSION_UNAVAILABLE` 且未伪造 review record。
- [x] **AC-C3 — implemented + Alpha-accepted**: shared discriminated union 与 Codex adapter 已覆盖 goal/review/plan/diff/warning/guardian/model-reroute/safety；Claude/Gemini/Kimi/ACP negative fixtures 保证 wire type 不成为产品 kind，provider 只作 provenance metadata。merged Alpha 的 Goal event `0000001788331105-000002-bf950f14` 与 Review started/binding/mode/terminal `0001788331126037-000003-02e7eabe` 至 `0001788331165617-000008-546756fd` 在真实壳可见；持久化消息额外字段只有 `semanticEvent`，没有 raw provider payload 泄漏。
- [x] **AC-C4 — implemented + Alpha-accepted**: Thread Settings Status 只读 exact native binding，响应携 source/observedAt/freshness/availability。merged Alpha 在桌面显示 Codex app-server live、已绑定、authenticated ChatGPT Pro 与 `observedAt=1788332387275`；重启造成 provider request failure 时，桌面与 390px 都诚实显示“Codex 运行状态当前无法读取；不会用本地配置猜测”，恢复后 refresh 回到 live snapshot。
- [x] **AC-C5 — implemented + Alpha-accepted**: `CodexAppServerNativeRpc` 与 goal/review/status controls 复用 SessionChain exact binding；fork/list/compact adapter/route tests 证明 provider thread id 只作 provenance/binding，未写第二份 ThreadStore/message/custody truth。merged Alpha 的 Goal、Review、Status 与 semantic observations 全部留在同一 Clowder AI thread `[thread-id]`，跨 F5/重启 identity 不变，native session 仅保留为 binding/provenance。
- [x] **AC-C6 — implemented + Alpha-accepted**: #4083/#4174 已让 foreground、background、hydration/F5、callback/replay 共用 `provider-semantic-registry` / `projectProviderSemanticEvent`；历史 `thinking`、`context_presentation_receipt`、`context_continuity`、`provider_capability`、invalid/projector-throw fixtures fail-closed。merged Alpha 的同一 Goal/Review semantic events 在 live、F5 与服务重启后的 replay 呈现相同用户语义，桌面与 390px 的 terminal Review、Goal 与错误态对称，plain human notice 继续可见。
- [x] **AC-C7 — implemented + Alpha-accepted**: #4083 已把 exact-hash native hook 注入 managed Codex app-server/exec 边界并保留 Claude shared-classifier defense-in-depth；#4213 用 Red→Green 将 `date`、`stat`、`rg ... /dev/null`、`git rev-parse/rev-list/ls-remote`、exact `git fetch origin main`、`sqlite3 -readonly` 与 loopback GET/HEAD 分类为 read / `repository_refresh`，危险 Node、HTTP write/external/output、SQLite mutation、arbitrary fetch/ref rewrite 和 chained dangerous segment 继续 deny。merged Alpha `4ff638b368` 从 `<tmp>/relay-station/cat-cafe-runtime` 经真实 hook CLI 放行并执行 9 项、拒绝且未执行 6 项；危险 child sentinel 不存在，denied SQLite mutation 后行数仍为 `1`。

### Phase D（能力生态与持续 parity）

- [ ] AC-D1: Codex skills/apps/plugins/marketplace/MCP 作为 provider source 进入 F146/F202/F286 既有 lifecycle；没有第二套 install、grant、secret、enable/disable 或 marketplace store。
- [ ] AC-D2: Codex CLI version upgrade 通过显式/异步 protocol audit 产出 schema delta，再只对具名 consumer 与安全策略做 disposition review；unknown/deprecated/experimental capability 默认不启用。未知 runtime 数据不能 crash，安全请求继续 fail-closed；协议漂移本身不阻断普通 build。
- [ ] AC-D3: Alpha 真实 app-server 完成 Goal、Review、human interaction、structured event、capability-source 五类旅程，并附 exact version、截图/录屏、restart 与 error-path evidence；mock-only 不得关闭 AC。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “不要制造出太多分叉的概念，能对齐到 Codex App 和猫咖的就复用对齐” | AC-A2, AC-A4, AC-B1, AC-B2, AC-C3, AC-D1 | ownership review + schema/contract negative fixtures | [ ] |
| R2 | “希望能够把能力尽量对齐 Codex App” | AC-A3, AC-B3, AC-C1–C5, AC-D3 | real-provider Alpha journeys | [ ] |
| R3 | 把持续 parity 立成产品承诺，而不是零散补 endpoint | AC-A1, AC-A4, AC-D2 | explicit protocol audit + consumer-owned disposition review | [ ] |
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
| 参数、权限、路由、状态机、SSOT 与 runtime fallback 是确定契约 | test / lint / structural guard | build-independence、adapter、unknown-event、restart/authorization fixtures；merge gate 消费 |
| installed protocol drift 是运行健康/调查信号 | explicit audit / scheduled health check | `audit:codex-protocol` 输出 live snapshot；不进入普通 build，不默认挂 Eval Hub |
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

- Phase B 的第一个真实用户 surface 贡献 `feature-f306-runtime-interaction`：Codex 运行中需要审批、回答问题或补充 MCP 信息时，在当前 thread 的 canonical card 处理；Approval Hub 只负责提醒和导航。
- Phase C 的 Goal / Review surface 合入时再补对应入口，不要求用户记 slash command，也不让 Phase B tip 提前宣传尚未 live 的能力。
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
| Approval Hub 被泛化成 routine provider permission 或所有 ask-human 的第二个 store | 生产 command/file approval 由 upstream `auto_review` 消化；只允许显式 human-boundary canonical approval 投影，非 approval interaction 留在原 thread lifecycle |
| 把 filesystem capability 或目录边界误当成授权/安全边界 | `danger-full-access` 是执行能力，不是缓解措施；既有任务授权内允许跨目录。#4083 的 managed Codex native hook 在执行前按 effect/target 拦截不可逆与圣域候选，物理隔离和 trash/undo recoverability 仍优先；Closure 对 read/refresh 的放行必须由 exact parser + negative fixtures 守住。F306 不新增 Codex-only path jail，也不把 raw shell 重新投给 operator |
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
| KD-5 | runtime 只保留 consumer-owned 语义分类；全上游协议只做显式/异步 audit，不耦合普通 build | pinned 全协议 fixture 与 installed CLI 都不是产品构建真相；安全策略和真实 consumer 才是需要确定 guard 的契约 | 2026-08-28 |
| KD-6 | native `review/start` 不满足跨个体 merge gate | provider 自审与家里独立 reviewer 的信任边界不同 | 2026-08-25 |
| KD-7 | F306 设唯一 Command Thread + 最终 Vision Guard，所有实现拆到 `final-only` execution threads | 指挥视角必须独立于局部实现；执行自主闭环后再由指挥塔做 Phase checkpoint | 2026-08-25 |
| KD-8 | execution thread 的 code author 默认是平行 `@codex-sol`，reviewer 按难度从 Opus 5 / Terra / Kimi 选择 | 保留 Sol 的 coding ownership，同时用 thread 隔离和非作者 review 分离指挥、实现、审查责任 | 2026-08-25 |
| KD-9 | Codex notification 不成为全家标准；各 provider raw stream 在 adapter 内收敛为家里的 semantic event，再由 F183 单一 projector 决定可见输出 | 复用现有 AgentService/Bubble Pipeline，既统一概念又保留协议真实差异；从根上阻止 raw JSON fallback 与 foreground/background 漂移 | 2026-08-26 |
| KD-10 | 生产 app-server permission reviewer 固定为 upstream `auto_review`；runtime interaction port 只承载真正需要用户输入的 question/elicitation，以及显式 `user` reviewer 的兼容契约。routine raw command/file approval 永不降级成人类卡片 | operator 明确要求恢复决策漏斗；sandbox capability、permission review 与 human product decision 是三个不同维度，不能因有交互面就把脚本审批投给人 | 2026-08-28 |
| KD-11 | Danger 模式下“路径在 workspace 外”不构成越权；任务授权与高后果 effect/target guard 分开建模，F306 不造本地 workspace path jail。该坐标修正不等于 guard 已存在；Codex native shell 的结构性覆盖由 AC-C7 承接 | operator source `0001787933681490-000475-ed15c3ea`；ADR-026 Decision 3 与 LL-010 已把安全优先级放在物理隔离、结构性 guard 和 recoverability，而不是目录级人工审批 | 2026-08-28 |
| KD-12 | Phase C closure truth 强制拆成 implemented / Alpha-accepted / production-active 三层；AC-C1～C7 只有 implemented 与 merged-main Alpha 同时成立才关闭 | 防止用 #4083/#4174 的代码或 feature-worktree smoke 冒充 merged Alpha，也防止用 Alpha 冒充未授权的 production rollout | 2026-09-01 |

## Review Gate

- **Command Thread**：只审批 scope、依赖、Phase 启停与 landed evidence；不承担代码 author/reviewer 身份。每个 execution thread 以 `final-only` 自主走完实现、targeted self-check、非作者 review 与 merge，再回报一次。
- **Kickoff**：复用 Opus 5 对同一事实基线与架构边界的审查；本提交只把其 blocking corrections 和 operator 决策落为 canonical spec，不重复召 reviewer。
- **Phase A**：协议/参数确定契约，targeted schema/request tests + 一个非作者 exact-HEAD review。
- **Phase B**：权限、持久化、restart 与用户交互跨域，必须完成 Architecture + Experience Design Gate，并由非作者审 approval/authorization contract。
- **Phase C**：先以本 discussion + `bubble-pipeline` cell 为 Architecture Design Gate 输入；实现必须证明 typed semantic union、单一 registry/projector、历史 payload fail-closed 和非 Codex adapter negative fixtures，再按实际 diff 选择非作者 reviewer。
- **Phase D**：按实际代码 diff 的行为/数据/安全/契约风险选择 reviewer；真实用户 surface 合入后走 Alpha UAT。
