---
feature_ids: [F171, F320]
topics: [issue-1466, oauth, api-key, test-isolation, main-integration]
doc_kind: bug-report
created: 2026-10-13
---

# #1466：OAuth 测试前提与最新 main 衔接

## 问题和判断

采纳 [zts 对 9677b944 的测试环境 P2](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6137734903)。原 CRUD 用 `clientId: opencode / accountRef: claude` 期待 400，没有固定认证环境。有 `ANTHROPIC_API_KEY` 时 resolver 正确解析为 syntheticNative/api_key，OAuth 的客户端家族限制不适用，因此测试得到 201。

用不会发送调用的假 key 重放原断言，观察到 **201 ≠ 400**。这是测试前提缺口；没有重开已修的 ACP 历史 P1，也没有把正确的 API key 继承登记成产品错误。

## 修复范围

- 将 OAuth 家族拒绝用例从庞大的 CRUD 文件移到 `cats-routes-auth-inheritance.test.js`，在独立 fixture 固定 key/base URL、账户根及完整模板，并恢复原环境。保留原测试名字和 400/具体错误断言。
- 单独验证匹配 OAuth 客户端 201、假 Anthropic key 在协议兼容的 OpenCode 中继承并允许 POST/PATCH、不兼容 OpenAI 官方端点身份仍被拒绝。正向继承验证 resolver 的 `authType=api_key / syntheticNative=true`、原 key 和 accountRef；不用放宽拒绝断言解决问题。
- 共享 `ACCOUNT_AUTH_ENV_KEYS` 和快照/恢复 helper，只涉及测试进程。覆盖 resolver 使用的 provider key 与 base URL；检查外层值、空字符串、原先缺失的变量及内层覆盖均能精确恢复。
- CRUD 的 beforeEach/afterEach 固定认证环境；account-resolver 测试复用键列表，补齐遗漏的 `ANTHROPIC_BASE_URL`。污染环境扩大回归另复现 F320 managed OAuth 的三个同型失败，亦在它保存完整环境后清理认证输入，由既有 afterEach 恢复。
- **产品 resolver、CLI 的 API key 继承、syntheticNative auto 认证、状态根保护和 ACP 实现均未改变。** 没有改真实 CLI 登录、生产配置、Redis 或历史消息。

## 新 main 冲突

9677b944 的 MERGEABLE 结论仅属于当时 `0fc7e3747` 基线。公开 main 新增 `dc582b899ebdcb6f7bb3c6abf2eb81090f8c1c3d`（#1587）后，GitHub 重新显示 CONFLICTING / DIRTY；本轮实际 merge-tree 只有 `ThreadSidebar/thread-utils.ts` 一处内容冲突。

合并保留上游 Windows drive-root 名称保护、斜杠规范化和输入框 `useTextareaAutosize`，以及已有侧栏和引导行为。冲突解决后的 `thread-utils.ts` 与当前 main 完全一致，不选择一侧退回另一侧合同。采用双父 merge，不重写已有 review SHA。

## 验证

- 原 OAuth 反例：注入假 Anthropic key，移除 base URL，RED；原输出保留在 `oauth-environment-red.log`。
- 受影响 API 151 项，在**清空认证环境**与**注入假 Anthropic/OpenAI key 和 base URL**两个独立进程中各 **151 pass / 0 fail / 0 skip**。首次扩大范围的 148 pass / 3 fail 保留，不改写成通过；修复同型 F320 前提后再次运行相同集合。
- 负向 API key 断言进一步核对身份拒绝的实际原因，专用四条合同再次 **4/4 pass**，避免无关配置错误带来假通过。
- 上游 sidebar/输入框、已有引导、成员动作和 ACP 历史/回放 Web：**77 文件 / 491 pass / 0 skip**；完整前端类型检查 exit 0。
- 只读检查独立实例 5144 首页与 DSH 成员详情，原入口和继承偏好保持；没有发送任务、保存配置或删除实际伙伴。
- 最终 merge HEAD 的远端 CI 与当前合并状态须在推送后重新核对，不搬用 9677b944 的 17 success / 1 skip。

## macOS 预览观察仍未确诊

zts 的首次 macOS 整组 **30 pass / 3 fail** 保留；随后本分支与 main 的三条单独重放均通过，不能由此抹去首次失败。相关路径是 raw signal 后进程/launchd 状态，以及 owner cleanup 完成和回执观察。

本轮阅读 fixture、supervisor 和 stop 调用链：`start` 证明监听就绪；`stop` 需等待 supervisor completion，验证 owner 的正常退出回执，再确认进程组/端口退出。没有回执时继续失败并保留状态，不能用端口关闭代替正常清理。该 PR 的相关信号修改限制在 Windows 分支，POSIX drain/回执合同保留；这不足以认定 macOS 没有时序问题。

当前主机为 Windows，同四文件重新运行 **9 pass / 24 POSIX 条目明确 skip**。这不替代 macOS 整组证据。本轮没有给测试增加 sleep、retry 或 skip 来掩盖未确证问题，也没有凭猜测改 POSIX 生命周期。

下一步取证需要首次失败的完整断言/stdout/stderr、supervisor log、owner/completion receipt、status JSON、OS/Node/pnpm/launchd 条件，连同同环境整组重放结果。根因和 macOS 全组复验仍开放，请原执行者补充这些材料；不据此关闭 #1466 或宣称跨平台已验收。
