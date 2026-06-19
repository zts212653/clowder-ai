---
feature_ids: [F240]
related_features: [F088, F202, F132, F134, F137, F142, F151]
topics: [connector, im-connector-plugin, adapter, plugin-architecture, extensibility]
doc_kind: spec
created: 2026-06-11
---

# F240: IM Connector Plugin Architecture — YAML 驱动的统一接口 + 配置 + 前端 + Action 状态机

> **Status**: in-progress | **Owner**: Ragdoll Opus-4.6 | **Priority**: P1

## Architecture Ownership

Architecture cell: connector + plugin（KD-15 统一 ConfigField 类型跨两个 cell）
Map delta: update required
Why: 将现有 hardcoded adapter switch-case 改为 YAML 驱动的注册表模式——接口契约、配置持久化、前端渲染、交互动作全部由 YAML 清单声明，前端变成纯粹的状态机渲染器。KD-15 修改 plugin manifest 解析 + config store + Settings UI 的 shared type 契约，跨 connector 和 plugin 两个 cell。

## Why

> 铲屎官原话（2026-06-11）："我不太希望我们 clowder-ai 对接一个我们在外网完全用不了的 im connector 的；如果只是插件包的话；完全可以让用户安装一下这个插件包就可以在内网用了的"
>
> 铲屎官原话（2026-06-15）："让用户手动配置 IM_CONNECTOR_PLUGINS 这个好像不太合理？有没有更合适点方式的？比如我们在 im 插件管理那边添加插件安装包。因为要考虑有的用户使用的是安装包版本，而不是源码版本，对于安装包版本的用户是没有 node 环境的"
>
> 铲屎官原话（2026-06-15）："之前定制的一些逻辑是不是都可以清理了；比如原先前端的卡片；是不是可以直接复用插件那边的卡片做渲染的?"
>
> 铲屎官原话（2026-06-15）："飞书 钉钉 微信我都可以外网测试的；内网是那个我要基于我们的新的和插件那一套的接口和yaml配置；内网去实现对接内部im connector的组件用来集成"
>
> 铲屎官原话（2026-06-15）："二维码那个其实也是一个yaml的字段，只不过他的数据是需要调用生成二维码这个action来生成的...yaml支持为自己的插件定制endpoint和action...`{pluginId}/actions`"
>
> 铲屎官原话（2026-06-15）："迁移后保存数据是保存到.cat-cafe的运行时数据；.env文件和环境变量的只是作为没有运行时数据的fallback（用来兼容）后续我们.env是不需要这些配置了的（.env.example应删掉）"
>
> 铲屎官原话（2026-06-15）："代码上不用考虑兼容；只数据上需要稍微考虑下；因为我们是一个客户端应用；所以不需要考虑代码兼容"

当前 connector 系统（F088）有四个问题：

1. **硬编码耦合**：`connector-gateway-bootstrap.ts` 用 switch-case 管理 connector，新增必须改核心代码。
2. **无法外部扩展**：内网用户想对接 Cat Cafe，只能 fork 改代码。
3. **配置散落在 env**：IM connector 的凭证配置分散在 `.env`/环境变量，无法通过 Hub UI 配置和持久化，与 F202 插件管理体验不一致。
4. **前端硬编码**：IM connector 卡片有独立 CSS/icon/状态系统（`PLATFORM_VISUALS` / `connStatePill`），QR 扫码（weixin/feishu）、权限（`PERMISSION_CONNECTORS`）、心跳都是 per-connector 硬编码，外部 connector 无法复用这些能力。

期望终态（两阶段）：
- **Phase A**：YAML 驱动的完整闭环 — 接口 + 配置 + 前端 + action 状态机，一次做完可端到端验证。内网团队照着 YAML+接口开发新 connector，前端自动支持（含 QR/心跳/权限）
- **Phase B**：动态插件安装 — 自包含 tar.gz 插件包 + Hub UI 安装/卸载/更新，安装包用户也能装第三方 connector（无需 Node/npm）
- **Phase C**：内置 connector 统一结构 — 与外部插件使用相同的目录布局和接口

## Current State / 现状基线

**后端（大部分 done）：**
- 7 个 adapter 已迁移至 `IMConnectorPlugin` 接口
- 7 × `connector.yaml` 完成（config fields + steps + icon + themeColor）——但尚未扩展 field type / action chain
- 配置持久化 `.cat-cafe/im-connector-config/` done——这是配置的**主存储**
- `.env` / 环境变量是**仅在无运行时数据时**的 fallback（用于从旧版本升级的兼容），后续 `.env.example` 应删除 connector 相关配置项
- Hub 写端点 `PUT /api/connectors/:id/config` done
- Bootstrap 集成三层解析 done（stored > env > yaml default）
- 外部 connector 加载 + 示例包 done

**前端（待改造）：**
- IM connector 卡片用 `console-list-card`（自定义），插件卡片用 `settingsResourceCardClass`（共享）
- icon/themeColor 硬编码在 `HubConfigIcons.tsx` 的 `PLATFORM_VISUALS`（与 YAML 重复）
- QR 扫码（weixin/feishu）各有特化面板和硬编码路由（`/api/connector/feishu/qrcode` 等）
- 权限硬编码 `PERMISSION_CONNECTORS = { feishu, wecom-bot, dingtalk }`，独立 API `/api/connector/permissions/`
- 心跳有就显示，但不是声明式的
- `CONNECTOR_DEFINITIONS`（shared types）在前端被 `ConnectorBubble` 和 `CatHueInjector` 消费

## What

### Phase A: YAML 驱动的完整闭环 — 接口 + 配置 + 前端 + Action 状态机（PR #903）

**设计核心**：所有 connector 交互都是"字段"，数据来源两种——用户输入 or action 生成。Action 之间是状态机链（如 QR: generate → status → connected → disconnect → generate）。前端是纯粹的**状态机渲染器**，读 YAML 知道节点和转移边，读 API 知道当前状态，按 render 类型渲染对应控件。**零硬编码。**

#### A-1: 后端基础（✅ 大部分 done）

1. **YAML 清单**：每个内置 connector 有 `connector.yaml`，声明 id / name / config / docsUrl / steps / icon / themeColor
2. **配置持久化**：`im-connector-config-store.ts`，存储到 `.cat-cafe/im-connector-config/{id}.json`
3. **配置解析链**：stored value（Hub 写入）> env var（.env 兼容）> default value（YAML 声明）
4. **Hub 写端点**：connector-hub `PUT` API，前端可保存 connector 凭证
5. **消除重复定义**：`CONNECTOR_PLATFORMS` 从 YAML 清单动态派生
6. **Bootstrap 集成**：启动时扫描 YAML + 加载 config store + 三层解析驱动 pluginEnv

#### A-2: 统一 Config Field 类型系统 + 共享解析器（KD-15）

**F202 Plugin 和 F240 IM Connector 共用同一套字段类型和解析器**。YAML 配置文件各自独立管理（业务域不同），但类型定义和解析逻辑是同一份代码。代码不考虑兼容（客户端应用），数据层 YAML 无 `type` 字段时 fallback 到 `input`。

**五种 config field 类型**（F202 plugin 和 IM connector 共用）：

| type | 用途 | 有 envName | 前端渲染 |
|------|------|-----------|---------|
| `input` | 用户填文本/密码 | ✅ | 输入框（sensitive → password） |
| `toggle` | 布尔开关 | ✅ | Switch 开关 |
| `select` | 下拉选择 | ✅ | Select 下拉 |
| `list` | 列表值（多个 ID 等） | ✅ | 动态列表输入 |
| `operation` | action 驱动的操作字段 | ❌（有 `name`） | action 控件（按 render 类型） |

**共享类型定义**（`packages/shared/src/types/config-field.ts`）：

```typescript
type ConfigFieldType = 'input' | 'toggle' | 'select' | 'list' | 'operation';

// ── Value fields: env-backed, have envName ──────────────────────────
// input:  { type, envName, label, sensitive, required, hidden?, default?, requiredWhen? }
// toggle: { type, envName, label, required, default? }
// select: { type, envName, label, required, options: {value, label}[], default? }
// list:   { type, envName, label, required, itemLabel? }
type ValueConfigField = InputConfigField | ToggleConfigField | SelectConfigField | ListConfigField;

// ── Operation fields: NOT env-backed, have name ────────────────────
// operation: { type, name, label, required, target?, actions[] }
type OperationConfigField = { type: 'operation'; name: string; /* ... */ };

// ── Union + type guard ──────────────────────────────────────────────
type ConfigField = ValueConfigField | OperationConfigField;

function isValueField(field: ConfigField): field is ValueConfigField {
  return field.type !== 'operation';
}
function isOperationField(field: ConfigField): field is OperationConfigField {
  return field.type === 'operation';
}
```

直接替换现有 `PluginConfigField`（不留 alias，不留 deprecation path）。

**类型分离铁律（KD-17）**：所有 env-backed 代码路径（config store 读/写/加载、env resolve、PluginRegistry.envClaims、bootstrap isConfigured）**只操作 `ValueConfigField[]`**，必须用 `manifest.config.filter(isValueField)` 或等效 type guard 过滤。`OperationConfigField` 永远不进入 env 持久化/解析链——它的状态（`currentAction`、action result）走独立的 operation state 存储路径（见 A-3）。违反 = 编译期 type error（envName 不存在于 OperationConfigField）。

**Value Codec Contract（KD-18）**：

存储层是 `Record<string, string | null>`（和现有 plugin-config-store / im-connector-config-store 一致）。所有 typed 值通过 string codec 序列化/反序列化，store 层不感知业务类型。Codec 定义在共享解析器 `config-field-codec.ts`，前端和后端共用。

| field type | 存储值 (string) | 解析方向 | YAML `default` 写法 |
|------------|----------------|---------|---------------------|
| `input` | 原始字符串 | 无需转换 | `default: "value"` |
| `toggle` | `"true"` / `"false"` | `value === "true"` → boolean | `default: false` → 存 `"false"` |
| `select` | options 中某个 `value` 字符串 | 直接使用 | `default: webhook` → 存 `"webhook"` |
| `list` | JSON 序列化的 string 数组 `'["id1","id2"]'` | `JSON.parse(value)` → `string[]` | `default: []` → 存 `"[]"` |
| `operation` | **不进入 value store** | — | — |

API wire format（GET/PUT）使用相同 string 编码。适配器 `ctx.env` 保持 `Record<string, string>`——typed 解析是消费者（适配器自己 / 前端）的责任，不改变 env 投递层的 string 契约。

验证规则：
- `toggle`: 存储值不是 `"true"` / `"false"` → 视为 `"false"`（容错，不 throw）
- `select`: 存储值不在 options 列表中 → 视为 undefined（fallback 到 default / env）
- `list`: `JSON.parse` 失败或结果不是 `string[]` → 视为 `[]`（容错，不 throw）
- YAML `default` 在解析时统一转为 string codec 格式存入内存（`parseConfigField` 负责）

**共享解析器**（`packages/api/src/infrastructure/config-field-parser.ts`）：
- `parseConfigField(raw)` — 按 type 分发解析，无 type 则 fallback 到 input
- `parseConfigFields(rawArray)` — 批量解析 config 数组
- 两边的 manifest parser（`plugin-manifest.ts` + `im-connector-manifest.ts`）都 import 这个共享解析器

#### A-3: YAML Action 状态机 + 通用端点

**核心区分**：action 状态（持久化，用户能做什么）≠ 连接状态（运行时 health check）。两者独立（KD-13）。

**operation 是独立字段**（KD-14）：有自己的 `name`，没有 `envName`，不挂在 input 字段上。action 成功后通过 `target` 回填到指定 input 字段。

YAML 声明 action chain（状态机），插件实现 `handleAction()`，通用路由委托：

```yaml
# weixin/connector.yaml — QR 扫码型（全部 5 种字段类型示例）
config:
  # ── input 字段（用户不直接填，hidden，由 operation 回填）──
  - envName: WEIXIN_BOT_TOKEN
    label: Bot Token
    type: input
    sensitive: true
    required: true
    hidden: true        # 用户不手动填，QR 扫码后自动回填

  # ── operation 字段（独立，驱动 action chain）──
  - name: weixin_qr_login
    label: 微信扫码登录
    type: operation
    target: [WEIXIN_BOT_TOKEN]   # 操作成功后回填到哪些 input 字段
    actions:
      - id: qr-generate
        label: 生成二维码
        render: button
        resultRender: img
        next: qr-status
        # 无 rollback — 链的起点
      - id: qr-status
        label: 等待扫码
        render: polling
        timeout: 60
        rollback: qr-generate   # 超时/失败 → 沿 rollback 链回滚
        next: disconnect
      - id: disconnect
        label: 断开连接
        render: button
        next: qr-generate       # 循环回到起点

# feishu/connector.yaml — QR + 手动填 双路径 + select + toggle + list
config:
  # ── input 字段 ──
  - envName: FEISHU_APP_ID
    label: App ID
    type: input
    required: true
  - envName: FEISHU_APP_SECRET
    label: App Secret
    type: input
    sensitive: true
    required: true

  # ── select 字段（下拉选择）──
  - envName: FEISHU_CONNECTION_MODE
    label: 连接模式
    type: select
    required: false
    default: webhook
    options:
      - value: webhook
        label: Webhook（需公网 URL）
      - value: websocket
        label: WebSocket（无需公网，推荐内网）

  # ── input + requiredWhen（条件必填）──
  - envName: FEISHU_VERIFICATION_TOKEN
    label: Verification Token
    type: input
    sensitive: true
    required: false
    requiredWhen:
      envName: FEISHU_CONNECTION_MODE
      value: webhook

  # ── toggle 字段（权限开关）──
  - envName: FEISHU_WHITELIST_ENABLED
    label: 白名单模式
    type: toggle
    required: false
    default: false
    group: permissions
  - envName: FEISHU_COMMAND_ADMIN_ONLY
    label: 仅管理员可用命令
    type: toggle
    required: false
    default: false
    group: permissions

  # ── list 字段（管理员 ID 列表）──
  - envName: FEISHU_ADMIN_OPEN_IDS
    label: 管理员 Open ID
    type: list
    required: false
    itemLabel: Open ID
    group: permissions
  - envName: FEISHU_ALLOWED_GROUPS
    label: 允许的群组
    type: list
    required: false
    itemLabel: 群组 ID
    group: permissions

  # ── operation 字段（QR 扫码授权）──
  - name: feishu_qr_login
    label: 飞书扫码授权
    type: operation
    target: [FEISHU_APP_ID, FEISHU_APP_SECRET]
    actions:
      - id: qr-generate
        label: 生成二维码
        render: button
        resultRender: img
        next: qr-status
      - id: qr-status
        label: 等待扫码
        render: polling
        timeout: 60
        rollback: qr-generate
        next: disconnect
      - id: disconnect
        label: 断开连接
        render: button
        next: qr-generate

# dingtalk/connector.yaml — 纯手动输入型 + toggle 权限
config:
  - envName: DINGTALK_APP_KEY
    label: App Key
    type: input
    required: true
  - envName: DINGTALK_APP_SECRET
    label: App Secret
    type: input
    sensitive: true
    required: true
  - envName: DINGTALK_WHITELIST_ENABLED
    label: 白名单模式
    type: toggle
    required: false
    default: false
    group: permissions
  # 无 operation → 前端只渲染输入框 + toggle + 连接状态(health check)
```

**Action 状态持久化（与 value config 分离存储）**：

Operation 状态存储在 `.cat-cafe/im-connector-config/{id}.json` 的 `_operations` 命名空间下，与 value field 的 key-value 平级但隔离：

```jsonc
// .cat-cafe/im-connector-config/weixin.json
{
  // ── Value fields（envName → string | null）──
  "WEIXIN_BOT_TOKEN": "xxxx",

  // ── Operation state（独立命名空间）──
  "_operations": {
    "weixin_qr_login": {
      "currentAction": "disconnect",
      "lastResult": { "render": "status", "data": { "label": "已连接" } }
    }
  }
}
```

`_operations` 前缀保证不与任何 envName 冲突（envName 不允许 `_` 开头，解析器校验）。`loadAllConnectorConfigs` 加载时跳过 `_operations` key；`resolveConnectorEnv` 只遍历 `ValueConfigField`。Operation state 由独立的 `readOperationState()` / `writeOperationState()` API 读写。

前端加载时读 `currentAction` 决定渲染哪个 action 控件。超时/失败 → 沿 `rollback` 指针链回滚，直到首个无 rollback 的 action 为止。

**连接状态独立于 action**：heartbeat + 连接态（connected/reconnecting/disconnected）来自 health check，在卡片顶部独立显示。重启后 bootstrap 自动用持久化凭证重连（`isConfigured()` → `createAdapter()` → `startInbound()`），不需要用户点 connect。

**配置的主存储是 `.cat-cafe/`**：Hub UI 写入 → `.cat-cafe/im-connector-config/{id}.json`。`.env` / 环境变量仅在无运行时数据时作为 fallback（用于旧版本升级兼容）。后续 `.env.example` 应删除 connector 相关配置项（KD-16）。

**Config Resolution 三态语义（KD-19）**：

config store JSON 中每个 key 有三种状态，语义不同：

| 状态 | JSON 表现 | resolve 行为 |
|------|----------|------------|
| **absent file** | `{id}.json` 不存在 | 全量 env fallback（旧版本升级首次启动场景） |
| **absent key** | key 不在 JSON 对象中 | 该 key env fallback（从未配置过此字段） |
| **stored null** | `"KEY": null` | **tombstone — 阻断 env fallback**，视为"用户主动清空" |

resolve 伪码（connector 和 plugin 两套 config store 统一遵守）：
```
for each ValueConfigField:
  fromStore = cache[field.envName]
  if typeof fromStore === 'string' → 使用 stored value（主存储命中）
  if fromStore === null → 返回 undefined（tombstone，不穿透到 env）
  // fromStore === undefined → key 不在 store 中，允许 fallback
  fromEnv = process.env[field.envName]
  if fromEnv → 使用 env value（兼容 fallback）
  if field.default != null → 使用 YAML default（按 codec 编码）
  else → undefined（未配置）
```

**注意**：当前 `im-connector-config-store.ts` 的 `resolveConnectorEnv()` 缺少 `null` tombstone 分支（stored null 会落穿到 env），实现时必须修复对齐 `plugin-config-store.ts` 的正确行为。测试用例必须覆盖：用户在 Hub 清空已配置字段 → `.env` 中的旧值**不复活**。

通用 API：
- `GET /api/connectors/:id/status` → `{ configured, connectionState, heartbeat, operations: { [name]: { currentAction } } }`
- `POST /api/connectors/:id/actions/:operationName/:actionId` → 插件 `handleAction()` 处理，返回 `{ render, data, label }`。成功后后端自动持久化 `currentAction = next` + 回填 `target` 字段
- 权限 = config 里 `type: toggle` + `group: permissions` 的普通字段，按 `group` 分区渲染
- 所有字段（含 toggle/select/list）统一走 `PUT /api/connectors/:id/config` 写入

消除的硬编码：
- `WeixinQrPanel` / `FeishuQrPanel` 特化组件 → 通用 action 渲染器
- `/api/connector/feishu/qrcode` 等 4 条硬编码路由 → 通用 `/:id/actions/:operationName/:actionId`
- `PERMISSION_CONNECTORS` + 独立 permissions API → config `type: toggle` + `group: permissions`
- `PLATFORM_VISUALS` → YAML manifest API

#### A-4: 前端卡片统一

1. **卡片壳**：`HubConnectorConfigTab` 改用 `settingsResourceCardClass` + `SettingsBadge`（复用 F202 插件卡片组件）
2. **视觉**：icon + themeColor 从 manifest API 获取，干掉 `PLATFORM_VISUALS`
3. **配置区**：**共享 `<ConfigFieldRenderer>`** 组件，按 field `type` 渲染对应控件（input→输入框 / toggle→开关 / select→下拉 / list→动态列表），按 `group` 分区（如 permissions 区）。F202 plugin 和 IM connector 两边复用同一个渲染器
4. **Action 区**：读 YAML actions chain + API currentAction 状态，按 `render` 类型渲染（button / img / polling / status）
5. **连接状态区**：独立于 action，卡片顶部显示 health check 结果（connected / reconnecting / disconnected）+ heartbeat

**关键产出**：

| 文件 | 说明 |
|------|------|
| `packages/shared/src/types/config-field.ts` | 共享 `ConfigField` 联合类型（替换 `PluginConfigField`） |
| `packages/api/src/infrastructure/config-field-parser.ts` | 共享解析器 `parseConfigField()` / `parseConfigFields()` |
| `im-connectors/{id}/connector.yaml` × 7 | 配置 + 视觉 + action chain（单一真相源） |
| `im-connector-manifest.ts` | YAML 解析（引用共享解析器 + action chain 扩展） |
| `plugin-manifest.ts` | YAML 解析（改为引用共享解析器） |
| `im-connector-config-store.ts` | `.cat-cafe/` 主存储 + env fallback |
| `connector-hub.ts` | manifest 派生状态 + 写端点 + 通用 action 路由 |
| `connector-gateway-bootstrap.ts` | config store 解析链 |
| `IMConnectorPlugin.handleAction()` | 插件接口扩展 |
| 前端 `<ConfigFieldRenderer>` | 共享字段渲染器（两边复用） |
| 前端通用 action 渲染器 | 替代 WeixinQrPanel / FeishuQrPanel |
| `.env.example` | 删除 connector 相关配置项 |
| `docs/guides/im-connector-dev-guide.md` | 开发文档（含完整代码示例，替代独立 example 包） |

### Phase B: 动态插件安装 — 自包含 tar.gz 包 + Hub UI 管理

支持非源码用户安装第三方 connector，无需 Node/npm 环境：

- **插件包格式**：自包含 tar.gz，内含 `<id>/connector.yaml` + `index.js` + 可选 icon 文件
- **安装服务**：`plugin-installer.ts` — 解压、校验 manifest + entry、ID 冲突检测、移动到 `.cat-cafe/plugins/<id>/`；安装时 force-write `source: external` 到 connector.yaml
- **生命周期**：安装 → 更新（替换代码，保留配置）→ 卸载（清理磁盘文件 + 内存注册表 + manifest 缓存，可选清除配置）
- **`source` 标识**：`'builtin' | 'external'`，内置 connector 标记 `builtin`，插件安装时 force-write `external`。前端根据 source 渲染 "外部" badge + 🗑️ 卸载按钮
- **Icon proxy**：外部插件 icon 通过 API 路由 `GET /api/connectors/plugins/:id/icon` 代理，connector.yaml 中的相对路径（如 `icon.svg`）由 `rewritePluginIconSrc()` 自动 rewrite 为 API URL
- **卸载清理**：DELETE 时同步清理 `external-connector-registry` Map + `@cat-cafe/shared` connectorMap + manifest 缓存，避免幽灵卡片
- **API 路由**：`connector-plugins.ts` — `GET /api/connectors/plugins`、`POST .../install`（multipart 上传）、`DELETE .../:id`、`GET .../:id/icon`
- **前端 UI**：`ConnectorPluginInstallButton` — "安装 IM Connector" 上传按钮 + 开发文档下载链接，集成在 IM Connectors 页顶部
- **Loader 集成**：`loadInstalledPlugins()` 动态导入已安装插件，gateway bootstrap 扫描插件 manifest
- ~~`IM_CONNECTOR_PLUGINS` env var~~ 已移除；tar.gz Hub 安装为唯一外部插件路径

### Phase C: 内置 connector 统一结构

内置 connector 已使用与外部插件相同的目录结构（`connector.yaml` + `index.ts` + adapter），区别仅在于交付方式（编译进二进制 vs 运行时加载）。内网团队可直接参考内置 connector 的代码结构开发自定义 connector。

## Acceptance Criteria

<!-- 立项愿景硬度自检：每条 AC trace 回 Why：Why-1=消除硬编码耦合，Why-2=支持外部扩展，Why-3=配置对齐插件框架，Why-4=前端零硬编码 -->

### Phase A（YAML 驱动的完整闭环）

**A-1: 接口与后端基础：**
- [x] AC-A1: `IMConnectorPlugin` 接口定义完成（Why-1）
- [x] AC-A2: 7 个 adapter 均迁移至 `im-connectors/{id}/index.ts` 格式（Why-1）
- [ ] AC-A3: 飞书/钉钉/微信通过 plugin 接口启动后功能不退化（Why-1，验证：外网实测三平台收发消息正常）
- [x] AC-A4: 每个内置 connector 有 `connector.yaml`（Why-3）
- [x] AC-A5: `CONNECTOR_PLATFORMS` 从 YAML 清单动态派生（Why-3）
- [x] AC-A6: Hub UI 保存 connector 凭证 → `.cat-cafe/im-connector-config/{id}.json`（Why-3，验证：前端配置面板保存→文件写入→重启后凭证保持）——代码实现完成，待外网实测验收
- [x] AC-A7: 配置解析链 stored > env > default（Why-3）
- [x] AC-A8: 已有 env 配置向后兼容——env 作为无运行时数据时的 fallback（Why-3）
- [x] AC-A8a: Tombstone 语义——`resolveConnectorEnv()` 中 stored `null` 阻断 env fallback，对齐 `plugin-config-store.ts` 行为（KD-19，验证：单测覆盖"Hub 清空字段 + .env 有旧值 → resolve 返回 undefined 不复活旧值"）
- [x] AC-A9: 示例 connector 包 + 贡献者指南（Why-2）
- [x] AC-A10: Hub UI 展示外部 connector 状态（Why-2）

**A-2: 统一 Config Field 类型系统 + 共享解析器：**
- [x] AC-A11: 共享 `ConfigField` 联合类型（`ValueConfigField | OperationConfigField`）定义在 `@cat-cafe/shared`，直接替换 `PluginConfigField`（Why-3，验证：`pnpm lint` + `pnpm test` 全绿）
- [x] AC-A11a: `isValueField()` / `isOperationField()` type guard 导出，所有 env-backed 代码路径（config store / env resolve / envClaims / isConfigured）只操作 `ValueConfigField[]`（KD-17，验证：`OperationConfigField` 不含 `envName` 属性 → 若漏过滤则 TS 编译报错）
- [x] AC-A11b: Value codec `config-field-codec.ts` 导出 `encodeFieldValue()` / `decodeFieldValue()`，toggle↔`"true"`/`"false"`、list↔JSON string array、select 验证 options 范围（KD-18，验证：codec round-trip 单测覆盖 5 种边界）
- [x] AC-A12: 共享 `parseConfigField()` / `parseConfigFields()` 解析器，`plugin-manifest.ts` 和 `im-connector-manifest.ts` 都引用（Why-3，验证：两边 YAML 解析测试通过）
- [x] AC-A13: 现有 plugin.yaml 无 `type` 字段时 fallback 到 `input`，零破坏（Why-3，验证：现有 plugin 功能不退化）
- [x] AC-A14: `.env.example` 删除 connector 相关配置项（Why-3，KD-16）
- [x] AC-A14a: `.env` 相关旧路径清理——后端/前端中"重启后生效"、"写入 .env"的文案和代码路径消除或替换为 .cat-cafe 路径（Why-3，验证：grep 'write.*\.env\|写入.*env' 在 connector 相关文件中命中 0）
- [x] AC-A14b: `docs/guides/im-connector-dev-guide.md` 更新——不再引导用户在 .env 配置凭证，改为 Hub UI 配置（Why-3）

**A-3: Action 状态机 + 通用端点：**
- [x] AC-A15: YAML `actions` chain 声明 + `handleAction()` 插件方法（Why-2，验证：外部 connector 声明 action chain 后框架自动路由）
- [x] AC-A16: 通用 `POST /api/connectors/:id/actions/:operationName/:actionId` 端点替代硬编码 QR 路由（Why-1+4）
- [ ] AC-A17: weixin QR 全流程：qr-generate→qr-status→disconnect→qr-generate（Why-4，验证：外网实测生成→扫码→回填凭证→断开→重新生成 全正常）——后端实现完成，待外网实测
- [ ] AC-A18: feishu QR 全流程同上（Why-4，验证：外网实测）——后端实现完成，待外网实测
- [x] AC-A19: config field `type: operation` + `target` 回填支持（Why-3+4，验证：QR 扫码成功后 hidden input 字段自动写入值）
- [x] AC-A20: action 状态持久化：每次 action 完成后 `currentAction` + `updatedAt` 写入 config store，刷新页面后保持（Why-3）
- [ ] AC-A21: qr-status 超时 rollback 链：沿 rollback 指针回滚到首个无 rollback 的 action（Why-4，验证：60s 不扫码→回到"生成二维码"按钮）——后端 `updatedAt` 已就位，rollback 链走行是前端逻辑（A-4）

**A-4: 前端统一：**
- [x] AC-A22: IM connector 卡片使用 `settingsResourceCardClass` 共享壳（Why-4，commit: c31dcd0a8）
- [x] AC-A23: icon + themeColor 从 manifest API 获取，`PLATFORM_VISUALS` 删除（Why-4，commit: c31dcd0a8）
- [x] AC-A24: 共享 `<ConfigFieldRenderer>` 组件：按 type 渲染 input/toggle/select/list 控件，F202 plugin 和 IM connector 两边复用（Why-3+4，commit: c6586f33d）
- [x] AC-A25: config field `type: toggle` + `group: permissions`，`PERMISSION_CONNECTORS` 和独立 permissions API 消除（Why-4，commit: 74e4f66b6）
- [x] AC-A26: 前端 action 渲染器：按 `render`（button/img/polling/status）通用渲染，`WeixinQrPanel`/`FeishuQrPanel` 消除（Why-4，commit: e6c7e5314）
- [ ] AC-A27: 心跳/连接状态独立于 action 状态，来自 health check，在卡片顶部显示（Why-4）——待外网实测验收

### Phase B（动态插件安装）

**B-1: 插件安装服务 + Loader 集成：**
- [x] AC-B1: `plugin-installer.ts` — installPlugin / uninstallPlugin / listInstalledPlugins / resolvePluginsDir（验证：12 项单测覆盖安装/卸载/更新/列表/配置保留/ID 冲突/manifest 缺失/entry 缺失）
- [x] AC-B2: `im-connector-loader.ts` — `loadInstalledPlugins()` 动态导入 `.cat-cafe/plugins/<id>/index.js`，`validatePluginInterface()` 共享校验（Why-2）
- [x] AC-B3: `connector-gateway-bootstrap.ts` — 启动时加载已安装插件 + 扫描插件 manifest，ID 冲突拒绝（Why-2）
- [x] AC-B4: 更新（同 ID 重装）保留用户配置，卸载默认保留配置（Why-3）

**B-2: API 路由：**
- [x] AC-B5: `GET /api/connectors/plugins` — 列出已安装插件（Why-2）
- [x] AC-B6: `POST /api/connectors/plugins/install` — multipart 上传 tar.gz，安装/更新插件，触发 gateway reload（Why-2）
- [x] AC-B7: `DELETE /api/connectors/plugins/:id` — 卸载插件，`?clearConfig=true` 可选清除配置（Why-2）

**B-3: 前端插件管理 UI：**
- [x] AC-B8: `HubConnectorPluginsSection` 组件——列表 + 上传 + 卸载，集成在 IM Connectors 页底部（Why-2）
- [x] AC-B9: 安装/更新/卸载操作触发父组件 connector 列表刷新（Why-2+4）
- [x] AC-B10: 安装插件按钮 hover tooltip + 插件开发文档链接（指向 `docs/guides/im-connector-dev-guide.md`，需与指南同步刷新）（Why-2）

### Phase C（内置 connector 统一结构）
- [x] AC-C1: 7 个内置 connector 使用与外部插件相同的目录结构（`connector.yaml` + `index.ts` + adapter），无需额外改造

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway）
- **References**: F202（Plugin Framework — YAML 清单 + config store 设计模式 + 前端卡片组件的参考来源）
- **Related**: F132/F134/F137/F142/F151（各平台 connector feature）

## Risk

| 风险 | 缓解 |
|------|------|
| 飞书 adapter 复杂度高（~1500 行），封装后可能丢失边角功能 | AC-A3 外网实测飞书/钉钉/微信三平台 |
| YAML 清单与代码中的 config 可能不同步 | 启动时校验 YAML 声明的 envKeys 与 plugin 的 requiredEnvKeys/optionalEnvKeys 一致 |
| 外部包 import() 有安全风险（任意代码执行） | 只从 env 显式声明的包名加载，sensitive: true |
| 已有 env 用户升级后配置丢失 | AC-A8 env fallback 兼容（仅在无 .cat-cafe 数据时读 env） |
| 直接替换 PluginConfigField 影响 F202 | AC-A13 验证现有 plugin 功能不退化（无 type → fallback input） |
| 前端统一后 QR/权限功能退化 | AC-A17/A18 验证 QR 全流程；AC-A25 验证权限 toggle |
| OperationConfigField 混入 env 持久化链 → crash/空 key | KD-17: `isValueField()` type guard + TS 编译期保护（OperationConfigField 无 envName 属性） |
| toggle/select/list 值序列化不一致（bool vs string 等） | KD-18: 共享 value codec + round-trip 单测（AC-A11b） |
| 用户 Hub 清空字段后 .env 旧值复活 | KD-19: tombstone 语义 + 回归测试（AC-A8a） |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | ~~外部 connector icon 分发~~ → 已实现：plugin 目录内相对路径 + API proxy route `/api/connectors/plugins/:id/icon` | ✅ Phase B |
| OQ-2 | ~~QR 面板扩展点设计~~ → 已决策：YAML action 状态机 | ✅ KD-12 |
| OQ-3 | ~~action handler 多步骤生命周期~~ → 已决策：状态机 chain（每个 action 是一个节点，next 指向下一个） | ✅ KD-12 |
| OQ-4 | 权限从独立 store 迁移到 config store 的数据迁移路径（现有 permissions 数据保持兼容） | ⬜ 实现时处理 |
| OQ-5 | `<ConfigFieldRenderer>` 在 F202 plugin config panel 的复用路径——是直接替换还是渐进迁移 | ⬜ 实现时处理 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 内置 adapter 也改装为 IMConnectorPlugin 格式 | 铲屎官："弱模型只需要对着抄然后打包就好了" | 2026-06-11 |
| KD-2 | PR 保持 draft，等验证完整后再推进 | 铲屎官指示 | 2026-06-11 |
| KD-3 | IM connector 配置对齐 F202 插件框架设计模式 | 铲屎官：参考插件管理那边的设计，YAML 清单 + .cat-cafe 持久化 + Hub UI 配置 | 2026-06-15 |
| KD-4 | ~~Phase A 后端 + Phase B 前端~~ → 合并为单一 Phase A（见 KD-12） | 铲屎官："一次性做完，这样我可以去完整的闭环验证" | 2026-06-15 |
| KD-5 | env 配置作为默认值 fallback，不要求用户迁移 | 铲屎官：env 当历史配置和默认值做兼容 | 2026-06-15 |
| KD-6 | ~~`IM_CONNECTOR_PLUGINS` env var 降级为 escape hatch~~ → 已移除（`9135333`） | 安装包用户没有 node 环境，tar.gz Hub 安装为唯一外部插件路径 | 2026-06-15 |
| KD-7 | 飞书/钉钉/微信均可外网测试，不需要内网环境 | 铲屎官：内网是基于新接口+YAML去实现对接内部 IM connector | 2026-06-15 |
| KD-8 | IM 前端卡片可复用插件卡片渲染，但保留 QR 面板等 IM 特有能力 | 铲屎官："之前定制的逻辑是不是可以清理了，直接复用插件那边的卡片" | 2026-06-15 |
| KD-9 | 心跳/健康检查作为 YAML capabilities 通用声明，有就支持无就不显示 | 铲屎官："心跳是不是可以作为通用配置项的；就和健康检查一样" | 2026-06-15 |
| KD-10 | 权限开关放入 YAML config 作为 type: toggle 字段，消除独立 permissions API | 铲屎官："权限标签也可以放到yaml里面；toggle类型的；映射到im connector上应该都是配置的key value值" | 2026-06-15 |
| KD-11 | QR 扫码作为插件自声明 action，通用端点 `{pluginId}/actions/{actionId}` | 铲屎官："有没有可能作为插件内的定制逻辑...yaml支持为自己的插件定制endpoint和action" | 2026-06-15 |
| KD-12 | 后端+前端+action 合入单一 Phase A，不拆 Phase；action 是状态机链，前端是纯状态机渲染器 | 铲屎官："没有必要到 Phase B 我们 Phase A 应该就把整个做完的...action 委托给不同的插件自己去处理...yaml回显当前 action 是哪个就好了" | 2026-06-15 |
| KD-13 | action 状态（持久化，用户下一步）≠ 连接状态（runtime health check），两者独立 | 铲屎官："connected 应该是 health 的检测是独立的" | 2026-06-15 |
| KD-14 | operation 是独立字段（有 `name`，无 `envName`），不挂在 input 字段上。通过 `target` 声明回填到哪些 input 字段 | 铲屎官："应该要用一个独立的字段来承载...不应该把 operation 字段放到 WEIXIN_BOT_TOKEN 上" | 2026-06-15 |
| KD-15 | Config field 解析逻辑 F202 plugin 和 F240 IM connector 共用一份（`ConfigField` 联合类型直接替换 `PluginConfigField` + `parseConfigField()`），YAML 配置文件各自独立管理。代码不考虑兼容（客户端应用直接改到位），数据层 YAML 无 `type` 字段 fallback 到 `input` | 铲屎官："两边的逻辑基本上是差不多的；配置文件可以是两边独立管理的(业务上有区分)，但对yaml的解析和处理可以是同一份的"；"代码上不用考虑兼容；只数据上需要稍微考虑下；因为我们是一个客户端应用" | 2026-06-15 |
| KD-16 | `.cat-cafe/im-connector-config/` 是配置的主存储，`.env` / 环境变量仅在无运行时数据时作为 fallback（旧版本升级兼容）。后续 `.env.example` 应删除 connector 相关配置项 | 铲屎官："迁移后保存数据是保存到.cat-cafe的运行时数据；.env文件和环境变量的只是作为没有运行时数据的fallback；后续我们.env是不需要这些配置了的（.env.example应删掉）" | 2026-06-15 |
| KD-17 | 所有 env-backed 代码路径只操作 `ValueConfigField[]`（通过 `isValueField()` type guard 过滤），`OperationConfigField` 不含 `envName` 属性 → 漏过滤则 TS 编译报错 | Review P1: operation 字段混入 env 持久化链会 crash 或产生空 key | 2026-06-15 |
| KD-18 | Value codec 契约：store 层保持 `Record<string, string \| null>`，typed 值通过 string codec 序列化（toggle→`"true"`/`"false"`, list→JSON string array, select→options value string）。Codec 在 shared `config-field-codec.ts`，前后端共用 | Review P1: spec 声明了 toggle/select/list 但没定义序列化格式，实现会不一致 | 2026-06-15 |
| KD-19 | Config resolution 三态：absent file→全量 env fallback; absent key→该 key env fallback; stored `null`→tombstone 阻断 env fallback。im-connector-config-store 必须对齐 plugin-config-store 的 `null` 处理 | Review P1: 当前 `resolveConnectorEnv()` 缺 null 分支，用户清空字段后 .env 旧值复活 | 2026-06-15 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | 立项。铲屎官确认方向：adapter 插件化 + 内置吃狗粮 + 外部 npm 包加载 |
| 2026-06-11 | Phase A 前半段：接口定义 + 7 adapter 迁移 + 外部加载器 + 示例包 + 文档 |
| 2026-06-12 | @codex R3 APPROVED（接口+迁移部分） |
| 2026-06-13 | Maintainer review: 4×P1 provenance fix + cloud P2 (Hub status heuristic) |
| 2026-06-15 | #925 weixin duplicate message fix 拆出为独立修复，不随 F240 PR 合入 |
| 2026-06-15 | 铲屎官重新定义 scope：YAML 清单 + 配置持久化 + Hub 写端点 纳入 Phase A |
| 2026-06-15 | Phase A 后半段：YAML 清单 + config store + bootstrap 三层解析 + visual metadata |
| 2026-06-15 | ~~三阶段拆分~~ → 合并为两阶段：Phase A 完整闭环 + Phase B 动态安装 |
| 2026-06-15 | 铲屎官确认 action 状态机设计：QR/心跳/权限全部 YAML 驱动，前端零硬编码 |
| 2026-06-15 | KD-15: config field 解析逻辑统一——共享 `ConfigField` 类型 + `parseConfigField()` 解析器，YAML 文件各管各 |
| 2026-06-15 | KD-16: .cat-cafe 是配置主存储，.env 是 fallback only，.env.example 应删除 connector 配置项 |
| 2026-06-15 | Feat doc 全面刷新：A-2/A-3/A-4 拆分 + 五种字段类型 + 统一解析器 + AC 重编号 A11-A27 |
| 2026-06-15 | @codex doc review 退回：3×P1（value codec/operation type split/tombstone）+ 1×P2（ownership scope） |
| 2026-06-15 | KD-17/18/19: 修复 spec——ValueConfigField 分离 + string codec 契约 + 三态 resolve 语义 + operation state 隔离存储 + AC 补充回归覆盖 |
| 2026-06-15 | A-2 实现完成 + @codex APPROVED：共享 ConfigField 类型 + codec + parser + tombstone 修复 |
| 2026-06-15 | A-3 后端实现完成：action state machine + 通用端点 + advance polling + plugin handleAction + updatedAt |
| 2026-06-16 | AC-A14/A14a/A14b 完成：.env.example 清理 + guide 更新 + 旧路径验证 |
| 2026-06-16 | Phase B 完成：icon API proxy + source 标识 + ConnectorIcon onError fallback + uninstall 内存清理 |
| 2026-06-16 | 文档整理：guide 改名 → `im-connector-dev-guide.md`；安装按钮 → "安装 IM Connector" |

## Review Gate

- Phase A: 跨族 review（缅因猫）→ 铲屎官外网实测（飞书/钉钉/微信 QR + 配置 + action 全流程）
- Phase B: 跨族 review + 铲屎官内网试用（基于新接口开发自定义 connector）

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F088-multi-platform-chat-gateway.md` | 原始 connector 系统 spec |
| **Feature** | `docs/features/F202-plugin-framework.md` | 通用 Plugin Framework（YAML + config store + 前端卡片设计参考） |
| **Codebase** | `packages/api/src/infrastructure/connectors/` | 现有 connector 代码 |
| **Codebase** | `packages/web/src/components/HubConnectorConfigTab.tsx` | IM connector 前端卡片（改造对象） |
| **Codebase** | `packages/web/src/components/settings/PluginsContent.tsx` | F202 插件卡片（复用目标） |
| **Upstream** | `https://github.com/zts212653/clowder-ai/pull/903` | PR #903（draft） |
| **Upstream** | `https://github.com/zts212653/clowder-ai/issues/907` | Issue #907 |
| **Bug Fix** | `https://github.com/zts212653/clowder-ai/issues/925` | #925 weixin 重复消息（独立修复，非 F240 scope） |
