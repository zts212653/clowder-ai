---
feature_ids: []
topics: [superagent, design-preview, verification]
doc_kind: verification
created: 2026-11-04
status: synthetic-preview-only
---

# 体验稿验证与实例台账

本轮交付是源码依据、架构提案和当前 Web 路由内的原生组件体验稿。插件包、语义判断、真实监听、任务准入、成员执行和恢复均尚未交付。以下记录只证明体验稿及其隔离边界。首版范围已确认后的 Host 接口组合验证另见 [contract-slice.md](contract-slice.md)：内存存储与替代 Queue 上的 3 个探针、相关测试共 27 项通过，仍不代表真实插件验收。

## 工位与样例边界

- 工位：`G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103`
- 分支：`feat/superagent-plugin-20261103`
- 基线：`upstream/next@0fb68bc03455507836a0a35a706985a1ccc66058`
- 保留原因：等待本线程的体验方向确认，后续沿同一任务实现；生命周期已登记 owner=codex。
- 体验路径：`http://127.0.0.1:5214/dev/superagent-preview?shell=v2`。当前只覆盖 v2；classic 和完整 Host 集成尚未验收。
- UI 复用 `WorldRailFrame`、`ThreadSidebarV2Header`、`ShellIcons`、`ShellPresentationContext` 与当前产品 token。通过 RootLayout 的明确 development fixture 分支组合原生组件；不挂载 AppShell 的后台运行服务。产品周边导航在体验稿中为只读。
- 三个会话、两个工作和所有消息均为固定合成样例。状态转移由显式样例操作驱动，没有调用模型或外部服务。
- `SUPERAGENT_PREVIEW_FIXTURES=1` 仅在 development 选择该原生组件组合。没有伪造 Host API、健康快照或任务回执，所有 `/api` fixture 路由已移除。Next API rewrites 保持原状。
- 最终浏览器探针要求 API 请求数为零。没有读取用户 API、配置、Redis 或原生客户端 HOME；Redis 环境值显式为 6398，实际上未启动或连接 Redis。

## 已执行检查

1. `pnpm install --frozen-lockfile` 成功，使用该工位锁文件与独立 workspace 链接。
2. 构建 `@cat-cafe/mcp-server`，补齐 Web 类型检查需要的 dist；初次 tsc 缺少该依赖产物，不通过更改产品类型掩盖。
3. Web `tsc --noEmit --pretty false` 通过。
4. 新增及改动文件的 Biome error 级检查、`git diff --check` 通过。
5. 既有侧栏测试两文件 16 项通过：`thread-sidebar-v2-header.test.tsx`、`thread-sidebar-v2-groups.test.tsx`。
6. 无头 Chromium 走通合成体验：v2 顶部入口、监听范围清空禁用、Escape 关闭、同一事项反馈、决定与交付、暂停、连接修复、安装后设置、390px。
7. 手机视口单独核对首个决定按钮位于输入框上方，页面无横向溢出；不通过测试脚本手动滚动来掩盖首屏问题。

截图和机器回执位于工位 `artifacts/superagent-preview/`：

- `desktop.png`：原生组件侧栏、入口与主对话。早期 `classic.png` 不作为最终版本的通过证据。
- `scope-desktop.png`、`scope-mobile.png`：范围设置。
- `mobile.png`：390px 下当前决定与回复。
- `paused.png`、`delivery.png`：暂停与原处结果样例。
- `probe.json`：浏览器异常、实际 API 请求和验证边界；不会将此回执标为真实成员验收。

复跑：

```powershell
node packages/web/test/browser/superagent-preview.design-probe.mjs
pnpm --filter @cat-cafe/web exec tsc --noEmit --pretty false
pnpm --filter @cat-cafe/web exec vitest run src/components/ThreadSidebar/__tests__/thread-sidebar-v2-header.test.tsx src/components/ThreadSidebar/__tests__/thread-sidebar-v2-groups.test.tsx
```

## 预览实例台账

| 项目 | 值 |
| --- | --- |
| 负责人 / 原任务 | codex / `task:work:0001793720663272-000609-8bfe63c4` |
| 用途 | 供本线程确认新增交互方向，非功能验收环境 |
| 程序目录 | 当前工位 `packages/web` |
| 数据 | 仅工位内合成样例和浏览器本地设计状态，无用户数据副本 |
| 端口 | 5214；没有另启 API 或 Redis |
| 托管 | `preview:process`，origin=detached；这只证明当前存活，不承诺跨 invocation 存活 |
| 活跃记录 | `C:/Users/Administrator/.cat-cafe/preview-processes/33eb55007dce51f6.json` |
| 日志 | 同目录 `33eb55007dce51f6.log` |
| 源码 / 浏览器 revision | `59d124ea86b026a48223f197091eceae480f1b2e`；后续仅补验证记录与截图 |
| 当前 PID | 租约 runner 20248，5214 监听进程 17328；后续以 managed status 与实际监听回读为准 |
| 租约 | 当前登记到 `2026-11-03T18:17:43.857Z`，到期停止；最新 PID、状态以 managed status 为准 |
| 保留 | 供用户体验；不自动安装 EXE、创建快捷方式或改在线 runtime |

初次从仓库根目录启动时，Next 未使用 Web 包的 Tailwind 工作目录。该尝试已停止，原 PID 45184 已退出。第二次 5212 实例的 runner 37220、第三次 5213 实例的 runner 47592 也已停止；5212、5213 已回读无监听。但 Windows managed stop 未完成 cleanup 回执，重复 canonical stop 后仍 unsettled，因此保留 `9bc6535e76fe7cfa.json`、`2bade21c746123d8.json`、`a52fa58ab285784d.json` 诊断，未手改托管记录。当前仅一个 5214 实例运行。完整 AppShell 尝试还暴露合成健康快照字段不足和未提供原生后台服务的问题。最终体验稿改为原生组件组合，移除这些 API 替身；不将最初失败冒充产品缺陷，也不把组件体验稿称为完整 Host 验收。

启动时在工位根目录显式设置以下环境，再使用 managed launcher；不得省略隔离端口：

```powershell
$env:NODE_ENV = 'development'
$env:API_SERVER_PORT = '3214'
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3214'
$env:SUPERAGENT_PREVIEW_FIXTURES = '1'
$env:REDIS_URL = 'redis://127.0.0.1:6398'
$env:NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION = (git rev-parse HEAD)
node scripts/preview-process.mjs start --port 5214 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --lifetime-seconds 7200 -- node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 5214
```

状态与停止使用同一 target cwd：

```powershell
node scripts/preview-process.mjs status --port 5214 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --json
node scripts/preview-process.mjs stop --port 5214 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --json
```

没有构建安装包，不存在版本号/EXE 哈希或真实插件发布证明。未做非作者产品审查、macOS 实跑、真实账户/模型执行、消息恢复或多人 Channel 验收。
