---
feature_ids: [F143, F161]
topics: [acp, provenance, evidence, source-audit]
doc_kind: reference
created: 2026-10-13
---

# 来源、复核与本次证据

本文件保留2026-10-13设计初稿的来源/检查结论。后续实现、真实补证与独立阶段判定分别见[执行回执](execution-evidence.md)、[原型门禁回执](prototype-gates.md)，不以初稿“未实施”覆盖后来的结果。

## 讨论来源

| 来源 | 本稿如何使用 | 边界 |
|---|---|---|
| [#1590](https://github.com/zts212653/clowder-ai/issues/1590) | 公共合同、桥版本、宿主漏接、候选统一路线 | 未决定全量默认迁移 |
| [zts 6140080514](https://github.com/zts212653/clowder-ai/issues/1590#issuecomment-6140080514) | 独立 parser 证据、先修漏接与新增合同拆分 | 合成输入，非真实模型验收 |
| [zts 6140218308](https://github.com/zts212653/clowder-ai/issues/1590#issuecomment-6140218308) | factory permission 接线、SDK notice 与 Codex fence 的原生基线 | 不扩大成平台 MCP/Approval Hub 被绕过 |
| [#1463](https://github.com/zts212653/clowder-ai/issues/1463) | availability 跟成员/carrier/执行节点、spawn-free probe | 不另造 clientId 可用性 owner |
| [#1466](https://github.com/zts212653/clowder-ai/issues/1466) | 首次配置后真实使用兑现演示承诺 | demo 不代替真实验收 |
| 本轮用户原话 | 创建 worktree，沿统一方案落地并保证能力不下降 | 不把本地用户决定写成上游 maintainer signoff |

## 源码复核

本地路径以 README 的 `3add05c16` 为固定基线；#1519 候选独立注明。新分支的文档提交不改变源码 hash。仓库已有文档的历史状态只作为归属来源，不代替本轮运行证明。

| 判断 | 已核实源码 | 结论级别 |
|---|---|---|
| 北向已统一且包含原生增强 | `packages/api/src/domains/cats/services/types.ts` 的 AgentService（1047 起） | 源码；不是新的统一贡献 |
| Codex 现有 typed controls / context 可信度 | `providers/CodexAgentService.ts`（1237–1410） | fork/compact/goal/review/status 等需承接；app-server usage 尚未 authoritative |
| Claude SDK notice 与共用 parser | `providers/ClaudeSdkAgentService.ts`（72–85、事件循环）、`providers/claude-sdk-input.ts` | queued_internal_turn 是基线，不能仅以 print 比较 |
| Claude 原生结果漏接 | `providers/claude-ndjson-parser.ts`（assistant tool_use 分支与 user 处理缺口） | 本次实际 parser 合成输入诊断，见下 |
| ACP 指令优先级与 initialize | `providers/acp/AcpClient.ts`（303）、`AcpAgentService.ts`（576–579） | clientInfo/capabilities 缺失，systemPrompt prepend |
| ACP 权限实际接线 | `providers/acp/AcpServiceFactory.ts` 的 clientCfg、`AcpClient.ts` 的 handleAgentRequest | factory 未传 permissionHandler；默认分支选 allow；不推导整个平台审批绕过 |
| 已有 ACP tool/恢复补齐 | [#1519](https://github.com/zts212653/clowder-ai/pull/1519) HEAD `a89f25ab0`，`acp-tool-events.ts` / `acp-tool-content.ts`、AcpClient | 已在候选分支；当前 main worktree 不冒称已 intake |
| Claude bridge 结果与指令 | [d0aafb1c acp-agent.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/d0aafb1ca26427285ffaeac8d8a4452fff28e9c3/src/acp-agent.ts) 的 createSession/tool_result | 本地固定源码复核；未执行桥 |
| Claude bridge steering | 同文件 2108 起的 steer 与 STEER_PRIORITY/结果处理 | preempt abort；未等价非打断 notice |
| Codex ACP public steering | [AcpExtensions.ts](https://github.com/agentclientprotocol/codex-acp/blob/51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e/src/AcpExtensions.ts#L122) | 只有 sessionId/prompt 与 outcome，无 caller target/turn receipt |
| Codex native fence 的实现基础 | [CodexAcpClient.ts](https://github.com/agentclientprotocol/codex-acp/blob/51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e/src/CodexAcpClient.ts#L1291) | 内部 steerTurn 已调用 expectedTurnId；扩展可在此补 caller fence，仍待双端真验收 |
| DSH 合同 | #1590 固定 [d7432673](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/acp/acp/src/index.ts#L383) | 本稿引用 Issue 版本审计，不声称本机 DSH 已重新验证 |

providers 相对 `packages/api/src/domains/cats/services/agents/`。有关 bridge 的能力仅限定上述版本，不外推到更新版；不把拟新增 `_clowder/v1` 记为桥现有能力。

## 官方协议

2026-10-13 在线读取：

- [Initialization](https://agentclientprotocol.com/protocol/v1/initialization)：协商 version/clientCapabilities/clientInfo。
- [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)：合法 _meta、下划线扩展方法与能力声明。
- [Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)：load 与 resume 的 replay 差异、session capabilities、MCP。
- [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)：工具更新、usage、取消与 prompt settlement。
- [Elicitation](https://agentclientprotocol.com/protocol/v1/elicitation)：form/URL 的双向交互合同。

最新 v1 页面已描述 resume/close、elicitation、compaction 等可选能力；不能继续笼统将它们写成协议永远没有。**文档存在不证明固定旧桥/安装 SDK 实现**，W0 必须冻结实际 schema 与兼容性。

## 本轮反馈后的上游状态核实

2026-10-13经GitHub API/CLI只读回读Claude PR [#1175](https://github.com/agentclientprotocol/claude-agent-acp/pull/1175)：HEAD `bcddee2eda74cf64c8f714813a6693cb45d6d22f`、OPEN、mergedAt=null、reviews=[]。候选diff增加delivery="next"并修改SDK输入priority；所附测试使用mock generator，不是本轮真实执行或完整freshness验收。[#871](https://github.com/agentclientprotocol/claude-agent-acp/issues/871)仍OPEN；需求描述不能覆盖后续桥已实现的steering事实。

Codex expectedTurnId关键词与Claude "non-interrupting"关键词检索未命中；Claude steering检索找到包括#1175的相关讨论。该检索只用于发现候选，不证明没有其他提案/社区拒绝。本轮未发布社区消息、未获维护者接受回执。具体标准/vendor/候选/本地拟议状态见contracts表，不能给旧固定桥增加候选能力。

## 可复跑 parser 诊断

[诊断脚本](evidence/characterize-claude-parser.mjs)读取实际 parser 与实际 MCP status helper，仅 transpile TypeScript，不 mock parser 分支；输入为成功、失败、child 三个合成 tool_result。

Node 24 下无需安装 worktree 依赖，从根运行：

```powershell
node docs/design/2026-10-13-issue-1590-acp-unification/evidence/characterize-claude-parser.mjs --output docs/design/2026-10-13-issue-1590-acp-unification/evidence/claude-parser-characterization.json
```

脚本使用 Node 内置 stripTypeScriptTypes，**源码取本 worktree**，output 记录源码 SHA-256、git HEAD 与 Node 版本。生成转译件仅放本 worktree `.cat-cafe/tmp/`，不写 main；不是解析器 mock。Node 可能输出该 API 的 experimental warning，不影响样本结果。

本次实际结果见[原始诊断 JSON](evidence/claude-parser-characterization.json)。它只证明对应原生 ID 的 tool_use 被发出、三种结果样本没有 tool_result。未运行真实 Claude/ACP bridge、未验证存储/UI、未声称全部工具都不可见。

## 本轮交付检查与限制

方案覆盖：27 项能力、24 条差分场景、W0–W7 工作单元、G0–G5 迁移门禁；来源、实际源码基线与 #1519 候选区分。

本轮新增：R1/R2的W4.P/W5.P前置Go/No-Go原型与补丁长期成本量尺；R3的W2.S安全下限和W3.P完整权限接线；R4的V24-C真实crash/压缩/恢复集成设计；README回滚决策树、扩展上游状态、W4/W5成功标准和逐Gate非作者独立回执。它们是计划/验收合同的修订，P0/P1运行验证和provider修复本身仍未实施。

本轮执行的是实际 parser 源码诊断、文档相对链接/路径/版本检查和 git diff 检查。独立内容复核的结果写在 [review-notes](review-notes.md)。没有修改 provider 行为、没有运行真实模型，没有迁移任何成员，ACP 全量不退化尚未被运行证明。

全局 `node scripts/check-feature-truth.mjs` 报 F147 user-journey-missing、F128/F177 all-ac-status-drift 三项；对未改的 main 基线复跑得到同样结果，未冒称全局门禁通过、未改他人 Feature 来使检查变绿。新 worktree 尚未安装依赖（Corepack 下载受当前网络限制），本轮未运行 provider 构建/全套测试；Node 内置源码诊断不依赖这些安装。

方案完成不等于 Feature close；F143/F161 只增加方案入口，不改 status/owner，不重开 #718/#483，不向外部 Issue 发布未经授权的消息。
