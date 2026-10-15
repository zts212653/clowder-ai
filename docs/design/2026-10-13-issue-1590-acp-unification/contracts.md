---
feature_ids: [F143, F161]
topics: [acp, protocol, permissions, steering, telemetry]
doc_kind: design
created: 2026-10-13
---

# 标准与扩展合同

本节 `_clowder/v1/*`、`clowder.ai/acp.v1` 均为本方案的**私有扩展合同**，不是已存在的 ACP 标准或普遍桥能力。W2 已实现部分 consumer 协商/校验；W4.P/W5.P 仅有固定原型。生产桥的正向采用仍需后续双端实现与验收，不能从宿主类型推断上游支持。

## 扩展上游状态（2026-10-13）

| 合同/能力 | 上游状态与来源 | 本方案采用边界 |
|---|---|---|
| initialize/new/prompt/update/cancel/permission，协商后的 load/resume/elicitation/compaction | 官方 v1 文档定义的标准/可选能力 | 冻结 schema 并逐桥证明支持；文档定义不等于本机可用 |
| `_meta`、下划线扩展方法、capability advertisement | ACP 标准允许的扩展机制 | 机制被标准允许不等于具体 `_clowder` 合同被接受 |
| Claude `_meta.systemPrompt`、Codex AIR customInstructions | 本稿固定桥版本的 vendor 实现 | 不是跨桥标准，不声称 ACP 社区已采纳这些字段 |
| Claude v0.70 `_session/steering` 的 preempt/abort | 固定桥现有 vendor 实现 | 不当成非打断 notice |
| `_session/steering` + `_meta.steering.delivery: "next"` | [Claude PR #1175](https://github.com/agentclientprotocol/claude-agent-acp/pull/1175)，HEAD `bcddee2eda74cf64c8f714813a6693cb45d6d22f`：OPEN、mergedAt=null、读取的 reviews=[] | 上游候选，尚未获得接受/合入证据；先评估与本方案语义等价性 |
| `_clowder/v1/control`、inputModes/nativeTurnIds/receipts | 本地拟议，未提交上游、未获接受回执 | 2026-10-14 隔离原型已有 exact fence、native ID 和持久回执/原生历史对账；完整合同仍未发布，只在验证桥启用 |
| `_clowder/v1/execution/read`、instructions/applied receipt、hooks/invoke、interaction/request、session/prepare 与扩展遥测/子执行 | 本地拟议，未提交上游、未获接受回执 | 若落为自维护补丁，登记 upstream SHA/patch hash/发行物/维护预算；不得写成标准 |

状态区分：`standard`、`vendor_implemented`、`upstream_candidate`、`local_proposed`、`maintained_patch`。当前没有 `_clowder/v1` 的 maintained_patch 发行物。没有检索命中不能证明社区拒绝或没有其他方案；候选 OPEN 也不是 maintainer 接受。标准 `session/update.notice` 是 agent→client 展示通知，不能代替 host→SDK 的非打断输入。

## 1. Initialize 与有效能力

initialize 发送 protocolVersion、clientInfo、真实 clientCapabilities。fs/terminal/elicitation/compaction/notices 仅在对应 handler、权限与消费路径完整时声明；缺省不支持。对方版本不兼容立即报告并关闭连接。标准参考：[Initialization](https://agentclientprotocol.com/protocol/v1/initialization)。

扩展放 `clientCapabilities._meta["clowder.ai/acp.v1"]` / `agentCapabilities._meta["clowder.ai/acp.v1"]`；方法使用下划线前缀，标准类型不随意加顶层字段。参考：[Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)。

建议扩展 advertisement：`contractVersion`、逐方法支持、`instructions.roles`、`control.inputModes`、`control.nativeTurnIds`、`control.receipts`、`executionBinding`、`telemetry.fields`、`subexecution`、`hookCallbacks`。方法支持和语义版本共同协商，不能用一个 `supportsAcp` boolean。

对第三方既有 vendor 扩展，使用其真实 namespace/版本做桥侧映射。未声明的扩展不得试发；固定旧桥可提供经过审计的 version profile，但必须以发行物 hash 限定，不能仅凭 agentInfo 名称臆测。

有效 capability 由四层证据组成：

`effective = declared/profile support ∩ bridge implementation ∩ host consumer ∩ binding policy`

每项另记录 `runtimeVerification: unverified | passed | failed`、证据 ref、observedAt、binding fingerprint。声明支持不等于 live verified；缺省标准能力按 unsupported 处理；安装/认证/遥测事实缺失时仍可为 unknown。

版本/账号/模型/profile/MCP/节点/指令改变即失效相关运行证据；不可把上次某个 clientId 的“绿色”覆盖所有成员。

## 2. 执行绑定与模型采用

`_clowder/v1/execution/read` 返回桥及实际原生可执行物的 path/hash/version 来源、执行节点、cwd、HOME/profile 的脱敏引用、认证状态、account binding ref、requested/effective model/effort 与 tool policy revision。不返回 token、cookie、完整环境变量或账号 secret。

host 在启动前将同一 resolved launch plan 交给 bridge；Claude SDK 必须实际设置所选 `pathToClaudeCodeExecutable`，Codex app-server 使用同一 resolved binary。桥返回 agentInfo 只证明桥版本，不证明它内部运行哪个 CLI。

选项从桥返回的 models/configOptions 枚举，调用标准配置方法或协商扩展；验证 response/更新中的有效值，禁止 invalid option 后静默默认。requestedModel、effectiveModel、servedModel 分别保留；供应商未报 servedModel 就标 unknown，不能复制请求值当作证明。

LL-055 的低成本 readiness 保持 spawn-free，使用静态解析与既有事实投影。这里的 initialize/真实 prompt/实际环境审计是显式验收，不混入后台 health/version 探测。

## 3. 高优先级指令、MCP、skills、hooks

W2 当前仅实现 consumer 的协商与回执验证：`agentCapabilities._meta["clowder.ai/acp.v1"]` 必须声明 `contractVersion:1`。`instructions` 声明支持的 `roles` 和 `nativeSources`，`instructionsApplied` 回执含 sessionId/revision/nativeSource 及按序 role/sha256；空必需输入在 acquire 前拒绝。`methods["_clowder/v1/execution/read"]:true` 才能读取 typed binary/account/policy fingerprints，结果只记 `bridge_reported`。以上是本方案拟定的 fork 合同，未获社区接受；当前固定 Claude/Codex 桥均未协商，W4/W5 负责正向原生实现，缺通道成员不迁。

受信任 L0 compiler 输出单独传递，不拼进 user prompt 冒充优先级。新桥在 session/new/load/resume 的 `_meta["clowder.ai/acp.v1"]` 接受 `instructions: {revision, entries:[{role, content}]}`；只接受协商支持的角色。

Claude 桥映射至原生 systemPrompt；Codex 映射至原生 developerInstructions/customInstructions。供应商角色优先级不同，返回实际 applied role/hash 与 native 来源；没有通道阻断强身份成员迁移。用户正文/工具输出不能自行成为 trusted instruction。

旧 Claude `_meta.systemPrompt`、Codex AIR customInstructions 均须按固定版本真实字段映射，不能直接发送上述新合同并假定旧桥理解。新建、恢复、压缩后重建以及 fallback 都复用同一编译版本并校验 applied receipt。

MCP 继续使用现有 resolver、内置自动 provisioning、白名单、session credential 文件与轮换。session/new/load/resume 传同作用域服务器；对不支持的必需 transport/tool 阻断，而不是过滤后仍记“全部可用”。skills/项目规则由原生环境和既有 provisioning 提供，额外路径不得扩大用户已选 cwd/roots。

JS HookCallback 留在桥进程内注册，使用同一 native 生命周期。需要 host 回调时，定义 `_clowder/v1/hooks/invoke` request：hook ID、session/turn/interaction binding、typed input、deadline；返回 typed decision。不传任意 JS 函数/代码，不给跨进程回调提升权限。失败按该 hook 的既有 fail policy处理，并验证现有压缩、MCP、freshness hooks 全部仍可触发。

## 4. Tool 与子执行事件

复用 #1519 的 rawInput/rawOutput/content/原生 ID/状态映射，后续扩展 delta。统一键为 `(binding, native session, invocation/turn execution scope, toolCallId)`；同 ID 跨 session 或子执行不能串配。

partial patch 按字段冻结，不能以同一 null 算法代替 schema：省略字段保留旧值；实验性 `name:null` 按固定 SDK 明确注释保留原名。`rawInput/rawOutput:null` 保留此次原生 null 事实并替换旧值，opaque input 投影为 `{rawInput:null}`；`content:null` 保留 null 并清除旧 collection，`content:[]` 替换为空 collection，均不自动清除独立 rawOutput。后四项是本 consumer 的逐字段合同，SDK 短注释不充分定义统一 null 语义；不是声称社区已接受某个泛化算法。terminal 重复更新幂等。工具 name/input 的最终快照可晚到，不能以最早空 input 为最终真相。success、failed、denied、cancelled、unknown 独立表达。

raw output 与展示摘要分别保留；content 的 text/image/resource/diff/terminal 引用按类型消费。超长内容保留引用、完整性摘要、截断原因与上限，UI 不显示内部指令或 secret。子调用记录 native child ID、parent tool/turn、execution principal/作用域；不能把所有 child event 扔给主猫同一个工具 ID。

使用现有 `AgentMessage` / `ProviderSemanticEvent`，沿工具日志、transcript、持久投影与 bubble reducer；不要新增供应商 UI renderer。无法合法映射的新事件先为有界 diagnostic，不冒充成功工具结果。

## 5. 权限与真人交互

标准 `session/request_permission` → 现有机器执行政策：自动决定必须有 policy/principal/revision 来源，只能选 request 给出的 optionId；移除“未传 handler 就默认 allow”行为。无已适用政策时拒绝或进入已有审批，handler 异常/超时按 fail policy 收敛，不选 allow_always。

question/form/URL → 现有 RuntimeInteraction，不用工具授权代替问答。优先使用双方支持的标准 [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)，其余定义 `_clowder/v1/interaction/request`，携带 schema、session/turn/native request ID、deadline、principal 绑定与交互类别。

host 交互记录持既有 ID 与 native request mapping；响应回原 request ID。仅接受合法选项/schema、匹配当前 binding 和 interaction revision 的答案。人类问题不得由 default allow 或机器人伪造回答。

取消/超时/crash 完成 pending interaction 的 cancelled/expired；重复请求不重复建卡、重复回答不二次执行，迟到答案明确 rejected。URL 交互只交付既有安全打开流程，不自动访问授权链接，不将凭证放正文/日志。

fs/terminal server request 如启用，接既有工具政策、项目根/symlink 校验、执行 principal、取消与输出引用；未完整接线就不声明。ACP 请求不能新建绕开平台审批的 shell 或文件通道。

## 6. 精确 turn 控制与回执

拟定 `_clowder/v1/control` 请求：

实施状态：本 worktree 的 fork 原型已有真实 native fence，并在隔离 journal 验证 binding revision、durable claim、丢回执及 warm/cold 对账；尚未接生产 durable owner。Claude 本地 `_clowder/v1/notice` 固定 next/promptRequired，返回输入 UUID，已验证真实 elicitation、多 Notice 和取消；queued cancel 依赖非公开 SDK `Query.request` 与 native `interrupt_cancel_queued_v1`，失配拒绝 next/退役未知 ingress。两者在 initialize 声明 `prototype:true`，均未获上游接受，不能直接作为下方完整生产端口。证据见 [执行回执](execution-evidence.md)及[私有 seam 维护边界](notice-boundary-evidence.md)。

```json
{
  "sessionId": "acp-session",
  "operationId": "host-durable-operation",
  "bindingRevision": "frozen-revision",
  "operation": "input",
  "target": {"nativeSessionId": "native-session", "expectedTurnId": "native-turn"},
  "input": {"mode": "exact_active_turn", "content": [{"type": "text", "text": "..."}]}
}
```

`input.mode` 明确区分：`queue_next_turn`、`exact_active_turn`、`notice_at_safe_boundary`、`preempt_restart`。bridge 只能执行声明过的 mode。调用方请求 exact 时 turn 已结束/变化 → target_mismatch/too_late，绝不能自动 startedNewTurn。

Codex bridge 暴露真实 native turn ID 与原生 expectedTurnId fence，调用真实 turn/steer 并保留返回 native turn ID。host 本地比较不能替代原生 fence，否则比较与发送之间仍有 race。

Claude notice 保留当前 SDK `queued_internal_turn` 的安全边界投递、message UUID、notice/result 关联；原周期不被 abort。该模式不声称 Codex 式 exact fence。已有 bridge v0.70 的 preempt steer 只能声明 `preempt_restart`，需补独立非打断方法和结果处理。

回执至少有 operationId、requested/effective mode、bindingRevision、native session/turn、accepted/applied/settled 时间或证据 ref、outcome/reason。`injected` 只证明输入阶段，不等于模型已采用或任务已完成；内部 queued turn 也不能结清主 invocation。

原生控制按 typed discriminated union：compact/goal/review/status/fork/capability-source/realtime-open-close。request 与 response 保留现有 `AgentService` 类型语义；review 仍输出结构化事件，fork 返回真实新 session 与父关系，Realtime 仍只有现有 experimental opt-in consumer、text/websocket/v2 与 exact binding。

不能用 `/compact` 文本冒充 structured compaction observation，不能用 `/review` 文字冒充现有 review 状态机。操作 idempotency 存于现有 durable operation owner；桥缓存只用于本进程去重。重连后丢回执须查询 native 状态对账，无法确定记 outcome_unknown，禁止重新发送 fork/steer 等副作用。

## 7. Usage、压缩、上下文与终态

分开计量：当前 context used/size、单请求 tokens、invocation 累计 tokens、session 累计 cost；来源、scope、单位/货币、exact/estimated/unknown、observedAt 与 native turn/epoch 必须明确。snapshot 不重复累加，delta 才累加；非 USD 不硬填 costUsd。

标准 usage_update 及 prompt result usage/_meta 逐字段映射；原生缺数值保持 unknown。缺上下文窗口或可信 used 不启用自动压缩阈值。Codex app-server 现状不可信的 usage 不能因换 ACP 变成 authoritative，也不能为了“保持”已有声明制造值。

固定 SDK 的实验性 prompt usage 注释同时出现 turn/session 描述，当前默认保留完整 raw、scope=unknown。仅上述 v1 namespace 明确声明 `usage:{scope:"prompt"}` 后，才消费 result 同 namespace 的 `usage:{scope:"prompt",kind:"snapshot"|"delta",id?}`；delta必需稳定id，snapshot完整替换自己的已报字段，换session清当前投影，历次回执各自保留。该计量扩展也未获上游接受。标准 context used/size 只作context快照，session累计cost保留货币与scope，不作为本invocation的costUsd；观察到桥数据仍不自动升级native authority。

优先采用双方已冻结支持的标准 compaction 更新；旧桥用协商扩展传同语义 observation。给压缩 ID、阶段、cause、前后 epoch/native session、可展示摘要引用；复用 context continuity owner 的换代判定与 pre-prompt seam，不靠“输出了压缩文本”判完成。

标准 session/cancel 仍是 notification；settlement 通过原 prompt result 与静止证据。桥自然终止、错误、拒绝、取消、crash 对应既有终态分类，晚到/重复终态幂等。协议参考：[Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。

## 8. 扩展兼容与发布

冻结双端 schema/SDK/bridge hash、feature profile 与最小兼容版本，生成类型、验证 unknown 与 `-32601/-32602` 路径。新增字段走 _meta；重大语义变化新 contractVersion，旧客户端保留原生路径并明确缺项。

扩展不支持时返回 typed unsupported，不把异常吞成成功或 silently fallback。所有 capability 宣告均须命中本 binding 的端到端 consumer 测试；版本升级重新跑矩阵，不以“仍然 ACP v1”跳过。

## 9. 北向声明与 continuity barrier

| 现有 AgentService 方法 | ACP façade 必须保留的语义 |
|---|---|
| injectsL0Natively | 仅当前 binding 的高优先级原生指令通道已真实应用时为 true；影响 routing 的 pack-only/full identity 选择，不能凭 protocol 名称返回 true |
| usesChainKeyResume | 保留 bg 等 chain-key carrier 的链归属；新 native UUID 通过 resumeSessionId/replacement provenance 更新，不按 UUID 变化盲目 seal/create |
| contextBinding | 反映本服务实际采用的 model/window 绑定，与 config/readback 一致 |
| contextBindingForCapacity | 保留原有 capacity 解析的独立投影，含 Codex exec 的模型窗口；不把可解析 window 丢掉，也不把它当可信 used |
| supportsToolExecutionPolicy | 仅 bridge 在模型启动前应用本次请求的政策才返回 true；事后筛工具事件不等价 |
| contextCapability / freshnessCarrierCapability | 当前原生来源与消费证据决定；保留 exact_active_turn / queued_internal_turn 区分 |
| invokeWithContinuityPreflight | 严格保留下面的原生 barrier，不能退化为 invoke 包装 |

preflight 顺序固定：①原生恢复/初始化返回 actual continuity evidence；②排空并收集该绑定的 buffered authoritative compaction observations；③调用 `preflight.settle({ evidence, compactions: observations })` **恰一次**，由既有 settle 内的 epoch owner 先更新 epoch 再构建最终 prompt bytes；④发送第一个 session/prompt。②③前不得先组装/冻结/发送用户 prompt，也不得在 settle 之外另行更新 epoch，不能用本地配置预测 evidence。

桥需要协商的 prepare/continuity observation seam（可单独 `_clowder/v1/session/prepare` request，仍属拟实现），返回真实 native binding/epoch 与完整有序 observations；不是凭 host 的“想恢复”记录成功。prepare 超时/不支持时明确失败或走调用方已有非 preflight 路径；已要求该能力的迁移成员不能以 fallback 通过能力门禁。

bg 的 native UUID 轮换、PTY 的 hook sidechannel/transcript 与 cancel→drain→dispose 都在桥内保留原执行生命周期。API-key 与 OAuth 按 factory/account 的真实认证分支冻结；底层同 ClaudeAgentService 不代表可以替换计费路线。
