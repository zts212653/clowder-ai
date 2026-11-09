---
feature_ids: []
topics: [acp, dsh, pi, diagnostics]
doc_kind: bug-report
created: 2026-11-04
tips_exempt: "修复已有 Pi 失败消息并记录 DSH 调查证据，不新增操作入口。"
---

# Issue #1831：DSH 路由核对与 Pi 空回复诊断

原始报告：[zts212653/clowder-ai#1831](https://github.com/zts212653/clowder-ai/issues/1831)。
源码基线：`next@faaa1b000ebe0dc6da2aa4c7c09fa80c5be5da43`。

## DSH：报告的硬编码不是普通 ACP 调用的根因

固定 DSH `0.2.1-rc.2`，源码提交
`687f282e8625c6b8d11ff58211a90524be2e4317`：

- `packages/llm/llm-deepseek-api-key/src/index.ts` 注册的路由名就是
  `deepseek-official`，其 `baseURL`、`apiKeyEnv` 仍可配置。自定义端点不等于自定义路由名。
- Host `config/native-accounts/dsh-account.ts#selectedModel` 的限制用于受限插件成员的
  原生账号投影；普通聊天走 `AcpAgentService.invoke` 的 ACP 连接池，模型留空时跟随 ACP 原生选择。
- Desktop/Web 和 ACP 使用不同 profile。Desktop 可用不证明 ACP 选择了相同路由或凭据引用。

在上述 next 基线上，实跑已有 `packages/api/test/dsh-setup-native.test.ts`：

复现时，将 `<DSH_CLI_ENTRY_PATH>` 替换为自己安装的上述版本 DSH CLI 的 JavaScript 入口绝对路径。
从仓库根目录执行：

```powershell
$env:DSH_SETUP_TEST_ENTRY='<DSH_CLI_ENTRY_PATH>'
Set-Location packages/api
node --import tsx --test --test-timeout=180000 test/dsh-setup-native.test.ts
```

结果：1/1 通过。真实 DSH CLI 使用独立 HOME、本地模拟 OpenAI 服务和合成凭据，
从官方默认显式切换到 `custom-only / only-custom-model`，完成验证请求、首次回复和同会话续接，
服务收到 3 次请求，原生配置保持不变；测试子进程已退出。
这是 CLI 与本地端点的集成证据，不代表用户的外部网关、额度或原生登录已验证。

缺少实际 ACP 路由所引用凭据的恢复指引已有
[#1798](https://github.com/zts212653/clowder-ai/issues/1798) /
[PR #1808](https://github.com/zts212653/clowder-ai/pull/1808) 承接。
本次不扩大受限成员的 provider 契约，也不自动借用其他 profile 的凭据。
已有显式配置入口见 [DSH ACP 使用自定义 LLM](../ops/dsh-custom-llm-acp.md)。

## Pi：空 assistant 结束事件被误当成成功

实际调用链：`PiRpcProcess` → `PiAcpEvents` → `PiAcpSession.prompt` →
`PiAcpBridge` → `AcpClient` → `AcpAgentService`。

原实现将任意 assistant `message_end` 标记为完成，随后 `agent_settled` 就返回 `end_turn`。
如果消息只有空白、思考或空 content，Host 最后才生成通用 `empty_response`，
还可能尝试新会话；进程已经收集到的脱敏 stderr 没有进入这条错误路径。
已有 `success:false` 和 assistant `stopReason:error` 的诊断透传仍然有效。

修复在 Pi 回合结束时检查正文或工具事件，空结果返回具体 ACP 错误；
缺少 assistant 完成事件时也补充最近的 CLI 诊断。诊断复用现有的完整行脱敏、
PEM 隐藏和 1000 字符上限；标明是最近诊断，不将它冒充供应商给出的确定原因。
正常正文、最终快照补齐、工具调用及取消继续使用原有处理。

## 验证与边界

回归调用真实桥接与 ACP Host，只有 Pi JSONL 子进程使用本地 fixture：

- RED：空回复与带诊断空回复两条用例均失败，旧代码返回 `empty_response`。
- GREEN：同样两条用例通过；错误中保留 `provider quota exhausted`，屏蔽合成 API key；同一会话可重试。
- Pi 相关 8 个测试文件 36/36 通过，覆盖最终正文补齐、工具回复、取消、RPC 拒绝、
  进程退出、会话恢复和现有诊断脱敏。
- DSH 发现、配置复制、catalog 边界及原生 readiness 5 个文件 32/32 通过；
  API build、TypeScript 检查、改动文件 Biome 错误级检查和 `git diff --check` 通过。

发现工具、登录证据、模型目录和真实调用是不同证据。
本次没有在一键检测中发送模型 prompt；Pi 未报告默认模型时仍保留原生继承语义，
不把 `unknown/unknown` 当成已知模型，也不据此阻止用户配置模型。
本次不声称修复了用户 Pi 供应商侧的额度或登录问题，issue 保持开放直至相应验收完成。
