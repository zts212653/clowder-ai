---
feature_ids: [F202, F241, F050]
topics: [agent, plugin, member, session, pdl]
doc_kind: plan
created: 2026-11-18
---

# Agent 接入插件化完整切换

状态：设计修订稿，等待独立复审。源于当前线程的交付委托和 PR #1982 底座补充。设计获独立批准后开始实现。验收以一个发往 `zts212653/clowder-ai:next` 的完整迁移 PR 为目标。

## 基线和复查坐标

- Clowder `upstream/next` 为 `8e3462f60ee306925f956bed4e4f96e6f87210fd`。仍开放的 [PR #1982](https://github.com/zts212653/clowder-ai/pull/1982) 的真实 head `d38110948d4a522bc61ea247ae02ff5e8c4cc635` 已包含该提交，与 GitHub 试合并 `9bcede9187b78c2a9d590099695eb8d08403e001` 同树。调研原产品入口用前者，改动和实机验收用后者。PR #1982 进入 next 以前，两份 PR 会共享其基线差异。迁移审查以 `d38110948...HEAD` 看本次变化，向 next 开 PR 时回读真实远端合并关系。
- F202 的包校验、声明、实例维护、worker 与 owner route 是既有装配骨架。#1982 固定的 `@clowder-ai/plugin-contract` 为 `0.4.0-candidate.0`，#1982 的 Host 能读取插件随包的 `console/pdl.yaml` 并投影到既有控制台。成员流程复用 Host PDL 入口，无须新建插件控制台。猫猫球配置迁移只作为单一 owner 的对照。
- F241 期望新增 runtime 无需 Host 增加分支，保留 Host 的工作区、进程权限、凭据签发及审计。当前 `declaredAgentSessionProviders` 在 activation 读 `agent-provider.json`，通过 Agent Client Library 展开 ACP 配置，经 `registerPluginAgentProvider` 注册到 `SessionImplementationRegistry`。创建者仍是 `index.ts` 注入的 `createRefreshingAcpSessionProvider` / `createAcpServiceForConfig`。未绑定的 ACP 以及原生、HTTP A2A 走另一条 Host 构造分支，`CAT_CAFE_AGENT_SESSION_CONTRACT` 缺省为 `plugin`，只有显式关闭或非法值会落到 `off`。该声明能力本身无法完成接入和角色管理。
- F050 记载已交付的 CLI L1 和待独立实机确认的 L2。当前 `index.ts` 能按环境中既有角色 ID 解析 A2A URL，`A2AAgentService` 实际使用同步 `tasks/send`，取消本地等待时会把远端终止标为未确认。产品内 `@角色` A2A、HTTP runtime、经插件寻址的 Collective 和 Dot 使用的路由各自核对。HTTP A2A 以源码路径和经脱敏确认的实启角色为准。本机当前产品目录的 v2 catalog 中无 HTTP A2A 角色绑定。按只读 inventory 查询，`official.collective-connector` 已启用且 runtime=healthy，Dot 当前无已安装实例。配置与进程健康不能证明目标路由已真实调用。独立环境分别验证 HTTP A2A、Collective 和 Dot。
- DeepSeek Harness 固定在 `2e39e70496aa02986ca6a820c5d497e816b69d7e`。其 bundle 显式列出 agent registry 和 loop 实现，loop 在 Cordis scope 内用 `ctx.effect` 调 `agents.setFactory(this)`，Agent handle 关联 owner 和 disposer。Clowder 可借鉴发行组合、能力声明和按激活释放，复用已有 F202 工具。Cordis 的容器和 context 链无须引入。 [Bundle](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/bundle/base/cordis.patch.yml#L82) · [Registry](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/core/agent/src/index.ts#L388) · [Loop](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/core/agent-loop/src/index.ts#L335)

- 既有 [#1748](https://github.com/zts212653/clowder-ai/pull/1748) 已由 [#1762](https://github.com/zts212653/clowder-ai/pull/1762) 带入 next。复用 `RoleProfile`、`ExecutionProfile`、`FrozenExecutionBinding`、`HostExecutionBoundary` 以及 catalog 的编辑 CAS 和原生停止事实。历史方案的实机缺口须在本任务重新验收。对当前 13 个接入和构造入口扫描静态值导入及字面量动态导入，联合依赖 485 个 API 源文件，含目录、账户、凭据和执行活动。包构建断言生产代码没有 Host 内部依赖，直接从现有路由入包无法达到这个边界。

## 调用链和归属

以一个默认发行的接入插件承接现有内置运行时、角色管理和既有 ACP 声明兼容。项目内置和自定义是同一份角色目录里的不同来源，同一个写入方。一个插件就能覆盖默认用户旅程，安装和升级时只新增一个必须就绪的组件。第三方 ACP 包仍可按已发布的声明安装和扩展客户端列表。

1. 在 #1982 的 PDL `#members` 保留默认底包 `members.detect` 插入、`nativeSetup` 弹窗和 `A.nativeDetect`。`pdl-doc.js` 启动先加载 default，再叠加选定主题。实际用默认和简约经典分别验证空名单与已有成员的入口，修复覆盖造成的按钮或锚点缺失。在 v2 `page.members` 恢复公开的 `members.actions` 槽位，由原插入渲染按钮。首次引导和成员页复用弹窗，明确区分打开来源。成员页关闭和完成只关窗并刷新角色，无权写引导回执。只有首次引导的关闭与完成分别写 `dismissed` 和 `completed`。保留 `#memberNew` 和 `#member-<id>`。PDL Host 通过版本化公开接入 API 获取客户端候选、状态和表单选项。API 在 Host 做 owner 鉴权，绑定项目和请求身份，交由当前接入插件处理。插件提供客户端类型、检测结果、登录操作、模型选择和角色绑定声明。PDL `member-actions.readMemberSettings` 直接把插件目录填进现有 `meta.clients`，沿已有 `type`、`pluginName` 和 `why` 展示。模型和运行时选项用同一目录。原先只从 `CLIENT_OPTIONS` 构造工具下拉，导致声明插件无法手动选择。托管账号沿现有登录窗口和浏览器授权，原生账号展示或复制对应 CLI 登录命令，用户在客户端按原方式完成。Host 通过安全接口执行打开窗口、启动命令和凭据签发。
2. 插件用同一角色服务执行创建、编辑、重新绑定、启停与角色卡投影。创建返回现有 `catId` 和 revision，Host 以提交成功后的角色目录更新会话候选和界面。同一写入不靠 UI 插入猜测状态。保留已用的创建回执、写版本和别名冲突检查。账户页面的批量选择也经同一写入方。Host 保留默认路由偏好，写入前按插件目录判断角色可用性。
3. Host 继续做线程身份、路由、队列、许可、执行账本、暂停与消息持久化。以 `catId` 和稳定服务引用解析可路由角色，再由 `RegisteredSessionAgentService` / 已有会话 bridge 消费公开协议。插件负责组装客户端调用、输出映射、有限会话能力、取消及释放；Host 转发已验证事件。成员列表 `member-projection`、编辑 `hub-cat-editor.model` 与聊天 `chat-models.memberCard` 读同一插件成员投影。保留 banner、模板和覆盖字段。HTTP A2A Card 与出站 JSON-RPC 按既有协议和可用性验证。
4. Host 的授权与通用 I/O 作为窄接口注入。复用现有工作区、进程准入、取消/回收、凭据、访问审计。插件使用受保护的账户引用和调用域，Host 把回调/MCP 载荷注入已获准的客户端进程或连接。第三方 `agent-provider.json` 仍为纯数据，生成受验证的启动计划并沿现有通用传输执行。可执行接入实现按 F202 已准入的一方包信任策略运行。worker 用来管理执行生命周期与 RPC。进程和凭据的授权沿现有 Host 机制，原始凭据、`hostOptions`、Host 内部对象及全局配置文件路径不进入公开协议。
5. 零角色时通过 `prepareHostInitialPlugins` 的既有 installer/reconcile/activate 安装随包归档。分发时内含该包的选择和归档坐标，离线首装沿同一安装事务使用本地包。包校验、准备或激活失败由现有 Manager 进度及失败状态回传。停用和卸载沿现有 tombstone 工序，启动遵从用户选择。Host 的同一检测公开入口总返回 `readiness` 和 `candidates`。插件已就绪才调用包探测；未安装、停用、准备中、损坏或不兼容时读取 Manager 的当前库存/生命周期状态，返回状态和可执行的安装、启用、重试或修复操作，动态候选为空。只有就绪且探测成功返回的空数组代表没有候选，仍可手动添加。明确区分已安装但需登录、未安装、候选已存在、需配置和不支持。部分失败仍给成功候选并允许重测失败项。现存会话历史可由 Host 读取，暂不可用的角色不可发起新调用。
6. 包利用现有 verified package、`ModulePluginRuntime` 和 worker lifecycle。包边界用 F202 owner 请求、声明文件与生命周期 phase，新增一个 Agent 接入能力和版本的协商。基于当前激活租约发现和调用。包契约与接入协议版本不兼容时，在包能力准入和归档预检阶段反馈，旧包仍运行；已停旧包但新包启动失败时由现有维护事务恢复上一个包。对升级中的目标插件明确返回暂时不可用并保留客户端输入，其他插件实例和路由继续。正常更新后的主动回退走 Manager 选择上一版本归档。对于当前源为 catalog 的安装，`confirmArchiveReplacement` 绑定旧包同名、digest、实例和 revision 并让 owner 确认。该路径不比较版本大小。对于同源 local-archive，既有同名替换也保留实例。测试使用准确包身份与校验路径。

## 公开协议

本次新增 `packages/agent-contract`，各自构建的 Host 和插件包复用该包导出的 Agent v1 schema、类型与操作枚举。包内新增 `agent-access.json`，含 `protocolVersion`、操作列表和传输能力，由现有 `readPackageCapabilityRejection` 入口在包准入时校验。继续使用 vendored manifest 与独立严格校验的 `agent-provider.json`，存量 ACP 声明包无需修改。Host 沿现有模块 worker 路径执行接入操作与回复流。插件向 Host 请求的范围限定存储、运行权限、账户引用，由 Host 按原请求或调用租约授权。无需跨仓修改现有 manifest schema，也无需新进程。

| 契约 | 约定 |
| --- | --- |
| 发现和兼容性 | F202 校验包与声明。接入协议独立版本 `1`，带可用操作和传输能力。同 major 允许新增可选字段或能力，Agent v1 wire envelope 解析后仅采用已知字段，既有 ACP 声明仍做严格校验。必需能力缺失或 major 不兼容即拒绝准入。包版本、协议版本、数据版本和 native resume 兼容版本分别比较。沿用安装 digest 和激活租约。 |
| 角色标识和投影 | 主键沿用 `catId`；归属用稳定 `pluginId + contributionId`，不把 digest 当作角色身份。以现有 `CatData` 字段为基线，投影包含 `id`（即 catId）、`configurationRevision`、`roster.available`、`agentProvider`、`clientId`、`displayName`、`nickname`、`avatar`、`banner`、`mentionPatterns`、`accountRef` 及现有角色信息。增加当前客户端显示项 `client`，含 `id`、`label`、`type`、可选 `pluginName` 和 `why`。配置启用与运行就绪分别投影。内部存储不参与 Host 查询。配置不可用时路由状态显式为不可用。 |
| 接入操作 | 探测、查询可选项、检查/启动/取消登录或配置、创建、更新（含重绑/启停）、删除、查询卡片。候选含稳定 client/transport 标识、就绪或确认理由、现有绑定、模型配置及可执行操作。延续创建请求幂等键与修改 revision。返回冲突、失效候选、不可用、部分失败等可操作状态。 |
| 调用和续接 | 按现有 `AgentSessionProvider` 可移植语义提供 open/resume、start、input、inspect、cancel、compact、release 和 capability。输入为 `hostSessionId`、`invocationId`、当前角色/工作区、授权引用和现有 native binding。用预发事实与 Host settle 接合后发冻结 prompt，回调函数及 bearer 留在 Host。沿用明确的 resume 失败和启动新会话策略。 |
| 流式事件 | 沿用当前 session/turn 事件标识、递增序号、append/replace、工具及结果、usage、native binding、错误、done。用现有 worker 远程值和取消通信提供背压和结束，Host 继续审计与保存。插件声明真实的 input、cancel、compact、continuity 支持度。 |
| 取消和生命周期 | Host 传调用及实际 turn 引用，区分已接收、取消已结算、远端未确认及旧代际。停止新准入后按现有顺序 release，等退役结果再复用资源。发布挂在激活租约；失败只收回自己登记的能力。版本变更使内存 provider 重新打开。每个声明插件实例激活单独持有原 `AcpPoolRegistry`，池仍以角色 profile ID 为键，停用时通过现有 lease/retirement 排空。新激活使用新池，其他插件池继续运行。激活代际和持久会话兼容性分别计算。升级期间受维护插件的角色新调用用现有 `session_implementation_unavailable` 收尾并提示可重试。该插件尚未结束的调用按已有退役和取消语义结算。启用、停用和替换结算时，在生命周期贡献接线复用 `agentRegistry.refreshForAdmission(() => syncAgentRegistry(..., false))`，刷新角色路由和 Host 投影，既有角色无需重新保存配置；兼容包用原持久化 native ID 续接。 |

## 存量迁移和回退

- 保留 `.cat-cafe/cat-catalog.json` 的路径和现有记录格式作为首版兼容数据。通过绑定工作区和激活的固定 catalog 字节入口原地交接，保留原格式与既有原子写入。插件版本专属数据进入现有插件私有存储。Host 只提供固定范围的原子/条件存储与路由投影，插件执行初始化、旧版数据修复、内容校验和写入。启动的 `bootstrapCatCatalog`、读时迁移、模板补写、成员路由与账号联动都要切走旧写入。迁移前读取隔离副本，保留原始 id、绑定、凭据引用、角色覆盖、墓碑、创建回执、头像、可用性和版本语义。原生客户端资料、会话路径和归属用现有映射，禁止凭配置模型猜测 history 迁移。
- Host 持有线程、会话链、调度、选中默认角色偏好、凭据及可交付消息。保留 `catId`、thread 和 chain key、native session ID、绑定位与已跟踪的 invocation/continuity。插件保留客户端本身的状态和原生登录目录。按单个角色调用验证持久会话。保留无原生 resume 路径原有的明确降级。
- 同一个 Host 构建的两个兼容包读写同一份角色和绑定格式。首版避免破坏性写迁移，新版在回退窗口内维护上一个包能读取的格式。拒绝不可读的新 schema，恢复旧包全程保留数据。历史 Host 的程序回退只在已经验证旧 Host 读同一格式时执行，数据照常读写，但有新插件专属字段时必须由兼容性测试明确验证。无需把包回退设计成数据库回滚。
- 独立升级路径复用 `runWithRuntimeSuspended`、`LocalPluginPackageAdmission` 和 inventory 的 revision CAS，后者保留实例 ID。基线源码能证明作用域为单个实例，测试才能证明程序 PID 和其他路由连续。`RuntimeCarrierSupervisor.start()` 会取得当前新包并执行贡献注册，无需在替换尾部另调 `configRefresh`。现有声明注册的 `compatibilityRevision` 含包 digest。以现有冻结接口拦旧代际执行，持久续接比较 client、carrier、账号、状态根、工作区和 native resume 协议。先为 ACP 包替换建立旧池退役与无关池隔离检查，再实现激活范围的池归属。

## 场景矩阵

| 场景 | 原入口与责任 | 切换后 / 实机证据 |
| --- | --- | --- |
| 首装空列表的一键检测、已有成员添加/重新检测 | next 的 `MemberListPage` / `MemberSettingsHost`，#1982 的 PDL `nativeSetup` 弹窗 → `A.nativeDetect`；`GET /api/cats/native-runtimes`、`discoverNativeRuntimesWithReadiness` 及客户端专属探测 | 从 PDL 空成员列表按钮进入，完成后从同一列表重新进入。在默认和简约经典各跑一次。成员页打开→关闭/完成不会改变引导 `pending`，首次引导关闭和完成分别核对回执。默认插件提供候选，记录包版本、激活身份、真实 CLI 和就绪。分别运行无候选、需登录、部分失败和重复检测，再用已检测的角色创建，回到对话 @ 通。 |
| 导入与登录、模型设置 | PDL `member-actions.ts`、DSH setup、Agent Client Library、模型目录和连接检查；Native account 页面处理 OAuth 和本地资料。 | 插件展示并调用这些已存在的操作。账号凭据由 Host 接收或签发，角色绑定由插件写。实测未登录→接入→就绪；OpenAI native、DSH Desktop/ACP、通用 ACP、外部声明分别验证。 |
| 手动添加、编辑、重绑、启停、默认与删除 | PDL `members.js` + `member-actions.ts`，`/api/cats` 写 routes 与 `accounts-codex-binding`。默认路由偏好 `/api/config/default-cat`。 | 所有角色写入汇入插件。实机检查配置版本、原生到 ACP 以及声明插件客户端之间的换绑、账号切换、卡片、默认和停用恢复，重复保存重读无重复。删除只对隔离新建角色验证墓碑。 |
| 聊天成员卡与角色身份 | `cats.ts` 生成公共字段，PDL `chat-models.memberCard` 投影，成员头像 routes 和 dossier 追加身份信息。 | 插件提供成员卡投影，Host 显示同样的名字/模型/@/头像等，并保留已停用历史成员。记录编辑前后列表、聊天卡和路由结果。 |
| 原生调用矩阵 | Host 选择 Claude CLI / SDK、Codex exec/app-server、Google AGY Native、Kimi、OpenCode、CatAgent，以及停用的 AGY IDE。 | 原生适配汇入插件。逐 carrier 验证已有入口、模型/账号、流式、取消、同一历史 native ID；已退役状态保留并核可见反馈。 |
| ACP 和插件客户端矩阵 | generic ACP、DSH Desktop/CLI、OpenCode/Kilo、固定与多 profile ACP 声明；`/api/agent-providers`、bootstrap-check、models。 | 用现有声明注册另一个真实客户端，无 Host 专用分支。验证列表、模型、首次调用、流式、取消、恢复；核 package/version 和真实 executable。 |
| 外部 A2A 与其他路由 | F050 HTTP `tasks/send` 与已有错误语义，Host `AgentRouter` 的内部串/并行和 callback，F202 Dot / Collective 插件寻址。 | HTTP 外部适配交由插件并验证现行能力；Host 内部路由和其他实例保持。记录哪些外部路由实际启用，按实际入口、账号、实例和运行回执给出证据。 |
| 历史恢复、重启、回退 | `invoke-single-cat`、原生会话导入/绑定/控制、session-chain 和各客户端档案。 | 从已安装旧 Host 用隔离账号和角色产生会话，再用新 Host 打开原角色，追踪 native ID 继续一轮，重启后重读。双包升级回退也重复同一验证。 |
| 包独立升级、失败恢复 | Manager 的 install/update/repair/upload、实例级停启和失败回滚。 | 用同一已打包 Host，从 Manager 走旧→新→旧。跨升级区间核 Host 构建、API PID、另一活跃 A2A 的流结束与新消息回执；升级中对目标插件验证可读的暂不可用提示，升级和回退后无需重新保存角色即可检测、添加与继续历史调用。不兼容或启动失败可见，旧包可继续。 |

## 评审记录

- 宪宪审查首稿 SHA-256 `22f814862cb1ef5c91d30e17e44516b3b1d5100890cf97dccb27a768f31df90a`，线程消息 `0001795020467260-000028-045f3159`。结论要求更正默认值、明确运行时池生命周期、删除无证据的回退分支。已修改，候选替换与池退役的真实证据进入实现验证。
- 鲸鲸在 `0001795020245814-000025-aadef1f2` 核查 PDL 当前唯一产品入口，指出 v2 单文件无检测按钮声明、登录态丢失、声明客户端选不到、卡片客户端显示和 banner 缺口。复核 `themes/default/theme.yaml` 的 `members.detect` 插入与 `pdlPackBoot` 装配，默认产品已有按钮。本次保留现有插入并验证选定主题叠加与首次引导完成后的继续可达。其余缺口已纳入矩阵。原 React 链只作为迁移前行为参照。

- 本轮修订以前稿 `b796e6a8` 和线程 `0001795021558747-000054-19b0c73d`、`0001795021711339-000058-98d9c3ac` 为父版本与评审证据。已写明协议包与声明、首装降级、角色投影和激活刷新，成员页弹窗来源及回执隔离。复审结果绑定本文件外部计算的 SHA-256。

## 实施顺序、红绿检查和交付

1. 基线建立正常入口测试并给出失败证据。优先从空成员设置页回到 @，测试插件不可用时 Host 不发起旧探测/写入。冻结包升级前后同 Host/异插件路由、CLI 续接和存量 catalog 的复现，并把 #1982 的基线问题与本次失败区分。
2. 公开契约、包产物、包兼容和默认安装。检查固定 Host 可加载两个同协议版本，安装声明化 ACP 包可在生命周期中注册与释放，权限范围与已有语义一致。
3. 迁移角色 store、检测、配置和运行逻辑，各提交沿依赖排列。逐步切换 PDL 和仍被其他产品使用的公共 HTTP 路由，旧 URL 可作为必要兼容代理。删除旧分支和适配实现前，以启动图、生产 grep、编译及端到端负向证据确认已无调用方。
4. 在独立 Windows 程序、Clowder 数据、Redis 与客户端 HOME 运行安装包。记录 Host/包 SHA、实例 PID/端口、客户端版本、场景步骤及脱敏产物。用隔离的旧版本生成真实数据证明升级。运行受影响测试、`pnpm check`、`pnpm lint` 和适用构建。分别保存契约检查、实机结果及 CI。
5. 中文 PR 正文用 UTF-8 文件提交并远端逐字回读。设计结论及最终代码独立审查均绑定版本。验收报告逐项标记证据或缺口，保留 GitHub、Worktree 与最终 SHA。合并发布另有授权。
