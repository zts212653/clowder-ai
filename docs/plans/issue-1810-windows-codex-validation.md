---
feature_ids: [F320]
topics: [windows, codex, verification]
doc_kind: evidence
created: 2026-11-03
---

# Issue #1810 实现验证记录

本轮交付范围：Issue、两猫方案、独立 worktree 实现与自动化验证。用户正在使用本机，未部署、未发起真实 OAuth、未打开可见终端或浏览器验收。

Architecture cell：既有账户登录与 Codex native compatibility。Map delta：none，平台适配在原有职责内；不新增账户、浏览器或终端管理服务。

## RED → GREEN

1. 原代码：四项失败，分别是 npm `.CMD` 版本查询 `spawn EINVAL`、worker 直接启动 `.CMD` 同错误、Windows PATH 冒号拼接、平台错误误报为版本/策略错误。其余 11 项生命周期测试通过。
2. 实现后四项转绿；追加了三类策略拒绝、Windows 系统层投影、真实进程出生时间、取消时子孙进程退出与带中文/空格/单引号的 PowerShell worker 路径。
3. 系统层投影新增回归在原实现得到 `model_provider=undefined`，适配 ProgramData 与 Windows legacy managed 路径后通过。所有写入都在临时 ProgramData 下，不写真实系统目录。
4. 隐藏 PowerShell driver 测试抓到开发态 `--import C:/...` 不能作为 ESM import URL，改为 `file:` URL 后通过。
5. 实际 Windows capability 测量抓到强制结束 host 后 `thread/resume` 仍报 active writer；改为先关闭 stdio、等待正常退出，超时再终止进程树，完整准入测试通过。没有删掉单写者或续接检查。

## 本轮通过的检查

工作目录均相对本 worktree；所有 API 运行命令均经 `packages/api/scripts/with-test-home.mjs` 隔离 HOME、USERPROFILE、数据根与 Redis。

```powershell
# 仓库根
pnpm --filter @cat-cafe/api build

# packages/api
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test --test-concurrency=1 test/f320-windows-login.test.ts test/f320-windows-policy.test.ts test/f320-login-lifecycle.test.ts test/codex-native-compat.test.ts test/f320-effective-config.test.ts test/f320-account-launch.test.ts test/f320-managed-accounts.test.ts test/f320-login-uniqueness.test.ts test/codex-managed-layout-diagnostic.test.ts

node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env F320_NATIVE_WINDOWS_TEST=1 node --import tsx --test test/f320-windows-managed.native.mts

# packages/web（DOM 单测，不打开浏览器）
node scripts/run-with-node-env-test.mjs node node_modules/vitest/vitest.mjs run src/components/__tests__/f320-account-truth-locale.test.tsx src/components/__tests__/account-locale-contract.test.ts
```

- API 构建：exit 0，包含 shared、mcp-server、API TypeScript 编译与构建检查。平台不支持 SQLite read-window backend 的提示属于原有构建行为。
- 后端定向组：76 项，73 通过、0 失败、3 项 macOS 实机检查跳过。
- Windows source/compiled driver：同组中两条均通过，分别执行 `.ts` 与 `dist/*.js` 的 worker，全部隐藏终端、使用假 CLI，不调用真实 login。
- 实际 `codex-cli 0.161.0` 的 Windows 平台准入与 managed_accounts：通过，14 个能力检查全部成功。临时 HOME、假模型、无真实凭据、不调用 OAuth；本轮只读 status 与 stdio RPC 的成功不是完整真人登录验收。
- Web：2 文件、58 项通过。新增平台/策略失败通过真实账户行的重试动作显示，并可切换中英文。
- Biome：所改文件无 error；保留原有复杂度和非空断言警告，driver 的状态等待与平台分支也有复杂度 warning。未用关闭规则隐藏。
- `git diff --check`：通过。

## 扩大检查中的既有失败

`test/f320-state-admission.test.ts` 在本分支出现 6 项失败。用同一 Windows 环境、同一隔离命令，在干净基线 `6c2021d494b7fe0f7a5423868709d4ae99c097ed` 的独立 checkout 复现相同 6 项失败，未改测试或产品源码：

- synthetic ambient restart drift 的默认 launch 检查。
- probe/direct/pooled/exec 四种 carrier 对 ambient shared-root drift 的拒绝。
- recreated control/attachment host 的 shared-root 检查。

表现为未抛期望的 divergent 异常，部分 fixture 进入 `unexpected_spawn` 或把 `app-server` 当成 Node 脚本。该组涉及既有 synthetic auto-auth 与 shared-root 契约，未在本次扩大修改；不能将本轮结果表述为 API 全量通过。独立 reviewer 需评估该基线事实与新增 managed 登录路径的边界。

基线准备时缺少部分 MCP 编译输出，TypeScript 报缺少模块；补入相同基线、未修改 MCP 源码生成的构建文件后才运行上述对照。该构建准备失败不计作产品回归。主实现 worktree 的完整 API 构建通过。

## 尚未执行的验收

以下项目有意保留为未验，符合当前用户边界：

- 可见 Windows 终端、默认浏览器及真人双账户 OAuth；不得以隐藏 fixture 代替。
- 真实账户绑定与远端模型请求、B 存在时逆序重登 A、重启后的真实会话续接。
- 跨 API 进程并发登录和 1455 回调归属；当前保留既有 manager 队列，未新增端口抢占机制。
- 标准用户无 symlink 能力的完整登录；#1709 仍是独立前提，已有诊断单测不等于解决权限限制。
- macOS 实机回归、最终安装包及合入后的隔离验收。

后续真人验收步骤、实例台账、数据边界和回退方式见 [技术方案](issue-1810-windows-codex-login-plan.md)。本轮不关闭 Issue，不合入或替换日常安装版。

## 隔离纪律核对

作者只在独立 worktree 与临时测试根运行；未更改日常安装目录、真实凭据或应用进程。

协作探针曾短暂写入机器级 ProgramData 配置以验证系统层，随后已恢复；作者独立核对真实 `ProgramData/OpenAI` 与 `ProgramData/OpenAI/Codex` 均不存在。这个操作不符合本轮隔离约束，已对用户说明，不将其算作隔离验收。此后政策实验仅在临时 ProgramData 重定向下运行。
