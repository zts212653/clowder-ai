---
feature_ids: [F249]
related_features: [F041, F043, F145, F178, F213, F228]
topics: [mcp, capability-dashboard, multi-project, sync, drift-detection, plugin]
doc_kind: spec
created: 2026-06-17
tips_exempt: design-phase spec — capability tips added when feature reaches implementation
---

# F249: Multi-Project MCP Sync Management — 多项目 MCP 配置同步管理

> **Status**: design | **Owner**: @opus (布偶猫/宪宪) | **Priority**: P1

---

## 一、Why

Skill 侧（F228）已实现完整的多项目管理体系。MCP 配置目前还停留在扁平模型，缺失项目级管理、按成员控制、漂移检测、级联同步。本 Feature 对齐 F228 架构，在 MCP 侧建立对等能力。

---

## 一-B、前置：#712 单源改造（PR #713 已实现）

> **PR**: [#713 fix(#712): unify MCP config to capabilities.json single source](https://github.com/zts212653/clowder-ai/pull/713)
> **状态**: 待合入 | **分支**: `fix/712-mcp-config-single-source`

F249 的多项目同步体系建立在 #712 改造的基础之上。改造前 MCP 配置散落在多个位置，改造后统一到 `capabilities.json` 单一真相源。

### 改造前的问题

| 问题 | 表现 |
|---|---|
| 真相源分散 | 各 provider 各自硬编码 `{ 'cat-cafe': { command: 'node', args: [...] } }`，改一处漏一处 |
| 中间产物文件 | 存在 `mcp-resolved.json` 等持久化中间文件，生命周期不清晰 |
| ACP 依赖 `.mcp.json` | ACP 外部 server 从项目根 `.mcp.json` 读取白名单，绕过 capabilities.json |
| 启动时预解析 | `resolveAcpMcpServers()` 在 API 启动时执行，不能响应运行时配置变更 |
| callback env 散落 | 9 个 callback env key 在各 provider 重复定义 |

### 改造后的架构

```
capabilities.json（唯一真相源）
     ↓ invoke-time 读取
resolveServersForCat(capConfig, catId)  ← 统一入口
     ↓
按 provider 分路注入
     │
     │ invoke-time 临时注入（无持久化 CLI 文件）：
     ├── Claude:      --mcp-config inline JSON + --strict-mcp-config
     ├── Codex:       --config mcp_servers.X... 请求参数
     ├── OpenCode:    临时 opencode.json（OPENCODE_CONFIG env 指向）
     ├── Kimi:        临时 mcp.json（--mcp-config-file 指向）
     └── ACP:         session 参数（AcpAgentService — provider-agnostic）
     │
     │ 持久化配置文件（CLI 不支持 invoke-time 注入）：
     ├── Gemini CLI:  .gemini/settings.json（项目级，每次 capability 变更时刷新）
     └── Antigravity: ~/.gemini/antigravity/mcp_config.json（全局级，仅支持全局目录）
```

### 关键改动清单

| 改动 | 说明 |
|---|---|
| **`mcp-constants.ts` 新增** | `CAT_CAFE_SPLIT_ENTRYPOINTS`（5 个 split server 的单一定义点）、`MCP_CALLBACK_ENV_KEYS`（9 个 callback env 集中定义）、`resolveCatCafeNodeCommand()`、`summarizeMcpInjection()` |
| **`mcp-resolved.json` 移除** | 不再生成持久化的中间解析文件 |
| **ACP `.mcp.json` fallback 移除** | 外部 server 改从 capabilities.json 读取，invoke-time 解析 |
| **启动时预解析移除** | `resolveAcpMcpServers()` 从 `index.ts` 启动流程移除，改为 invoke-time 惰性解析 |
| **各 provider 统一** | 所有 provider 通过 `resolveServersForCat()` 从 capabilities.json 读取 MCP 列表 |
| **PROVIDER_WRITERS 精简** | 从 5 个（anthropic/openai/google/antigravity/kimi）缩减为 2 个（google/antigravity）。Claude/Codex/Kimi 改为 invoke-time 临时注入，不再启动时生成持久化 CLI 配置文件 |
| **硬编码清理** | 各 provider 散落的 `{ command: 'node', args: [serverPath] }` 统一为 `resolveCatCafeNodeCommand()` |
| **`enabled` → `globalEnabled` 迁移** | MCP entries 此前同时存在 `enabled`（旧）和 `globalEnabled`（F228 新增给 skill 用），#712 统一所有 capability 类型走 `globalEnabled`。旧 `enabled` 字段由 init 时一次性迁移（`readCapabilitiesConfig` / `migrateAndPersistCapabilities`），运行时不再 fallback 读取 |

### F249 在此基础上的增量

#712 解决了"从哪读"（单源）和"怎么注入"（invoke-time）。F249 在此基础上增加：

| 维度 | #712 已有 | F249 新增 |
|---|---|---|
| 数据源 | capabilities.json 单源 | 全局 + 项目双层 capabilities.json |
| 猫级控制 | `overrides[]` per-cat toggle | `blockedCats` 黑名单模型 |
| 项目配置 | 无项目级概念 | `mcpServerOverride` 项目覆盖 |
| 同步 | 无 | `syncMcpProject` / `syncMcpAll` 级联引擎 |
| 漂移检测 | 无 | 3-case drift detection |
| env 管理 | callback env 注入 | `McpEnvEntry` 含 sensitive + `${VAR}` 引用 |

---

## 二、数据模型

### 2.1 MCP CapabilityEntry（项目 capabilities.json 中）

```typescript
interface McpCapabilityEntry {
  id: string;                    // MCP 名称，全局唯一
  type: 'mcp';
  globalEnabled: boolean;        // 全局级别的启禁用状态标识（与 skill 侧对齐）。项目下该 MCP 是否启用取决于 blockedCats，不取决于此字段
  source: 'cat-cafe' | 'external';
  pluginId?: string;

  mcpServer: {
    command?: string;
    args?: string[];
    transport?: 'stdio' | 'streamableHttp';
    url?: string;
    headers?: Record<string, string>;
    env?: McpEnvEntry[];         // env 数组（含 sensitive 标记）
    workingDir?: string;
    resolver?: string;
  };

  // ---- 项目级字段 ----
  blockedCats?: string[];        // 黑名单：哪些猫不能用此 MCP
  mcpServerOverride?: McpServer;           // 项目级配置覆盖（全量存储，存在则完全替代全局 mcpServer）

  // ---- 全局维度按猫 override（保留兼容） ----
  overrides?: CatCapabilityOverride[];
}
```

### 2.2 McpEnvEntry

```typescript
interface McpEnvEntry {
  key: string;
  value: string;       // 支持 ${ENV_VAR} 变量引用，运行时从进程环境解析
  sensitive: boolean;   // true = Console 默认掩码显示（眼睛 toggle 切换）
}
```

### 2.3 McpSyncState（per-project，存在 capabilities.json 中）

```typescript
interface McpSyncState {
  sourceConfigHash: string;         // 上次同步时全局 MCP 配置的 hash
  lastSyncedAt: string;             // ISO 8601
  cascadeDisabledMcps?: string[];   // 由全局级联传入的禁用项
}
```

### 2.4 黑名单模型说明

MCP 默认对所有猫可见。只记录"谁不能用"：

| `blockedCats` 值 | 含义 |
|---|---|
| `undefined` 或不存在 | 全部猫可用（默认） |
| `[]` | 全部猫可用 |
| `['gemini']` | 只有暹罗猫不能用 |
| `[全部猫 ID]` | 该项目完全禁用此 MCP |

**新增成员级联**：遍历所有项目 MCP entries → 对 `blockedCats` 包含所有现有猫的 entry（= 完全禁用），把新成员加入 `blockedCats`。其他项目不动。

---

## 三、主流程与场景

### 场景 1：全局新增 MCP

```
用户在"全部 MCP" tab → [新增 MCP] → 填写配置 → 两个按钮：

[保存]                  → 写入全局 capabilities.json，globalEnabled: false，不级联
[保存并同步到所有项目]    → globalEnabled: true → 遍历所有项目 syncProject（写入 entry，blockedCats=[]）
```

### 场景 2：全局启用/禁用 MCP

```
用户在"全部 MCP" tab 切换全局开关
  ↓
写 globalEnabled = true/false（仅全局 capabilities.json）
  ↓
不级联到项目（项目的启禁用由 blockedCats 独立控制）
```

`globalEnabled` 是全局维度的状态标识，和 skill 侧的 `globalEnabled` 语义对齐——表示"全部 MCP 管理页"上该 MCP 的启禁用状态。项目下该 MCP 是否对某只猫可用，完全由 `blockedCats` 决定。

### 场景 2-A：全局 tab 整体 toggle 状态派生（Board 回显规则）

> **补充背景**：场景 2 描述了 toggle 的写入侧，本节补充 Board 读取侧的回显规则。

```
用户打开"全部 MCP" tab → GET /api/capabilities
  ↓
对每个 MCP entry，Board 上显示的 `enabled`（整体 toggle 状态）：
  ↓
  1. 用 resolveServersForCat(config, catId) 得到每只猫的实际 enabled 状态
  2. enabled = Object.values(cats).some(Boolean)
     （任一猫启用 → 整体启用；全部猫禁用 → 整体禁用）
  3. 无猫时 fallback 到 globalEnabled 配置值
```

**为什么不直接用 `globalEnabled`**：当用户在 per-cat level 做过 override（例如单独启用每只猫），`globalEnabled` 可能仍为 `false`，但实际每只猫都已启用。Board 上的 toggle 应该反映**实际状态**，而不是一个可能过期的配置字段。

此规则同时适用于全局 tab 和项目 tab：项目 tab 的回显也从 per-cat resolved states 派生（通过 `blockedCats` 或 `overrides` 解析），不是直接取 `globalEnabled`。

### 场景 2-B：全局 parent toggle 清除 per-cat overrides

> **补充背景**：场景 2 描述了 "写 globalEnabled"，本节补充 per-cat overrides 的连锁处理。

```
用户在"全部 MCP" tab 切换整体开关（parent toggle）
  ↓
写 globalEnabled = true/false
  ↓
清除该 MCP entry 的 overrides 数组（delete cap.overrides）
  ↓
不级联到项目
```

**为什么清除 overrides**：`overrides` 是对前一个 `globalEnabled` 值的个别例外。当用户明确点击 parent toggle 设置新的全局状态时，旧的例外不再有意义。如果不清除，会出现以下问题：

```
初始状态：globalEnabled=false, overrides=[{codex: true}, {opus: true}, {gemini: true}]
用户点击 parent toggle → globalEnabled=true
不清除 overrides → overrides 仍含 [{codex: true}, ...]
  → 这些 overrides 与新的 globalEnabled 方向相同，成为无效冗余
  → 下次用户点击 parent toggle 禁用 → globalEnabled=false
     但 overrides 还在 → 每只猫仍然是 enabled → toggle 状态与实际不一致
```

清除 overrides 确保 parent toggle 是一个"重置为统一状态"的干净操作。

### 场景 2-C：项目视图继承全局 globalEnabled（无 blockedCats 时）

> **补充背景**：场景 2 说"不级联到项目"，这指的是不写项目配置文件。本节补充 **Board 读取时**的继承规则。

```
用户在"项目 MCP" tab 查看外部项目的 MCP 列表
  ↓
对每个 MCP entry：
  blockedCats 存在（undefined 以外的值） → 由 blockedCats 控制，不继承全局
  blockedCats 不存在（= 还没做过项目级配置） → 从全局 config 继承 globalEnabled 和 overrides
```

**为什么需要继承**：外部项目的 capabilities.json 在首次同步时从全局复制。之后如果用户在全局 tab 变更了 `globalEnabled`，全局配置更新了但项目的本地副本不会自动更新（场景 2 明确说"不级联"）。

对于已做过项目级配置（有 `blockedCats`）的项目，项目自己的配置是权威的——这没问题。但对于**还没做过项目级配置**的项目（`blockedCats === undefined`），项目本地的 `globalEnabled` 是创建时的旧值。Board 读取时应从全局 config 继承最新的 `globalEnabled` 和 `overrides`，确保用户在全局 tab 做的变更能在项目视图中反映出来。

这是**读取时继承**，不是写入时级联——不修改项目的 capabilities.json，只在 API 响应中使用最新的全局值。

### 场景 3：全局修改 MCP 配置

```
用户编辑 MCP 的 command/args/env/url → 保存
  ↓
写入全局 mcpServer
  ↓
遍历所有项目：
  ├── 无 mcpServerOverride → 自动更新
  └── 有 mcpServerOverride → 跳过 → 漂移检测提示
```

### 场景 4：全局删除 MCP

```
用户 [卸载] → 确认
  ↓
从全局 capabilities.json 删除 entry
  ↓
遍历所有项目 → 删除该 entry（含 mcpServerOverride 一并删除）
```

### 场景 5：项目启用/禁用 MCP（整体）

```
用户在"项目 MCP" tab → 切换开关
  ↓
禁用：blockedCats = [全部猫 ID]
启用：blockedCats = []
  ↓
只写该项目 capabilities.json，不影响全局和其他项目
```

### 场景 6：项目按猫启用/禁用 MCP

```
用户展开 MCP → 按猫 toggle
  ↓
从 blockedCats 增加/移除对应 catId
  ↓
只写该项目 capabilities.json
```

### 场景 7：项目独立修改 MCP 配置

```
用户在"项目 MCP" tab → 点击 MCP 卡片 → 修改 command/args/env
  ↓
写入 mcpServerOverride（全量存储，不做差异计算）
  ↓
后续全局变更不会自动覆盖此项目的该 MCP（跳过 + 漂移提示）
```

**mcpServerOverride 存储策略：全量覆盖**

不做字段级 diff，原因：差异表示需要区分"新增字段"、"修改字段"、"删除字段"三种语义（例如全局有 a/b 两个 env，项目新增 c、修改 b、删除 a），diff 格式复杂且合并逻辑容易出错。

全量存储规则：
- `mcpServerOverride` 存在 → 该项目的该 MCP **完全使用 override 内容**，不与全局 mcpServer 合并
- `mcpServerOverride` 不存在 → 使用全局 mcpServer
- 用户编辑时，前端以全局配置为初始值加载到编辑器，用户修改后整体保存为 override
- 判断"有 override" = `mcpServerOverride !== undefined`（不需要和全局 diff 比较）

项目弹窗中提供 [恢复全局配置] 按钮 → 删除 `mcpServerOverride` 字段（不是设为空对象）。

### 场景 8：项目同步全局

```
用户在"项目 MCP" tab → 看到 McpDriftBanner → 点击 [立即同步]
  ↓
对每个漂移项：
  - global-new → 写入项目（blockedCats=[]）
  - project-orphan → 确认后移除
  - config-mismatch → 用全局配置覆盖（清除 mcpServerOverride）
  ↓
更新 mcpSync.sourceConfigHash
```

### 场景 9：全局级联同步（syncAll）

```
用户在"全部 MCP" tab → [同步到所有项目]
  ↓
遍历 GovernanceRegistry 所有外部项目 → 对每个调 syncMcpProject
  ↓
有 override 的项目跳过 → 漂移检测可见
```

### 场景 10：插件 MCP 生命周期

```
插件激活 → 调用 MCP 新增接口 → 写入 capabilities.json（pluginId 标记）→ 级联到项目
插件停用 → 调用 MCP 删除接口 → 从全局 + 所有项目删除
插件 MCP 不允许项目级 override（pluginId 标记的条目 UI 禁止编辑）
```

### 场景 11：新增成员

```
系统新增猫猫成员
  ↓
遍历所有项目 MCP entries
  ↓
对 blockedCats = [全部现有猫ID] 的条目 → blockedCats.push(新成员ID)
  ↓
确保"完全禁用"的 MCP 对新成员也保持禁用
```

---

## 四、API 接口

### 4.1 现有接口（适配）

| 方法 | 路径 | 变更说明 |
|---|---|---|
| `GET` | `/api/capabilities` | **去掉默认 probe**。MCP 列表只返回配置数据，不探测工具。增加返回 `blockedCats` / `mcpServerOverride` / `mcpSync` / `allCats`（完整猫列表，含 catId + displayName）|
| `PATCH` | `/api/capabilities` | **MCP 新增 `scope=project`**。`scope=global` 写 `globalEnabled`；`scope=project` 写 `blockedCats`；`scope=project` + `mountPointId=<catId>` 按猫 toggle |
| `POST` | `/api/capabilities/mcp/install` | **增加 `syncAll: boolean` 参数**（保存并同步）+ `projectPath` 参数（有 → 写 mcpServerOverride，无 → 写全局）。env 字段改为 `McpEnvEntry[]` 含 sensitive 标记 |
| `DELETE` | `/api/capabilities/mcp/:id` | **增加级联逻辑**：删除全局 entry + 遍历所有项目删除 |

### 4.2 新增接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/mcp/:id/tools` | 单个 MCP 工具探测（延迟加载） |
| `POST` | `/api/mcp/drift-check` | 漂移检测 |
| `POST` | `/api/mcp/drift-resolve` | 漂移修复 |
| `POST` | `/api/mcp/sync-all` | 全局级联同步 |

### 4.3 删除的接口

| 路径 | 原因 |
|---|---|
| ~~`PATCH /api/capabilities/mcp/:id/env`~~ | env 合入 install 接口统一处理 |
| ~~`POST /api/capabilities/mcp/preview`~~ | 客户端应用，新增时前端校验同名即可，不需要 dry-run |

### 4.4 接口详解

#### `GET /api/mcp/:id/tools` — 工具延迟加载

```
触发：用户点击 MCP 卡片打开详情弹窗
行为：对该 MCP server 发起连接，获取工具列表
响应：{
  tools: [{ name: "search_evidence", description: "..." }],
  connectionStatus: "connected" | "timeout" | "error",
  latencyMs: 342
}
超时：5s 硬上限
缓存：可选 30s 内存缓存
```

**关键优化**：MCP 管理列表页永远不触发工具探测。只有打开单个 MCP 弹窗时才延迟加载。解决当前列表加载极慢的问题。

#### `POST /api/mcp/drift-check` — 漂移检测

```
请求：{ projectPath: string }
响应：{
  issues: McpIssue[],
  driftHash: string,
  summary: { new: number, orphan: number, mismatch: number }
}
```

#### `POST /api/mcp/drift-resolve` — 漂移修复

```
请求：{
  projectPath: string,
  action: "sync",
  resolutions?: [{ mcpId: string, decision: "use-global" | "keep-project" }]
}
响应：{
  added: string[],
  removed: string[],
  updated: string[],
  skipped: string[],    // 用户选 keep-project 的
  syncedHash: string
}
```

#### `POST /api/mcp/sync-all` — 全局级联

```
请求：{}
响应：{
  projects: [
    { path: string, result: SyncResult } |
    { path: string, skipped: true, reason: string }
  ],
  summary: { synced: number, skipped: number }
}
```

#### `PATCH /api/capabilities`（MCP scope=project 扩展）

```json
// 项目整体启禁用
{ "id": "my-tool", "type": "mcp", "enabled": true, "scope": "project", "projectPath": "/path" }

// 项目按猫 toggle
{ "id": "my-tool", "type": "mcp", "enabled": false, "scope": "project",
  "projectPath": "/path", "mountPointId": "gemini" }
```

#### `POST /api/capabilities/mcp/install`（适配）

```json
{
  "id": "github-mcp",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@mcp/github"],
  "env": [
    { "key": "GITHUB_TOKEN", "value": "${MY_GITHUB_TOKEN}", "sensitive": true },
    { "key": "REPO", "value": "clowder-ai/cat-cafe", "sensitive": false }
  ],
  "syncAll": true,
  "projectPath": null
}
```

- `syncAll: true` → 保存并同步到所有项目
- `syncAll: false` → 仅保存到全局，`globalEnabled: false`
- `projectPath` 有值 → 写 `mcpServerOverride` 到该项目
- 前端新增时校验同名冲突（`id` 已存在 → 提示不能继续）

---

## 五、MCP 加载与调用时注入

### 5.1 调用时注入路径

```
invoke-single-cat.ts
  ↓
resolveServersForCat(config, catId)
  │  ← config = 项目的 capabilities.json（单一配置，无 global+project 合并）
  │     调用方从 workingDirectory 读取项目配置；无项目配置时回退到主项目配置
  │
  ├── 1. 项目过滤：catId 不在 blockedCats 中（项目级启禁用的唯一判据）
  └── 2. 配置来源：有 mcpServerOverride → 完全使用 override；无 → 使用 mcpServer
  ↓
构建最终 MCP 列表
  ↓
按 provider 分路注入：
  ├── Claude:   --mcp-config JSON 参数（CLI 自身还会读 .mcp.json，取并集）
  ├── Codex:    请求参数（CLI 自身还会读 .codex/config.toml，取并集）
  ├── OpenCode: 临时 opencode.json（OPENCODE_CONFIG env 指向，完全替换）
  ├── Kimi:     临时 mcp.json（指定路径，完全替换）
  └── ACP:      session 参数（完全由我们控制）
  ↓
env 中 ${VAR} 变量 → 运行时从 process.env 解析注入
callback env keys 注入（CAT_CAFE_API_URL / INVOCATION_ID / TOKEN 等）
```

### 5.2 Provider 注入模式

| Provider | 注入机制 | 指向方式 | CLI 原生配置 | 关系 |
|---|---|---|---|---|
| Claude | `--mcp-config` inline JSON | CLI 参数直传 | `.mcp.json` | 取并集（两边都加载） |
| Codex | `--config` 请求参数 | CLI 参数直传 | `.codex/config.toml` | 取并集 |
| OpenCode | 临时 `opencode.json` | `OPENCODE_CONFIG` 环境变量指向临时文件路径 | 无（被替换） | 完全由我们控制 |
| Kimi | 临时 `mcp.json` | `--mcp-config-file` CLI 参数指向 `mkdtemp` 生成的临时目录下 `mcp.json` | 用户项目 `.kimi/mcp.json`（合并为 base layer） | 我们的 entry 优先，用户 server 保留 |
| ACP（通用） | session 参数 | `newSession(cwd, mcpServers)` / `loadSession(sessionId, cwd, mcpServers)` | 无 | 完全由我们控制 |

> **ACP 说明（F161）**：ACP 是 provider-agnostic 的通用 Agent Communication Protocol client。
> OpenCode / Gemini / Kimi 均通过 `AcpServiceFactory` 构造 `AcpAgentService`，
> MCP 配置通过 session 参数（`resolveAcpMcpServers` + `mcpWhitelist`）传递。
> 不存在独立的 Gemini ACP provider — 所有 ACP transport 统一由 `AcpAgentService` 处理。

### 5.3 env 变量引用

```
配置值：GITHUB_TOKEN = ${MY_GITHUB_TOKEN}
运行时：读取 process.env.MY_GITHUB_TOKEN → 注入到 MCP server 的 env
未找到变量：保留原始字符串 "${MY_GITHUB_TOKEN}"（不替换）
```

---

## 六、漂移检测

### 6.1 检测模型

```
全局 capabilities.json (MCP entries)
       ↕ 对比
项目 capabilities.json (MCP entries + blockedCats + mcpServerOverride)
```

只有一层对比：全局 vs 项目。没有 CLI 配置文件对比（invoke-time 全部临时生成，无持久 CLI 文件）。

### 6.2 Issue 类型（3 种）

| type | 触发条件 | 提示文案 |
|---|---|---|
| `global-new` | 全局有、项目没有 | "全局新增了 MCP「X」，项目尚未同步" |
| `project-orphan` | 项目有（非 `source=external` 单独添加）、全局没有 | "MCP「X」在全局已不存在，疑似残留配置" |
| `config-mismatch` | 两边都有，全局 mcpServer 变了，项目未跟进 | 统一文案："MCP「X」项目配置与全局不一致"（不区分有无 override，同一个 issue type） |

### 6.3 检测方法

```
checkMcpProject(projectRoot):
  1. globalMcpMap = 读全局 capabilities.json 的 type=mcp entries
  2. projectMcpMap = 读项目 capabilities.json 的 type=mcp entries
  3. global-new:     globalMcpMap 中有、projectMcpMap 中无
  4. project-orphan: projectMcpMap 中有（非 external）、globalMcpMap 中无
  5. config-mismatch: 交集中 hash(mcpServer) 不同 且 mcpServerOverride 无/有分别标注
  6. 返回 { issues, driftHash, summary }
```

### 6.4 同步行为（drift-resolve）

用户在 banner 点击 [同步] 后，对每个 issue：

| issue type | 同步动作 |
|---|---|
| `global-new` | 在项目 capabilities.json 中写入该 MCP entry（blockedCats=[]） |
| `project-orphan` | 从项目 capabilities.json 中删除该 MCP entry |
| `config-mismatch`（无 override） | 用全局 mcpServer 覆盖项目的 mcpServer |
| `config-mismatch`（有 override） | **删除 mcpServerOverride**，回到使用全局配置。提示文案类似 skill 侧同名冲突："项目自定义配置已移除，已恢复为全局配置" |

### 6.5 Follow-up: skip_until_next（暂不实现）

> **状态**: P3 defer — 明确先不做，根据实际使用情况决定是否需要

对于 `config-mismatch` 有 override 的场景，用户可能希望保留 override 并忽略本次漂移提示。可以增加 `skipUntilNext` 字段：

```typescript
interface McpSyncState {
  sourceConfigHash: string;
  lastSyncedAt: string;
  cascadeDisabledMcps?: string[];
  // follow-up: 用户选择 ignore 时设为 true + 记录当时的 globalHash
  skippedMcps?: Record<string, {
    skipUntilNext: boolean;
    skippedAtGlobalHash: string;  // 当全局 hash 再次变化时重新提示
  }>;
}
```

行为：
- 用户对某个 `config-mismatch` 选择 "忽略" → `skipUntilNext: true` + 记录当前全局 hash
- 下次 drift-check 时：如果全局 hash 未变 → 跳过该 issue；全局 hash 变了 → 重新检测并提示
- 这比 skill 侧多了一个 "ignore" 选项，因为 MCP 有项目覆盖的合理场景

### 6.6 检测时机

| 时机 | 检测范围 | 说明 |
|---|---|---|
| 打开"项目 MCP" tab | `checkMcpProject`（当前选中的项目） | 前端调 `POST /api/mcp/drift-check` |
| 打开"全部 MCP" tab | 遍历所有项目 `checkMcpProject`，汇总 | 前端调 `POST /api/mcp/drift-check`（无 projectPath = 全局汇总） |
| toggle / 同步操作后 | 刷新 drift banner | 操作完后前端重新调 drift-check |

**与 skill 侧 drift detection 的复用关系**：

skill 侧已有 `POST /api/skills/drift-check` 和 `POST /api/skills/drift-resolve`（F228 Phase 2，`skills-drift.ts`）。MCP 侧的 drift-check / drift-resolve **路由结构完全对齐**：

| | Skill | MCP |
|---|---|---|
| 检测路由 | `POST /api/skills/drift-check` | `POST /api/mcp/drift-check` |
| 修复路由 | `POST /api/skills/drift-resolve` | `POST /api/mcp/drift-resolve` |
| 检测器 | `skills/drift-detector.ts` (`checkGlobal` / `checkProject`) | `mcp/mcp-drift-detector.ts` (`checkMcpGlobal` / `checkMcpProject`) |
| 修复器 | `skills/drift-resolver.ts` (`syncDrift`) | `mcp/mcp-drift-resolver.ts` (`syncMcpDrift`) |
| Issue 类型 | `config-new` / `config-orphan` / `conflict` / `phantom` / ... | `global-new` / `project-orphan` / `config-mismatch` |

前端 banner 组件复用同一套模式（见 §8.7）。

**注意**：当上游代码更新引入新的内置 MCP 时（如新增 split server），`healCatCafeMcpTopology()` 会在启动时静默自动修复全局 capabilities.json（补入新 entry）。但项目侧不会自动同步——用户打开 MCP 管理页时 drift-check 会检测到 `global-new` 并在 banner 提示。当前 skill 侧也是同样的触发机制（打开 Settings → Skill tab 时才检测），不是新建对话触发的。

### 6.7 全局 tab 汇总展示

全局 tab 的漂移 banner 聚合所有项目的检测结果，类似 skill 侧的 `AllProjectsSyncBanner`：

```
⚠️ 3 个项目存在 MCP 配置漂移
  项目 A：2 项新增未同步
  项目 B：1 项配置不一致
[同步到所有项目]
```

---

## 七、冲突处理总表

| 冲突类型 | 场景 | 检测时机 | 通知位置 | 处理方式 |
|---|---|---|---|---|
| **全局 vs 项目** | 全局变了，项目有 override | 打开 MCP 管理页 | 项目 tab drift banner | 用户点同步 = 明确覆盖 |
| **全局 vs 项目** | 全局变了，项目无 override | 全局级联时 | 自动更新，无通知 | 自动同步 |
| **全局级联跳过** | 全局操作，项目有 override | 级联执行时 | 项目 tab drift banner | 跳过 → 漂移提示 |
| **新增同名** | Console 内新增 MCP，id 已存在 | 新增时 | 新增弹窗 | 前端校验拦截 |
| **CLI 原生同名** | Claude/Codex 项目原生配置同名 | P3 defer | — | 先不处理 |

---

## 八、前端 UI

### 8.1 McpManageContent 改造

```
┌──────────────────────────────────────────┐
│  MCP 管理                                │
├──────────────────────────────────────────┤
│  [全部 MCP]  [项目 MCP]                  │  ← 双 tab
├──────────────────────────────────────────┤
│  (全部 tab)                              │
│  ┌ AllProjectsSyncBanner ───────────┐   │  ← 汇总所有项目漂移
│  │ 3 个项目存在配置漂移 [同步所有]   │   │
│  └──────────────────────────────────┘   │
│                                          │
│  (项目 tab)                              │
│  项目选择器: [当前项目 ▼]                │
│  ┌ McpDriftBanner ──────────────────┐   │  ← 当前项目漂移
│  │ 发现 2 项配置漂移 [立即同步]      │   │
│  └──────────────────────────────────┘   │
│                                          │
│  ┌ MCP 卡片 ────────────────────────┐   │
│  │ cat-cafe-collab    [全局开关] [▼] │   │
│  │  ┌ 按猫 toggle ──────────────┐  │   │  ← 展开
│  │  │ 布偶猫 [✓]  缅因猫 [✓]    │  │   │
│  │  │ 暹罗猫 [✗]                 │  │   │
│  │  └───────────────────────────┘  │   │
│  └──────────────────────────────────┘   │
│                                          │
│  [+ 新增 MCP]                            │
│    └→ 新增弹窗底部：[保存] [保存并同步]    │
└──────────────────────────────────────────┘
```

### 8.2 env 掩码展示

```
┌──────────────────────────────────────────┐
│ GITHUB_TOKEN   ••••••••••••   👁️‍🗨️ [闭眼] │  ← sensitive=true，默认掩码
│ REPO           clowder-ai     👁  [睁眼] │  ← sensitive=false，默认明文
└──────────────────────────────────────────┘
点击眼睛 toggle → 掩码/明文切换
sensitive 状态持久化到 capabilities.json
```

### 8.3 项目覆盖编辑

项目 tab 点击 MCP 卡片打开弹窗时：
- 显示全局配置（只读参考）
- 允许修改 → 写入 `mcpServerOverride`
- 提供 [恢复全局配置] 按钮 → 清除 override
- 插件 MCP（有 `pluginId`）→ 禁止编辑

### 8.4 MCP 工具延迟加载

列表页：只显示 MCP 配置信息，**不** 加载工具列表。
弹窗内：打开后异步调用 `GET /api/mcp/:id/tools`，loading 态 → 工具列表渲染。
与 MCP 配置信息的展开是独立的两个区域。

### 8.5 前端 cat 列表与 toggle 回显

API 返回每个 MCP entry 的 `blockedCats` + 响应顶层的 `allCats` 完整猫列表。前端渲染逻辑：

```
allCats: [{ catId: 'opus', displayName: '布偶猫' }, { catId: 'codex', ... }, ...]
blockedCats: ['gemini']

前端对比：
  opus   → 不在 blockedCats → ✓ 启用
  codex  → 不在 blockedCats → ✓ 启用
  gemini → 在 blockedCats   → ✗ 禁用

MCP 卡片整体 toggle 回显：
  blockedCats 包含全部 catId → 禁用态
  blockedCats 为空或不包含全部 → 启用态
```

前端不需要自己维护 cat 列表，全部由后端 `allCats` 提供。

**全局 tab 整体 toggle 回显**（补充，详见场景 2-A）：

```
全局 tab 的 MCP 卡片整体 toggle 回显：
  从每只猫的实际 resolved enabled 状态派生 →
  Object.values(cats).some(Boolean) → 任一猫启用 = 整体启用
  全部猫禁用 = 整体禁用
  无猫（边界条件） → fallback 到 globalEnabled

不直接使用 globalEnabled：
  globalEnabled 可能与 per-cat overrides 的实际效果不一致
  （例：globalEnabled=false 但每只猫都有 override enabled=true）
```

**项目 tab 对无 blockedCats entry 的继承回显**（补充，详见场景 2-C）：

```
项目 entry 无 blockedCats（从未做过项目级配置）：
  Board 读取时从全局 config 继承 globalEnabled + overrides
  → per-cat states 从 resolveServersForCat(globalConfig, catId) 解析
  → enabled 从 per-cat states 派生（同全局 tab 规则）

项目 entry 有 blockedCats：
  使用项目自己的配置（不继承全局）
  → per-cat states 从 resolveServersForCat(projectConfig, catId) 解析
```

### 8.6 共用组件

| 组件 | 来源 |
|---|---|
| `ProjectSelector` | 已有，直接复用 |
| `PerCatToggles` | 已有，增加 project scope（写 blockedCats） |
| `ToggleSwitch` | 已有 |
| `McpDriftBanner` | 直接复用 `SkillsDriftBanner` 组件结构（仅替换 title / issue 文案 / API 路径），样式完全一致 |
| `McpAllProjectsSyncBanner` | 直接复用 `AllProjectsSyncBanner` 组件结构（同上），样式完全一致 |
| `McpConfigModal` | 现有改造（增加项目覆盖区域 + 恢复按钮） |

### 8.7 Skill ↔ MCP 前端复用对照

MCP 侧 banner / 弹窗 / 同步流程与 skill 侧**除展示信息外完全一致**：

| 维度 | Skill 侧 | MCP 侧 | 差异 |
|---|---|---|---|
| 项目 drift banner | `SkillsDriftBanner` | `McpDriftBanner` | title / issue 文案 / API 路径不同 |
| 全局 drift banner | `AllProjectsSyncBanner` | `McpAllProjectsSyncBanner` | 同上 |
| drift-check API | `POST /api/skills/drift-check` | `POST /api/mcp/drift-check` | 返回的 issue type 不同 |
| drift-resolve API | `POST /api/skills/drift-resolve` | `POST /api/mcp/drift-resolve` | 同上 |
| 同步按钮行为 | 调 drift-resolve → 刷新 banner | 完全一致 | — |
| banner 样式 / 布局 / 交互 | — | 完全复用 | 无差异 |

实现时建议把 banner 组件抽成通用的 `DriftBanner<T extends Issue>`，skill / mcp 各传自己的 fetcher 和 renderer。

---

## 九、同步引擎

### 9.1 syncMcpProject

```
输入：projectRoot, options?: { cascadeDisabledMcps? }
流程：
  1. withCapabilityLock(projectRoot) 内执行
  2. 读全局 + 项目 capabilities.json
  3. 差集计算：新增 / 删除 / 配置更新
  4. 有 mcpServerOverride 的条目 → 跳过
  5. 写入项目 capabilities.json
  6. 更新 mcpSync state
输出：{ added, removed, updated, skipped, syncedHash }
```

### 9.2 syncMcpAll

```
输入：无
流程：
  1. 读全局 capabilities.json，构建 globalDisabledMcps
  2. 从 GovernanceRegistry 加载所有项目
  3. 对每个项目调 syncMcpProject（传入 cascadeDisabledMcps）
  4. 跳过不存在的 stale 注册项
输出：{ projects: [{ path, result | skipped }], summary }
```

### 9.3 级联规则

| 全局操作 | 无 override 项目 | 有 override 项目 |
|---|---|---|
| 新增（仅保存） | 不级联 | 不级联 |
| 新增（保存并同步） | 写入 entry，blockedCats=[] | 写入 entry，blockedCats=[] |
| 全局启用/禁用 | 仅写全局 globalEnabled，不级联 | 仅写全局 globalEnabled，不级联 |
| 删除 | 删除 entry | 删除 entry（override 随 entry 删） |
| 修改配置 | 更新 mcpServer | **跳过** → 漂移提示 |
| 新增成员 | 不动 | 完全禁用的 → blockedCats 加新成员 |

---

## 十、插件 MCP

- 插件新增 MCP → 调用 `POST /api/capabilities/mcp/install`（`pluginId` 标记）
- 插件删除 MCP → 调用 `DELETE /api/capabilities/mcp/:id`（级联所有项目）
- 插件 MCP 标记 `pluginId`：Console 禁止编辑、不允许项目级 override
- 插件 env 注册时 `sensitive: true`（默认掩码）

---

## 十一、Scope 外（P3 / defer）

| 项 | 原因 |
|---|---|
| Claude/Codex CLI 原生配置同名冲突检测 | 实践中极少发生，先不做 |
| `skipUntilNext` 漂移忽略 | 见 §6.5，根据实际需求决定是否实现 |
| Thread 级别漂移通知 | 新建对话时检测 skill/MCP 配置漂移并在聊天窗提示同步，当前 PR 不做 |
| MCP marketplace 集成 | 独立 Feature |
| MCP 版本锁定 / 生态治理 | F146 范畴 |

---

## 十二、Acceptance Criteria

### Phase A（数据模型 + 同步引擎）
- [x] `globalEnabled` 在所有 capability entries 上统一使用，旧 `enabled` init 时一次性迁移
- [x] `blockedCats` 按项目按猫控制 MCP
- [x] `resolveServersForCat(config, catId)` 两参数形式，单一项目配置，无 global+project 合并
- [ ] `syncMcpProject` / `syncMcpAll` 工作正常
- [ ] 有 override 的项目被级联跳过

### Phase B（漂移检测 + API）
- [ ] 3 种 issue type 正确检测
- [ ] `drift-check` / `drift-resolve` / `sync-all` 接口工作
- [ ] `PATCH scope=project` 正确写 blockedCats
- [ ] `GET /api/mcp/:id/tools` 延迟加载工作

### Phase C（前端 UI）
- [ ] 双 tab + ProjectSelector 切换正常
- [ ] McpDriftBanner / AllProjectsSyncBanner 显示正确
- [ ] env sensitive 掩码 toggle 正常
- [ ] 项目覆盖编辑 + 恢复全局配置正常
- [ ] 新增同名校验拦截
- [ ] MCP 列表加载不触发工具探测
- [ ] 弹窗内工具延迟加载

### Phase D（插件 + 固化）
- [ ] 插件 MCP 走统一接口，级联正常
- [ ] 插件 MCP 禁止项目 override
