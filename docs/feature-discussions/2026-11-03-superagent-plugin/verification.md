---
feature_ids: []
topics: [superagent, design-preview, verification]
doc_kind: verification
created: 2026-11-04
status: synthetic-preview-only
---

# 体验稿验证与实例台账

本轮交付是源码依据、架构提案和真实 Clowder 壳内的体验稿。插件包、语义判断、真实监听、任务准入、成员执行和恢复均尚未交付。以下记录只证明体验稿及其隔离边界。

## 工位与样例边界

- 工位：`G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103`
- 分支：`feat/superagent-plugin-20261103`
- 基线：`upstream/next@0fb68bc03455507836a0a35a706985a1ccc66058`
- 保留原因：等待本线程的体验方向确认，后续沿同一任务实现；生命周期已登记 owner=codex。
- 体验路径：`http://127.0.0.1:5212/dev/superagent-preview?shell=v2`；classic 将参数改为 `shell=classic`。
- UI 来自实际 AppShell、ThreadSidebar、WorldRail 和产品 token。顶部行只在 development 的此体验路由插入；生产路由为 notFound。
- 三个会话、两个工作和所有消息均为固定合成样例。状态转移由显式样例操作驱动，没有调用模型或外部服务。
- `SUPERAGENT_PREVIEW_FIXTURES=1` 只在当前 development 实例提供合成 `/api/session`，并关闭本地 API rewrites，防止预览自代理；其他 API 不伪造成功响应。
- `API_SERVER_PORT` 与 `NEXT_PUBLIC_API_URL` 显式指向本预览端口。没有读取用户 API、配置、Redis 或原生客户端 HOME；Redis 环境值显式为 6398，实际上未启动或连接 Redis。

## 已执行检查

1. `pnpm install --frozen-lockfile` 成功，使用该工位锁文件与独立 workspace 链接。
2. 构建 `@cat-cafe/mcp-server`，补齐 Web 类型检查需要的 dist；初次 tsc 缺少该依赖产物，不通过更改产品类型掩盖。
3. Web `tsc --noEmit --pretty false` 通过。
4. 新增及改动文件的 Biome error 级检查、`git diff --check` 通过。
5. 既有侧栏测试两文件 16 项通过：`thread-sidebar-v2-header.test.tsx`、`thread-sidebar-v2-groups.test.tsx`。
6. 无头 Chromium 走通合成体验：顶部入口、监听范围清空禁用、Escape 关闭、同一事项反馈、决定与交付、暂停、连接修复、安装后设置、v2/classic、390px。
7. 手机视口单独核对首个决定按钮位于输入框上方，页面无横向溢出；不通过测试脚本手动滚动来掩盖首屏问题。

截图和机器回执位于工位 `artifacts/superagent-preview/`：

- `desktop.png`、`classic.png`：实际侧栏、入口与主对话。
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
| 端口 | 5212；没有另启 API 或 Redis |
| 托管 | `preview:process`，origin=detached；这只证明当前存活，不承诺跨 invocation 存活 |
| 活跃记录 | `C:/Users/Administrator/.cat-cafe/preview-processes/2bade21c746123d8.json` |
| 日志 | 同目录 `2bade21c746123d8.log` |
| 租约 | 当前登记到 `2026-11-03T17:55:07.090Z`，到期停止；最新 PID、状态以 managed status 为准 |
| 保留 | 供用户体验；不自动安装 EXE、创建快捷方式或改在线 runtime |

初次从仓库根目录启动时，Next 未使用 Web 包的 Tailwind 工作目录。该尝试已停止，原 PID 45184 已退出；旧记录 `9bc6535e76fe7cfa.json` 因 Windows cleanup 未完成回执保留诊断，不是另一套运行实例。现实例的实际 cwd 为 `packages/web`。预览的同源 API 自代理问题已通过 development fixture 的明确 rewrites 边界修正。

启动时在工位根目录显式设置以下环境，再使用 managed launcher；不得省略隔离端口：

```powershell
$env:NODE_ENV = 'development'
$env:API_SERVER_PORT = '5212'
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:5212'
$env:SUPERAGENT_PREVIEW_FIXTURES = '1'
$env:REDIS_URL = 'redis://127.0.0.1:6398'
$env:NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION = (git rev-parse HEAD)
node scripts/preview-process.mjs start --port 5212 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --lifetime-seconds 7200 -- node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 5212
```

状态与停止使用同一 target cwd：

```powershell
node scripts/preview-process.mjs status --port 5212 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --json
node scripts/preview-process.mjs stop --port 5212 --cwd G:/AIwork/clowder-ai/worktrees/feat-superagent-plugin-20261103/packages/web --json
```

没有构建安装包，不存在版本号/EXE 哈希或真实插件发布证明。未做非作者产品审查、macOS 实跑、真实账户/模型执行、消息恢复或多人 Channel 验收。
