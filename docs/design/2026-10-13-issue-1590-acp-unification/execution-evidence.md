---
feature_ids: [F143, F161]
topics: [acp, implementation, tool-results, permission, evidence]
doc_kind: report
created: 2026-10-13
tips_exempt: {reason: "修复既有工具结果与权限语义，当前阶段没有新增用户操作入口"}
---

# W0/W1、W2 与原型执行回执

2026-10-14 首批公开提交已对齐新 main 并重新复验，正式 Web tsc 本轮通过；历史捕获与当前检查的区别见 [公开 PR 回执](public-pr-evidence.md)。

后续控制恢复缺口已取得真实回执并经独立复审，见 [W4.P 恢复证据](control-recovery-evidence.md)；该局部结论不自动放行完整原型。

Claude 的真实 elicitation、多 Notice、queued/SDK-ingress 取消和 SDK/native 各一次升级已补证。2026-10-14 两条原型分别经独立审查为 **W4.P Go、W5.P Go**，完整条件索引、统计与exact审查目标见 [原型门禁回执](prototype-gates.md)。首轮样本的限制保留为历史；最新阶段状态以本表和门禁回执为准。草稿 [PR #1596](https://github.com/zts212653/clowder-ai/pull/1596) 持续更新。

工作区：`G:/AIwork/clowder-ai/worktrees/feat-acp-unified-client-plan-1590`；分支 `feat/acp-unified-client-plan-1590`。生产配置、服务和历史未用于本分支验收，迁移未开启。

## 阶段与门禁

| 阶段 | 本次实物 | 独立审查 | 尚未放行的边界 |
|---|---|---|---|
| W0 | 9 份冻结 Git blob hash、北向接口清单、6 个 carrier 声明、CLI/桥/SDK 版本与原生二进制 hash | 源码基线足以实施 W1 | 每个实际 binding 的 B/R/E、账号/profile、运行预算与升级演练尚未完整冻结，完整 G0 未通过 |
| W1 | 原生 `user/tool_result` 漏接修复、原生 ID/parent/invocation 配对、raw payload、失败状态、真实 CLI/官方 SDK、持久历史/UI 刷新 | 两个 P2 已修，代码与新增 SDK 证据通过 | 完整平台调用/socket/UI 链未验收，完整 G1 未通过 |
| W2.S | STDIO/HTTP 共用 fail-closed 权限边界、factory 显式默认取消、prompt admission/generation、取消隔离 | P1/P2 全部修复，安全下限通过 | 不是 W3.P 平台 principal/policy/审批/审计，也不证明原生工具已静止 |
| W2 首个切片 | STDIO/HTTP共用typed initialize、真实clientInfo/fs/terminal声明；2项wire RED→61项回归、API build及两实际桥握手兼容通过 | `160a02218` 独立窄复核通过，无P1/P2，见[公共初始化](client-initialize-evidence.md) | 不等于完整dispatcher/能力协商/身份/config接线；未验真实HTTP桥/模型/产品审批，G2仍未通过 |
| W2 图片输入切片 / #1598 | 两transport及collect发送标准image blocks；fresh/busy/resume-empty保持字节；能力缺失/不可读明确拒绝；27专项、280受影响回归、API build及真实Claude/Codex读图通过 | `feeabe1f7` 独立窄复核通过，无P1/P2，见[图片输入](image-input-evidence.md) | 内存MessageStore+测试JSON冷读/受限session wrapper，不等于产品持久化/UI/factory；未实测CodeAgentCLI/MiniMax具体binding，完整G2/G4未通过 |
| W2 公共 consumer | 共用 dispatcher/capability/session/prompt/usage 叶模块、typed 指令与执行回执、模型采用 readback、工具完整内容/父scope/最终输入、pool 指纹；API 450+1、Web 131；后续 context 修复另有 API143/组件84及14项消费链检查 | `eab5082c9` 原代码窄审后，zts 新发现 context authority 退化，已在 `652ff67fe` 修复并另行复审；当前回执见[公共合同](w2-public-contract-evidence.md) | 两真实桥只验证支持判定/拒绝和当前模型 readback；新 namespace 未协商，正向原生增强及完整 G2 未通过 |
| #1598 产品图片链补证 | 冻结 `eab5082c9` 源码/编译/桥/native 等 84 个 hash；真实 UI 发图与回答、温刷新、API/Redis 保存重启、真实存储冷读与 UI 冷重放；1 prompt/0 tool/2 messages | 证据及独立验收见[产品链回执](product-image-ui-evidence.md) | 安全 guard 限制为合成图片、覆盖 model/system/tools 等选项，不证明生产审批/L0/模型选择；CodeAgentCLI/MiniMax 用户要求跳过、未实测 |
| W4.P | native fence/目标反例、持久对账、owner退出反例、稳定owner中的A跨HTTP响应断开；3个可审A→B边界 | **Go**；21项反例及真实边界/恢复，标题预算纠正 | W2/W3/W4尚需生产consumer/owner/principal/persistence接线；不批准G3/迁移 |
| W5.P | next/UUID/result、真人等待、多 Notice、queued/SDK-ingress取消、SDK0.3.285/native2.1.299升级及now对照 | **Go**；最新升级129项相关桥回归/9项helper，真实关键语义与审查问题闭环 | W3/W5/G3尚需交互UI、私有seam维护合同/完整矩阵/预算；不批准迁移 |

审查者：独立个体 `/root/acp_plan_review`，作者之外的本地同行。同家族审查，不称为跨家族审查；回执只覆盖各自阶段，未批准 G0、完整 G1、G3 或整体迁移。

## W1 的实际路径

根因：Claude 原生结果位于 `user.message.content[].tool_result`，共用 decoder 未处理该分支。print 与官方 SDK 均调用该 decoder。bg 的 assistant-only consumer 和 PTY 独立路径不在本窄修复覆盖范围。

先观察新增 decoder 检查 8 项失败、1 项通过，再修复。用原生 `tool_use_id` 发结果，保留 `parent_tool_use_id` 到 `toolParentUseId`。根调用原生 ID 不改写；内部配对按 parent/native ID，历史再按 invocation/session 分隔。没有对应 use 的结果保留原生事实，不编造工具名。原生缺省 `is_error` 为成功；畸形值保留 unknown。

`toolRawPayload` 沿用 #1519 的最小合同形状，完整 input/output/content 进入 canonical transcript；1500 字符历史预览保持有界。#1519 未整体合入本分支。ToolSpanTracker、串/并行 pending、ToolEventLog、StoredToolEvent、前台/后台消息事实及故事重放保留同一调用作用域。

独立审查发现并修正：并行 nameless/orphan 带 ID 结果不能 FIFO 消耗别的调用；新 invocation 重用 ID 不能改写旧 ToolEventLog。两个反例留在既有测试中。

真实 Claude CLI 2.1.296、模型 `claude-opus-5-5[1m]` 完成受限 Read/Agent 调用。472 个原始事件中有 5 次 use、5 次 result，其中 2 次失败、2 次子调用结果。原始输出留在 worktree 私有临时目录，脱敏完整工具块在 [fixture](../../../packages/api/test/fixtures/claude-native-tool-results.json)，hash 与脱敏规则在 [原生捕获](evidence/w1-native-capture.json)。不从 `apiKeySource:none` 推断 OAuth、账单或正式绑定。

真实数据 → 生产 decoder → `TranscriptWriter` 写盘 → 新 `TranscriptReader` 冷读，10 个工具事件和完整 raw output 不丢。随后在 `https://claude-w1-replay.test` 的隔离 Edge 中用生产 `ReplayMessageList`/`CliOutputBlock` 展开 5 个工具行并刷新，2 次原生失败仍可见、无 pageerror。该证据是实际组件和实际持久数据，网络夹具并非生产 API/socket；截图没有加载完整产品样式，不用于视觉验收。

用户明确授权限定认证测试后，真实官方 SDK 0.3.285 → `ClaudeSdkAgentService` → 同一 decoder 完成 Read/Agent(w1-reader) 检查：374 个原始事件、29.720 秒、SDK 报告 costUsd 0.065478，5 use/5 result/2 error/2 child，service error=[]。仅选取现有用户设置中的认证/模型 env；`settingSources=[]`、禁 hooks/用户指令、2 美元上限、精确 Read 路径与 Agent 类型 allowlist，无仓库源码出站。SDK 的脱敏完整工具块在 [fixture](../../../packages/api/test/fixtures/claude-sdk-tool-results.json)，版本/原始 hash/预算与映射见 [授权执行证据](evidence/authorized-runtime.json)。两份捕获各通过持久冷读与 2 次磁盘读取的浏览器刷新，共 2 个历史检查、2 个浏览器检查。

## W2.S 的实际边界

- 两条实际权限入口先观察默认 Allow 的 2 项 RED。无 handler、factory 未接审批、异常/rejection、超时、非法选择和畸形 schema 均返回 ACP `cancelled`；仅显式 handler 的合法选项才能 selected。
- 真实 prompt 在写 wire 前准入；原生终态撤销准入；取消、超时或 consumer 提前退出且未获原生终态，隔离旧连接的该 session。后续请求不能自行重开；其他活跃 session 保持独立。取消后的新执行需要新连接，复用现有 pool 退役判断。
- 审批决定与写 wire 之间再检查 admission generation；同步 allow 后同 tick cancel 也不能送 selected。迟到 callback、新权限 request、旧 session 的再 prompt 和 closed connection 不再获得权限。
- 实际 STDIO/随机端口 HTTP NDJSON 夹具验证 A 取消、B 正常、数字 ID 原样保留、畸形 kind 取消、STDIO 原生终态后的迟到请求，以及 consumer early-return。模拟 native/权限 owner，未声称真人审批 UI 验收。

## 首轮 Go/No-Go 样本与历史限制

Codex 固定 bridge 2.1.1 / `51f78d67`、native CLI 0.161.0，在 STDIO wire 注册 `_clowder/v1/control`，导出真正 native callback ID。最初仅 extMethod 未注册 wire 的调用为 `-32601`；错误包装遗漏 message 的问题也已修正并留档。最终同一 binding 的 3 个受限只读回合、79.038 秒，caller A 原值经真正 `CodexAcpClient.steerTurn` 进入 native `turn/steer.expectedTurnId`：valid A 原生回执匹配、重复 operation 只有一次 native 调用；B active 时 stale A/非空不存在 target 被 native 拒绝，B 保持原 ID；idle/取消 target 被 native 拒绝；unknown ACP session、foreign binding、空 target 分别由桥拒绝。原型协商、bundle/lock/runner hash、caller/native mapping 与 raw refs 已冻结。

Codex 的模型/认证沿用户原有选择复制到私有隔离 profile，禁 hooks、项目指令、shell/编辑、apps/skills；测试仅允许 fixed fixture MCP，首轮3个工作load turn、每回合90秒、工具8秒/12次。后续审查发现桥另发1个title turn，原“modelTurns”不是全部模型请求的硬上限，已记录真实RPC计数和未知费用，见预算纠正。没有原生USD硬上限，不从模型名猜账单。最终样本、早期失败均保留。该首轮仅桥内缓存；后续对账/寿命分离的进展见追加回执，完整W4/G3与迁移仍未放行。

Claude 固定 v0.70.0 / `d0aafb1c` / SDK 0.3.232，实际 native CLI 2.1.296。#1175 完整 diff 不能直接应用到固定源码，采用本地 narrow patch：专门 `_clowder/v1/notice` 固定 next/promptRequired，协商声明 prototype 并返回 native input UUID；这不是上游已接受的扩展或完整生产合同。旧 pendingCount→禁止入队合成判据过强，按非作者意见改为不抢占/不代答；历史 RED 保留，未以修改测量判据宣称修好原生安全缺陷。

真实 next 样本：工具完整完成并返回哨兵后，notice UUID 才 native started；原生 result 同时包含 primary/notice UUID，ACP 主请求在原生 idle 后结清。实际 `session/request_permission` 由测试 handler 延迟 3 秒：未响应时工具不执行、主请求不结清，释放后正常完成；这不是产品真人审批 UI，也不是 elicitation。idle/aftercancel notice 返回 promptRequired，无 detached 新 prompt；取消样本有本地 iterator 异常终止和随后 native error/idle，未证明 ACP wire 正常 cancelled 结清、工具静止或已排队 notice 撤销。

真实 now 对照发现悬挂：工具转后台继续运行，随后 task_notification、自主 result、idle 均出现，ACP 主请求仍 90 秒超时。原文明确“未中断”，不能因文本含 interrupt 就写成工具取消。确定性回归复现 owned autonomous idle 债吞掉 steer 结清；第一次最小归属补丁又被“旧主任务迟到工具块污染新主任务”反例证伪。最终精确链为 native command UUID → model message ID → tool ID → task notification run ID → autonomous origin.runId，仅本主任务已确认拥有的 followup 不额外记该 idle 债。历史/foreign 债、原 subagent drain gate、autonomous usage/错误所有权保留；缺原生关联证据时不猜 owner。29 项受影响 steering/next 检查通过，并重跑真实 now/next；最终 now 19.236 秒正常结清，失败样本均保留。

首轮仅能判定核心表达/桥承接的有界可行性；当时两条原型held。追加丢回执恢复、活动owner寿命分离、A→B重复、elicitation/多Notice/queued取消及SDK/native升级后，原型已各自Go，可继续后续实现。G0–G5仍需自身独立证据，不能把原型Go改写为整体迁移批准。

原型准备脚本和检查位于 `scripts/acp-spikes/`；上游副本在 worktree 的 `.cat-cafe/tmp/acp-prototypes/`，没有嵌入 Git 仓库；研究 clone 在 workspace 根目录。未修改上游源仓，也未公开发社区消息。

## 验证与限制

前阶段受影响检查：API build、131 项既有/入口回归、42 项源码检查、28 项前端适配器、1 项浏览器，见 [阶段机器回执](evidence/stage-validation.json)。授权续办增加 SDK 历史/浏览器样本，实际各 2 项通过；Codex 可控检查 2 项、固定桥映射 1 项；Claude 完整受影响 steering/next 29 项、生成上游 TypeScript 编译通过，续办日志/SHA 见 [授权执行清单](evidence/authorized-runtime.json)。变更文件 Biome 检查通过，有 intentional literal-template、complexity 等 warning/info；没有使用 unsafe fix。

历史 Web tsc 的 Vitest 类型身份冲突已在对齐 main/安装冻结依赖后消失，正式 Web tsc 通过，见公开 PR 回执。更宽的 print/SDK 检查曾有6项失败：5项 Windows MCP 参数为文件路径而测试按内联 JSON 读取，1项 SDK 图像路径未按平台 resolve。现在按实际 inline/file 合同读取及规范化路径，保留原功能断言、未改启动实现，71项通过；失败日志保留，不能扩写成全仓回归通过。

无用户设置的 SDK 曾返回 `Not logged in`；启用用户设置的尝试曾因缺少明确认证/出站范围授权被自动审批拒绝。用户随后明确答复“授权上述限定测试范围”，本轮据此完成隔离 SDK/native 检查；没有改写原认证或生产配置。账号/profile 测试绑定不等于正式成员绑定，完整 G0 的 B/R/E、成本/升级预算矩阵仍未验收。

原始 JSONL、冷读历史、日志、截图均保留在本 worktree `.cat-cafe/tmp/`。不把这些夹具视作运行中的正式安装、生产账号或线上成员已更新。整体迁移保持关闭，现有 native 服务未被替换。
