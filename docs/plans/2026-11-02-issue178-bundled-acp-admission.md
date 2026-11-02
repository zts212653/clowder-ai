---
feature_ids: []
topics: [plugins, acp, bundled-packages, codeagent, relayagent]
doc_kind: plan
created: 2026-11-02
status: proposed
---

# Issue #178：内置 ACP 声明插件安装修复方案

> 本轮交付为独立 worktree 内的待审方案，没有实施产品改动、安装依赖、启动服务或打包。来源：[插件仓 Issue #178](https://github.com/zts212653/clowder-ai-plugins/issues/178) 及本轮用户确认；不是新增两个客户端的硬编码接入。

## 1. 目标、基线与证据

目标：同一份合法 ACP 声明包，既能从本地压缩包安装，也能在发行版选择预置后从内置目录安装；安装、启用、更新和失败重试沿用现有 Host 生命周期，不覆盖既有连接配置、角色绑定和历史。

| 基线/证据 | 已知事实 | 使用限制 |
| --- | --- | --- |
| 本工位 | `fix/issue178-bundled-acp-admission`，基于刚刷新后的公共 `upstream/develop@4f9fb8e4fd4f8c1af41840be62166cb1d2dc83d0` | 已有 #1745、#1748；不整体搬入 #1702 或 #1762 |
| 现场 Issue | CodeAgent 0.1.0，`POST /api/plugin-manager/plugins/install`，`source.kind=catalog`，422 / UNSUPPORTED_TRANSPORT | 现场说明包含 `71020406f`、分析基线 `8270e59a9`；当前公共仓及个人 fork 未取得这两个提交 |
| 旧对照 | #1702 的 c7 包直接发现/配置 CodeAgent ACP，用户内网验收通过 | 不经过插件压缩包安装，不能证明内置目录准入正确 |
| 作者此前探针 | #1762 的 `b9e1c035` + CodeAgent beta.4，真实上传路由/安装器返回 201 | 是 local-archive，不能替代现场 0.1.0 的 bundled 验证；#1762 后续 HEAD 已变化 |

已核对的公共代码与现场给出的门禁一致：`official-package-installer.ts:359` 将 bundled 一律要求为 builtin runtime。纯声明包的 manifest 无 runtime，因此被拒；错误在启动 CodeAgent/Python 前发生。物理归档位于本机，不代表请求的 source.kind 是 local-archive。

校正 Issue 的两处表述：runtime 门禁在 pluginId/version/presentation 比对之前，不能说这些比对均已通过；仓库已有 ChatGPT Dot 的 bundled 测试，缺少的是 bundled 纯声明 ACP 类型及新增产品包的覆盖。

Architecture cell：现有 Plugin Manager → 包准入 → carrier → ACP provider。Map delta：增加既有 bundled 准入允许的包类型，不新增协议、生命周期、配置存储、常驻进程或公共目录 schema。

## 2. 三方职责和交付范围

| 归属 | 本次具体工作 | 不属于该归属的工作 |
| --- | --- | --- |
| Host 通用修复 | 严格识别合法 ACP 声明包；共享构建/安装校验；catalog 安装/更新/重试回归；失败诊断 | 不按 CodeAgent/RelayAgent 名称分支，不内置其程序、账号或模型 |
| 插件仓 | 保留 manifest、agent-provider.json 和稳定 ID；仅在真实归档不合法时修包并按规则发新版本；文档说明所需 Host 能力 | 本次不要求增加假的 builtin runtime，也不默认新增插件仓 PR |
| 内网发行集成 | 保留已有预置清单、归档及其版本/摘要；吸收通用 Host 修复；对实际 CodeAgent 0.1.0、RelayAgent 1.0.0 验证 | 不要求用户修改系统盘/祖先 ACL、删除 inventory、重配角色或重新登录 |

公共修复不默认将这两个客户端加入公共预置列表。发行版是否预置、预置哪些插件，继续由其已有定义决定；Host 支持同类声明，与插件名称无关。公共 PR 目标先按现行 develop 路线准备；如需进入 next，在基础能力已具备的目标上单独回灌该增量，不顺带合并 #1762 的其他内容。

## 3. 准入规则

前提：沿用 Host 注册表、固定归档摘要、体积/解包预算、路径/链接限制和 manifest schema 校验。不得通过将 distribution 改成 registry 或注入未注册归档来绕过 bundled 注册校验。

| staged manifest | agent-provider.json | 预期 |
| --- | --- | --- |
| runtime.transport 为 builtin | 无需新增声明 | 保持现有流程、desktop 资源验证与 carrier 检查 |
| runtime 不存在 | 存在且通过现有 ACP 声明解析 | 允许继续既有身份/版本/呈现、inventory 准入；安装时不启动客户端 |
| runtime 不存在 | 缺失、不可读、非法 JSON/schema、非法 transport 或既有解析器拒绝的包内启动路径 | 拒绝；不创建实例、不发布 provider |
| runtime 存在且不是 builtin | 即使同时有合法 ACP 声明 | 仍拒绝；不能借声明绕过对模块类型的限制 |

复用 `parseAgentProviderDeclaration(raw, { packageRoot })` 的既有规则，同时兼容其已支持的固定客户端和可配置客户端目录声明，不新造宽松 parser。按声明解析成功放行，不按文件名存在或 `transport: acp` 一项放行。

读取复用 `resolvePackageFile`、现有 64 KiB 声明读取上限；schema 在此边界校验一次，向下传明确结果。构建时缺少运行时 staged root，可使用其受控输入根作同一解析的上下文，包内相对命令限制不放宽。后续启用仍从已验证归档重新读取，不能把安装时对象当作永久运行授权。

## 4. Host 的具体改动

### H1：复用声明读取，集中 bundled 类型规则

- 从 `declared/declared-agent-session-providers.ts` 中提取可复用的“有界读取并解析声明”逻辑到 `declared/read-agent-provider-declaration.ts`（拟新增）。原有 provider 激活调用它，保留既有前后完整性验证与注册/退役顺序。
- 在 `domains/plugin/bundled-archive-admission.ts`（拟新增）封装第 3 节判定；安装器与构建入口共同使用。该模块不依赖 official-catalog、构建索引或 inventory，避免先构建索引才能验证索引输入的循环。
- `official-package-installer.ts` 仅替换现有 bundled runtime 门禁，保持其余身份、版本、呈现、摘要和发布流程；不能删掉整段限制。类型不支持、声明缺失或内容无效仍为 UNSUPPORTED_TRANSPORT / 422，并区分提示，不回显声明内容；注册、摘要和解包错误保留原错误码，意外内部 I/O 错误不伪装成声明缺失。
- `install`、`update`、`preflightUpdate` 已共用 withVerifiedPackage，同一规则覆盖三条路径；不复制三个实现。

结果与验证：先用正式注册的 bundled ACP 归档复现当前 UNSUPPORTED_TRANSPORT，再使安装及预检成功；负例与现有 builtin 对照继续通过。不得以 registry fixture 的成功充当此项 GREEN。

### H2：构建规则与运行准入一致

- `packages/api/scripts/copy-bundled-plugin-packages.mjs` 复用 H1 规则；生产从编译后的 dist 导入，现有 `node --import tsx ... --source` 开发入口从 src 导入，不增加新的加载器或构建模式。
- `bundled-plugin-artifacts.mjs` 当前仅打 manifest 和 SVG。增加一个可选的 agentProvider 声明输入，打入 `package/agent-provider.json`；复用现有定义列表，不增加任意文件打包器或客户端安装逻辑。没有 icon 的合法 ACP 包不强制补 SVG。
- 继续从唯一 canonical manifest 生成公开 manifest/归档/索引；校验声明在归档中真实存在，生成结果与 producer 对应。旧 ChatGPT Dot 的压缩字节、版本及摘要必须不变，已有 canonicalGzip 保持。
- 对内网已有 checked-in tgz，使用真实 staging 读取它采用的 plugin.yaml/manifest.json，与 sibling manifest 比对 pluginId、version、runtime 形态，并校验声明。禁止仅检查归档外 manifest；不重打已发布的同版本归档。
- 所有候选输入通过后才发布新构建输出；`--check` 只检查、不重写。坏候选不能清掉上一份有效构建。现有数据目录不属于生成器输出清理范围。

结果与验证：src 模式、编译模式、`--check` 对同一 producer 给出相同接纳结果；构建通过的 ACP 包能够经真实 catalog 路由安装。实际 bytes 改变时发布新插件版本，不对已发布 version 换 SRI。

### H3：安装失败可定位

- 在 `routes/plugin-manager-routes.ts` 的 install、update、upload 三个包操作失败边界记录一次结构化 warn，沿用 request logger 和既有错误类型/HTTP 映射。
- 字段限定：reqId、operation、sourceKind、已校验的 catalogId/可用的 pluginId、公开 code。没有解析出 pluginId 时不猜，也不为日志额外取包或解包。
- 不记录 body、命令参数、认证头、配置值、用户文件路径或完整 cause/stack；HTTP 状态和错误码保持既有语义。
- 不扩展审计 schema、不新增审计落盘要求、不改变审计失败时的保存策略；requested 审计与此次诊断日志职责分开。

结果与验证：一次 422 对应一条可按 reqId 关联的 warn；响应与原错误映射一致；成功安装不记录失败告警，日志不包含 fixture 秘密值。

### H4：用户路径与运维说明

更新 `docs/ops/codeagent-main-acp-plugin.md`：分别说明内置目录与本地包入口，二者安装后走同一启用/绑定流程。保留原生程序、认证、模型、Windows 策略和权限响应的职责边界；本次不同时改写历史模型/身份验收结论。

用户预期操作：已有内置列表 → 安装 → 启用 → 成员选择工具。默认命令可用时无需新增配置；自定义命令/参数仍在现有插件配置入口保存一次。已有本地安装和角色不自动换源、迁移或重建 ID。

## 5. 生命周期、失败恢复与升级契约

| 场景 | 必须保持的结果 |
| --- | --- |
| 安装合法包 | 201；artifact=installed；activationState=disabled、runtimeState=stopped；无原生子进程 |
| 包校验失败 | 现有错误码/非 2xx；inventory 无新实例；无 provider 注册或半启用状态；临时 staging 释放 |
| 旧版 Host 安装失败后升级重试 | 同一 catalog 操作可重新安装；不要求清除 inventory、quarantine、配置或用户目录 |
| 更新合法新版 | 先通过共用预检，再沿既有 lifecycle/CAS/事务处理；保留实例身份、配置和角色绑定 |
| 更新候选不合法或目录已变化 | 拒绝/按既有更新恢复契约处理；旧包、原配置及可用状态保留，不提前切换 provider |
| 已从本地装过同 pluginId | 不自动重装或改来源；显式替换按现有版本/摘要/确认规则执行，不能覆盖同版本不同字节 |
| 停用/重启/再启用 | 沿既有注销、退役和恢复逻辑；配置、角色、历史回读不变 |

本次没有新增持久状态或迁移。无需增加后台轮询、进程、代理或环境变量。新增成本仅为内置纯声明包安装/预检的一次有界读取；换取构建和安装规则一致，避免正常用户安装必定失败。

## 6. 工作顺序与验证矩阵

按 T1 → H1 → H2 → H3 → H4 推进。每个行为改动先观察对应 RED，再验证 GREEN；无需实现时跑不相关的全仓测试。

| 编号 | 检查及拟落点 | 通过标准 |
| --- | --- | --- |
| T1 | 新增 `packages/api/test/bundled-acp-admission.test.js`；扩展现有 bundled build fixture | 真正注册的 bundled 无 runtime + 合法声明当前能稳定 RED；修复后成功 |
| T2 | 同套准入负例 | 无声明、坏 JSON、超限、非法声明、违规包内命令、stdio runtime + 好声明全部拒绝 |
| T3 | 现有 f322/official-package 套件 | 未注册、错 digest、错 ID/version、坏资源/归档及旧 builtin 行为保留；区分错误前置顺序 |
| T4 | 扩展 `bundled-plugin-build.test.js`、`bundled-plugin-artifacts.test.js` | 两种 build 入口和 check 一致；声明闭包保留；旧包字节不变；坏输入不覆盖有效输出 |
| T5 | `plugin-manager-routes.test.js` + 新增 bundled catalog 集成 | 真实 catalog POST 安装/回读；日志包含 reqId/来源/code，秘密与本地路径不进入日志 |
| T6 | installer refresh/update 及新增 retry 集成 | 首次拒绝后同包重试、更新失败保旧、合法更新保配置/绑定；不清数据恢复 |
| T7 | `agent-session-contract/fixed-client-package.test.js` 扩展 catalog 分支 | 同一稳定版本归档分别经 catalog/local-archive；启用注册同一 provider 引用；fixture 两角色、续聊、停用/恢复/重启通过 |
| T8 | 内网实际注册的两份 tgz | 从该安装包 index 取版本和 digest，真实 catalog 安装/启用/回读通过；不得用重新制作的替代归档代测 |
| T9 | 企业实际 CodeAgent/RelayAgent | 用户绑定角色、真实回复、Clowder MCP/协作、重启续接，记录客户端版本和结果；不与 fixture 验证合并报“通过” |

bundled 正负例在隔离安装布局中生成真实 index/归档，并用新子进程加载该布局，避免改动/伪造冻结的生产 BUNDLED_PACKAGE_ARCHIVES。名称不影响判定，增加一个非 CodeAgent 名称的合法 ACP fixture，证明通用性。

## 7. 已核对的实施命令

以下为实施阶段命令，本轮不运行、不以文档自检冒充回归。工作目录均为本工位；依赖只安装到本工位，按锁文件，不链接其他工位 node_modules。

```powershell
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/api run build
pnpm --filter @cat-cafe/api run lint
```

构建后，在 `packages/api` 执行既有测试沙箱入口；新增文件须先按 T1 创建：

```powershell
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/bundled-acp-admission.test.js test/plugin-official-package-installer.test.js test/plugin-official-package-installer-refresh.test.js test/f322-bundled-plugin-icons.test.js test/plugin-manager-routes.test.js test/bundled-plugin-build.test.js test/bundled-plugin-artifacts.test.js test/bundled-plugin-closure.test.js test/agent-session-contract/fixed-client-package.test.js
node scripts/copy-bundled-plugin-packages.mjs --check
node --import tsx scripts/copy-bundled-plugin-packages.mjs --source --check
pnpm run test:public:plan
```

确认新增测试进入 public 测试计划及适用的 Windows/Linux CI；不为本修复新增整套平台工作流。最后只对实际修改的 TS/JS 文件运行 `pnpm exec biome check <实际文件列表>`，并执行 `git diff --check`。`pnpm check` 若报告既有 Windows 基线问题，保留原失败和归因，不改断言/安全规则刷绿。

纯方案本轮校验：`node scripts/check-frontmatter.mjs --strict-delta --base 4f9fb8e4fd4f8c1af41840be62166cb1d2dc83d0`、文档本地链接、`git diff --check`。不需要为写方案安装依赖或启动 Redis。

## 8. 内网交付、负责人及验收

| 阶段/执行者 | 具体动作 | 收据/验收标准 |
| --- | --- | --- |
| Host 实施者 | 完成 H1–H4、通用测试和非作者审查 | 提供 exact HEAD、测试结果、未验证项；不携带客户端二进制/凭据 |
| 内网集成/打包者 | 在含 71020406f 的目标树吸收增量，保留原插件 index/归档及配置；核对 sibling/归档一致性 | 给出真实集成 SHA、两份 tgz 摘要、程序包版本/哈希，不能仅用通用 1.14.0 版本号识别来源 |
| 作者安装包验证 | 新程序/数据目录首装，另外验证现有环境升级；只操作已确认归属实例 | catalog 可安装、启用/回读、旧连接/角色/历史/会话绑定保留；后台无额外命令窗口 |
| 用户内网验收 | 在已有成员入口选择 CodeAgent/RelayAgent，沿企业已有登录和连接配置使用 | 真实首轮、第二轮、MCP/角色协作与重启续接通过；异常可按 reqId 找到包操作 |

内网无需手动编辑源码、加假的 runtime 或卸载旧包。本修复不触碰 intranet-host.json、.env、认证目录或 ACL；已有 Windows 兼容策略保持其部署值。

完整关闭 Issue 的条件：通用回归通过，且 T8 在实际现场发行归档上通过。T9 若暂不可执行，应单独保留待验收状态，不能把安装修复宣传为客户端语义、原生 system/persona 或模型能力全部验收。

## 9. 回退、未决项与当前工位

- 回退代码不删除或改写 inventory、归档缓存、角色、配置和历史；若旧 Host 不认识新安装的插件，先按现有入口停用并确认退出，再退回程序。原程序及数据回退包按实例台账保留，不通过卸载清数据。
- 技术待办：取得含 71020406f/8270e59a9 的实际源码及归档后，把 H2 的内网 checked-in 输入检查接到真实构建入口，固定 T8 证据。当前不伪造这些提交存在，也不把它们作为公共修复的新依赖。
- 在飞检查：已核对 #1762、#1765、#1725 的相关 changed files；#1765 触及 plugin-manager-routes.ts，实施 H3 前重新核 HEAD 和冲突。此为方案，不接管或改写它们。
- 创建工具：桌面 create_worktree 因聚合根不是 Git 仓库且子目录不在其精确白名单而失败；已用仓库 worktree-new.mjs 创建并登记 owner=codex、policy=merged。没有修改主 worktree 或其未提交文件。
- 工位：`G:/AIwork/clowder-ai/worktrees/fix-issue178-bundled-acp-20261102`。本轮仅计划文档，无服务/端口/PID、无测试安装及数据操作；保留供用户审阅和后续实施，2026-11-09 复查去留，不自动删除。

批准前停在方案阶段；后续实施消费本方案，不重新设计客户端协议或扩展内网权限边界。
