# F202 终态 Plugin Manager 实施计划

**功能：** F202 — `docs/features/F202-plugin-framework.md`

**方向准入：** Maintainers accepted the bounded Train B scope in
[clowder-ai#1478](https://github.com/zts212653/clowder-ai/issues/1478). This admits formal review of one
Host-owned Manager plus one real `video-analysis` package loop; it does not authorize a production-default
cutover, Train C1/C2 delivery, npm publication, or merge.

**目标：** 在 Clowder AI Core 中交付唯一的 Plugin Manager：用户和 Agent 从同一份 Host-owned 投影查询 catalog、已安装实例、配置/授权、启用意图、实时运行状态和能力，并通过同一服务完成安装、启用、禁用与卸载。Train B 结束时管理面即为终态；Train C1 只迁出既有业务实现、切换默认路径并删除旧管理入口，Train C2 仅按真实消费者开放公共 hook/UI seam 与迁移 managed services，不重做管理面。

**本 PR 验收标准：** 真实 Settings 产品壳在现有插件卡片样式上补充搜索和左右布局：左侧同一列表覆盖已安装/未安装，右侧复用现有展开卡片；安装状态不显示冗余 badge，而由左侧卡片当前可执行 action 直接表达——已安装插件只有卸载和启禁用 toggle，未安装插件只有 Install，右侧不重复这些生命周期动作；配置字段直接显示在展开卡片中，不新增“设置”按钮；离线安装复用 IM connector 的上传交互并放在页面右上角。卡片固定高度并截断溢出描述；列表与详情均从 verified `plugin.yaml` 读取同一份多语言描述与随包图标。API 与 Agent 工具复用同一个应用服务；官方 npm、本地目录/zip 和迁移期 repository-local 插件均投影到 Host inventory；公开管理面精确包含 list/search/get/install/set-enabled/uninstall，不公开通用 update/repair；启用后的动态插件能力通过两个静态治理入口 `plugin_list_tools`/`plugin_call` 仍由 Host supervisor 执行；所有写操作保留 loopback、身份、审计与 revision fence。

**架构单元：** `plugin`

**架构图变更：** 需要。

**架构图变更理由：** 现有 ownership map 仍把 repository-local manager、Core 静态 official catalog policy 和 dormant external runtime 写成终态。此次改动把 catalog 发布真相移到 `clowder-ai-plugins`，把 Host inventory 与统一 Manager projection 定为 Core 权威，并增加 Console 与 Agent 两个同源消费者。

**技术栈：** TypeScript、Fastify、React、Vitest、Node.js test runner、Redis、`@clowder-ai/plugin-contract`、受监督 stdio runtime、pnpm。

**前端验证：** 需要。必须在真实 Settings 壳、窄屏与宽屏上完成 Design Gate 和行为验收；不能用孤立组件或静态截图代替。

---

## 1. 冻结范围

### 1.1 Train B 本 PR 交付

- 一个 Plugin Manager 页面，不再让用户理解 “repo-local / official / IM connector” 三种内部来源。
- 一个 `PluginManagerService`，组合 catalog 候选与 Host inventory，不建立第二份安装数据库。
- 官方 npm catalog 查询与安装；本地 directory/archive 安装通过同一 package admission 和 inventory。
- 迁移期 repository-local 与 connector 状态通过 compatibility adapters 进入同一只读投影；Train C1 删除 adapters 与旧实现。
- Console 与 Agent 使用同一服务层和同一状态模型。
- Agent public tools 精确为：
  - `plugin_list`
  - `plugin_search`
  - `plugin_get`
  - `plugin_install`
  - `plugin_set_enabled`
  - `plugin_uninstall`
- 启用后的动态 contribution 不直接注册进 canonical tool registry；Agent 通过两个静态治理工具访问：
  - `plugin_list_tools`
  - `plugin_call`
  二者复用 Host supervisor 的 live/grant authority，不能启动独立 MCP 进程或读取 Host secret。
- `plugin.yaml` 继续是静态格式和接入协议；动态 SDK registration 不替代 manifest。
- `plugin.yaml` 的能力/用途描述支持 `default + translations`，图标支持 legacy Host icon name 或随包 SVG/PNG；Console、Agent 与 catalog 搜索消费同一 verified metadata，不维护第二份 copy。

### 1.2 明确不进入公开产品面的能力

- 不开放 `plugin_update`、`plugin_repair` 或 `updateAvailable`。
- 不接受 arbitrary free-form shell command。生命周期 action 只能使用 plugin-contract 定义的固定 action 名称和结构化 `command + args + mode`；未声明 action 即 no-op。Core 不复制该 schema。
- 不在 Train B 迁出全部业务实现，不删除 connector/provider 代码，不切生产默认路径。
- 不把 derived aggregate status 持久化成第四份状态；Manager 每次从权威轴投影。
- 不把 catalog 候选当成已安装、已授权、已启用或健康证据。

### 1.3 稳定内核与 Train C 后续边界

- Core 只稳定拥有生命周期阶段、类型化 hook/capability 契约、调度/隔离/授权/审计、UI slot policy
  与 disable/uninstall 时的完整撤销；公共 SDK 是插件注册 handler 和声明式 contribution 的唯一作者面。
  Host 触发阶段但不认识 TTS、翻译、IM provider 等业务语义，也不允许插件修改私有 Core 对象或任意 DOM。
- Train B 用一个真实 `video-analysis` 包证明两仓闭环，不切生产默认路径。
- **Train C1（独立 follow-up；本期不承诺日期）**：`clowder-ai-plugins` 一个聚合 PR 迁移冻结 inventory 中剩余
  IM providers、connectors 与 repository-local business plugins；Clowder AI 一个聚合 PR 完成
  配置/binding/数据映射、默认路径切换、旧新防双跑，并删除 provider-specific loader、route 和第二管理入口。
  Core PR 应以删除为主，只保留消费既有 Host plane 所需的窄迁移 wiring。
- **Train C2**：由首个真实消费者逐点开放公共 hook 与 UI slot，再迁 managed services（含 TTS/ASR）。
  每个点位必须同时交付 contract schema、SDK registration、Host 业务无关调度，以及插件 disable/uninstall
  后 UI entry 与 handler 一起消失的验收。
- Train C1/C2 都不重做 Manager UX 或 Agent management contract；C2 也不反向把业务逻辑放回 Host。

## 2. 终态用户旅程

1. 用户打开 Settings → Plugins，看见可搜索的全部发布候选和本机已安装插件。
2. 用户选择插件，右侧直接显示现有展开卡片：manifest 多语言能力说明、配置字段、资源 badges 与必要诊断；安装/卸载/启禁用只保留在左侧卡片，不在详情重复。完整正交状态仍供 Agent/API 和深层诊断使用，但默认 UI 不把它们拆成仪表盘，也不重复显示安装状态标签。
3. 未安装插件可直接安装；本地开发包可选择 directory/archive，但同样经过验证、digest 与 inventory admission。
4. 安装后，用户在详情中完成配置和专属授权。配置未完成时不能伪装成可启用。
5. 用户启用插件，Host 创建新的 activation revision，由 supervisor 启动外部进程或执行 contract 定义的 no-op/builtin 路径；UI 原位更新，不产生重复 toast。
6. 用户可禁用或卸载。禁用撤销运行权限但保留安装与数据；卸载先撤销 runtime/grants，再按 manifest 数据策略处置并删除安装实例。
7. Agent 可在明确的用户意图下使用六个管理工具，读到与 UI 相同的状态和能力；启用后再通过
   `plugin_list_tools` 读取实时 schema，并以 `plugin_call` 调用一个精确工具。Agent 不能绕过权限、
   配置门、live/grant authority 或 revision fence。

**失败旅程：** catalog 不可用时，已安装插件仍可管理；package 校验失败进入 quarantined，不生成可启用实例；授权过期、启动崩溃或配置不完整分别显示其真实轴，不压成含糊 “error”；写操作失败保持旧 revision 可解释且不双跑。

## 3. 真相源矩阵

| 事实 | 唯一 owner | Manager 只读来源 | 禁止推断 |
|---|---|---|---|
| 已发布哪些插件/版本/manifest/digest | `clowder-ai-plugins` machine catalog + npm artifacts | verified catalog provider | Core 硬编码数组不是发布真相 |
| 本机 package admission 与 digest | Host inventory | `PluginInventoryStore` | catalog presence 不等于 installed |
| 安装实例、grants、activation revision | Host inventory | instance/grant records | runtime hello 自报不可信 |
| 配置 readiness | Host config service + manifest schema | readiness projection | 有 env 值不等于 schema 合法 |
| 授权状态 | typed auth contribution/Host secret boundary | auth projection | process alive 不等于 authorized |
| 用户启用意图 | Host activation record | desired activation | running 不等于 user intended enabled |
| 实时运行状态 | supervisor/Broker lease | runtime projection | persisted PID 不等于 live |
| 插件能力 | verified manifest + active contribution registrations | capability projection | UI label 不授予 capability |
| 插件名称、能力说明与图标 | verified manifest/package | catalog + admitted package metadata | Console fixture、来源类型或 Core 硬编码图标不是发布真相 |
| 用户可执行动作 | 上述各轴的纯函数 | action policy | 不持久化 `canEnable` 等派生字段 |

## 4. 核心不变量

- **INV-PM1 — 单一管理面：** Console、Agent 与 REST 只能调用同一应用服务；不得各自拼状态或实现 mutation。
- **INV-PM2 — inventory 权威：** 所有可执行 package，不论 npm、directory 或 archive 来源，都必须先成为 verified Host inventory package；loader 不能旁路动态 `import()` 到 API 进程。
- **INV-PM3 — 状态正交：** artifact、config、auth、intent、live 是独立轴；安装状态由 action 集合表达，必要的运行诊断只能是确定性投影。
- **INV-PM4 — 写入带 fence：** enable/disable/uninstall 以 plugin instance 与 expected revision 为条件；stale UI/Agent 请求零副作用。
- **INV-PM5 — catalog 失效可降级：** catalog fetch 失败不能让已安装实例消失或不可禁用/卸载；候选搜索明确标记 unavailable/stale。
- **INV-PM6 — 外部代码不入 API：** terminal path 只通过 supervisor 或 contract-declared builtin/no-op；本地 zip 不复活 F240 进程内 loader。
- **INV-PM7 — 权限不自报：** identity、grants、capabilities 与 action availability 均从 Host admission 和 lease 派生。
- **INV-PM8 — 不双跑：** 每个 instance + activation revision 最多一个有效 runtime lease；restart、retry 与 Train C1 cutover 均不允许旧新路径同时消费。
- **INV-PM9 — 卸载先撤权：** runtime/lease/grants 的不可用必须先于 package 与用户数据处置；失败时不得留下有权运行但 UI 显示已卸载的实例。
- **INV-PM10 — 公开面收敛：** generic update/repair 不出现在 UI、Agent 工具或 canonical Manager API；内部 recovery primitive 不能被产品面反向发现。

## 5. 有状态对象与迁移矩阵

### 5.1 Package artifact

| 当前状态 | 事件 | 下一状态 | 原子要求 |
|---|---|---|---|
| absent | install candidate | staged | 只写 Host 私有 staging |
| staged | digest/manifest/provenance valid | verified | package identity 固定 |
| staged | verification failure | quarantined | 不创建可启用实例 |
| verified | install commit | installed | instance 与 package revision 同批可见 |
| installed | uninstall after revoke | absent/retained artifact | 遵循数据/缓存策略 |

### 5.2 Plugin instance projection

| 轴 | 值 | owner |
|---|---|---|
| `artifact` | absent/staged/verified/installed/quarantined | inventory |
| `config` | incomplete/ready/invalid | config service |
| `auth` | not-required/disconnected/pending/connected/expired/error | auth contribution |
| `intent` | disabled/enabled | activation record |
| `live` | stopped/starting/handshaking/running/degraded/crashed | supervisor + Broker lease |

### 5.3 Activation

| 当前状态 | 事件 | 下一状态 | 原子要求 |
|---|---|---|---|
| disabled | enable + prerequisites ready | enabling | 分配新 activation revision |
| enabling | handshake/activation success | enabled/running | lease 与 revision 绑定 |
| enabling | failure | error/stopped | 撤销本次 lease/resources，不影响旧稳定 revision |
| enabled | disable | disabling | 先阻止新 effect，再 drain/settle |
| disabling | cleanup complete | disabled/stopped | disposer 与 runtime 均不可再产生 effect |
| any | stale expected revision | unchanged | typed conflict，零副作用 |

### 5.4 Catalog projection

| 输入 | 输出 |
|---|---|
| catalog fresh + not installed | available candidate |
| catalog fresh + installed | one joined row, not duplicate cards |
| catalog unavailable + installed | installed row + catalog degraded banner |
| catalog unavailable + not installed | not enumerable; search reports unavailable, never fake empty success |
| local verified package | local-source installed row with digest/provenance |

## 6. Design Gate

### 6.1 Before / after

**Before:** Settings 将 Personal Chrome、官方 npm 插件、repository-local 插件和 IM connector 分散为多块/多 section；同一插件可能出现多张卡；official card 暴露 update/repair；用户和 Agent 看不到统一能力与五轴状态。

**After:** Settings → Plugins 是唯一入口。保留现有插件卡片语言，只增加搜索和 VS Code 式左右结构：左侧是已安装+未安装列表，右侧是当前卡片的展开内容；窄屏先列表后详情并可返回。每个插件只出现一次。IM provider 在 Train C1 后只是普通插件及其 typed configuration contribution。

### 6.2 页面结构

- 页面右上角：离线安装；搜索框单独位于左栏顶部。
- List item：直接复用 `settingsResourceCardClass`/现有插件行并使用固定高度；描述最多两行，溢出截断。未安装显示 Install，已安装显示卸载与启禁用 toggle，不增加状态 badge。
- Detail：直接复用当前插件展开卡片的信息层级、manifest 多语言描述、配置字段、setup steps 和 resource badges；不重复安装、卸载或启禁用动作。
- lifecycle action 本身就是安装状态提示，不重复显示“已安装/未安装”；配置内容直接展开，不新增“设置”按钮。
- Icon：旧 manifest icon name 保持兼容；新插件使用 package-relative `{ type: svg|png, src }`，Host 在校验路径/MIME/包边界后改写为同源资源 URL，Console 不按 `catalog/local` 来源猜占位图。
- Local install：复用 `ConnectorPluginInstallButton` 的 `.tar.gz/.tgz` 上传交互，但 endpoint 接统一 package admission/Host inventory，不接进程内 connector loader。
- 专属 journeys：Feishu owner auth、Personal Chrome pairing 等以 typed contribution 进入详情，不成为独立 manager。

### 6.3 State matrix

| 场景 | 主展示 | 允许动作 |
|---|---|---|
| initial loading | skeleton list/detail | none |
| no candidates and no installed | honest empty state | local install / retry catalog |
| catalog degraded, installed present | installed list + degraded banner | installed mutations remain usable |
| available | 展开卡片 | install |
| installed, config incomplete | 原配置区 | uninstall/toggle disabled until ready |
| auth pending/expired | 原授权区的 typed guidance | disable/uninstall |
| enabled + running | enabled toggle | disable/uninstall |
| enabled + degraded/crashed | 展开卡片内一条最新诊断 | disable/uninstall |
| quarantined | 展开卡片内验证原因 | remove only; never enable |
| narrow viewport | single-column list/detail | same semantic actions |

### 6.4 In-context observability contract

- **primary_surface:** selected plugin's existing expanded card and the install versus toggle/uninstall action set.
- **why_not_dashboard_only:** plugin owner must understand and resolve state at the exact install/enable/config action point.
- **deep_dive_surface:** the same detail expands bounded runtime diagnostics; no new global dashboard.
- **noise_dedup_strategy:** one latest actionable error per instance/revision; polling replaces it in place, and repeated health samples do not emit toast spam.

### 6.5 Design Gate acceptance

- 用真实 Settings shell 加载 fixture-backed terminal projection；不连生产数据。
- 宽屏验证搜索已安装/未安装、list-detail selection、available→installed→configured→running journey。
- 验证离线安装在页级右上角、卡片等高/截断、右侧无重复 lifecycle action、locale fallback 与 package icon 渲染。
- 窄屏验证列表到详情、返回、primary action 不溢出。
- 模拟 catalog offline、auth expired、crashed、quarantined 四个失败态；失败信息只在需要时进入展开卡片，不新增状态仪表盘。
- 2026-09-01 的 co-creator 反馈只冻结 Settings list/detail UI 方向，不构成完整个人旅程验收。
- 按 #1478，正式代码 review 不再等待新的个人签字；maintainers 必须在最终批准/合并前，用已发布且
  digest 匹配的真实包复现完整旅程并记录结果。

**2026-09-01 direction verdict:** co-creator accepted the real Settings-shell list/detail direction and
authorized formal wiring to continue, with one required correction: complete PNG/SVG plugin icons must not
render as tiny glyphs inside a second background. The correction is protected by
`PluginManagerDesignGate.test.tsx`. This historical verdict unlocks Task 7 but is not evidence of complete
personal phase-4 acceptance. Maintainer direction acceptance in #1478 now admits formal review, while the
published-package end-to-end journey remains pending before final approval/merge.

## 7. 实施任务（TDD）

### Task 1 — 冻结 shared projection contract

**Files:**
- Modify: `packages/shared/src/types/plugin.ts`
- Test: `packages/shared/src/__tests__/plugin-manager-contract.test.ts`
- Modify: `packages/shared/vitest.config.js`

1. Red：为五轴状态、catalog freshness、capability summary、derived actions、多语言描述 fallback 与 manifest icon 写 closed-shape tests。
2. Green：增加 `PluginManagerItem` / `PluginManagerDetail` / command request/response types；描述和图标保持 Agent/Console 同源；禁止 update/repair fields。
3. Refactor：复用现有 official/repo-local types，只保留迁移期 adapters，不建立并行公开 type。

### Task 2 — 建立统一应用服务与 projection

**Files:**
- Create: `packages/api/src/domains/plugin/plugin-manager-service.ts`
- Create: `packages/api/src/domains/plugin/plugin-manager-projection.ts`
- Modify: `packages/api/src/domains/plugin/index.ts`
- Test: `packages/api/test/plugin-manager-service.test.js`

1. Red：catalog + inventory join、catalog offline、local package、quarantined、stale revision、action derivation tests。
2. Green：用 ports 注入 catalog、inventory、config/auth/runtime readers 与 lifecycle commands。
3. Refactor：保持 projection pure；把 compatibility mapping 隔离在 adapter 层。

### Task 3 — 本地 directory/archive 接入 Host inventory

**Files:**
- Create: `packages/api/src/domains/plugin/local-package-admission.ts`
- Modify: `packages/api/src/domains/plugin/official-package-installer.ts`
- Modify: `packages/api/src/domains/plugin/external-runtime/filesystem-package-locator.ts`
- Test: `packages/api/test/plugin-local-package-admission.test.js`
- Protect: `packages/api/test/plugin-installer.test.js`

1. Red：directory/archive 均产生 verified package + instance；zip-slip、symlink escape、digest mismatch、manifest mismatch、API-process import 全拒绝。
2. Green：抽取共同 package admission，复用 archive verification 与 locator。
3. Refactor：F240 installer 只可作为输入解析 adapter，不能保留 runtime ownership。

### Task 4 — Canonical REST surface

**Files:**
- Create: `packages/api/src/routes/plugin-manager-routes.ts`
- Modify: `packages/api/src/routes/plugin-routes.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/test/plugin-manager-routes.test.js`
- Protect: `packages/api/test/plugin-official-routes.test.js`

1. Red：list/search/get/install/set-enabled/uninstall、loopback/auth、revision conflict、audit 与 catalog degraded tests。
2. Green：routes 仅做 validation/HTTP mapping，调用 `PluginManagerService`。
3. Refactor：旧 official/repo-local routes 转为 compatibility delegates；canonical response 不含 update/repair。

### Task 5 — Agent 六管理工具与两贡献调用工具

**Files:**
- Create: `packages/mcp-server/src/tools/plugin-management-tools.ts`
- Modify: `packages/mcp-server/src/canonical-server-tools.ts`
- Modify: `packages/mcp-server/src/canonical-tool-registry.ts`
- Modify: `packages/mcp-server/src/tools/index.ts`
- Test: `packages/mcp-server/test/plugin-management-tools.test.ts`
- Test: `packages/mcp-server/test/tool-governance.test.ts`

1. Red：六个管理工具加 `plugin_list_tools`/`plugin_call` 的精确名称、read/write annotations、closed
   input、permission/revision/live/grant fence、无 update/repair tests。
2. Green：管理工具 handler 调用同一 Host manager client/service contract；贡献工具调用同一
   Host-owned builtin supervisor，不自行读文件、拼状态、拉起 MCP 进程或传递 secret。
3. Refactor：readonly/desktop toolset projection 显式治理；readonly 只含读操作，不能因注册 full
   toolset 自动泄露 `plugin_call` 或生命周期写能力。

### Task 6 — 真实壳 Design Gate prototype

**Files:**
- Create: `packages/web/src/components/settings/plugin-manager/PluginManagerContent.tsx`
- Create: `packages/web/src/components/settings/plugin-manager/plugin-manager-fixtures.ts`
- Modify: `packages/web/src/components/ConnectorPluginInstallButton.tsx`
- Modify: `packages/web/src/components/SettingsResourceCard.tsx`
- Modify: `packages/web/src/components/settings/PluginsContent.tsx`
- Test: `packages/web/src/components/settings/__tests__/PluginManagerDesignGate.test.tsx`

1. Red：现有卡片语言、action 表达安装状态、搜索范围、页级右上角离线安装、固定卡片高度/截断、manifest icon/多语言描述、左栏 Install/卸载/toggle 边界、详情无重复 lifecycle action、无额外状态 badge/设置按钮、窄屏 navigation tests。
2. Green：在真实 Settings section 中以 explicit dev fixture flag 渲染，不加入 production fallback；离线安装复用 connector upload 组件。
3. 用 browser-preview 投递 feature server；co-creator 确认 before/after、宽屏/窄屏和失败态。
4. Gate 未确认前不进入 Task 7 的正式数据 wiring。

### Task 7 — 正式 Console wiring

**Files:**
- Modify: `packages/web/src/components/settings/plugin-manager/PluginManagerContent.tsx`
- Modify: `packages/web/src/components/settings/PluginsContent.tsx`
- Modify: `packages/web/src/components/SettingsContent.tsx`
- Modify: `packages/web/src/components/SettingsSidebar.tsx`
- Test: `packages/web/src/components/settings/__tests__/PluginManagerContent.test.tsx`
- Protect: `packages/web/src/components/settings/__tests__/OfficialPluginsPanel.test.tsx`
- Protect: `packages/web/src/components/__tests__/hub-connector-config-tab.test.tsx`

1. Red：API loading/search/filter/detail/mutations、optimistic fence conflict、catalog degraded、poll dedup tests。
2. Green：接 canonical REST；现有 typed panels 作为 detail contributions 迁入。
3. Refactor：移除 public official update/repair UI；IM section 在 Train B 仅标记兼容入口，Train C1 删除。

### Task 8 — Composition、回归与交付门

**Files:**
- Modify: `packages/api/src/domains/plugin/runtime-composition.ts`
- Test: `packages/api/test/plugin-manager-composition.test.js`
- Test: `packages/api/test/plugin-manager-restart.test.js`
- Docs: `docs/features/F202-plugin-framework.md`
- Docs: `docs/architecture/ownership/cells/plugin.md`

1. 在隔离 Redis 运行 install→configure/auth→enable→restart→disable→uninstall。
2. 证明 catalog offline 仍可管理 installed；stale revision、crash、quarantine、uninstall failure 全 fail closed。
3. 跑 focused API/Web/MCP tests、build、lint、`git diff --check`，再按风险进入 full gate。
4. 跨家族 review 通过后，按 #1478 进入 formal exact-content review；最终批准/合并前由 maintainers
   用已发布 exact package 完成可复现集成验收。历史 UI 方向反馈不替代这条证据。

**2026-09-01 exact-artifact checkpoint:** `clowder-ai-plugins` exact HEAD
`03289dc0d0013ce75e90f2896b01baaf542e32a5` 的 contract beta.13、SDK beta.9、
`video-analysis` alpha.0 已在审批 toolchain 下复现发布 digest。Core isolated admission 已用 exact
contract validator 消费 machine catalog 与 canonical `plugin.yaml`，并把 exact video tar 录入 Host
inventory；fresh consumer 的真实 MCP call 与 restart call 均 green。此 checkpoint 只关闭 catalog/
artifact consumability blocker。随后 paired isolated acceptance 已通过同一 `PluginManagerService`、Host
inventory/lifecycle 与 builtin-contribution supervisor 完成 install → configure → enable → real use →
restart/resume → real use → disable → uninstall，最终 instance 为 retired，secret 未进入 inventory。
Core feature composition 现已提供 fail-closed builtin dependency materializer：带依赖的包必须携带
publisher-owned lockfile-v3 `npm-shrinkwrap.json`，所有 lock entry 只能指向 canonical npm registry 且携带 canonical
sha512 integrity，Host 只执行 script-free `npm ci`。正式 Manager REST/Console live wiring 现包含
revision-fenced typed configuration contribution；它不是第七个 generic Agent management operation。
动态 contribution 通过静态治理的 `plugin_list_tools`/`plugin_call` 间接面暴露，执行仍由 Host
supervisor 持有并在每次调用前复核 live/grant authority。
composition 同时提供 repository-local/connector compatibility projection、durable quarantine ledger
与 authenticated same-origin package icon route。按既定 Train B/Train C 边界，Console live wiring 仍以
non-production `pluginManagerLive=1` 显式启用，production default 留给 Train C1 聚合切换，避免丢失
Personal Chrome pairing 等专属 journey。production machine catalog 已切换到 bounded HTTPS provider；
`@clowder-ai/video-analysis@0.1.0-alpha.0`、contract beta.13 与 SDK beta.9 已发布，catalog/npm digest
逐字一致，video package 携带 lockfile-v3 `npm-shrinkwrap.json` 并可由 terminal materializer 以
script-free `npm ci` 闭合依赖。外部发布状态 provenance：`[primary | npm registry + machine catalog +
exact repository HEAD | checked 2026-09-10 | Train B deployability | high confidence]`。最终 co-creator
hands-on journey acceptance 不是 formal review 的前置条件，也未被追认为历史完成事实。
`clowder-ai-plugins#50` 中 reviewed `@clowder-ai/video-analysis@0.1.0-alpha.1` artifact 的公开 npm
可用性与 digest-matched 最终集成仍待完成；maintainers 必须在最终批准/合并前记录完整旅程证据。

## 8. 既有正确行为保护

- Feishu owner auth、meeting intake、signal routes 的 typed product flows 不因 Manager 统一而失效。
- Personal Chrome 明确安装/配对/会话绑定与 receipt semantics 不被 generic plugin status 替代。
- Repo-local skill/MCP/limb enable/disable 与 capability ownership 在 Train C1 cutover 前保持兼容。
- Connector bindings、消息幂等、thread routing 与 secret tombstone 不在 Train B 搬迁或重写。
- Host Broker handshake、lease、durable call settlement、restart recovery 与 closed child environment 保持原安全边界。
- 用户可见/可恢复数据继续默认持久化；uninstall 数据处置只按 manifest policy 与用户显式选择执行。

## 9. 验证命令

```bash
pnpm --filter @cat-cafe/shared test
pnpm --filter @cat-cafe/api build
pnpm --filter @cat-cafe/api exec node --test test/plugin-manager-*.test.js
pnpm --filter @cat-cafe/mcp-server test
pnpm --filter @cat-cafe/web exec vitest run src/components/settings/__tests__/PluginManager*.test.tsx
pnpm lint
pnpm build
git diff --check upstream/main...HEAD
```

涉及 Redis 的 restart/atomicity 测试必须使用 test harness 的隔离 store；不得指向运行实例数据。
