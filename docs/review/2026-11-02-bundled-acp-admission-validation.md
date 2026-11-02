---
feature_ids: []
topics: [plugins, acp, bundled-packages, regression]
doc_kind: verification
created: 2026-11-02
---

# 内置 ACP 插件准入：实施与验证记录


## 复审修订验证（2026-11-02）

本节是当前实现的验收结论；后面的初版记录属于 `cddfc25179c6eda69fd98f64ba1c6540c28ca3dd` 及以前提交，不能当作本轮批准。mindfn、YukinaXSer 和 zts 的意见及用户选择的默认 auto 已回填到[修订契约](../plans/2026-11-02-pr1776-review-revision.md)。维护者对新 HEAD 的复审尚待回复，PR 保持不合并。

| 约定 | 实物与证据 |
| --- | --- |
| 发行来源不决定 runtime | 删除 bundled 专属例外，构建/所有归档入口共用能力校验；同字节 ACP、stdio、静态包经 catalog/upload 的判断一致；存在但非法的声明、不支持 runtime 一致拒绝 |
| 保留 builtin 实际能力 | 未删除 Dot、模块、静态资源或 stdio carrier；现有图标、包定位、更新和资源边界套件通过；Dot 0.1.2 与修订前 producer 的 tgz 逐字节相等，SHA-256 `eee081361b5f10b14dbb0e78a7adce84cec26e90c48ea1144f3f0d2eac77863d` |
| 未设置权限不因接入形态分叉 | 固定与目录解析结果对 unspecified/deny/auto_allow 相同；仅删除固定客户端注入的缺省 deny。保留显式声明/已存策略、owner 对 auto_allow 的确认及 pool 策略隔离 |
| 成员 auto / ask user | 使用原成员高级接入入口，`executionApproval` 保存于原成员目录并回读；默认 auto；原生 ACP、固定插件与目录共用 factory/service；不新建授权表、存储或消息 API |
| 真实确认链 | 两种编译 transport → RuntimeInteractionService → MessageStore 卡片/发布 → 原用户响应路由 → 原 ACP 请求 id/选项；分别覆盖同意、拒绝、取消、中止、过期、跨 owner 和重复/迟到回复 |
| 旧限制保留 | 显式 deny、iCode 默认拒绝和 AGY guard 先于用户确认；ask user 不能提高原有权限；确认服务不可用返回协议错误 |
| 安装/更新/恢复 | CodeAgent/RelayAgent 隔离发行布局经真实 index/tgz、Manager、inventory、声明注册、ACP factory/pool、NDJSON fixture；一个成员 auto，另一个成员 ask user，经真实回复路由确认；成员隔离、续聊、停用再启用、临时下载重试与坏更新保旧通过 |

验证输出集中在工作区外 `artifacts/pr1776-ci-followup-20261102`：

- 完整 API build（含 shared/MCP 构建和 producer）通过；Web TypeScript 检查通过；Biome、frontmatter delta、approval producer registry、diff 检查通过。
- `permission-green3.log`：交互/成员持久化/固定连接 17/17；`acp-permission-transports.test.js`：两 transport 决策矩阵 12/12。
- `admission-regression.log`：52 项通过，2 个新增对照的状态断言读错 inventory 字段；修正为读取 Manager projection 后，`source-parity-green.log` 2/2。该组最终 54 项均已验证。
- `client-regression.log`：178 项通过，4 项原先等待 activation 拒绝坏声明的断言因拒绝前移到 admission 而失败；相应测试改为断言 admission 的 UNSUPPORTED_TRANSPORT 后，在 `lifecycle-build-regression.log` 的 93/93 中通过。保留原始失败日志，不把这 4 项说成未修前通过。
- `member-routes-regression.log`：成员 CRUD 路由 69 项通过，含 POST/GET/PATCH/reload 确认策略与拒绝非法枚举；目录组有 1 项被本次组合命令错误预加载的 CAT_TEMPLATE_PATH 干扰。用修改前两个目录模块作 loader 对照，同一预加载方式复现；正确独立入口的 `catalog-standalone-green.log` 为 44/44。不改产品代码绕过该测试。
- `web-regression.log`：20/20；新增三个 UI 测试覆盖原生/固定插件/目录的同一控件、无关连接参数不变与保存 payload。
- `member-approval-browser.json` / `.png`：当前 worktree 的真实 MemberAdvancedFields 在隔离 headless Chromium 中切换 auto → ask user → auto，无 page error。该证据是组件交互检查，使用简单页面样式，不冒充安装版完整页面/模型验收；浏览器已关闭，没有新建 Host 服务。

各组包含重叠测试，不累加为不重复覆盖量。HTTP 的问题仅证明明确拒绝被 experimental transport 忽略，未认定发生了真实 CodeAgent 越权事故。

RED 证据包括修订前真实 transport 12 项矩阵中 7 项失败（HTTP 忽略 reject、缺少 session handler/响应围栏等）及固定/目录默认策略与 bundled stdio/static 对照。原始日志保留；新增 ask-user 确认端到端使用真实 Host 交互服务和协议 fixture，不伪称现场原生验收。

独立 fresh-context scan 固定在 `5b74c49b38391b823117fdc865dbfeeac62d0184`，仅生成 findings，不产出批准：

1. FC-1（P2）：AGY guard 只允许 allow_once，外层卡片却可以选 allow_always。修正为卡片和回传仅接受 guard 已允许的那个 allow 选项及拒绝/取消。
2. FC-2（P2）：HTTP promptStream 等待确认时，取消/预算超时没有中断 handler。把 transport controller.signal 经共同 handler 的可选上下文传入原 RuntimeInteractionPort；复用同一取消语义，不另开通道。
3. 作者同时补齐 empty-resume replacement：每次 provider-session binding 都先取消上一次 binding，旧卡片不能在新 session 活跃后迟到放行。

`permission-lifecycle-red.log` 对上述场景观察到 4 项失败（HTTP cancel/budget 分开）；`permission-lifecycle-green.log` 为修正后 27/27，含原 23 项决策/交互矩阵及 4 项新回归。HTTP 测试使用真实编译 client.promptStream 和真实 RuntimeInteractionService，以内存 ReadableStream 代替 fetch，不连接外网、不开监听。重绑测试经过真实 AcpAgentService 的空响应重试分支，核对旧交互已失效与迟到请求取消。

最终完整构建通过（api-build-final.log）；受上述修改影响的客户端/空响应重试/iCode/AGY/权限组 127/127（permission-clients-final.log），CodeAgent/RelayAgent 安装/执行主旅程重新验证 2/2（bundled-execution-final.log）。既有 Runtime Interaction 服务/路由/消息发布组 28/28（runtime-interaction-regression.log）。

Fallback scanner 按 next 基线的最新报告触发增长提示；新增条件用于缺省配置、原生 guard 分流及取消生命周期，没有增加安装失败后的另一种低信任执行路径。来源和能力由错误的 bundled/builtin 绑定改为共同判定；异常仍报错或取消，未降级为自动允许。最终 scanner 输出保存在同一 artifacts 目录。

新提交 `2e3b717b4` 的首次 CI 暴露 Directory Size Guard：ACP 根目录 26 个文件超过 25 上限。仅将本次新增的两个权限模块归入 permissions 子目录并更新内部引用，根目录降为 24；不新增目录例外、不修改门禁阈值。后续回归和新 CI 以包含该布局修正的 HEAD 为准。

本次未修改用户配置、历史、认证或系统盘/祖先 ACL。没有运行真实企业模型，不重复旧模型调用，不安装测试 EXE；测试 child/server 均限自有临时环境并在退出时关闭。仍需内网验证实际企业 tgz、原生 CodeAgent/RelayAgent、认证、模型/MCP/角色协作和包升级；不关闭插件 Issue #178。


## 目标与边界

来源：[插件仓 Issue #178](https://github.com/zts212653/clowder-ai-plugins/issues/178)；[已批准方案](../plans/2026-11-02-issue178-bundled-acp-admission.md)。PR 目标为 `next@74b5bfd4d59c3722c76140d9df36e332b72a0acd`，本轮不合并，不打包 EXE。

Architecture cell：`plugin`，复用既有包准入、carrier、配置存储和 ACP provider。Map delta：none；没有新增架构所有者。五轴风险：包安装行为有变；数据无迁移；保留摘要、注册表、隔离和本机 owner 鉴权；固定连接声明增加可配置字段与默认拒绝权限；代码可回退，无不可逆数据操作。

`next` 尚未包含 develop 的固定客户端连接能力。本次仅移植 #1745 中必要的声明解析、连接覆盖、权限决策和 root-only 恢复，未整体合入角色重构或 #1762。固定客户端继续使用 manifest 的普通 string 配置字段；多客户端目录的编辑器契约不变。

## 根因与修改

- 旧安装器将 `distribution=bundled` 等同于 `runtime.transport=builtin`，纯 ACP 声明包在启动原生程序前即被拒绝。新规则仅接纳原有 builtin 或无 runtime 且具有合法 ACP 声明的包；不按客户端名称分支。
- 构建与安装共用同一声明解析/准入规则，构建将声明实际打入归档；没有 icon 的声明包不必伪造 SVG。坏构建输入保留上一次输出，`--check` 只读。
- 包仍需注册身份匹配、SRI、完整归档预检、路径/类型检查、manifest 身份/版本及 inventory 生命周期校验。损坏摘要保留隔离，不提供重试绕过。
- Windows 系统 tar 的 CRLF 列表留下尾部 CR，使静态读取器找不到 canonical manifest。仅识别行分隔符，不放宽归档路径规则；后台 tar 调用隐藏窗口。旧测试的 URL pathname 改用 fileURLToPath，保留原有断言。
- install/update/upload 失败各记录一次安全 warn，带 reqId、操作、可用来源/标识及公开错误码，不记录 body、命令参数、路径、认证和 cause。

## RED 证据

1. 新增真实 catalog 路由测试在旧门禁返回 422 / UNSUPPORTED_TRANSPORT，错误为 `bundled archive must retain its builtin runtime`。
2. 构建测试在旧 producer 上发现归档缺少 `package/agent-provider.json`。
3. 诊断测试在旧路由得到 0 条失败日志，期望 3 条。
4. Windows tar 列表测试在修复前得到 `package/manifest.json\r`，无法匹配应有成员名。

## 已执行的验证

本机 Windows，Node 24.16.0。命令从本 worktree 执行；测试统一使用 `packages/api/scripts/with-test-home.mjs`，不启动或连接共享 Redis。

| 检查 | 结果及含义 |
| --- | --- |
| `bundled-acp-admission.test.js` | 最终 9/9（含成员投影、再启用）。两客户端真实 catalog 路由及同字节上传、启用/停用、瞬时下载失败重试、失败更新后合法更新、坏摘要隔离、非法声明负例、不同名称客户端 |
| 构建/准入/路由/权限/恢复组合回归 | 121/121。包括 source/compiled producer、check 只读、坏输入保留旧输出、canonical gzip/闭包、固定连接与 root-only 恢复、CRLF、旧 builtin/身份/摘要/资源、日志脱敏 |
| 声明/目录/生命周期/绑定组 | 81/81，测试进程使用已有 trusted-host 模式；未改部署默认值或系统盘/祖先 ACL |
| 临时目录收尾后的恢复套件复验 | 29/29，属于上述 121 项的子集，不重复累计；仅清理 helper 当次记录的自有 fixture 根 |
| `pnpm --filter @cat-cafe/api run build` | 通过，包含 shared、MCP、API TypeScript、bundled 产物和 recorder census |
| Biome / frontmatter / capability tips | 修改的 TS/JS 无错误；3 份 Markdown frontmatter 通过；tips 检查通过，既有复杂度及失效文档 anchor 告警保留 |

三组主回归共 211 项通过；29 项收尾复验不重复累计。CodeAgent 和 RelayAgent 的同一客户端连续会话与不同成员隔离、权限拒绝、停用后再启用均有实际 ACP 管道输出。最终构建后未再修改产品代码。

非作者审查：独立 reviewer 对 `f789832f13d61754a9710e47a2a814807b105309` 给出 approve，无 P1/P2，并独立执行构建/固定连接权限/CRLF/诊断 10 项通过。两处非阻断文案意见已按实现收窄：reqId 关联请求日志，不声称响应新增标识；默认 deny 限定本次固定客户端，不改写旧目录策略。

公共测试：原有 Windows planner CLI 在 `spawnSync('pnpm')` 无法执行 pnpm.ps1 时返回 `could not resolve pnpm version: undefined`。未将这项报绿或顺带改 CI；改用同一 resolver/planner/validator API，并通过 PowerShell 实测 pnpm 9.15.4、记录真实 tree/lockfile/toolchain，得到 2968 个入选测试，新增 5 份测试分别进入 distributable 分片。记录为 `public-test-selection.log` / `public-test-plan-manual.json`，不冒充全套公共测试执行结果。

Fallback scanner 已按 next 基线执行并提示净增 25。核对：修复的是“发行来源被当成 runtime”这一错误分类，没有增加安装失败降级；scanner 把测试协议/动作分派的布尔条件也计为 fallback。生产连接读取的优先级是“owner 已存值 → manifest 默认 → 空覆盖”，用于保留已有配置；权限缺省固定为 deny。JSON 边界拒绝和已知 I/O 分类保留原错误语义，不通过另一执行器或不受校验路径重试。

固定连接成员投影使用普通 connection 字段，避免误选多客户端目录编辑器；执行 fixture 同时覆盖停用后重新启用。新增该调用时曾漏传 invocationId，Host 正确拒绝，已补齐测试输入，未放宽生产校验。

上述 9 项集成使用隔离的发行布局：复制本工位编译产物，写入真实 bundled index 和 canonical tgz，在独立进程加载冻结注册表，经真实 Manager、文件 inventory、包定位器和 HTTP 路由执行。鉴权测试身份与审计 writer 为测试注入，不声称覆盖浏览器登录或生产审计落盘。

CodeAgent 0.1.0 和 RelayAgent 1.0.0 的声明形状来自 Issue；执行阶段明确改用 Node NDJSON fixture，通过真实 RegisteredSessionAgentService → ACP factory/pool。验证两个成员不共用 native session、同成员续聊、权限默认拒绝。fixture 不读取认证、不连接模型或外部网络。

更新测试跨子进程重载真实插件配置，比较同一实例与配置；另检查绑定/历史哨兵文件未被包生命周期改写。实际成员配置磁盘回读由既有 client-library-persistence 测试覆盖；哨兵文件不等于真实原生会话历史或业务存储恢复验收。

原始严格模式回归中，5 项既有 invocation 测试因本机临时目录祖先 ACL 返回 PARENT_REPLACEMENT。仅为测试子进程设置 trusted-host 后，这 5 项及相应组通过；严格模式原始失败保留在日志中，不报告为默认严格模式全部通过。

## 现场仍需验证

未取得包含 `71020406f` / `8270e59a9` 的企业源码与实际 tgz；没有真实 CodeAgent/RelayAgent 程序及企业认证。故不宣称已验证现场归档、真实模型、system/persona、MCP/角色协作、企业安装包升级或重启续接，也不自动关闭 Issue #178。

集成者按[操作指南](../ops/bundled-acp-plugins.md)保留实际归档版本/SRI，吸收 Host 增量后验证 catalog 安装和更新；已有用户只在必要时修正原连接字段，不清 inventory、配置、认证或历史，不重建角色。

## CI 跟进：Linux 测试布局修正

`be4e0693b31acba03116fe21e0c614d508bf64c6` 的 CI 中，Lint、Build、Windows（含 installed layout）、macOS 及其他公共测试分片通过；distributable-5 的两项新增执行测试失败，Test (Public) 随之聚合失败。

日志中的首个原因是 `guarded-zsh-directory` 创建目录时 EACCES：测试把 API 编译产物放在 `/tmp/<fixture>/dist/utils`，而实际 CLI guard 按 `packages/api/dist/utils` 层级向上解析 runtime 根。前者得到 `/`，因此触发 `/.cat-cafe/tmp/guarded-zsh` 写入拒绝。此处还没有启动 CodeAgent/RelayAgent；不是包校验、模型认证或原生客户端返回的失败。

修正仅涉及测试布局：复刻 `<fixture>/packages/api`，把 workspace marker、模板和词表放在 fixture 根；Unix 执行时再用真实 `buildChildEnv` 检查 guard 根确实位于自有 fixture，比较规范路径以兼容临时目录别名。原安装、成员隔离、权限拒绝、更新/重试及停用/启用断言均保留，不跳过 Linux、不改生产 guard、不增加权限或 CI 例外。

布局修正后，本机 Windows 同一套集成测试 9/9 通过，Biome 和 diff 检查通过。已注册的 WSL 发行版因 VHDX 路径缺失无法启动，未修改或修复该系统环境。Linux 修正后的通过结果须由更新提交的 CI 给出，不用 Windows 结果替代。CI 日志与复验日志位于 `artifacts/pr1776-ci-followup-20261102`（聚合工作区的仓库外目录）。

## 环境与收尾

- 工位：`G:/AIwork/clowder-ai/worktrees/fix-issue178-bundled-acp-20261102`；负责人 codex，关联 Issue #178。保留用于 PR 修改，2026-11-09 复查。
- 原始日志集中在仓库外 `G:/AIwork/clowder-ai/artifacts/issue178-codeagent-install-analysis-20261102`，包括 RED、各组回归、原始严格模式失败与兼容模式复验。
- 没有安装测试 EXE、创建快捷方式、后台交互服务或监听端口；新增集成测试的 finally/shutdown 关闭 fixture 进程，测试退出移除自己的临时目录；恢复 helper 也只清理它当次记录的 fixture 根，不按名称批量清理旧目录。
- 没有改用户运行环境、系统盘根/祖先 ACL、.env、认证、角色、会话、Redis/SQLite 或历史；现有引导逻辑仅维护自己创建的临时私有目录。回退仅回退代码。PR 不合并。
- 最终测试退出后，已核对没有遗留 `bundled-acp-agent.mjs` / `bundled-acp-probe.mjs` 进程；没有停止其他任务的服务。既有、无法核实归属的旧临时目录未按名称批量删除。

## 回归命令

以下从 `packages/api` 运行；完整构建在仓库根运行上表命令。

```powershell
$regressionTests = @(
  'test/plugin-archive-member-listing.test.js',
  'test/f322-bundled-plugin-icons.test.js',
  'test/plugin-official-package-installer.test.js',
  'test/plugin-official-package-installer-refresh.test.js',
  'test/plugin-manager-routes.test.js',
  'test/acp-bootstrap-config-recovery.test.js',
  'test/acp-bootstrap-config-route-recovery.test.js',
  'test/acp/acp-pool-signature.test.js',
  'test/bundled-acp-build.test.js',
  'test/bundled-plugin-build.test.js',
  'test/bundled-plugin-artifacts.test.js',
  'test/bundled-plugin-closure.test.js',
  'test/fixed-acp-connection.test.js',
  'test/plugin-package-diagnostics.test.js'
)
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=120000 @regressionTests
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=240000 test/bundled-acp-admission.test.js

$clientTests = @(
  'test/agent-session-contract/plugin-declaration.test.js',
  'test/agent-session-contract/client-library.test.js',
  'test/agent-session-contract/client-library-persistence.test.js',
  'test/agent-session-contract/client-library-lifecycle.test.js',
  'test/agent-session-contract/client-library-invocation-ownership.test.js',
  'test/agent-session-contract/plugin-lifecycle.test.js'
)
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 --test-timeout=120000 @clientTests
```
