---
feature_ids: [F032, F127, F143, F161, F241]
topics: [codeagent, acp, contract-test, acceptance]
doc_kind: acceptance-fixture
created: 2026-10-30
status: mock-only
---

# CodeAgent 本机模拟与正式接入链验证

用户确认本机没有 CodeAgent，授权简单 mock。脚本位于 `packages/api/test/fixtures/codeagent-mock.mjs`，只通过 stdin/stdout 说 ACP，必须显式传入 `--state-dir`。它不会访问网络、真实认证或本机客户端历史。状态、工具文件与会话 JSON 仅写入该目录；不会自动清理它。它是确定性协议夹具，没有模型推理能力。

mock 支持 initialize、new/load/resume、文本分块、权限请求、一次隔离写文件、cancel/close 和受控断线。`#tool` 请求写文件，缺 handler/拒绝/审批异常均不写；显式批准才写 `mock-output.txt`。`#wait` 保持本轮运行以验证取消；`#disconnect` 以非零退出模拟断线。取消响应和真实进程停止仍分别验证，不能用 mock 返回的文字认定真实客户端停止。

从本任务 `packages/api` 目录运行已有测试入口：

```powershell
node ./scripts/with-test-home.mjs --env CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host node --import ./test/helpers/setup-cat-registry.js --test --test-reporter=spec --test-timeout=30000 test/acp/codeagent-mock-contract.test.js test/agent-session-contract/codeagent-declaration-mock.test.js test/agent-session-contract/plugin-declaration.test.js
```

Windows trusted-host 是现有测试专用引导选择：夹具不为系统 Temp 上级目录背书，没有放宽产品 ACL 或 TLS 校验。测试不需要模型、登录、Redis 或服务端口。

第一组直接验证真实 AcpClient 与 Node mock 的握手、两轮持久续接、权限拒绝/批准、取消、断线。新增第二组让合法声明经过现有 parser → SessionImplementationRegistry/registerPluginAgentProvider → RegisteredSessionAgentService → AcpSessionProvider → 实际 factory/client → mock 子进程；角色 ID 为 `mock-review-partner`，插件 contribution ID 为 `codeagent`，没有把角色名当客户端身份。

接受方案中的最小样本 `{id:"codeagent", transport:"acp", acp:{command:"codeagent",startupArgs:["--acp"]}}` 原样通过严格 parser。四种非法顶层字段被拒绝，坏显式引用保留失败事实。运行夹具明确改用已安装的 Node 及包外 mock 脚本；它不证明真实 codeagent 程序发现或企业支持。注册项停用后 Host 返回 `session_implementation_unavailable`，不追加 mock 会话内容，不改投 iCode 或其他原生客户端。当前身份文本走已有普通消息前缀，未宣称系统级注入或旧会话身份更新。

每次实际运行在 `packages/api/artifacts/role-agent-refactor/codeagent-declaration/独立 状态 */instance.json` 保存源码 SHA、测试/夹具/Node/factory 哈希、实际 PID、程序/数据/原生状态根与收尾事实。原低层夹具也有独立 instance 台账。测试结束等待 bridge release 和 pool close，再记录 closed-data-retained；失败则保留 cleanup-unconfirmed，不能记作成功。所有数据保留供核查，不删除用户状态。

本轮定向检查 54 PASS，完整 session-contract 加原低层 mock 回归 228 PASS，均无失败或跳过。日志在根工位 artifacts/role-agent-refactor-20261029-gpt-sol/codeagent-declaration-green.log 和 codeagent-declaration-regression.log。checkpoint_review 对 c99d7259159ed34d46a65991c6b5efb4f3efe857 给出 approved，独立 49 PASS（另含坏显式引用到实际 Registered service 且 builtin 工厂调用为 0 的两个反例）。独立 mock PID 26620 已退出，台账及精确 PID 回读见 packages/api/artifacts/role-agent-checkpoint-review/codeagent-declaration-c99-instances.json；数据保留。以上只补 C21 和 E03 的局部模拟证据；发现/探测/执行同一真实程序、企业 CA/代理/登录、无公网、真实工程任务质量和 macOS/最终安装包仍待验收。C/E/Q 总账不据此改为 PASS。

复杂度复核：继续复用原 mock 和已有注册/生命周期，没有新增 CodeAgent 运行服务、插件脚本 loader、配置类型、数据库、通用启动器或角色 preset。
