---
feature_ids: [F202]
topics: [plugin-framework, train-c1, convergence, worklist]
doc_kind: plan
created: 2026-09-21
architecture-cell: plugin
---

# F202 C1 — 两仓收敛工作清单（可直接开工）

> **已被取代（2026-09-21）：决策入口改为 `2026-09-21-f202-c1-contract.md`。** 本文多处结论已被推翻，仅作推导过程存档，不要据此动手。

> **⚠️ 本文是推导过程存档，不是决策依据。** 1,055 行中多处结论已被后续证据推翻
> （见各节自带的作废标记）。**决策请看
> [`2026-09-21-f202-c1-honest-assessment.md`](./2026-09-21-f202-c1-honest-assessment.md)（101 行）。**


> 设计依据在 `2026-09-20-f202-c1-host-plugin-interface-contract.md`。本文只讲**改什么、什么顺序**。

## 0.04　实际状态（读实物，2026-09-21）：两边都停在「声明完成、实现体未开始」

§0.03 里我写「插件仓那一半早就做完了」——**错的，只有声明做完了。**

**插件仓**（operator 已手动暂停该线）：14 个 manager-installable 包，
13 个 contract/sdk/yaml/runtime/catalog/freshConsumer 六项齐全。
唯一未闭合的是 `github-operations`，它自己的 closure 字段原文：

- `sdkClosure`: *beta.12 module dependency and **seven schedule action handlers required** before terminal*
- `runtimeClosure`: *carrier-neutral module and **operation bodies pending C1 implementation***
- `catalogClosure` / `freshConsumerClosure`: *required; pending …*

实物佐证：`packages/github-operations/src` 共 **89 行**
（`schedules.ts` 42 + test 45 + index 2），`runGitHubSchedule` 只做入参校验后
`await port.run(input)`，而 `GitHubOperationPort` **没有实现体**。
7 条 schedule 的真实逻辑仍在 Host 的 `github-schedule-factories.ts` 一侧。

**Host**：SDK pin `0.1.0-beta.10`，契约 `machineTruth` 要 `0.1.0-beta.12`，
插件仓当前已到 `0.2.0-beta.1`；contract pin `beta.15` vs 插件仓 `beta.17`。
`coreImplementationLane.requiredBehavior` 三条一条未做。

> **所以「感觉像从 0 开始」不是错觉，也不是回退：这一阶段两边本来就停在
> 声明/契约/计划完成、实现体未动的位置。** 本轮没有推进它——
> 时间花在了重新推导一份已存在的契约上（根因见 §0.03）。

**依赖顺序第 1 步是 Plugins 的打包产物**，而该线被 operator 手动暂停；
Host 可并行推进的是 requiredBehavior 第 1 条（把已有能力映射进冻结面）与 SDK pin 对齐。

## 0.03　根因更正：这份清单的大部分内容，两仓早就在迁移契约里写死了（我从没读过）

operator 问「你们问我的那些问题，插件仓最初就已经明确和声明过了，理论上早该做完了」。
去读插件仓，属实。**本文 §0.0–§0.02 的多数推导都是在重新发明一份已存在的契约。**

真相源：`clowder-ai-plugins` 分支 `feat/f202-train-c1-plugins-migration`
（HEAD `81aeb95`，ahead 30），文件 **`migration/f202-train-c1-inventory.json`**。
关联：`acceptedCoreIssue = zts212653/clowder-ai#1478`；
Core 对侧 PR `#1487`，其 plan 就是本仓的 `docs/plans/2026-09-19-f202-train-c1-migration-plan.md`。

### 被这份契约推翻的四条（全部作废）

| 我写过的 | 契约原文 |
|---|---|
| 「Host 不该造适配器」 | `reusedSurfaces`：**Host-owned** FeatureContext config, secret, state, connector ingress, logging, and **contribution adapters** —— 适配器是已达成的复用面，不是要发明的东西 |
| 「新动词要在 contract 加 wire 行」 | `machineTruth`：**frozen 13-row wire** + SDK **0.1.0-beta.12** module/lifecycle/action boundary；插件侧 requiredBehavior：*without adding provider-specific wire methods* |
| 「往 main 的 4 类 resource 收敛」 | 插件仓 `plugin.yaml` 用的就是 contract 形状（`contributions` + `features`）。收敛指**复用 main 的能力实现**，不是复用 main 的 manifest 格式 |
| 「插件仓是总闸 / 要迁 3 个类型」 | `github-operations/plugin.yaml` 已把 7 条 `factoryId` 换成 `action: {method}` + `schedule` + `policy`，包有 `src/` `dist/`。**插件仓那一半早就做完了** |

### Host 侧要做什么：契约里三句话（`trustBoundary.coreImplementationLane.requiredBehavior`）

1. map existing Host-owned configuration, secrets, bindings, state, schedules,
   webhooks, and delivery authority **into the frozen plugin surfaces**
2. prove no double-run, switch the production defaults, and **delete provider-specific
   Core implementations**
3. preserve secret redaction, durable state, rollback, and wake authority
   **without business-specific Host branches**

**第 1 条就是「适配器」的真实含义：把已有能力映射进冻结的面。是映射作业，不是设计作业。**

`hostKernelRetained` 明确留在 Host 的 7 项，含 **generic webhook and schedule activation**。

### 跨仓依赖顺序（`terminalAcceptanceContract.dependencyOrder`）

```
1. Plugins exact Linux-packed artifact
2. Core exact-artifact integration journey     ← Host 在这一步
3. Plugins merge and registry publication
4. Core registry pin, final journey, and merge
```

`followupPolicy: no C1 cleanup follow-up PR`——不留尾巴。

### 根因（写在这里防止下一位重犯）

**我从 Host 源码反推了一整轮，而答案写在两仓已达成的迁移契约里，我一次都没打开过它。**
布偶猫家族病「我能猜出来」的教科书案例：读 Host 代码得到的每个"发现"，
契约里都有对应条目。**动手前先读 `migration/f202-train-c1-inventory.json` 与
`docs/plans/2026-09-19-f202-train-c1-migration-plan.md`。**

## 0.05　唯一接口表（冻结候选 · 2026-09-21）

> 本节取代 §0.0–§0.04 中所有零散的"缺什么"判断。**接口表冻结前不写任何 Host adapter。**
> 三分类：**已有**（可直接复用）· **重复**（同一件事多套实现，需收敛）· **缺失**（要新增）

### 层 1 · 静态声明

| 声明内容 | 现在在哪（file / 行数） | 判定 |
|---|---|---|
| 元数据 id/name/version/icon/docsUrl/setupSteps | main `plugin-manifest.ts`(351) · IM `im-connector-manifest.ts` · C1 `package-staging.ts`(234) | **重复 ×3** |
| 配置字段 | 同上三处，且形状分叉：main / IM 用 `envName,label,sensitive,required`；contract 用 `key,label,kind,required` | **重复 ×3 + 形状分叉** |
| skill / mcp 声明 | main `resources[{type,path}]` · contract `contributions[{type,id,path}]` | **重复 ×2** |
| schedule 声明 | main `resources[{type,name,factoryId}]`（指向 Host factory） · contract `contributions[{schedule,action,policy}]`（指向插件 action） | **重复 ×2 且语义相反** |
| limb 声明（auth / error / capabilities→commands） | `limb-yaml-loader.ts`(112) + `limbs/*.yml` | **已有**（通用适配器驱动，形状可复用） |
| test / healthCheck | main `healthCheck.limbCommand` | **已有**（仅 main 有，contract 侧无对应） |

**收敛目标**：一份包清单承载以上全部；`connector.yaml` 与 main `plugin.yaml` 高度同形，应先合这两套。

### 层 2 · 生命周期

| 能力 | 证据 | 判定 |
|---|---|---|
| install / prepare / enable / disable / repair / uninstall（带 revision fence + 按实例互斥） | `external-plugin-lifecycle.ts`(370) | **已有** |
| runtime start / stop / stopAll / restart recovery + 状态机 + 权限栅栏 | `bundled-runtime-carrier.ts` | **已有** |
| carrier 路由（按 manifest 选载体，不认 pluginId） | `runtime-carrier.ts`(113) | **已有** |
| 包加载 `create(manifest)` | `module-plugin-runtime.ts:90` | **已有** |
| **enable → `activate(featureId, context)` → 保存 `{actions, dispose}`** | 无 | **缺失** |
| **disable / uninstall / 启动失败 → 确定性 `dispose()`，失败时零 partial actions** | 无 | **缺失** |

> **整层只缺这两行。** 上一个 PR 的 Plugin Manager 是完整的，缺的是它与包内回调之间的最后一段接线。

### 层 3 · 动态交互（Host 能力端口 ↔ 冻结 FeatureContext）

| FeatureContext 需要 | Host 侧现状 | 判定 |
|---|---|---|
| `config.get` / `secrets.get` | `manifest-configuration-projection.ts`(164)，grant-checked、fail-closed | **已有** |
| `state.get/set` | 全仓无 plugin state store（grep 零命中） | **缺失** |
| `skills.register/dispose` | `addSkill` / `removeSkill` | **已有**（需薄包，勿走假定源码目录的 `PluginResourceActivator`） |
| `mcp.register/dispose` | `installMcpCapability` / `removeMcpCapability` | **已有**（需薄包） |
| `limbs.register/dispose` | `limbRegistry.register/deregister` | **已有，但被 pluginId 白名单挡住**（`index.ts:4356,4360`） |
| `scheduler.register/dispose` | `taskRunner.registerPostStart/unregister` | **已有，但要求 Host 源码内的 factory**（`PluginResourceActivator.ts:504,509`） |
| 出站发消息 | wire `messaging.send` | **已有** |
| Host→插件回调 | `module-host-invocation.ts:31` 把方法名写死成 `host.messaging.deliver` 并当实例属性查 | **形状错，需改为查 `activate` 返回的 actions 表** |
| `messaging.subscribe` | `SubscriptionDelivery`（`runtime-composition.ts:301` 已装配，`.register()` 无生产调用点） | **半接线** |
| thread 归属 | `ThreadStore.updateConnectorHubState(ConnectorHubStateV1)` | **形状过窄**（连接器专属，非通用 pluginInstance 归属） |
| 入站地址签发 | `createRelayAddressProvisioner`（`relay-address-provisioning.ts:98`，零生产调用者） | **半接线** |

### 冻结后的最小实现片（次序）

1. 层 2 两行（activate / dispose 接线）+ 层 3 的 `skills` 薄包 → 让已恢复的声明式 RED（`0f7c62983`）转绿
2. 改 `module-host-invocation` 的方法解析（写死常量 → actions 表）
3. 层 1 先合 `connector.yaml` 与 main `plugin.yaml` 两套同形声明
4. limb / scheduler 白名单随层 3 的回调接通自然消失

**在本表被 operator 认可冻结前，不写 Host adapter。**

## 0.0　更正（2026-09-21，operator 两问逼出来的）：卡点不在插件仓，在 Host 自己的两个白名单

operator 问了两句，两句都推翻了本文先前的结论：

> 「为什么不 feishu 这个不发版本就迁移不出去这个逻辑；host 为什么要造适配器 造什么适配器」

**答一：不该造适配器。** Host 今天有**两套互不相干的插件系统**，且零共享代码路径
（`PluginResourceActivator` 在 `runtime-composition.ts` 里被引用 **0 次**）：

| | 传统系统（F202 Phase 2） | C1 系统 |
|---|---|---|
| 入口 | `PluginResourceActivator.enablePlugin(manifest)` | carrier + `FeatureContext` + `FeatureHostAdapter` |
| 装配 | `index.ts:4294-4543` | `runtime-composition.ts` |
| 类型 | `@cat-cafe/shared` `PluginResourceDef`（4 类） | `plugin-contract` `StaticContribution`（12 类） |
| **实际能激活东西吗** | **能，今天就在跑** | **能跑插件**（feishu intake / content-editor / builtin MCP），但**从未向 capabilities / limbRegistry / taskRunner 注册过任何东西** |

`FeatureHostAdapter` / `FeatureContext` / module 载体**只为第二套服务**。传统系统注册
skill/mcp/limb/schedule 全程**没有适配器、没有 FeatureContext、没有 per-feature activate**。
所以「Host 要实现 6 个方法的适配器」是**给过度设计补零件**，不是 operator 要的收敛。

**答二：「不发版就迁不出去」不成立。** 本地文件夹安装早就有
（`LocalPluginPackageAdmission`，装配在 `runtime-composition.ts:692`）；出站发消息也早就有
（wire 表第 3 行 `messaging.send`）。

**真正卡住 github 代码出不去的，是 Host 自己写死的两个白名单**（逐条核过）：

| 白名单 | 位置 | 后果 |
|---|---|---|
| schedule 必须引用 Host 注册的 factory | `PluginResourceActivator.ts:504` 强制 `factoryId`；`:509` `getForPlugin(factoryId, manifest.id)`；查不到抛 `Unknown schedule factory`。全仓唯一注册者 = `index.ts:4350 registerGitHubScheduleFactories` | **任何 Host 源码外的插件都不可能拥有定时任务** |
| limb 必须有 Host 注册的 adapter 工厂 | `index.ts:4356` `set('weixin-mp', …)`、`:4360` `registerWeChatVisibleReaderLimbFactory(…)`；miss 即 throw | **只有这 2 个写死的 pluginId 能有 limb** |

skill 与 mcp **没有**白名单——所以这两类插件今天就能从外部完整工作。

**据此改写结论**：这不是跨仓总闸，是 Host 单方的小改造。把 schedule 从「引用 Host 写好的
factory」改成「插件声明要跑什么」，limb 同理，7 个 github factory 才可能出去。
§4 顺序图里「先迁类型 / 先发版」那一格**作废**。

## 0.01　再更正（同日，比 §0.0 更靠根）：两套系统各占闭环一半，谁都不能删

§0.0 提出的「删掉 C1、回到传统系统拆白名单」**是错的**。逐条核完：

| | 传统系统 | C1 系统 |
|---|---|---|
| 插件从哪来 | `pluginsDir = packages/api/src/plugins`，`PluginRegistry.scan()` = `readdirSync`（`PluginRegistry.ts:36,46`） | `LocalPluginPackageAdmission.install()`（`local-package-admission.ts:199`），有 inventory / 完整性 / 生命周期 |
| 有安装 / 卸载吗 | **没有**。`plugin-routes.ts` 只有 list/get/enable/disable/config/test | **有** |
| 能注册能力吗 | **能**：skill/mcp/limb/schedule | **不能**：插件跑得起来，但注册不进 Host 的能力面 |

**传统系统里「插件」的定义就是「Host 源码树里的一个目录」。**
这才是 github 代码出不去的根因——它不是"Host 里混进了插件代码"，
它是**传统系统定义下的一个合法插件**。§0.0 说的两个白名单
（schedule factory / limb adapter）是这个定义的**结果**，不是原因：
插件既然是源码，factory 当然可以在 Host 源码里 `register`。

**闭环 = 把 C1 的安装/卸载/生命周期，接上传统系统的能力注册面。**
既不删 C1，也不删传统；收敛点是两者之间那条今天不存在的连线
（`PluginResourceActivator` 在 `runtime-composition.ts` 里 0 引用）。

据此，Host 侧的活一句话：**让能力注册由「已安装的包」驱动，而不是由「源码目录」驱动。**
做完这一条，github 目录才能从 `packages/api/src/plugins` 变成一个可安装包。

## 0.02　接头形状：两层互补（operator 2026-09-21 纠正了 §0.02 初稿的伪二选一）

初稿把它写成「声明式 vs 命令式，二选一」，**operator 指出这是伪命题**：

> 「plugin.yaml 插件的元数据和能力声明；sdk 让插件能和 host 主动双向交互；两者是互补的」

**两层，各管各的：**

| 层 | 载体 | 管什么 | 今天状态 |
|---|---|---|---|
| 声明 | plugin.yaml（main 那套 `PluginManifest{ id, config, resources[] }`） | 元数据 + 提供哪些能力 + 配置 | **能用**，skill/mcp 无白名单 |
| 交互 | SDK `FeatureContext` | 运行时双向调用（插件要执行代码的那些） | SDK 侧已备齐，Host 侧无动词 |

**按能力类型分工，不是全局二选一：**

- **skill / mcp**（静态资源：挂文件、起进程）→ 声明就够，Host 照 main 的路径激活。**今天就没有白名单。**
- **schedule / limb**（要执行插件代码）→ 必须有双向通道，这正是两个白名单的由来：
  插件不能提供 handler，所以 handler 只能写在 Host 里。

### 实物证据：main 的声明面比此前记录的宽得多，耦合只剩「可执行件的指针」

operator 补充「静态的比如插件的配置、im connector 那边的 action、还有 test
这些通用能力其实都是基于 yaml 来声明的」。读实物，属实且更彻底。

**`plugins/github/plugin.yaml` 全文 = 元数据 + i18n + `config` 三字段 + 7 条
`{type: schedule, name, factoryId}`。** 整个 github 插件在 main 模型里就这些。

**`plugins/weixin-mp/plugin.yaml`** = 元数据 + i18n + `config` 两字段 +
`{type: limb, path}` + `{type: skill, path}` + `healthCheck: { limbCommand: … }`（即 test）。

**`plugins/weixin-mp/limbs/weixin-mp.yml`（292 行）** 顶部原话：
「通用 PluginLimbAdapter 从此文件驱动 HTTP 调用和 invoke handler」。
它声明了 `auth`（client_credentials，模板变量 `${WEIXIN_MP_APP_ID}` 引用插件 config）、
`error` 解析路径、`capabilities → commands`（即 operator 说的 action，带 authLevel）。

**所以 main 的声明面已覆盖：** 元数据 / i18n / 配置字段（含 sensitive、required）/
setupSteps / docsUrl / healthCheck(test) / limb 的 auth+error+actions / skill 与 mcp 的资源路径。

**两个插件的耦合形状完全一样，各只剩一根指向 Host 源码的指针：**

| 插件 | 声明（已解耦） | 指针（未解耦） |
|---|---|---|
| github | 全部 yaml | `factoryId: github.cicd-check` … 7 条 → Host 源码里的 factory |
| weixin-mp | 全部 yaml（含 292 行 limb 声明） | `limbAdapterRegistry.set('weixin-mp', …)` 里的 `handlers: weixinMpHandlers` |

> **所以 §0.02 缺口 ② 不是「两个白名单」两件事，是一件事：
> 插件需要一条通道，把「可执行件」从自己的包里交给 Host，而不是让 Host 源码持有它。**

这也解释了 operator 那句「已有的插件只是很早就在帮我们补齐相关的能力；但是没有解耦而已」——
声明层当年就是按可拆分设计的（通用 PluginLimbAdapter 就是证据），差的只有这根指针。

### 收敛方向：C1 往 main 收敛，不是反过来

> operator：「c1 往我们当前的 main 的那套收敛本来就是合理的；
> main 上那一套就是为了在做拆分做准备的……已有的插件只是很早就在帮我们补齐相关的能力；但是没有解耦而已」

main 的 4 类 `PluginResourceDef`（skill/mcp/limb/schedule）是**有实现的那一套**；
contract 的 12 类 `StaticContribution` 只有 2 类被真正消费。
**收敛 = 让已安装包的能力声明走 main 的激活路径，不是在 Host 里新建一台 12 类解释器。**

Fable review 担心的「Host 长出 12 类解释器」是真风险，**但解法是不采纳 12 类模型**，
不是把 skill 这种静态资源也改成运行时注册。该 review 的这一条据此更正。

### 「造适配器」错在方向，不是错在存在

`FeatureHostAdapter` 由 SDK 定义、却要 Host 去实现——依赖方向反了，这才是 operator 问的那个"造什么适配器"。
正确形状：**Host 只定义 wire 动词；SDK 内部把 `FeatureHostAdapter` 实现成 wire 客户端；Host 永远看不见它。**

### Host 侧实际缺的三处（全是接线，无新机制）

1. **把已安装包接上 main 的激活路径**（声明层，**不需要 wire 动词**）：
   已安装包的能力声明今天到不了 `addSkill` / `installMcpCapability`。
   薄包**已有原语**即可：`addSkill` / `removeSkill`、`installMcpCapability` / `removeMcpCapability`。
   **不要直接调 `PluginResourceActivator`**——它假定插件住在 `pluginsDir`
   （`assertPluginResourceInsideRoot` 走 `join(pluginsDir, manifest.id)`），
   已安装包不在那儿；要接在它下面一层。
   **这一条就能让 skill / mcp 类插件完整工作**，且零跨仓依赖。
2. **加两个 Host→插件回调**（交互层，**只为 schedule / limb**）：schedule 触发、limb 调用，
   形状照 `host.messaging.deliver`。**加上之后两个白名单自然消失**——
   factory 和 adapter 就是插件自己的 handler，不用专门拆。
   只有这一条需要 contract 加 wire 行（见下）。
3. **module 载体补两件**：今天只调 `create(manifest)`（`module-plugin-runtime.ts:90`）；
   需要给插件实例一个回环连接（`openBuiltinConnection` 已存在，`control-plane.ts:164`，
   目前只有 content-editor 在用），并在 enable/disable 时调它的钩子。

禁用/卸载时 Host 还要按 `pluginId` 清一遍该插件注册过的能力，防止插件崩溃后残留。

### 跨仓事实（排第一项，不是总闸）

wire 方法名是已发布 contract 里的**封闭枚举**：`control-plane.ts:315-317`
`WIRE_METHOD_REGISTRY[method]` + `ready` + 方向检查，无逃生口；
`openBuiltinConnection` 走同一个 control plane，**module 插件不绕过此闸**。
所以新动词要先在 contract 加行——插件仓一个小 PR，作为第一项排期，**不需要 operator 放行**。
「迁 3 个类型」方案继续作废。

## 0. 目标形态（operator 裁定，一句话）

```
Host 提供双向接口  →  SDK 包装这些接口  →  插件实现接口  →  Host 加载插件
```

单向依赖：`插件 → SDK → contract ← Host`。**Host 永不 import SDK。**

## 0.5　编号改用 operator 的 a/b/c/d（2026-09-21 复核；C-1…C-6 作废）

operator 原话：「c1/c2 呢 又是什么」「明明是很清晰的开发思路；为什么搞的乱七八糟的」。
C-1…C-6 是我自造的内部编号，只制造了理解成本。**从此只用 operator 的分步语言。**

| Host 侧 | operator 原文 | 旧编号 | 复核后状态 |
|---|---|---|---|
| **a)** | 整理我们应该暴露的能力，基于插件和 im connector 需要的来评估；收敛整合，不一味新增 | C-1/2/3/4/6 | **未闭合** |
| **b)** | 确保我们的插件是真的能加载的，不是一个插件一个子进程 | **旧清单根本没有这一项** | **未开工，是最大的洞** |
| **c)** | 整理好暴露的能力后清理所有插件代码；跨成员 review 和提交 PR | C-5 | 未开工（判据已落盘，范围待全仓重扫） |
| **d)** | 等插件仓发布后基于插件安装包完整验收 | 末尾 | 未开工 |

## 0.6　a) 的交付物：按 operator 模型的能力对照表（2026-09-21 全仓清点）

> operator 2026-09-21 原话（这是终态模型，不是需求变更）：
>
> 「sdk 提供一个标准的基于 lifecycle 的接口；然后插件实现这些接口；比如
> init/start/enable/disable/pre_destory/destroy 之类的……然后 sdk 还提供一个双向的
> 能力接口；就是前面说的注册注销 mcp/skill/scheduler/limb 工具/增删改查 thread/
> 收发消息之类的……host 这边提供统一的接口的；然后接口提供好后；然后就可以删代码」
>
> **清点结论：这个模型和代码现状高度吻合，而且它解释了为什么代码一直删不掉。**

### 先钉一个此前没人写下来的事实：Host 里有两套 manifest 体系

| 体系 | 类型定义处 | 类型集合 | 谁在用 |
|---|---|---|---|
| **旧 plugin.yaml**（`PluginResourceDef`） | `packages/shared/src/types/plugin.ts:64` | **4 类**：skill · mcp · limb · schedule | `PluginResourceActivator` **全部走这套** |
| **契约**（`StaticContribution`） | `@clowder-ai/plugin-contract` | **12 类** | 只有 `McpContribution` 与 `ContentEditorProviderContribution` 被真正消费，其余 10 类**零引用** |

`PluginResourceActivator.ts:5-13` 从 `@cat-cafe/shared` 导入，**不是** contract。
`plugin-manifest.ts:29` `SUPPORTED_RESOURCE_TYPES = {skill, mcp, limb, schedule}`。

**这才是 R-5「清单格式互不兼容」的实际内容**：不是三份 YAML 长得不一样，
而是**能跑的那套（旧 yaml）和契约那套是两个类型系统**。

### 12 类 contribution 的 Host 现状（每格都有 file:line）

| 类型 | Host 注册入口 | 卸载入口 | 通用性 | 判定依据 |
|---|---|---|---|---|
| **skill** | `PluginResourceActivator.ts:302` `activateSkill`→`:336` `addSkill` | `:368` `deactivateSkill`→`:383` `removeSkill` | ✅ **真通用** | 全程只用 `manifest.id` 作归属，无白名单、无 transport 判定 |
| **mcp** | ①旧 yaml `:437` `activateMcp`→`:462`　②契约 `builtin-contribution-supervisor.ts:277` `start` | ①`:488`+`:496`　②`:351` `stop`/`:366` `stopAll` | ①✅通用　②❌builtin 专用 | ②`:273-275` `claims()` 只认 `transport==='builtin'`；`:231-235` 非 mcp 直接抛 `UNSUPPORTED_CONTRIBUTION` |
| **schedule** | `PluginResourceActivator.ts:503`→`:535` `registerPostStart` | `:552`+`:564` `unregister` | ❌ **假通用** | `:509` 只接受 `getForPlugin(factoryId, manifest.id)`；`ScheduleFactoryRegistry.ts:53-58` 要求 `factory.pluginId === pluginId`；**全仓唯一注册者是 Host 内硬编码的 7 个 github factory**（`github-schedule-factories.ts:404-410`，由 `index.ts:4351` 装入）；非 github 插件声明 schedule 一律在 `:517` 抛 `Unknown schedule factory` |
| **limb** | `:397` `activateLimb`→`:414` `limbRegistry.register` | `:425`+`:433` `deregister` | ❌ **假通用** | adapter 工厂表只被填了两条硬编码：`index.ts:4356 set('weixin-mp',…)`、`wechat-visible-reader/factory.ts:47`；另 `index.ts:4526` 直接写死 `pluginId === 'wechat-visible-reader'` |
| **content-editor-provider** | `content-editor-runtime/runtime.ts:79` `start`→`:160` | `:87` `stop`→`:232` `close` | ❌ builtin 专用 | `admission.ts:9-26` 六重闸门：`transport==='builtin'`、`entrypoint===undefined`、configuration/data 必须为空、**所有** contribution 必须是本类型、feature 零 capability 零 resource |
| **connector** | 无（类型零引用）；最接近的是整包 runtime `collective-connector-runtime.ts:43` | `:60` `stop` | ❌ 硬编码单一 pluginId | `:39-41` `claims()` 判 `manifest.pluginId === COLLECTIVE_CONNECTOR…pluginId` |
| **identity** | **无** | 无 | — | 仅 `plugin-manager-projection.ts:100` 只读投影给 UI |
| **tool** | **无** | 无 | — | `DirectToolContribution` 无人读；唯一「tool」运行面是从 mcp 子进程 `tools/list` 派生（`builtin-contribution-supervisor.ts:408`），不是声明的 tool |
| **webhook** | **无** | 无 | — | `routes/connector-webhooks.ts:31` 用自己的 `Map`，由 connector-hub 填，从不读 manifest |
| **message-subscription** | **无** | 无 | — | `SubscriptionDelivery` 的订阅来源是调用方传入的 `SubscriptionDeclaration`（`subscription-delivery.ts:89-95`），不是 contribution |
| **service** | **无** | 无 | — | 类型零引用；`healthMethod` 全仓零命中 |
| **ui** | **无** | 无 | — | 三个子类型（含 `UiCommandContribution`）在所有 `packages/*/src` 零引用 |

**12 类里：真通用 1 类（skill）· 假通用 2 类（schedule/limb）· builtin 专用 3 类 · 完全没有 6 类。**

### 这张表回答了「为什么代码一直删不掉」

**schedule 那一行是钥匙。** 当前 schedule 的注册面是
**「插件引用一个 Host 里已经写好的 factory」**，而不是**「插件提供实现」**。
`ScheduleFactoryRegistry` 强制 `factory.pluginId === pluginId`，而 factory 只能由
Host 源码在启动时 `register` 进去——所以 github 插件的 7 个 factory
**必须住在 Host 里**（`github-schedule-factories.ts` 722 行 + 它 import 的
`infrastructure/email/` 6,068 行）。

> **不是「先删代码再改接口」，是「接口形状不改，代码就出不去」。**
> operator 的顺序（先整理收敛接口 → 再删代码）在因果上是唯一可行的顺序。
> limb 同理（adapter 工厂写死两个 pluginId），connector 同理（写死单一 pluginId）。

### 据此 Host 的活（按 operator 的两类接口重新表述）

**① lifecycle 接口**（`init/start/enable/disable/pre_destroy/destroy`）：
Host 今天的对称面散在 `PluginResourceActivator.activateResource/deactivateResource`
与各 runtime 的 `start/stop`，**语义不统一、状态存两处**（mcp 一个 inventory、
一个 `capabilities.json`）。活 = 归一到一条生命周期。

**② 双向能力接口**（注册注销 mcp/skill/scheduler/limb + thread 增删改查 + 收发消息）：
- skill：✅ 已达标，可直接作为其余各类的**范式样板**
- scheduler / limb / connector：把「引用 Host 内实现」改成「插件提供实现」——
  这是 c) 能删代码的**前置条件**，不是并行项
- mcp：两套合一
- thread 增删改查 / 收发消息：契约有 `thread.listMetadata` / `thread.readContent` /
  `host.messaging.deliver`，Host 侧分别是 0 命中与 R-1 三条路，需接线与合并

**③ 其余 6 类（identity/tool/webhook/message-subscription/service/ui）**：
先不动——按 operator「不应该一味的新增」，等插件仓 a) 报出真实诉求再补。

### a) 的答案不用发明——契约里已经写好了

Host 该暴露的通用能力面是**两张已发布的表**，不是新设计：

| 面 | 定义处 | 规模 | Host 侧实现 |
|---|---|---:|---|
| Wire 方法表（跨进程插件走 stdio broker） | `plugin-contract` `dist/wire/registry.d.ts` | **13 行**（含 `broker.hello`/`broker.ready` 两行协议握手） | messaging 数行已装配 |
| `FeatureHostAdapter`（进程内 module 插件） | `plugin-sdk` `dist/feature-context.d.ts:79` | **6 个方法** | **0 处实现** |
| `Capability` 授权表 | `plugin-contract` `dist/generated/contract.generated.d.ts:22` | **17 项** | 与上两张表从未对账 |

`FeatureHostAdapter` 全文只有六个方法，本身已是收敛形态：

```
readConfig / readSecret / readState / writeState
registerContribution / disposeContribution
```

`registerContribution` 收一个 `StaticContribution`，**一个方法覆盖全部 12 种 contribution 类型**
（identity / schedule / tool / mcp / skill / limb / webhook / message-subscription / service /
connector / ui / content-editor-provider）。这正是 operator 要的「收敛和整合」，而且契约已经做完了。

### 决定性事实：Host 一个都没实现（0 处，可直接清点）

```
grep -rn "FeatureHostAdapter|registerContribution|disposeContribution" packages/api/src  →  0 命中
```

Host 只有 **builtin 专用**注册路径（`runtime-composition.ts:146,326,671` 的
`registerBuiltinContributions`、`manager/builtin-contribution-supervisor.ts`），
没有契约定义的通用适配器。

**这一条把 a) 和 b) 解释成同一件事**：`builtin-runtime/module-plugin-runtime.ts:44`
原文写着 "Loading is done here; activation is not."。activate 需要 `FeatureContext`，
构造 `FeatureContext` 需要 Host 提供 `FeatureHostAdapter`——Host 没有，
所以插件**装得上、载得进，但永远激活不了**。

因此 **a) + b) 的核心工作量 = 实现这 6 个方法并把 activate 接起来**，
不是「补齐 17 项能力」。范围比旧清单小一个数量级。

### 依赖方向违规：一处，且根因可一句话封死

`packages/api/package.json:63` 依赖 `@clowder-ai/plugin-sdk@0.1.0-beta.10`；
非测试源码 import **1 处**：`external-runtime/stdio-broker-transport.ts:26`，
取 `createStdioChannel` / `classifyFrame` / `StdioFrame` 等 stdio 帧原语。

这与 `FeatureHostAdapter` 住在 SDK 是**同一个病**。判据：

> **`plugin-contract` = 双方都依赖的契约；`plugin-sdk` = 只有插件依赖。
> 凡 Host 必须实现或必须调用的类型与原语，必须住在 contract。**

按此判据需迁 contract 的有两处：`FeatureHostAdapter`（Host 必须实现）、
stdio 帧原语（Host 必须调用）。**这是插件仓侧的第一件事**，
也正是 operator 说的「如果发现接口签名有问题，就和 host 沟通再同步调整」。

### b) 的现状：确实是「一个插件一个子进程」，但共享进程的载体已经造好了

全仓清点运行时隔离点（`spawn` / `createServer` / `import()`，无 `worker_threads`/`vm`/`isolated-vm` 命中）：

| 载体 | 隔离单位 | 证据 |
|---|---|---|
| 外部 stdio 插件 | **每 pluginInstance 一个 Node 子进程** | `external-runtime/node-process-adapter.ts:64` `spawn`；`supervisor.ts:44` `Map<instanceId, RuntimeExecution>`、`:181` 每次 `startOwned` 一次 spawn |
| builtin contribution（MCP） | **每插件的每个 contribution 一个 MCP 子进程** | `manager/builtin-contribution-supervisor.ts:148,299-303,536` |
| content editor | **每 instance 的每个 feature 一个 HTTP server** | `content-editor-runtime/surface-server.ts:64,107`；`runtime.ts:152-175` |
| **module（进程内）** | **共享 host 进程，0 子进程** | `builtin-runtime/module-plugin-runtime.ts:78-90` `import()` + `create(manifest)` |
| IM connector（系统 C） | 共享 API 进程，0 子进程 | `im-connector-loader.ts:114-115` `await import()` |

一个 stdio 插件激活实际创建：**1 子进程 + 1 broker 连接 + 1 stdio transport + 1 心跳定时器**
（`supervisor.ts:155-224` 逐行可数）。

**共享进程的路径不需要新建——已经造好且已接线**：`ModulePluginRuntime` 已注册进
`BundledPluginRuntimeCarrier`（`runtime-composition.ts:285,287-299`）。
carrier 认领条件是 `runtime.transport === 'builtin' && typeof runtime.entrypoint === 'string'`
（`module-plugin-runtime.ts:58-61`）。

**没有任何真实包走这条路**，原因可直接清点：catalog 三个条目里
（`official-catalog.ts:117-176`）feishu-meeting-intake = stdio、
collective-connector = builtin **但没有 entrypoint**（`:116`）、genoffice-docx = content-editor。
没有 entrypoint → `claims()` 返回 false → 被 `CollectiveConnectorBuiltinRuntime` 抢先认领。
唯一走通 module carrier 的是测试 fixture（`test/f202-c1-module-carrier.test.js:33`）。

**所以 b) 拆成两件小事，不是重写运行时**：
1. **插件仓侧**：manifest 声明 `runtime: { transport:'builtin', entrypoint:'dist/plugin.js' }`
2. **Host 侧**：实现 `FeatureHostAdapter` 6 方法 → 构造 `FeatureContext` → 调 `activate`
   （现在卡在这里：`module-plugin-runtime.ts:44` "Loading is done here; activation is not."，
   所以插件的 identity / schedule / tools / mcp / skills / limbs / webhooks 贡献一个都注册不上）

### 顺带钉住的三个事实（复核确认，不是推测）

- **仓里同时跑着三套「插件」机制**，互不共享：F202 Plugin Host（新）、
  `plugin.yaml` repository plugin（旧，5 个：github / video-analysis / video-gen /
  wechat-visible-reader / weixin-mp，`index.ts:4322` `new PluginRegistry`）、
  IM connector（`im-connector-loader.ts`）。**c) 的删除面必须覆盖三套，不能只看 connectors 树。**
- **零调用者确认**：`createRelayAddressProvisioner`（`relay-address-provisioning.ts:98`）与
  `SubscriptionDelivery.register`（`subscription-delivery.ts:169`）生产侧均零调用——
  `index.ts` 从未读取 `pluginRuntime.subscriptionDelivery`。
  **今天即使插件装上跑起来：入站没有地址可发，出站没有订阅可投。**
- **测试覆盖的真实边界**：唯一完整产品级 e2e 是 content-editor 路径
  （`packages/web/test/browser/f309-genoffice-published-journey.test.mjs`，真安装真启用真编辑）。
  stdio 路径的真 spawn 真握手在 `plugin-m0d-joint-acceptance.test.js`（18 behavior case 全过），
  但用**测试自造 fixture 包**，且 `pre-merge-check.sh` 与 CI workflow 里**没有调用点**。
  唯一真实已发布的 stdio 插件 `official.feishu-meeting-intake`
  **没有任何测试覆盖它的安装→启用→收发**。

### c) 的删除面：全仓重扫后是 32,858 行，不是 16,785 行（旧数字作废）

> 这 32,858 **不含** `domains/signal-intake/` 里的厂商职责——那块按混合制逐职责切，
> 见下文「A/B scope 问题作废」一节。该节同时撤回了我抛给 operator 的 A/B 裁定请求。

2026-09-21 全仓普查（`wc -l` 实数，非估算）。核心两目录 160 files / 34,477 行分类：

| 分类 | files | lines |
|---|---:|---:|
| vendor-specific（必须迁出） | 55 | 13,434 |
| 通用机制（Host 保留） | 95 | 16,472 |
| mixed（同文件混装） | 10 | 4,571 |

**扩到全仓：vendor-specific 合计 32,858 行 / 通用插件机制合计 18,717 行。**

vendor 32,858 的构成：

```
im-connectors/                8,473    src/plugins/（整目录 100% vendor）  8,429
infrastructure/email/（实为 GitHub PR/CI/Issue）  6,068
domains/plugin vendor         3,219    github-repo-event/          1,496
vendor 专用路由               1,623    infrastructure/enterprise/  1,129
github-signals                  885    infrastructure/github/        596
LarkCliFeishuSourceResolver     322    web vendor 组件               309
connectors 顶层 3 文件          246    guides vendor flow             63
```

**另有 vendor 测试 30 files / 14,044 行**（`weixin-adapter.test.js` 2,270、
`wecom-bot-adapter.test.js` 1,450、`telegram-adapter.test.js` 1,340 …），
加 `test/infrastructure/` 下 lark/wecom 测试 1,433 行。

`src/plugins/` 整目录（55 files / 8,429 行）是**具体插件业务代码直接住在 host 仓里**：
`cloud-cat-personal-host` 4,421 · `wechat-visible-reader` 2,592 · `weixin-mp` 960 ·
`video-gen` 293 · `video-analysis` 108 · `github` 55。

`domains/plugin/` 里的 vendor（3,219）：`builtin-runtime/` 中 collective-connector
一个插件的运行时 9 files / 1,559 · `github-schedule-factories.ts` 722 ·
`official-plugin-auth.ts` 295（硬编码 `accounts.feishu.cn`，L127）·
`official-plugin-meeting-intake.ts` 216（L1-8 直接 import `@clowder-ai/feishu-meeting-intake`）·
`official-plugin-auth-command.ts` 191 · `official-plugin-history-import.ts` 153 ·
`official-plugin-meeting-intake-port.ts` 83。

**mixed 文件（不能整删，要切）**，vendor 行号已定位：
`connector-gateway-bootstrap.ts` 1,195 行含 210 行 vendor（逐厂商 env/凭据/生命周期）·
`ConnectorCommandLayer.ts` L452-457 逐厂商硬编码超时表 ·
`StreamingOutboundHook.ts` L151-156 `connectorId === 'feishu'` 分支 ·
`im-connector-loader.ts` L23-29 七家厂商 `import()` 硬编码清单 ·
`official-catalog.ts` L88-117 + L123-181 · `runtime-composition.ts` L258-259 等 ·
`machine-catalog-provider.ts` L10-11 写死 `raw.githubusercontent.com/zts212653/clowder-ai-plugins`。

**主入口 `packages/api/src/index.ts`（8,188 行）有 37 行 vendor**——host 启动路径直接
`new` 具体插件对象：`:4304` import weixin-mp · `:4344-4346` `new WeChatVisibleReaderArmStore()` ·
`:4350` `registerGitHubScheduleFactories` · `:5016` import `@clowder-ai/feishu-meeting-intake` ·
`:8002-8010` `weixinAdapter / startWeixinPolling / startWeComBotStream`。

**前端 host 里也有具体插件 UI**：`OfficialPluginOwnerAuth.tsx` 157 行整文件飞书扫码 ·
`WeChatVisibleReaderArmControl.tsx` 152 行整文件微信读屏 ·
`PluginConfigPanel.tsx:37` `if (plugin.id !== 'wechat-visible-reader') return null` ·
`shared/src/types/connector.ts:253-300` 七家厂商 displayName/品牌色/png 静态表。

### A/B scope 问题作废：这批厂商代码的归属，operator 目标 #5 早就判完了

2026-09-21 我把四块厂商代码当成「不是 IM connector、也不在当前插件清单里」escalate 给
operator 做 A/B 裁定（A=35,899 / B=22,684）。**这个前提是错的，escalation 撤回。**

错因：我只比对了 F202 `official-catalog.ts` 的 3 条，**漏了 `plugin.yaml` 体系的 5 个插件
和 7 个 connector 清单**——而这三套清单正是本文 §「三个事实」里我自己钉过的。

operator 目标 #5 原文：「im connector 和当前的插件都是我们的 scope，因为这些本身就是
基于插件的思路一起做的」。按这条尺子逐块量：

| 区块 | 行数 | 归属证据（可直接复核） | 判定 |
|---|---:|---|---|
| `infrastructure/email/`（实为 GitHub PR/CI/Issue） | 6,068 | `plugins/github/plugin.yaml` 声明 7 个 `factoryId: github.*`；实现体 `domains/plugin/github-schedule-factories.ts` 逐个 import 本目录（L21-37） | **github 插件的实现体** → 在 scope |
| `domains/github-signals/` | 885 | `GitHubWaitLifecycleService.ts:14` import `infrastructure/email/deliver-connector-message` | 同上 → 在 scope |
| `domains/plugin/github-schedule-factories.ts` | 722 | plugin.yaml 与实现体的装配点 | 同上 → 在 scope |
| `infrastructure/enterprise/` | 1,129 | `Lark*` 只被 `routes/callback-lark-action-routes.ts` 消费（服务 feishu connector + feishu-meeting-intake 插件）；`WeCom*` 只被 `routes/callback-wecom-action-routes.ts` 消费（服务 wecom-agent / wecom-bot connector） | **纯厂商代码** → 在 scope |
| `domains/signal-intake/` | 3,041 | **混合**（见下） | 按混合制规则逐职责切，不整块进出 |

`plugins/github/plugin.yaml` 由 `PluginRegistry`（`index.ts:4322`）实际扫描加载——
github 是**货真价实的「当前的插件」**，不是 host 一等功能。

`domains/signal-intake/` 的混合形状（operator 已给过这类文件的规则：
「分离厂商行，不要删机制」）：

- **厂商侧（跟插件走）**：`LarkCliFeishuSourceResolver` · `MeetingIntakeService/Store/Codec` ·
  `MeetingArtifactResourceService` · `MeetingIntakeActionService` · `ThreadMeetingArtifactDispatcher`
  —— 这就是 `official.feishu-meeting-intake` 那个插件的业务
- **通用侧（Host 保留）**：`SignalAdmissionService` · `SignalRouteStore` · `DestinationAuthority` ·
  `SourceAccessLeaseService` · `IngressTrace` —— 是 **plugin host 的通用入站机制**，
  消费者是 `domains/plugin/runtime-composition.ts` / `host-broker/events-publish-handler.ts` /
  `official-signal-routes.ts`。删了插件入站就没了。
- 注意 `domains/signals/` 是**另一个目录**（Signals 一等产品功能），与本块无关，不在删除面。

**唯一需要 operator 知情的后果（不是决策题，是提醒）**：`register_pr_tracking` 这个
猫在用的 MCP 工具，实现依赖 `infrastructure/email/PrTrackingStore`（`routes/callbacks.ts`）。
GitHub 迁成插件后，该工具将由插件以 `tool` / `mcp` contribution 提供——
这正是 contribution 表的设计用途，形状上自洽，但**未装 github 插件的实例会没有这个工具**。

**结论**：c) 的删除面按目标 #5 就是 A 的范围，**不需要新裁定**；
`signal-intake` 那 3,041 行里只有厂商职责跟着走，通用入站机制留在 Host。

### a) 的真实输入：7 个 connector 实际消费 11 组能力，契约只覆盖了 2 组

按 operator 的方法（「基于我们哪些插件和 im connector 需要的来评估」）从**现有 connector 的真实调用**
清点，不是从半成品迁移包反推：

| # | 能力组 | 谁在用 | 现在走哪条路 | 已发布契约覆盖 |
|---|---|---|---|---|
| 1 | 消息出站（含富文本/媒体/流式 placeholder/edit/delete/reaction） | 7/7 | `IOutboundAdapter` — **host 内部实现文件的类型**（`OutboundDeliveryHook.ts:12-68`） | ❌ 契约只有单形状 `host.messaging.deliver` |
| 2 | 消息入站（长连 `startInbound` / webhook） | 7/7 | `IMConnectorPlugin.startInbound`（`im-connector-plugin.ts:141`） | ❌ `messaging.send` 零调用 |
| 3 | thread 归属（externalChatId ↔ threadId 绑定） | 7/7（由 Router 代持） | `IConnectorThreadBindingStore` + `IThreadStore` 上直接刻 `ConnectorHubStateV1` | ❌ `thread.listMetadata`/`readContent` **0 命中** |
| 4 | 身份与地址签发 | **0/7** | connector 走 `handleAction` 扫码登录回填凭据 | ⚠️ 已建未用（Z-1） |
| 5 | 存储 | 3/7 直接拿裸 `ctx.redis` 自拼 key | `im-connector-plugin.ts:28` | ❌ `plugin.state.get/set` **0 命中** |
| 6 | 配置与凭据 | 7/7 | `ctx.env` 注入 + 三层解析（存储值 > env > YAML） | ✅ **唯一落地的两项**：`plugin.config.read` / `secret.read` |
| 7 | 定时调度 | 0/7（github 插件走 C 体系白名单） | `ScheduleFactoryRegistry` | ❌ `schedule.register` **0 命中** |
| 8 | **slash 命令** | 7/7（Router 内拦截，connector 无感知） | `CommandRegistry` 启动时一次性构建（`index.ts:6381`） | ⚠️ **本行原判「没有注册面」已作废**——注册面有两条（skill resource / `UiCommandContribution`），缺的是动态刷新，见下文更正节 |
| 9 | 媒体下载 | 5/7 | `createMediaDownloader` → `ConnectorMediaService` | ❌ 契约无 media 行；`whisper.extend` **0 命中** |
| 10 | webhook 入口 | 2/7 | `POST /api/connectors/:id/webhook` | ✅ A 体系内唯一真正通用化的入口 |
| 11 | 日志 | 7/7 | 直接暴露 `FastifyBaseLogger` | ❌ 契约无 |

**operator 说插件诉求「主要是 slash 命令」——而第 8 行是最硬的缺口：
`CommandRegistry.registerSkillCommands`（`infrastructure/commands/CommandRegistry.ts:22`）
只接受 core 与 skill 两类来源，插件/connector 无法贡献命令。**

### ⚠️ 更正：a) 不是「补缺口」，是「收敛已有的三套」——slash 注册面一说作废

2026-09-21 operator 打断我开工：「slash 命令注册面是什么意思；我们 host 这边不知道
也不需要这个的；这个不是插件 sdk 那边处理的么」「我们当前的那个插件不就已经支持了
skill mcp 这些的安装和卸载么；你们不会又要发明一套吧」。

**我当时正准备给 `CommandRegistry` 加 `registerPluginCommands` / `unregisterPluginCommands`
——那是本文 §5 根因里写的那个病的第四次发作（"发现要的东西不在，就在旁边另造一个"）。
测试已删，未入库。**

清点后 operator 的两条都成立：

**① Host 早就有对称的装/卸机制，而且不止一套**

| 机制 | 覆盖类型 | 对称面 | 位置 |
|---|---|---|---|
| `PluginResourceActivator` | **skill · limb · mcp · schedule** | `activateResource` / `deactivateResource` | `PluginResourceActivator.ts:264-300` |
| `BuiltinPluginContributionSupervisor` | mcp | `start` / `stop` / `stopAll` | `builtin-contribution-supervisor.ts:277,351,366` |
| 契约 `FeatureHostAdapter` | 12 类（单方法覆盖） | `registerContribution` / `disposeContribution` | sdk `feature-context.d.ts`，Host **0 实现** |

**这三套是同一件事的三种拼法。** a) 的正解是把前两套收敛进第三套的单一入口，
**不是新增任何类型专用的注册 API**。Host 不该有 command 专用公开面——
它只该有一个 `registerContribution`，内部按 `StaticContribution['type']` 路由。

**② slash 命令的注册面本来就存在，缺的是「刷新」不是「注册」**

- 契约已有 `UiCommandContribution`（`type:'ui', kind:'command'`，
  `contract.generated.d.ts:218-224`）——Host 消费 **0 处**
- 插件装 skill 这条路已通：`plugin.yaml` `resources:[{type:skill}]` →
  `PluginResourceActivator.activateSkill` → `addSkill` 落盘
- **真正的缺口**：`CommandRegistry` 在 `index.ts:6381` **只在启动时构建一次**
  （`parseManifestSlashCommands(cat-cafe-skills)` 扫一遍就封存）。
  插件运行时装了带命令的 skill，盘上有了，注册表不知道，**要重启才生效**。

> **所以本文 §「a) 的真实输入」表中第 8 行「插件侧根本没有注册面」是错的，作废。**
> 正确表述：注册面有两条，缺的是 `CommandRegistry` 的动态刷新——
> 而这是 Host 内部的生命周期问题（startup-static vs runtime-dynamic），
> 不是需要对插件新暴露的接口。

**这一条同时修正了 a) 的工作性质**：operator 原话是「整理我们应该暴露的能力……
**不应该一味的新增；应该是收敛和整合的**」。我之前把 a) 读成「补 5 个缺口」，
方向反了。a) 的交付物是**一张收敛后的接口表 + 把现有多套实现并进去**，
新增只在「真的一条路都没有」时才发生。

### 重复入口（operator 原话「两个入口之后应该汇聚到一起」）—— 实测 7 组

| | 重复的是什么 | 几条路 | 证据 |
|---|---|---|---|
| R-1 | 出站消息 | **3** | `OutboundDeliveryHook.deliver`（在跑）· `SubscriptionDelivery.drainOne`→`host.messaging.deliver`（契约，零生产调用）· `deliverConnectorMessage`（在跑，`infrastructure/email/deliver-connector-message.ts:29`） |
| R-2 | 入站唤醒推导 | 2 | `ConnectorRouter.ts:448-479` vs `ingress-wake.ts:56-70`（注释自陈是复制） |
| R-3 | 入站消息落库 | 3 | `ConnectorRouter.ts:459` · `deliver-connector-message.ts:34` · `collective-ingress-dispatcher.ts:162,202` |
| R-4 | 凭据/配置写入 | 2 | `im-connector-config-store.ts` vs `plugin-config-store.ts` |
| R-5 | **插件清单格式** | **3 套互不兼容** | `connector.yaml` · `plugin.yaml` · `plugin-contract` PluginManifest |
| R-6 | 插件安装目录 | 2 | `.cat-cafe/plugins/<id>/` vs `.cat-cafe/plugin-host/packages` |
| R-7 | webhook/HTTP 入口 | 4 | 通用 webhook · connector actions · 插件自带路由硬编码进 host · 插件专属 REST 硬编码进 host |

`connector_message` 这一个 socket 事件有**三份 payload 构造代码**
（`ConnectorRouter.ts:37` / `deliver-connector-message.ts:45` / `collective-ingress-dispatcher.ts:296`）。

### 零调用面（建好没人用）

- **Z-1** `createRelayAddressProvisioner` — 生产零调用；连带 `MessagingService.issueConnectorBindingHandle` 唯一调用者就是它
- **Z-2** `SubscriptionDelivery.register/drain` — `src/index.ts` 里 `subscriptionDelivery` **0 行**命中。
  `host.messaging.deliver` 整条出站链路唯一生产入口是 `subscription-delivery.ts:154`，而它的调用者无人调用
- **Z-3** `MessagingService.issueThreadHandle/revokeHandle` — 零调用，导致 `messaging.send` 的
  `thread_handle` 分支（`send-service.ts:56-66`）生产中不可达
- **Z-4** 11 项 Capability 在 `src/` **0 命中**（⚠️ 其中 4 项是承重面，见「github 插件的完整形状」一节，不可删）：`thread.listMetadata` `thread.readContent`
  `memory.query` `memory.append` `memory.retrieve` `windows.create` `whisper.extend`
  `schedule.register` `plugin.state.get` `plugin.state.set` `message.event.subscribe`
- **Z-5** `collective-connector` 的 `capabilities: []`（`official-catalog.ts:99`）——
  它绕过 broker 直接 import host 内部（`collective-ingress-dispatcher.ts:15-18` 拿 `InvocationQueue`/`QueueProcessor`）
- **Z-6** `IMConnectorPlugin.setup?` 钩子 7 个 connector 无一实现

**所以 a) 不是「新增接口」，是三件事**：
① 把 11 组真实需求对照 13 wire + 6 adapter 方法，**先查"已有哪条路"再决定是否新增**——
逐组的结论见下文「a) 不是补缺口，是收敛已有的三套」更正节；slash 命令那一项经查
已有两条注册面，缺的只是动态刷新，**不新增接口**；
② **合并 R-1…R-7 七组重复入口**；
③ **Z-4 的 11 项按消费者重新分档**——其中 `schedule.register` / `plugin.state.get` /
`plugin.state.set` / `message.event.subscribe` 是 github 插件与 7 个 connector 的承重面，
**必须接线不能删**；其余 7 项需先找到消费者再决定。详见下文「github 插件的完整形状」一节。

### github 插件的完整形状 = 3 个能力面（operator 口述，代码逐条证实）

operator 2026-09-21 原话：「github 那个插件核心不就是注册定时任务然后处理完了；
根据注册的路由信息；调用 sdk 的 send 接口来发送通知么」。**逐条核完，完全成立**：

| operator 的话 | 代码证据 | 对应契约面 |
|---|---|---|
| 注册定时任务 | `registerGitHubScheduleFactories(registry: ScheduleFactoryRegistry)`（`github-schedule-factories.ts:403-410`）注册 7 个 factory，`plugin.yaml` 逐个声明 `factoryId: github.*` | `schedule.register` |
| 根据注册的路由信息 | `PrTrackingStore` 文件头自述：「Maps (repoFullName + prNumber) → { catId, threadId, userId } … to **route notifications** to the correct cat/thread」 | `plugin.state.get` / `plugin.state.set` |
| 调 send 接口发通知 | `ReviewFeedbackTaskSpec:945` `reviewFeedbackRouter.route(...)` → `routeResult.kind === 'notified'` → 用 `routeResult.threadId / catId / content` 投递；底层走 `deliver-connector-message.ts` | 出站消息（R-1 三条路之一） |

**这一条把 Z-4 的处置建议推翻了。** 我原文写「删掉 Z-4 的 11 项空头 Capability
（或补 wire 行，二选一）」——但其中 **`schedule.register` · `plugin.state.get` ·
`plugin.state.set` 三项正是 github 插件迁出后赖以存活的面**。它们不是空头，
是**未接线的承重面**。删了 github 插件就没法迁。

Z-4 十一项按「有没有已知消费者」重新分档：

- **承重（必须接线，不能删）**：`schedule.register` · `plugin.state.get` · `plugin.state.set`
  （github 插件）· `message.event.subscribe`（7 个 connector 的入站）
- **待定（需先找到消费者再决定）**：`thread.listMetadata` · `thread.readContent` ·
  `memory.query` · `memory.append` · `memory.retrieve` · `windows.create` · `whisper.extend`

**并且 github 给 R-1 合并提供了硬需求**：它现在的出站是 `deliverConnectorMessage`——
R-1 三条路里的第三条。迁成插件后它只能走收敛后的 `host.messaging.deliver`，
所以 R-1 不是「代码整洁」问题，是 **github 插件能不能发出通知**的问题。

**推论：github 是最干净的端到端首发插件。** 它只需要 3 个能力面，
而任一 IM connector 需要 11 组。用它跑通「manifest → 装载 → activate →
注册 schedule contribution → 读写自己的 state → 调 send」整条链，
比抽象地「补 5 个缺口」更能证明 a)+b) 真的通了。

### plugin.yaml 与 SDK 不冲突——R-5 说的是同一层的三种拼法，不是要废掉 manifest

operator 原话：「plugin.yaml 和 sdk 包那个不冲突啊；plugin.yaml 是声明插件的一些
元信息 提供的能力 还有配置等等的」。**成立，且本文 R-5 不应被读成相反意思。**

manifest 是**声明层**，SDK 是**代码层**，两层各司其职，本来就该同时存在：

| plugin.yaml 现有字段 | contract `PluginManifest` 对应 |
|---|---|
| `id` / `name` / `version` / `description` / `icon` | manifest 元信息（`contract.generated.d.ts:286`） |
| `resources: [{type: schedule, factoryId}]` | `contributions?: readonly StaticContribution[]`（`:294`） |
| `config: [{envName, label, sensitive, required}]` | 配置声明 + `capabilities: readonly Capability[]`（`:272-273`） |

**字段一一对得上——plugin.yaml 不是要删的旧东西，是要「改拼写」的同一份声明。**
R-5「插件清单格式 3 套互不兼容」指的是 `connector.yaml` / `plugin.yaml` /
contract `PluginManifest` 这**三种拼法要收敛成一种**，
不是「manifest 这个概念要让位给 SDK」。迁移动作是**格式转换 + 跟着插件走**，不是删除。

### b) 的真正卡点：Host 单方做不完，缺一个 entrypoint 激活入口

读 `module-plugin-runtime.ts:63-96` 的实际代码：`start()` 只做到
`plugin = entry.create(packageRecord.manifest)`（`:89`），然后存进 `#loaded`。**到此为止。**

要继续激活，Host 必须拿 `DefinedPlugin.activate[featureId]` 并喂它一个 `FeatureContext`。
而构造 `FeatureContext` 的 `createFeatureContextSession` **住在 `plugin-sdk` 里**。于是二选一：

- **(A) Host import SDK 去构造 context** —— 违反 §0 铁律「Host 永不 import SDK」，**否决**
- **(B) 插件 entrypoint 增加一个激活入口**，签名形如
  `activateFeature(featureId, hostAdapter, binding)`；插件侧（本来就依赖 SDK）自己调
  `createFeatureContextSession`。**Host 只传一个 6 方法的纯对象，不需要任何 SDK 类型。**

**(B) 正是 operator 定的方向**——「Host 提供双向接口 → **SDK 包装这些接口** → 插件实现接口 →
Host 加载插件」：包装动作发生在插件侧，不在 Host 侧。

所以插件仓的第一件事不是「迁类型」，而是 **给 entrypoint shape 加激活入口**
（`FeatureHostAdapter` 类型随之归 contract，是同一件事的一部分）。
这就是 operator 说的「发现接口签名有问题，就和 host 沟通再同步调整」的具体那一项。

**Host 侧不被它阻塞、可以立刻开工的部分**：
`readConfig`/`readSecret`（已有 `readPluginConfig`/`resolvePluginEnv` 可接）·
`readState`/`writeState`（缺存储，要建）·
`registerContribution`/`disposeContribution`（把 builtin 专用的
`registerBuiltinContributions` + `builtin-contribution-supervisor` 泛化）·
接线两个零调用者（Z-1 地址签发、Z-2 订阅注册）· 补 slash 命令注册面。

## 1. 已完成（不要重做）

| commit | 内容 |
|---|---|
| `708ad9cf8` | 所有作者的消息进同一条发布流（`publishing-message-store.ts`，包在 `IMessageStore.append` 唯一汇聚点） |
| `80787735b` `5cfc6ef0b` `e1dd2f590` | 订阅投递驱动 + sink 泛化 + **回声抑制默认开启**（`includeOwnMessages` 才 opt-in） |
| `88f7f8c4c` | 激活时签发"转述人类授权"地址（`relay-address-provisioning.ts`） |
| `3daaea609` | 以上接进 `runtime-composition.ts` 真实装配 |
| `42aa3c73a` | 删除做错侧的 `connector-ingress.ts` |

回归基线：**1287 tests / 1286 pass / 0 fail**。

## 2. Core 侧待办（sol 可直接开工，按序）

### C-1　出站改用已发布的标准方法 ⚠️ 先做
`domains/messaging/subscription-delivery.ts` 目前调我自造的
`HostInvocationPort.invoke(targetId, method, params)`。**撤掉它**，改用契约已有的：

```
host.messaging.deliver
  M0CDeliverInput  = { deliveryId, threadHandle: ThreadHandleAddress, envelope: MessageEnvelope }
  M0CDeliverResult = { deliveryId }
```
- 已在 `WIRE_METHOD_NAMES`，已发布
- `external-runtime/stdio-broker-transport.ts:44` 已声明调用
- `host-broker/control-plane.ts:376` 已读它的 grant

`builtin-runtime/module-host-invocation.ts` 保留为**进程内载体的实现**，但其对外形状要对齐上面这个签名，不要另立一套参数。

> **分层别搞混，且别往 payload 里加字段**：`host.messaging.deliver` 的入参是**闭合**的
> （`deliveryId` / `threadHandle` / `envelope`，`additionalProperties:false`）。
> 插件声明的 `action.method` **不随线传输**——Host 调固定投递入口，
> **接收侧按自己已注册的 `message-subscription` 自行分发**。
> （我原文写"由参数携带"是错的，sol 在实现时查出并纠正。）
**验收**：`f202-c1-end-to-end-journey.test.js` 全绿且不再出现自造签名。

### C-2　~~把已声明但调不到的能力接上线~~ —— **取消（2026-09-21 从实际诉求收敛得出）**

### C-4 也一并取消。理由见下，这是从 7 个 connector 的**真实调用**数出来的，不是推测。

operator 第四次指出方向：

> 基于 sdk 来推导 host 的接口有且只有一种场景：sdk 已有能力不满足，且是**开发新插件**时。
> 我们现在做的是**插件迁移**——应该整理收敛这些插件需要调用/实现的接口，在 Host 收敛做完，然后清理代码。

照此把 7 个 connector 包实际用到的 Host 面全部数出来（`grep context.*` on `connector-*/src`）：

| 实际调用 | 次数 | 对应 Host 能力 | 状态 |
|---|---|---|---|
| `context.config.get` | 13 | `plugin.config.read` | ✅ 已发布可用 |
| `context.secrets.get` | 10 | `secret.read` | ✅ |
| `context.state.set/get` | 3 | `plugin.state.set/get` | ✅ |
| `context.messaging.send` | 2 | `messaging.send` | ✅ |
| `context.messaging.subscribe` | 2 | `message.event.subscribe` | ✅ |
| `context.connectors.deliver` | 5 | 由 `host.messaging.deliver` 取代 | ✅ C-1 已接通 |
| `context.logger` | 7 | SDK 本地日志函数表，不在 `Capability` / `WIRE_METHOD_NAMES` | 无需 Host 面 |
| ~~`context.open`~~ | 2 | **误报**：实为 `context.open_chat_type` / `open_chat_id`，飞书 webhook 载荷字段 | 非 Host 面 |

**七个包里没有任何 `thread.*` 调用。** 它们不列 thread、不读 thread、不建 thread——
会话落点靠激活时签发的地址（`relay-address-provisioning.ts`，`88f7f8c4c`），
群↔thread 映射靠 `plugin.state`（已有）。

**所以 C-2 / C-4 服务的是一个假想需求。** 我此前从 operator 的 5 步流程**推导**出"插件要取/建 thread"，
但那 5 步描述的是**未来插件可能的做法**，不是这 7 个包**现在的做法**。迁移的验收标准是这 7 个包能跑，
不是把所有可想象的能力补全。

> **这是今晚第四个同形状的错**：用推理代替对被描述物的清点。前三次是类型 vs schema、
> 子集 vs 全集、文件位置 vs 定义归属。这次是**假想流程 vs 实际调用**。

**结论修正：Host 侧接口**面**已完整（不缺任何方法），但**接线**还差一段。**

### C-6　激活接线（清点时发现，此前清单漏编号）

零件都造好了，但**没有任何生产调用点**：

```
createRelayAddressProvisioner  → 零调用者        （88f7f8c4c 建的，插件激活后拿不到地址）
SubscriptionDelivery.register  → 零生产调用点    （插件声明的 message-subscription 从未变成活订阅）
```

`module-plugin-runtime.ts` 自己也写着：加载做完了、激活没做。所以今天即使插件装上、跑起来：
**入站没有地址可发，出站没有订阅可投。**

**C-6 = 激活时做两件事**：① 为该 pluginInstance 签发地址（已有 provisioner）；
② 把它 manifest 里声明的 `message-subscription` 注册进投递驱动（已有 register）。
**不是新接口，是把已有零件接上。**

**次序**：C-6 → C-5（删除）。删在前面，等于删掉唯一在工作的那条路而新路还没通电。

### C-3　thread 归属 metadata（通用版）
`ThreadStore` 已有 `updateSystemKind` / `updateConnectorHubState`。
把连接器专属的 `ConnectorHubStateV1{connectorId, externalChatId}` **换成**通用归属记录
（哪个 pluginInstance 拥有这个 thread）。**一换一，不是新增。**
地址由归属推导 → 不需要逐 thread 授予。

### C-5　删除 —— 判据由 operator 给定（2026-09-21 修正，范围比原估大）

**判据（operator 原话，取代我此前按目录划的线）：**

> host 这边没有插件代码是指**没有任何和具体的插件相关的业务代码**；
> VSCode、IDEA，你看看他们的 host 会有某个插件特有的代码的么

**所以不是「删 `infrastructure/connectors/`、留 `domains/plugin/`」**——
我原先那条按目录划的线是错的，它会把下面这些原封不动留在 Host 里：

| 位置 | 行数 | 内容 | 判定 |
|---|---:|---|---|
| `infrastructure/connectors/` 全部 | 16,121 | Router / CommandLayer / gateway / 7 provider / Outbound hooks | ❌ 删 |
| `domains/plugin/official-plugin-meeting-intake.ts` | 216 | `createFeishuMeetingCatchUpService`、`createLarkCliFeishuPollingGateway` | ❌ **具体插件 service 整体迁走**；只有能独立证明与任何插件无关的生命周期/进程原语才留 Host |
| `domains/plugin/official-plugin-history-import.ts` | 153 | `FeishuArtifactLocator`、飞书制品解析 | ❌ **具体插件 service 整体迁走**；不以厂商字符串行数切割职责 |
| `domains/plugin/official-plugin-auth.ts` | 295 | Lark CLI device 登录、状态解析、飞书账号域名校验 | ❌ **具体插件 auth service 整体迁走**；通用授权协议另按消费者证明后抽取 |
| `domains/plugin/official-catalog.ts` | 181 | 具体插件条目 + 带 `lark-cli-device` / `meeting-intake` 的类型与策略 | ⚠️ 具体条目/策略迁到插件仓；Host 仅保留或重建仓目录契约与通用校验 |
| `domains/plugin/official-catalog-provider.ts` | 335 | 写死 npm registry、npm tarball URL 与 npm SLSA attestation | ⚠️ **npm 专用 resolver，不是通用多仓 provider**；可复用的有界读取、semver、digest/provenance 校验按职责抽取 |
| `domains/plugin/runtime-composition.ts` | 781 | 仅一行注释提到飞书超时 | ✅ 通用，保留 |

**当前可直接计数的删除面只有 connector 业务树约 16,121 行。** 其余文件必须按职责迁移/抽取，
不能把总行数、文件名或厂商字符串命中数当作删除量或通用性证据。

#### Catalog 终态：Host 认仓，不认具体插件

operator 冻结的终态是：Host 配置 **N 个 Git 插件仓地址**；官方仓与内网仓提供同一种 catalog，
每个仓自己维护其中有哪些插件。Host 不硬编码具体插件 id、包名或厂商策略。

一手代码事实先钉住两个边界：

- `LocalPluginPackageAdmission` 只接受已经位于本机的
  `{kind:'local-directory'|'local-archive', path}`。它是安装流水线的**末端**，没有
  Git clone/fetch/remote discovery；所以“已有本地目录安装 = 已支持 Git/内网仓”是错误结论。
- `official-catalog-provider.ts` 写死 `https://registry.npmjs.org`、npm tarball URL 和 npm
  SLSA attestation。它是 **npm resolver**，不是可直接改一个 origin 就得到的多 Git 仓 provider。

实现边界固定为五层：

1. **Repository sources**：Host 只保存/读取 N 个受信插件仓声明（仓 URL、信任与刷新策略），不列具体插件。
2. **Repository catalog**：每个官方或内网仓按同一 Host 契约发布 catalog；具体插件条目与厂商策略归仓所有。
3. **Artifact source**：每条 catalog entry 明确制品来源：npm 条目钉 exact package/version/integrity/provenance；
   Git/source 条目钉 commit、仓内 package path 与 tree/archive digest。
4. **Repository resolver**：按来源把选中的制品物化到 Host 控制的本地 directory/archive；网络获取、
   commit/path 约束和 digest 验证在这一层完成，不能把任意远端地址直接交给安装器。
5. **Local admission**：复用现有 `LocalPluginPackageAdmission` 消费受控本地制品，继续负责打包、
   manifest/schema 校验、grant policy、digest/quarantine 与 inventory 安装。

因此 `official-catalog.ts` 里的具体条目、`lark-cli-device`、`meeting-intake` 等策略随 catalog
迁出 Core；Host 侧只保留 carrier-neutral 的仓目录契约、解析/校验和安装机制。
`official-catalog-provider.ts` 中 npm 专用部分成为一种 artifact resolver；通用校验原语可以抽取，
但不能把整个现状标成“机制已经通用”。

同理，具体插件 service 是否迁走按**“这段行为为何存在、由谁消费”**判定，不按文件名，也不按
出现厂商字符串的行数判定。`OfficialPluginAuthService` 即使暴露通用命名接口，其实现仍为 Lark CLI
device flow 服务；保留接口名不能成为把实现留在 Host 的理由。

> **这份清单不完整。** 当前只确认了上述位置；`routes/`、`index.ts`、`infrastructure/` 其余子树仍须
> 按消费者与职责全仓重扫，不能从路径、导出名称或字符串命中推导归属。

**次序**：C-6 接线 → C-5 删除。
```
ConnectorRouter 664 · ConnectorCommandLayer 621 · connector-gateway-bootstrap 1,195
OutboundDeliveryHook 397 · StreamingOutboundHook 383 · ConnectorThreadBindingStore 71
InboundMessageDedup 27 · ConnectorMessageFormatter 108 · ConnectorPermissionStore 207
im-connector-loader 224 · im-connectors/ 8,180（7 provider）
合计 ~16,121 行，外部接点 10 个文件
```
**提前删会让 IM 里 @ 猫不再唤醒任何猫。**

> `connector-binding:*` 等 Redis 旧数据：删代码后无人读，但**不得由猫清理**——
> 那是 operator 的运行实例数据，清不清由他定。

##### operator 2026-09-21 给的具体做法（落盘，别再自己发明）

> 「我们当前默认让用户提供基于 http 协议的 git 地址；默认是全开放只读的；
> 然后默认用户本地是有 git 的；然后元数据直接根据 http 地址来读取；
> 或者 git clone 到我们的数据目录可能在 `.cat-cafe` 下然后就再来读取的」

四条默认假设把这一层压到很薄——**它们是设计约束，不是待确认项**：

1. 地址形态：**http(s) git URL**，用户提供
2. 访问模型：**全开放只读**（不做私有仓凭据层）
3. 运行环境：**假定本机有 git**（不自带 git 实现、不引新依赖）
4. 物化位置：**`.cat-cafe/` 下的数据目录**

两种读法都可，实现二选一即可：直接按 http 地址取清单文件；或 `git clone`
到 `.cat-cafe/` 再本地读。**clone 之后就落回已有的本地安装路径**
（`LocalPluginPackageAdmission.install(source)`，`runtime-composition.ts:750`），
所以「从 git 仓装插件」= 一个 clone/fetch 步骤 + 已有的本地安装，不是新子系统。

## 3. Plugins 侧待办（该线自行排期，此处只列事实）

| # | 项 | 依据 |
|---|---|---|
| **P-1+2** | **合并（Plugins 线 2026-09-21 修正，已复核）**：让契约**从 schema 生成**帧级闭合键集 + 错误码 → `contract-mirror.ts`(212) 整文件删 → `wire-dispatch.ts`(1,113) 改消费生成值并**挪进 `plugin-contract`** → Host 改从契约 import `classifyFrame`，反向依赖消失 | 见 §3.1 |
| P-3 | connector 专属栈作废：`connector-runtime.ts`、`ConnectorInboundMessage`、`ConnectorOutboundDelivery`、`requireConnectorOutboundDelivery`、`FeatureContext.connectors` | `host.messaging.deliver` 才是标准 |
| P-4 | 两个 `standalone-host` 收成一份，且**不公开导出** | 两份 Host 模拟必然漂移 |
| P-5 | `messaging-client.ts`(141) 零使用 —— 接上或删 | 零使用的公开面最坏 |
| P-6 | 7 个 connector：`connector` contribution → `message-subscription` + 实现自己的方法 | **不需要声明回声 filter**，Host 默认抑制 |

### 3.1 P-1+2 的前提更正（我原文写错了，Plugins 线纠正）

我原文写「`plugin-contract` 只导出类型、不导出运行时值」——**错的**。一手复核：

```
契约已导出运行时常量：ACCEPT_CLASSES / ALL_ERROR_CODES / APPLICATION_ERROR_CODES / ACK_* 边界 …
契约缺的是帧级闭合键集：RESPONSE_SUCCESS_KEYS / PARAMS_ALLOWED_KEYS / DELIVER_RESULT_KEYS → 零命中
```

`contract-mirror.ts` 手抄的 25 组全是**帧级闭合键集 + 错误码**，属于后一类。
它们**全都在 schema 里**（`messaging.schema.json` 有 42 处 `additionalProperties:false` + `properties`），
只是生成器没吐出来。

**~~必须从 schema 生成~~ —— 该句于 2026-09-21 由 Plugins 线更正，对少数成立、对多数不成立。**
逐个匹配 9 个 schema 文件后，25 组 mirror 常量分两类：

| 类 | 组数 | 真相源 | 正确做法 |
|---|---|---|---|
| **(a)** | 3（`SUBSCRIBE_INPUT_KEYS` / `ACK_INPUT_KEYS` / `DELIVER_RESULT_KEYS`）+ enum | schema | **从 schema 生成** |
| **(b)** | 13+（`REQUEST_ALLOWED_KEYS` / `RESPONSE_SUCCESS_KEYS` / `META_ALLOWED_KEYS` / `PING_INPUT_KEYS` / `CANDIDATE_HELLO_KEYS` …） | **契约包自己的 TS 接口**：`plugin-contract/src/wire/envelope.ts`（`CallMeta:43` `WireRequest:66` `WireSuccessResponse:108` `WireErrorResponse:329`）、`row-shapes.ts`（`PingInput:159` `DrainInput:202`） | **在接口旁导出运行时键集，用编译期断言与接口键集绑死**——不等则编译红 |

**不要为 (b) 去扩 schema**：那是更大的工程，而编译期绑定同样满足 LL-104「不是手写断言」的要求。
照原句做的实现者会发现 13 组无源可生，**大概率退回手抄——正好落回我们在治的病**。

> **同时撤回我提的"可能有重复"**：契约 `APPLICATION_ERROR_CODES` 是 JSON-RPC 数字码
> （`HANDSHAKE_REJECTED_CODE` / `DELIVERY_REJECTED_CODE` / …），mirror `MESSAGING_ERROR_CODES`
> 是语义分类（`VALIDATION` / `PERMISSION` / `NOT_FOUND` / …）。**不同的东西，不要合并。**

> **P-1+2 不是清理技术债，它是 LL-104 的唯一执行形式。** 同一天里两条独立车道
> （Core 与 Plugins）各自断言"插件声明的方法名由 deliver 参数携带"，而 schema 早就
> `additionalProperties:false`——两条不同的推理路径撞进同一个坑。**靠记住无效；
> 只有让 schema 的闭合约束生成进代码，违反才会在校验期就红。**


### 3.2 P-3 与 P-6 不冲突（分属两层，文档并排会让人卡住）

- `host.messaging.deliver` 是**传输层 wire 方法**：`plane:'host-to-plugin-delivery'`、
  `operation:'deliverOnMessage'`（`contract.generated.d.ts:848,875,1066,1072`）
- 插件声明的 `action.method` 是**应用层方法名**，`{type:'string', minLength:1}`，**无枚举约束**

> **更正（2026-09-21，sol 在 C-1 开工时查出，已一手复核）**：我此前写「`action.method`
> 由 `host.messaging.deliver` 的参数携带」——**错的，而且按它实现会撞死在校验上**。
> `M0CDeliverInput` 是**闭合**的：
> ```
> /$defs/M0CDeliverInput
>   properties : ['deliveryId', 'envelope', 'threadHandle']
>   required   : ['deliveryId', 'threadHandle', 'envelope']
>   additionalProperties: False        ← 塞不进第四个字段
> ```
> **`action.method` 不上线传输。** Host 只发这三个标准字段；
> **接收侧（SDK / 模块适配器）依据自己已注册的 `message-subscription` 自行分发**——
> 它本来就知道自己订阅了什么，不需要 Host 告诉它调哪个方法。

**所以"用标准 wire 方法"和"插件实现自己的方法"是两层、同时成立**，
但衔接点不是"多带一个字段"，而是**接收侧自己路由**。

## 4. 顺序（跨仓，用 operator 的 a/b/c/d）

```
Host a)  三张表对账（wire 13 / adapter 6 / capability 17）
         + 把 FeatureHostAdapter 与 stdio 帧原语迁进 contract ← 插件仓改
             ↓
Host b)  实现 FeatureHostAdapter 6 方法 + 接通 module activate
         + 接线地址签发与订阅注册（两个零调用者）      ← 当前最大的洞
             ↓
插件仓 a) 封装/调整 SDK  →  插件仓 b) 插件核心逻辑迁移 + manifest 声明 entrypoint
             ↓
Host c)  删除三套机制里全部具体插件业务代码 + 跨成员 review + PR
             ↓
插件仓 c) 发布  →  Host d) worktree 独立安装 / 启停 / 卸载完整验收
```

## 5. 根因（写在这里防止下一位重犯）

**17 个 Capability 可声明，7 个既无 wire 方法也无作者面**——能力表与可调用面从未对账。
每个人走到自己那块发现"要的东西不在"，就在旁边另造一个：
`ConnectorContribution.outboundMethod`、`HostInvocationPort`、`contract-mirror`、两个 standalone-host，
全是同一个病的不同表现。**改之前先通读整张方法表。**
