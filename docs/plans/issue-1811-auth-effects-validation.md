---
feature_ids: []
topics: [codex, native-hooks, authentication]
doc_kind: validation
created: 2026-11-04
---

# #1811 作者验证记录

本轮仅独立工位中的纯命令 fixture、假 CLI/SDK 和包内 hook。没有运行真实 Codex 登录/登出/设备授权，没有停止当前 Codex，没有改运行时配置、用户凭据、锁或历史。新 Windows 能力仍由 #1812 承接。

## RED 与真实入口

- 初始 `node --test scripts/native-auth-boundary.test.mjs`：56 条，9 通过、47 失败；事故命令对应生产 hook 返回空（允许），共享 guard 返回 unknown；失败是目标行为缺失。
- 初始 SDK 最终 settings 的真实 hook 进程：事故 JSON 未被拒绝，断言 `undefined !== deny`。没有执行 JSON 内的命令。
- 后补 npm `node .../codex.js login` 和 Windows `cmd.exe /c` 的 fixture，分别先观察失败，再补解析并转绿。
- CLI 从 fake spawn 时最终 `--settings` 文件读取内容，SDK 从最终 sdkOptions 读取内容；共同断言 Host hook 只出现一次且路径等于包内 canonical script，实际执行该 Node 脚本验证事故字符串被拒绝。
- 包移动到独立目录和 `node_modules` 布局后，继续实际执行包内 hook；二者都拒绝事故字符串，证明构建闭包包含新认证模块。

## 验证命令

在工位根运行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/mcp-server build
pnpm --filter @cat-cafe/api build
node packages/mcp-server/scripts/prepare-secret-runtime.mjs
node --test scripts/native-auth-boundary.test.mjs scripts/secret-native-hook.test.mjs
git diff --check
```

依赖和 API/MCP 构建通过；后续脚本修改后重新生成包内运行时。认证与防泄密检查 71/71 通过；随后核源码补入实验性选项值 `status` 的四条 RED → GREEN 反例，最终 75/75。格式检查对本次 JS/MJS/TS 文件运行 `pnpm biome check <files>`，退出 0；现有大函数和有限 argv 解析仍有非阻断复杂度 warning，不把它们说成零 warning。

在 `packages/api` 通过现有 `scripts/with-test-home.mjs` 隔离 HOME、清除运行环境，并禁用非隔离 Redis：

```powershell
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test test/native-auth-carrier.test.js
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-name-pattern 'F203 AC-C5: -p carrier passes' test/claude-agent-service.test.js
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --import ./test/helpers/setup-cat-registry.js --test test/secret-carrier-launch.test.ts test/claude-scoped-native.test.ts test/claude-sdk-scoped-native.test.ts test/f320-login-lifecycle.test.ts
```

CLI 行为断言 1/1 通过；SDK 与纯 fixture 64/64 通过，实验性选项值反例加入后 68/68；scoped、原生启动和 manager 生命周期合计 23 条通过。后者使用已有假 driver 和临时 fixture 凭据，不启动真实登录。scoped/member 的现有测试确认 CLI `--tools ''` / SDK `tools: []`，仅保留绑定的插件 MCP 工具，没有原生 Bash 漏口。普通 unknown、touch/write 分类保留，并另有明确断言。

在 `packages/mcp-server`：`node --import tsx --test test/secret-runtime-layout.test.ts`，两种迁移布局均通过。

公开测试自动收集新 `.test.js`；该文件加载纯 fixture。Windows Smoke 额外运行新入口测试与 fake CLI 最终 settings 测试，不依赖本机账户。

## 保留的旧失败与范围

扩大到旧 F306 测试时，本机 Windows 产生 7 条失败：Bash oracle 1 条、以未转义 Windows 路径构造 POSIX shell 的 program-identity 2 条 / unknown-allow 1 条 /主 guard 3 条。另有 4 条按既有条件跳过。将 `upstream/next@997eccf7` 原始 scripts、同一测试及其 helper 用 `git archive` 导出至独立 baseline 目录，分别运行同名 4 条和 3 条测试，得到同样 7 条失败及相同断言差异。它们不是本次绿色证据，也没有在本 PR 顺带修改。

`codex login status` 的只读分支和 `-h/--help` 的依据来自事故版本 [Codex CLI 原始源码](https://github.com/openai/codex/blob/979011409de0a60b52f179721948e65531d26144/codex-rs/cli/src/main.rs)：LoginCommand/LogoutCommand 派生 Clap Parser；顶层 `MultitoolCli::parse()` 先于认证分支，Status 单独调用 run_login_status；同文件 help 测试断言 DisplayHelp 短路。这里只对白名单中的 Codex CLI 语义作判断，不推广到任意命令。

## 合入前责任

宪宪已批准方案方向，并要求对最终 exact HEAD 审查；最终 verdict、CI、PR 状态和合入回执保存在 PR / 本线程，不在审查后提交报告造成 SHA 循环。作者选择受影响检查与一次完整 API 构建覆盖本次脚本接线，未运行全仓或真实账户验收。
