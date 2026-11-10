# Playwright MCP Reference

## 是什么

- Microsoft 官方 MCP server
- 面向 MCP 原生客户端，提供结构化浏览器工具
- 官方文档明确强调 accessibility snapshot 工作流，不要求 vision model

## 什么时候优先

- 客户端原生支持 MCP
- 任务是常规网页自动化、截图、Console、页面检查
- 想要稳定、标准化的浏览器工具面
- 本地 WebApp 验证需要和现有 Playwright 生态对齐

## 接入前提

- 客户端已经稳定接好 MCP
- 任务更偏工具面稳定，而不是“接手某个现有浏览器会话”
- 如果是本地 WebApp 验证，优先跟 `webapp-testing` 绑定使用

## 家里的默认：后台无头

- 受管 `playwright` 是 Host 解析的 `resolver: "shared-browser"`（F333）：全家共用一个后台无头 Chrome，每个工作目录一份登录。你连的是 API 的 `/api/browser-mcp/mcp`，不会再为你的会话单独起 Playwright 进程。固定版本 `@playwright/mcp` 0.0.84，不走 `npx …@latest`。
- 标签页按线程分：同线程的猫互相看得见、能接手对方的标签页（`browser_tabs` 选过去）；你的第一页是新开给你的，排在最前；别的线程的页面你看不到。要不带任何登录的干净环境，用 `browser_tabs` 的 `new` 并给 `isolatedContext` 起个名字。截图、下载等输出在 `<工作目录>/.playwright-mcp/<threadId>/`。`browser_close` 会被拒绝（共享的登录关不掉），不用的标签页用 `browser_tabs` 的 `close` 关掉。
- `browser_run_code_unsafe` 在共享服务进程里执行任意代码：能读写所有线程的页面和全家共用的登录，也能让整个服务崩掉，影响所有正在用浏览器的猫。只在别的工具做不到时用，别在里面关上下文或动 cookie。
- Codex（app-server）里这个服务叫 `playwright_shared`，工具名照旧是 `browser_*`；同时会出现一个名为 `playwright` 的已关闭条目，它是为了压住 Codex 配置文件里可能已有的旧 stdio 条目，不用管它。
- 不走共享 HTTP 的载体（插件托管的受限成员、Codex exec_json、OpenCode）和终端里直接开的会话，用的是固定版本 + `--isolated`：能用，不会和服务抢锁，但没有家里的登录。
- MCP CLI 在 macOS 默认有窗口，不能用 Playwright Library 的默认值、CLI 的 `-p` 模式或工具名推断它无头；共享服务和回退都显式无头。
- 配置源是实际调用项目的 `.cat-cafe/capabilities.json`（项目 override 优先）；invocation 注入会覆盖同名客户端副本。修配置应从该受管源入手，再同步实际使用的独立客户端副本，不能只改 `~/.codex/config.toml`。
- 配置更新作用于新 invocation / 新建的 MCP 实例；不为立即生效停掉别猫的 server。旧实例模式不明时，改用自己新建的无头 Playwright 实例，不自动转系统 `open`、其他有头后端或人的 Chrome。
- 无头操作仍可截图、读取 DOM、执行 JS、点按钮和保存下载；不要为了截图调用系统浏览器。
- 登录存在按工作目录划分的固定配置里（`~/Library/Caches/ms-playwright-mcp/mcp-chrome-<hash>`），共享服务独占它。如果看到 `Browser is already in use for …`，说明有个没走共享服务的旧 Playwright 进程还占着这份配置（多半是 F333 上线前就开着的会话）：等那个会话结束，不要删这个目录，也不要杀别的猫的进程。

## 显式可见操作：保留能力，保持公共默认无头

用户明确要求“看着操作”，或当前任务明确包含在猫自有 profile 内可见首次登录时，使用具名自有 profile。打开前在回复里说明会出现可见窗口及原因，并在有人在场的交互回合执行；无人值守时保留可点击入口与恢复点。沿用已有授权，不再要求用户批准一次浏览器工具配置。

当前受管 MCP 不能在一次工具调用中切换 launch mode 时，可在已有 shell 能力内使用 Playwright Library 的 `chromium.launchPersistentContext(profilePath, { headless: false })`。`profilePath` 必须是该任务自行创建并持有的独立目录，不能指向人的 Chrome 数据目录，也不能强抢其他活跃会话。同一个 profile 登录完成后，关闭自己持有的实例，再用 `{ headless: true }` 继续，可保留该 profile 的登录态。

Clowder AI checkout 内的手写浏览器脚本用现有入口 `node scripts/run-with-gate-resource-permit.mjs --mode exclusive --stage standalone-web-browser -- node /absolute/owned-script.mjs` 启动；脚本自己关闭自有浏览器。外仓先查其原生命令，不搬不存在的家内入口。资源票不授予可见窗口或会话接管权限。不要为这一分支永久再注册一套 MCP、扩大访问范围或更改全局默认。

普通自测、无头失败、需要 Cookie 都不自动进入可见分支。确实必须本人确认的步骤交由人主动点击入口；不要把“需要人确认”当作激活人的默认浏览器的许可。

## 不适合

- 拿来做 localhost 页面“给operator看效果”的预览入口
- 在 CLI-only 场景里硬替代更适合的 agent-browser

## 额外提示

- 我们家本地 WebApp 的确定性验证，优先和 `webapp-testing` 搭配
- 对“接手已登录的人类 Chrome”这条 lane，不一定是最顺手的默认

## 在家里的定位

- MCP 原生客户端的默认浏览器后端
- 不是 localhost 预览入口
- 不是登录态接管 lane 的默认解法

## 官方来源

- https://github.com/microsoft/playwright-mcp
