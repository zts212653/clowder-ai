---
feature_ids: []
topics: [codex, mcp, tool-routing]
doc_kind: bug-report
created: 2026-11-04
tips_exempt: "Internal Codex tool-routing guidance and diagnostic regression; no new user action or configuration."
---

# #1833：区分工具分发失败与 MCP 回调认证失败

来源：[issue #1833](https://github.com/zts212653/clowder-ai/issues/1833)。
修复与验证：[PR #1836](https://github.com/zts212653/clowder-ai/pull/1836)；
架构复盘：[issue #1846](https://github.com/zts212653/clowder-ai/issues/1846)。
基线：`upstream/next@faaa1b000ebe0dc6da2aa4c7c09fa80c5be5da43`。

## 已证实的机制

使用 Windows 上的真实 `codex-cli 0.161.0` app-server、本仓 `collab.js` MCP 进程、
隔离 HOME，以及只监听随机 loopback 端口的本地 Responses 测试服务。
测试服务发送指定工具调用，不调用远端模型或现有 runtime。

两组测试都通过 `CAT_CAFE_CREDENTIAL_FILE` 交付合成凭证，子进程环境中没有
`CAT_CAFE_CALLBACK_TOKEN`。MCP 已连接，模型请求中包含 `mcp__cat_cafe_collab` namespace。

| 模型返回的调用 | HTTP 回调次数 | 结果 |
| --- | --- | --- |
| 只有 `name=cat_cafe_get_thread_context` | 0 | `unsupported call: cat_cafe_get_thread_context` |
| 同一 name 加 `namespace=mcp__cat_cafe_collab` | 1 | 正确返回隔离的 `probe-thread` |

这足以证明：相同错误可由缺少 namespace 导致，与回调凭证是否有效无关。
原故障的完整原始 provider 响应尚未取得，不能据此宣称已经证明原故障一定丢失 namespace，
或已经修复所有 MCP 不可用情况。

## 调用链与边界

- `CodexAgentService.ts` 通过原生 MCP 配置交付工具；`codex-mcp-input.ts` 捕获配置与入口，
  并不把整套工具 schema 当作文本塞入系统提示词。
- `packages/api/src/utils/cli-spawn.ts` 的 `buildChildEnv` 在存在凭证文件的受管模式下，
  主动移除 shell 环境中的 callback token。环境变量为空不是丢失凭证的充分证据。
- `packages/mcp-server/src/tools/callback-tools.ts` 对无法解析凭证返回
  `callback not configured`。这与 Codex 工具分发器的 `unsupported call` 是不同失败层。
- L0 的 `l5-mcp-tools-index.md` 及线程命名指令使用 `cat_cafe_*` 短名。
  Codex 必须依据当前实际工具表解析到完整工具身份，不能直接把短名当作顶层工具调用。
- [OpenAI 的 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
  说明 Codex 原生支持 stdio 与 Streamable HTTP；本次具体 namespace 行为以真实进程对照为证据。

## 最小方案

为 Codex owner 调用补充持久的 provider 指引：使用实际注册的工具名与 namespace；
code mode 中先查 `ALL_TOOLS`，使用 `tools` 上的完整 key；
遇到 `unsupported call` 先核对分发身份，以实际 MCP 返回区分认证问题。
不新增短名别名，不改变凭证交付、授权、工具暴露和 runtime 配置。
公开或受限 native projection 不注入家庭工具路由指引。

[PR #1824](https://github.com/zts212653/clowder-ai/pull/1824) 处理安装双副本下的 MCP 入口身份，
与此处已经证明的分发失败分开承接，本 PR 不复制其入口修复。

`route-parallel.ts` 为每只猫创建独立的 `invokeSingleCat` 流，随后用 `mergeStreams` 合并
已经产出的 `AgentMessage`；这层不转发模型生成的工具调用给 MCP dispatcher。
新增的并发 fixture 同时启动两个真实 Codex app-server，各自使用不同的凭证与线程身份：
完整 namespace 的调用都成功，每侧只收到自己的回调凭证及线程结果。
这覆盖本轮 Windows 并发 native carrier，不等同于真实模型在产品并行入口的端到端验收。

## 验证与剩余缺口

- `codex-agent-service-l0.test.js`：从实际 launch 的 developer instructions 核对路由说明；
  新断言在修复前按预期失败，而不是因环境或语法错误失败。
- `codex-mcp-dispatch.native.test.ts`：真实 app-server 与 MCP 子进程对照，证明有凭证文件时
  裸短名失败、正确 namespace 成功，code mode 也能通过 `ALL_TOOLS` 找到并执行完整 key；
  两路并发也保持 namespace 与回调身份。无 Codex CLI 的环境显式 skip。
  本机 4 项实际执行通过，未 skip。
- 普通启动、app-server 新建/续接与既有交互回归共 29 项通过。
  `pnpm --filter @cat-cafe/api build`、最终 `tsc`、6 个改动代码/测试文件的 Biome、
  `git diff --check` 与 capability-tips 检查通过。
- 首次 CI 的 pooling 回归指出：新增指引包含 callback token 的环境变量字面量，
  触发了现有 RPC 内容隔离断言。指引已改用普通语言，原有断言、凭证交付及授权保持不变；
  修正结果由后续精确 HEAD 的 CI 验证，不将前一提交的红灯记为通过。
- 公开 native launch 的 Windows 测试在更早的 `plugin_native_workspace_not_private` 处失败，
  未到达新增的隔离断言，不能记为通过。该检查所在 `codex-plugin-native-launch.ts` 与
  `upstream/next` 无差异；真实 Windows 临时目录即使 `chmod(0700)`，`stat.mode & 0777`
  仍为 `0666`，不满足既有 `(mode & 0077) === 0` 条件。本 PR 不绕过该权限检查。
  公开与受限 projection 的运行验证需由支持该既有检查的平台继续执行。
- 测试 HOME 与凭证均为合成临时数据，结束后由 fixture 清理，不访问生产数据。
- 尚未用原故障会话和其实际自定义 provider 重放。指引能到达模型、正确调用能执行，
  不等于证明实际模型总会选择正确 namespace，也不能修复会丢弃 namespace 的外部代理。
- 不以本 PR 自动关闭 #1833；后续应在原环境重新执行线程命名、文档生成及消息发送，
  若仍失败，检查原始调用的 namespace、实际 MCP inventory 与 MCP 认证结果。

本轮交付只针对 `next` 创建审查用 PR，不部署 runtime，不自动合入。
指引不增加能力或权限；回退为撤销本次提交，无数据迁移。
