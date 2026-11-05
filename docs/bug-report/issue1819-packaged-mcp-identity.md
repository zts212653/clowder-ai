---
topics: [acp, mcp, thread-scope, packaged-runtime]
doc_kind: bug-report
created: 2026-11-04
tips_exempt: "修复既有 MCP 交付路径，不新增用户操作或能力。"
---

# #1819：安装布局使普通 ACP 的 MCP 回调绑定失效

授权：本线程用户要求隔离 worktree 实施修复、独立审核验证并提交目标为 next 的 PR。砚砚负责方案与实现，宪宪负责独立审核验证。本轮不修改当前安装 runtime、配置、用户会话或其他工作线。

## 可区分候选原因的证据

事故轮使用普通 ACP resume，session ID 属于原 thread，没有观察到 native session 混绑。Host 日志有六个 MCP 配置及回调字段，但 native 成员报告 callback config 未配置。

对安装版 API 的真实模块解析做只读检查，发现两套物理副本：API 的 `@cat-cafe/mcp-server/dist/managed-mcp-config.js` 来自安装根下的 `node_modules/@cat-cafe/mcp-server/dist`；Host 生成的启动入口却来自 `packages/mcp-server/dist`。两边的 collab.js SHA-256 相同，但 realpath 不同。通过 API 实际导入的模块调用 `isInstalledManagedMcpServer`，标准 Host 描述符返回 false；直接导入另一份 packages 模块则返回 true。

与此相符，事故使用的 session/new 元数据包含六个 stdio server，但每个 envKeyCount 都是 0。`acp-session-env` 在准备回调字段后，因 managed entrypoint 身份不匹配，没有把字段绑定到真正的子进程描述符。这里定位的是 MCP 交付失败机制；它不证明模型随后执行另一工作线的全部认知过程。

此前 scoped-member、`.cmd` 资格候选与事故路径不符，不作为修复目标。

## 引入点与平台范围

`289e124f79c256ce446d88d4809293c6687992f1`（#1731，2026-10-28）引入 `managed-mcp-config.ts`，并把普通 ACP 的名字前缀注入改为安装入口真实路径校验。两份物理副本的布局因此会触发此处交付失败。不能把该提交日期等同于完整串线行为首次出现的日期。

故障判定没有平台分支。在 Windows 安装版已只读复现；其他平台若存在相同双副本布局，也满足同一失败条件，但尚未做 macOS/Linux 实机验收。

## 最小方案

运行中的 API 应通过其实际导入的 `@cat-cafe/mcp-server` 包解析第一方启动入口，与身份检查使用同一个包实例。保留原来的真实路径、Node 可执行文件和第三方服务器隔离检查。

同一根因也影响 Codex 捕获的第一方描述符、公共 native provider 的 shared HTTP 物化，以及 OpenCode 的回调绑定。四个执行入口使用同一解析函数；持久化能力配置、开关、第三方 MCP 路径与用户项目路径的归属不变。

不通过扩大可信目录、按名字注入凭据、复制更多 env 或给错误布局加 fallback 修复。

## 验证与回退

1. 用独立的同内容 MCP 副本模拟安装布局，调用生产 ACP/native/Codex 解析入口。RED 必须表现为原布局下回调身份不绑定或 shared HTTP 物化失败，而非导入/语法错误。
2. GREEN 后通过真实 MCP client/server 调用，验证两个逻辑会话及一次 resume 的回调身份互不串用；伪造同名第三方副本仍不获得回调权限。
3. 跑相关 ACP、provider、Codex 配置与权限边界回归、API/MCP 编译及差异检查。测试使用独立 HOME、临时文件和随机端口，不连接用户 Redis 或真实 provider。
4. 宪宪审核最终 exact HEAD 并独立验证。修复源码与当前运行实例分开，未部署不能声称线上已修复。

回退为撤销本次源码提交，无数据迁移、新依赖或持久化配置修改。

Architecture cell：provider；Map delta：none。仅统一既有第一方启动入口与身份检查的来源，没有新增路由、存储或权限模型。

风险：行为为第一方启动路径变化；数据无迁移；安全保留真实路径/Node/第三方隔离；契约保留配置与能力开关来源；不可逆影响为无。

## 作者验证（2026-11-04）

- RED：ACP/native/Codex 的三个安装副本用例均失败；补扫 OpenCode 后独立用例同样因缺回调身份失败。
- GREEN：`acp/acp-packaged-mcp-binding.test.js` 四项通过。通过真实 stdio MCP 子进程执行 `A → B → A-resumed → B` 的 `cat_cafe_get_thread_context`，请求均携带对应合成身份，A 的续接刷新复用 A 的凭据文件且不改变 B。相同内容的第三方副本仍被拒绝绑定。
- ACP 会话环境、resolver、direct resume、冻结配置，Codex/native/Kimi/OpenCode 冻结配置，shared MCP carrier 相关回归通过。
- `invoke-mcp-workspace-root.test.js` 22 项通过；master disable、member block、显式 project、不可读来源拒绝回退和第三方路径来源断言保留。二进制断言改为 API 实际导入的包。
- OpenCode mcp-path 冻结断言同步到包实例来源后，四项完整测试通过；首次配置、Codex 项目兼容、OpenCode namespace 隔离回归通过。
- `direct-mcp-migration.test.ts` 使用 `--import tsx` 后五项通过；首次未带 TS loader 的模块导入错误不计为实现失败或通过证据。
- MCP build、API build 及最终 API `tsc` 通过；桌面 bundle/module identity 五项通过；Biome error 级检查、`git diff --check`、capability tips 检查通过（tips 有现存 anchor 警告）。公开仓库没有 `check:architecture-ownership` 脚本，架构边界由上述人工判断覆盖。

实际使用路径：安装版只读取证 → 生产解析入口的双副本回归 → 两个真实 MCP 子进程调用及续接身份回读。完整真实 DSH 模型行为旅程尚未验证；测试不接真实 provider、不重放用户委托、不执行 GitHub/其他 thread 写入。安装版未部署新源码，#1819 的完整跨委托范围行为仍需继续追踪；本修复不宣称用 MCP 交付修复代替 shell/Hub 权限边界。

独立审核：由宪宪绑定最终提交回传，见本次 PR/原线程的审核事实。
