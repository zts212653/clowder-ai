---
feature_ids: [F143, F161]
topics: [acp, implementation, dependencies, migration]
doc_kind: plan
created: 2026-10-13
---

# 可执行实施路线

所有路径相对仓库根。本路线定义技术依赖与交付物，不指定他人 owner，不创建第二条任务责任链。每个工作单元可单独 review；分步交付不能把整体未完成改写为完成。

## W0：冻结对照和桥依赖

产物：各 binding 的 B/R/E 能力基线、版本/依赖 hash、native fixture、G0 测量预算；记录 #1519 的真实 intake 状态。

从 `services/types.ts` 的全部 optional `AgentService` 方法、`CodexAgentService.ts` 原生实现、`ClaudeSdkAgentService.ts`/`claude-sdk-launch.ts`、F254/F296/F306/F318/F325 消费点逐项反查，防止只盘点基础文本工具。

同时核 `claude-carrier-factory.ts`、`ClaudeBgCarrierService.ts`、`ClaudeInteractivePtyCarrierService.ts`，分别冻结 print/SDK/bg/PTY/API-key 及 canary/fallback。北向 `contextBindingForCapacity`/`injectsL0Natively`/`usesChainKeyResume` 等纯声明也列入 baseline，不能因不是 wire 方法漏掉。

#1519 基线 `a89f25ab0` 的工具映射与 resume 协商已在候选分支。当前 worktree 从 main 建立，因此不得声称这些修复在本 worktree 已有。实施前以合入后 main 更新本分支；若仍未合入且实现必须验证，提取最小已审 patch 到单独验证提交，注明来源并预先核依赖/冲突，不把整个 onboarding PR 当本方案的新实现。最终提交去重并重跑检查。

桥先锁 Claude v0.70.0、Codex `51f78d67`；新补丁必须另有 hash。冻结 ACP v1 schema/SDK commit/hash，官方最新文档不是已安装 SDK 的兼容性证据。

## W1：先补 Claude 结果漏接

改动：`packages/api/src/domains/cats/services/agents/providers/claude-ndjson-parser.ts`、共用 print/SDK 调用点、现有工具/存储/重放消费链；定向测试 `packages/api/test/claude-ndjson-parser.test.js`。

RED：native tool_use 后同 tool_use_id 的成功/失败 user.message.content[].tool_result 没有统一结果。补 child parent/execution、并行和恢复 replay 反例。观察实测 RED 再改，不以本稿描述代替失败检查。

GREEN：按 native ID 发 tool_result，保留结果结构/错误状态/作用域；接现有 ToolEventLog/原始 archive/transcript 和 UI，不建新 store。不能用 string-only 摘要覆盖原始多模态输出。

出口：V05/V06/V22 parser+持久+浏览器链闭环，print/SDK 共用链不重复结果；L0/L1 与真实 L2/L3 分开报告。此窄修复不引入 ACP 桥依赖，独立可交付。

W1 优先级最高且可独立提交/审查；两条统一原型 No-Go 不撤销这项修复，也不要求等整个 ACP 重构完成再交付。

## W2：公共 ACP client 与能力/身份合同

改动：现有 `providers/acp/types.ts`、`AcpClient.ts`、`AcpHttpStreamClient.ts`、`AcpAgentService.ts`、`AcpServiceFactory.ts`、`acp-event-transformer.ts`、pool signature 与既有 registry/config 接线。

先从超长 client 抽出 typed request dispatcher/capability/事件模块，每个新增文件 ≤350 行，200 行起评估拆分；保持行为检查，不另写新 client。stdio/HTTPstream 共用合同与 mapping，差异仅 transport/lifecycle。

新增协议测试：initialize capabilities/clientInfo，JSON-RPC numeric/string ID，unknown field/raw refs，load/resume/close 支持选择、内容数组/patch/null 与 final input、prompt result usage/_meta。复用 #1519 的工具实现与 fixture，不重造。

实现 trusted instructions + applied receipt、模型配置采用、execution binding 与 capability provenance。同步 `contextCapability`/`freshnessCarrierCapability` 等北向声明，必须依据实际 bridge/consumer，不沿用 native 实例的无条件值。

出口：V01–V10、V13 的适用 L1/L2；缺 L0 必需通道的成员不迁。

2026-10-15 实施状态：公共 consumer 及工具/遥测链已落盘并完成独立代码审查，适用检查为 API 450 + MCP bootstrap 1、Web 131，见 [W2 回执](w2-public-contract-evidence.md)。隔离真实桥支持判定与 [图片产品 UI 冷重放](product-image-ui-evidence.md)分开记录。当前两固定桥未协商新的可信指令/execution namespace；强要求成员在执行前拒绝，正向原生采用归 W4/W5，不能将 consumer 完成写为完整 G2 或迁移通过。

**W2.S 安全下限（R3）先行**：同时移除 STDIO `AcpClient` 与 `AcpHttpStreamClient` 无 handler/异常路径的默认 allow，返回有据的 reject/cancelled，绝不伪造 optionId；minimal spike host 也显式装 deny-by-default handler。此项在任何真实原型启动前完成并有失败分支测试；不等 W3，不等于完整审批接线已完成。

## W3：政策、真人交互、取消与恢复

改动：ACP factory 必须传正确 handler/interaction port/audit context，沿 `domains/runtime-interaction`、现有 Approval Hub adapter 与工具执行政策，不给 bridge 另开默认审批。

**W3.P 完整权限接线（R3）**：`AcpServiceFactory` 的 STDIO/HTTPstream 创建链传入同一 policy/principal/revision、permissionHandler、交互 port 与 audit context；验证桥 native sandbox/approval 配置实际采用，不能让桥自身 auto-approve 绕过 dispatcher。V11 覆盖机器 allow_once/allow_always/reject、真人审批、缺 handler、非法 option、异常、超时、取消、重试、跨 binding 和 native 配置未采用的阻断；G2 逐分支检查。当前源码证据不等于整个平台审批已被绕过。

新增测试：默认 handler 缺失、合法政策 allow/reject、question/form/URL 实际 UI、pending cancellation、迟到回答、crash restart、session credential 轮换、cancel 后上游静止/lease quarantine；同时测 STDIO/HTTPstream。

修订 AcpAgentService 当前 load_failed_fresh/empty-resume retry 的产品合同：失败不能冒充恢复；正确生成 replacement provenance、重新应用高优先级指令、保留历史，不能 prepend 后悄悄继续。复用既有 SessionChain/RuntimeSession/context continuity owner。

出口：V07/V08/V11/V12/V21/V22 的 L1–L3，G2。取消和真人交互的真实 UI 回执必须存在。

## W4.P / W5.P：增强实现前的 Go/No-Go 原型

在 W0/W1 与 W2.S 之后，先按 [feasibility-spikes](feasibility-spikes.md) 做两个隔离原型：Codex 导出真实 native turn ID→ACP caller指定 target→原生 fence 原样执行；Claude 候选 next-boundary→原生非打断执行→UUID/结果关联。无需等待 W2/W3 全面重构，原型只使用测试绑定/显式政策，不接生产。

两个原型各自有独立审查与 L1/L2 证据。未导出 ID、仅有 host-side比较、只有mock，或 next 仍会中断/错结主结果，都不能放行。任一 P0 原型失败或证据缺失，暂停整体迁移和受影响桥的全面增强，保留原服务并形成重新评估记录；不降低 B/R/E、不删功能。

## W4：Codex 桥增强（统一的决定性 spike）

改动：固定 codex-acp bridge 的 `AcpExtensions.ts`、`CodexAcpClient.ts` 与 native event handler，宿主 ACP control mapper；复用 `CodexAgentService` 内 app-server 叶模块/合同的测试，北向 typed port 不变。

先实现 expected native turn ID 和 request/receipt 显式传递：bridge 已有 `steerTurn` 调用原生 expectedTurnId，但 public ACP steering 合同不暴露调用方 target。补 `_clowder/v1/control` 与 turn-started mapping、stale target 无副作用，不把 startedNewTurn 当 exact 成功。

随后桥接现有 compact/goal/review/status/fork/capability-source、语义事件、continuity preflight、tool execution policy 与已启用 Realtime。禁止宿主双连 app-server；所有功能都以 ACP 请求到同一 native binding。

出口：V14/V16/V18/V19；完整 native controls typed 对照，G3 的 Codex 部分。若 fence/能力源无法一致，记录证伪结果而非删按钮。

W4 成功标准：W4.P 已通过；V16 的 native A有效/stale A与B已启动/取消交错/重连丢回执反例均通过且没有新 turn/重复副作用；native ID与 ACP回执精确一致；V14/V18/V19 及 V24-C 在所有本成员 required controls 上达到 L2/L3，typed semantics/持久/UI不丢，独立审查无未结 blocker。只有普通 steer 或已跑原型不算 W4 全部通过。

## W5：Claude 桥非打断与 callbacks（另一决定性 spike）

改动：固定 claude-agent-acp 的 `src/acp-agent.ts` 及输入/turn owner；宿主既有 `providers/claude-sdk-input.ts` 中 ClaudeSdkFreshness 行为接至统一 control port。

先定义 notice_at_safe_boundary 与 SDK queued_internal_turn 对应，保留消息 UUID、边界、notice/result 关联和主 invocation终态；不得调用 v0.70 原 steer（preempt/abort）冒充非打断。

bridge 内复用 trusted systemPrompt、实际 executable 选择、tool/MCP/skills、原生 hooks/compaction 与 typed host callbacks。单独测试多个 SDK result/echo、取消边界、freshness notice 后再次读源，不误结清主输出。

出口：V09/V10/V14/V17/V20；主周期未被 abort 的 native 证据与 UI/持久关联，G3 的 Claude 部分。

W5 优先评估上游 [#1175](https://github.com/agentclientprotocol/claude-agent-acp/pull/1175) 的 next-boundary patch（固定 SHA 与 tests），不假定它在 v0.70.0 或已合入。沿 [补丁维护评估](feasibility-spikes.md) 比较候选复用、向上游提交和自维护路线；当前未联系社区、未获接受回执，自维护长期成本未知，必须经升级演练测量。

W5 成功标准：W5.P 已通过；V17 的主周期不中断/工具完成、notice UUID echo/结果关联、多个 SDK result与idle、pending权限/elicitation、too-late与取消路径全部通过；没有隐式新 turn、假 applied/settled 或提前结清主 invocation；V09/V10/V14/V20 与 V24-C 保持 L2/L3 完整因果，维护成本评估和独立审查通过。桥内priority="next"或上游mock测试单独通过不算成功。

## W6：逐成员真实差分与既有 ACP/legacy 覆盖

按 capability-matrix 的绑定全集跑 V01–V24，选择实际支持的案例且说明 N/A 依据。DSH/OpenCode/Kimi 等复用通用 transport，不因“能聊天”自动记完整支持；AGY 按 F325 必需 L0/认证/权限验证并补相应 bridge 扩展。

基于 `ToolEventLog.ts`、现有 transcript/session/invocation 持久 owner、`bubble-event-adapter.ts`、`bubble-reducer.ts`/replay harness 验实时与历史一致。UI 只有新的 capability/错误投影，不再写独立 renderer。

低成本 availability 跟随 resolved carrier/execution node 投影到 #1463 的 owner；首次真实调用复用 #1466 旅程。回归跨猫 @、MCP 记忆/任务、freshness、原生 controls，不只测 bridge fixture。

补 V24 的 verdict→drain→settle→prompt barrier、bg chain-key/native UUID 轮换、PTY transcript/drain/dispose、API-key/OAuth 计费不变和 canary/fallback 无重复副作用，沿现有 factory/consumer 与回归测试验证。

V24-C 是独立集成验收单元，完整设计见 [continuity-integration](continuity-integration.md)：真实 bridge/native恢复、压缩、bridge/host crash、全新进程与持久/UI重放，测实际wire首prompt和既有owner顺序。单元/假backend只能提供L1，不能替代G3/G4所需L2/L3。

出口：每 binding L2/L3 evidence manifest、性能报告、独立 review、G4。未知或缺证项阻断对应绑定，不影响已验证其他成员的独立验证。

## W7：迁移、回滚与旧服务退役

在现有成员 transport/config 路由加可回滚 rollout 选择，记录 schema migration/version 与旧配置 compatibility；不把用户 clientId 一律改成 acp，身份与认证仍按原 client/account。

只切新的 invocation admission；active lease/session 保持旧 carrier，完成后退休。对旧 session 明确同 native ID 导入条件与不兼容的新链节点，执行回滚演练。完成产品/设计审查和部署范围确认后才默认切换；无需把所有 provider 同一天切换。

最终删除宿主重复 native client/control 路由及失效配置路径；桥内部供应商实现继续存在。删除前确认所有迁移 binding 的 B/R/E 保持、所有旧历史仍可读、文档/配置/availability truth 同步，才过 G5。

## 依赖与建议实施顺序

`W0 → W1 → W2.S → W4.P/W5.P（独立 Go/No-Go）→ 完整 W2/W3 → W4/W5 → W6（含 V24-C）→ W7`。

W4/W5 依赖同一冻结扩展合同，可在隔离桥项目验证，合流时重新跑公共 client 与控制消费者。技术不确定性优先验证两条 decisive spike；不能把基本聊天优化做完后才发现原生增强无法承接。

G0–G5 各自要求非作者独立审查当前 Gate 的范围与证据；W4.P/W5.P 也各有定向复核。前一 Gate 的通过只能作为依赖，不能替代下一 Gate 的结论。失效条件与回执见 validation。

首个实现提交建议是 W1 的聚焦红绿修复；首个判断 ACP 全量可行性的里程碑是 W4/W5 的精确输入与非打断 notice 双端实际运行，不是标准 prompt 成功。

设计初稿之后已按上述顺序交付 W1/W2.S 及隔离原型，实际 provider 修复、真实模型和独立回执见 execution-evidence；成员默认迁移未开启。完整实现与不退化仍由各阶段门禁证明。
