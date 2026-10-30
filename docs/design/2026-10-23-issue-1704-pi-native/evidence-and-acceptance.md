---
feature_ids: []
related_features: [F241, F289]
topics: [pi, acp, sessions, recovery, diagnostics, issue-1704]
doc_kind: evidence
created: 2026-10-23
status: proposed
---

# 证据、承接情况与验收矩阵

本页为实施前证据快照，取证日期：2026-10-23。设计基线 `c7be47576cada416721ff93230d205417f6c0895`；上一轮真实/可控接口复现基线 `74ad585dccefb884d3d9d67367c90a9b5c605442`。两者间没有 Pi 桥冷恢复变更。用户批准后新增的实现和真实模型验证见[实施报告](implementation-report.md)，不与本页旧基线结果混用。

## 已知与未知

| 结论 | 证据及边界 |
| --- | --- |
| 企业机走内置桥 | [用户评论](https://github.com/zts212653/clowder-ai/issues/1704#issuecomment-6345264766) 的 agentInfo 为 `clowder-pi-bridge`，路径为安装目录内置入口 |
| 两次失败之间桥进程发生代际变化 | 评论记录 10 月 22 日 19:39:38 PID 23960 首轮 empty_response，22:52:15 PID 31328 同 Host 父进程下 resume_requested 后立即 prompt_failure；命令行属于重建推断，并非存活进程 argv 实采 |
| 可能由池回收触发换代 | 源码默认 idle TTL 30 分钟；3 小时 13 分间隔与此相容。尚缺 `Idle TTL eviction` / exit 原始日志，不能断言这就是现场退出原因 |
| 内置冷恢复缺失已确认 | `loadSession:false`、`--no-session`；真实 Pi/自定义 LLM 首轮和热续聊成功，换桥进程后 load 在模型调用前失败 |
| 存在空内容传递机制 | 可控接口空 assistant → 内置桥 end_turn → 真实 Host service empty_response。仅证明机制，不证明企业机上游为何为空 |
| 转换代码有可修复缺陷 | 空字符串 text_delta 也设置 streamedText，可能阻断随后 final 文本回填；assistant message_end 无条件设置 completedAssistant。实施须先加失败检查，不把静态推断冒充现场根因 |
| 自定义 LLM 本机不是必失败 | 两次真实调用均成功并记住测试词；不代表所有网关/模型/企业网络都兼容 |
| 实际 Windows shim 尚待核实 | `Get-Command pi` 返回 ps1；Host 自身使用 PATH/PATHEXT 和 Windows spawn plan，不能据此认定子进程实际使用 ps1 |

## 源码入口（均相对仓库根）

Pi 主目录 `P = packages/api/src/domains/cats/services/agents/providers/pi/`；ACP 主目录 `A = packages/api/src/domains/cats/services/agents/providers/acp/`。

| 路径 | 当前职责 / 设计关注点 |
| --- | --- |
| `P/pi-acp-bridge.ts` | ACP 能力、Map、new/prompt/close；尚无 load |
| `P/pi-acp-session.ts` | 随机桥 ID、`--no-session`、MCP 临时 extension、配置、settled fence |
| `P/pi-acp-events.ts` | 文本/thinking/tool 转换、完成和错误标记 |
| `P/pi-rpc-process.ts` | RPC admission/拒绝、进程退出、stderr、精确归属停止 |
| `A/AcpClient.ts`、`A/active-session-cache.ts` | 热复用、恢复能力、cwd/MCP/run-state 绑定；不得全局放宽 |
| `A/AcpAgentService.ts`、`A/native-session-defaults.ts` | Host 错误码/可用输出、无 prompt 的默认值探测 |
| `A/AcpProcessPool.ts`、`A/AcpServiceFactory.ts`、`A/acp-pool-signature.ts` | TTL、启动上下文、账户和池签名 |
| `packages/api/src/routes/native-pi-discovery.ts` | 优先外部 `pi-acp`，否则内置桥；不会自动选 `clowder-pi-acp` |
| `packages/api/src/utils/cli-process-ownership.ts` | 当前 `resolveCatCafeDataRoot()` 与进程所有权辅助能力 |
| `packages/api/src/utils/cli-resolve.ts`、`cli-spawn-win.ts` | 真实入口及 Windows shim 解析 |
| `packages/api/src/utils/sanitize-cli-stderr.ts` | 错误脱敏；先脱敏再截断 |
| [F289 根目录设计](../../features/F289-canonical-data-root.md) | 根切换暂停、新持久资产的兼容/归属要求；不依赖不存在的已合入 catalog |

Pi 1.3.0 原始依据为本机已安装 `@earendil-works/pi-coding-agent` 的 `docs/cli.md`、`docs/rpc-commands.md`、`docs/session-format.md` 及 `dist/core/session-manager.js`。核实了 `--session-dir`、`--session-id` 缺失则新建、`--session` 部分 ID/fork 风险、switch/new 的 cancelled 和惰性持久化。上游为 [earendil-works/pi](https://github.com/earendil-works/pi)；本方案未把上游 main 文档当作固定 1.3.0 标签内容。

## 相关 PR：采用边界

以下为本轮 API 核对快照；实施前再次刷新状态和文件差异。

| 对象 | 状态 / HEAD | 与本方案的关系 |
| --- | --- | --- |
| [Host #1665](https://github.com/zts212653/clowder-ai/pull/1665)、[#1677](https://github.com/zts212653/clowder-ai/pull/1677) | 已合入；#1677 merge `f5516afe2` | 通用会话/插件持久绑定等基础已存在；使用独立桥的重启证据不能套用于内置桥 |
| [插件仓 #104](https://github.com/zts212653/clowder-ai-plugins/pull/104) | Open、非 Draft；`a2d6b65fde77baee98175dbeb03c656926e889a9` | 独立 `@clowder-ai/pi-acp@0.1.0-beta.1` 已有 native load/MCP 实现及本机冷恢复对照；尚未合入/发布。借鉴恢复及测试，不强依赖其分发 |
| [作者 fork #14](https://github.com/whutzefengxie-ops/clowder-ai/pull/14) | Draft Open；`ecafa76d9af0f9438c179a652e27e51229e5b462` | Pi 空内容检测和错误测试可复用；还改 ACP env/错误链，未实现内置原生冷恢复。不要复制全部 DSH 范围 |
| [#1596 正式审查](https://github.com/zts212653/clowder-ai/pull/1596#pullrequestreview-5527065334) | Draft / Changes requested；`d2d7f5e2c087a1b8501ca9f2bebaf9175c3613fc` | 与 AcpClient/Service 有文件重叠，存在可选 restore 导致第二轮失败的 P1；保持通用绑定安全，不借本修复放宽全局回退 |
| [DSH #1668](https://github.com/zts212653/clowder-ai/issues/1668)、[文档 PR #1705](https://github.com/zts212653/clowder-ai/pull/1705) | #1668 跟进中；#1705 本轮文件仅为 DSH 自定义 LLM 文档 | DSH 有独立归口，不归入本次 Pi 修复 |
| [#1667](https://github.com/zts212653/clowder-ai/issues/1667)、[#1669](https://github.com/zts212653/clowder-ai/pull/1669) | #1667 是 issue；#1669 已关闭未合入 | 启动策略相关历史，不能作为 Pi 内置恢复已修复的证明 |

当前未查到完成内置 Pi 原生冷恢复的专用已合入 PR。#104 的独立桥与 fork #14 的诊断分别已有承接；默认内置桥冷恢复和企业机首轮空响应实际诱因仍需本路线补齐。本地计划分支不代表上游已受理或维护者认可。

## 既有实验账本

任务根：`G:\AIwork\clowder-ai\artifacts\issue-1704-pi-20261022`；旧工位：`G:\AIwork\clowder-ai\worktrees\analysis-issue-1704-pi`。

| 账本 | 内容 / 使用边界 |
| --- | --- |
| `real-results.json`、`real-ledger.json` | 真实 Pi 1.3.0 + 私有自定义 OpenAI-compatible LLM；首轮/热续聊两次真实调用通过，进程重建恢复失败 |
| `fixture-results.json`、`fixture-ledger.json` | 真实 Pi + 受控 SSE 接口 + main 实际 Client/Service；冷恢复失败且 provider 请求 0，空完成映射 empty_response |
| `external-fixture-results.json`、`external-fixture-ledger.json` | #104 独立桥 + 真实 Pi + 受控接口；重启后同 native ID，实际 provider messages 含原历史；本轮没有该桥新增真实 MCP 验收 |
| `completion-receipt.json` | 临时进程/监听已停止；原 Pi models/auth/settings 哈希不变；持久证据保留 |

前轮 API build 及 Pi bridge/cache/resume 三组 18/18 通过；Windows 包装器第一次受 TMPDIR 映射影响，改到任务临时目录后通过，不能记作产品故障。独立桥当次生成入口 SHA-256：`67f0a9c431c3447fad1c634fe7f8b7aecd7695af00a433f84c54c50a490dd1c8`。

旧工位 `.cat-cafe/issue1704/` 含隔离模型配置和原生历史，属于私有保护数据；不复制进 Git、不公开、不清理。本轮文档只引用脱敏结论。不得将这些旧基线结果宣称为未来修复分支已经通过。

## 实施验收矩阵

“计划验证”表示尚未实施；所有新行为均须先观察针对基线的 RED，再以实现获得 GREEN。

| 编号 | 场景 | 必须观测到的结果 | 层级 / 当前状态 |
| --- | --- | --- | --- |
| R1 | 新 session 首轮、同进程热续聊 | ACP ID = native ID；真实文件落盘；记住首轮词 | 真实 Pi + 受控 provider / 计划验证 |
| R2 | 真实池短 TTL eviction | 旧进程退出；新桥 load 同 ID，provider messages 含旧历史 | Pool + Client + Service / 计划验证 |
| R3 | Host/API 受控重启 | 同 scope/根/cwd 精确恢复；无替代 session | 持久绑定 + 真实 Pi / 计划验证 |
| R4 | 当前 MCP、凭据轮换 | 冷恢复后工具身份稳定、真实读写；使用新 invocation/credential-file，不使用旧 token | 真实 MCP / 计划验证 |
| R5 | 缺失/损坏/重复/越界/错 scope/cwd | 明确失败；不新建、不发 provider 请求、不改旧绑定 | 文件/Host 集成 / 计划验证 |
| R6 | 并发 load/prompt、双桥/双 Host | 至多一个真实写者；竞争失败可解释且无 JSONL 混写 | 跨进程 / W0 先决验证 |
| R7 | 桥崩溃但 Pi 子进程存活 | 禁止抢占；确认原写者停止后才可恢复；不误杀其他会话 | 进程所有权 / W0 先决验证 |
| R8 | prompt-free defaults、落盘前崩溃 | 不发模型请求/伪造历史；空目录不被误认作可恢复历史 | Client + 原生文件 / 计划验证 |
| R9 | 旧 UUID、旧 --no-session、版本回退 | 历史保留、明确不可恢复/版本限制；用户显式新会话 | 兼容/产品路径 / 计划验证 |
| R10 | 中文空格路径、只读目录、reparse、Windows shim | 受信根和准确入口可核查；拒绝越界；不扩 ACL/命令信任 | Windows + 文件系统 / 计划验证 |
| E1 | 空/空白 delta 后非空 final | final 文本完整出现；不被空 delta 屏蔽 | 事件 + Host / 计划验证 |
| E2 | 正常 stream + final、多 assistant/tool 阶段 | 不丢内容、不重复；输出计数跨 prompt 阶段正确 | 事件 + Host / 计划验证 |
| E3 | 真空完成/thinking-only/usage-only | `empty_response`；无占位输出或自动重试 | 实际 Service / 计划验证 |
| E4 | tool-only 成功 | 工具结果可用，不误报空响应 | MCP + Service / 计划验证 |
| E5 | provider/RPC 拒绝、handled、cancel、退出/超时 | 真实脱敏原因与各自语义保留，settled 前不成功 | RPC + Service / 计划验证 |
| E6 | 错误含 key/URL/user path、超长 stderr | 先脱敏后截断，日志/持久错误不泄漏，内存有界 | sanitizer + 持久投影 / 计划验证 |
| P1 | 最终包 + 真实自定义 LLM + 重启/MCP | 源码/包哈希绑定、同 ID 历史真实接续、原配置不变 | 本机最终路径 / 计划验证 |
| P2 | 企业机首次空响应及上述完整旅程 | 明确实际诱因及修复证据；或单列仍缺的事件链 | 企业真实环境 / 尚缺证据 |

每项证据记录实际源码 HEAD、包/入口、Pi 版本、时间、进程代际、受信根/scope、native ID 和脱敏摘要。模拟器/可控接口、真实 LLM、真实 MCP、最终安装路径和企业机验收分别标记，不能互相替代。

## 企业机需要补齐的最小证据

保留当前评论已提供内容，仅补未确证项：实际 Host commit/包哈希、Pi 版本、实际子进程 exe/argv、所用桥文件哈希、脱敏状态根及 cwd/MCP 绑定；换代对应的退出或池 eviction 日志；首次失败关联的 admission → assistant final（内容类别/长度、stopReason/error）→ settled → ACP 更新。

不需要 API key、完整 models/auth 文件、用户原始 prompt 或未脱敏 stderr。按 W3 的白名单采集；若现场旧包无法提供足够事件证据，先用诊断构建复现，不能以没有日志推断“main 已自然修好”。
