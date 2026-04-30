---
feature_ids: [F179]
related_features: [F041, F092, F099, F102, F127, F163, F340]
topics: [console, architecture, settings, service-manifest, navigation]
doc_kind: spec
created: 2026-04-23
---

# F179: Console 功能体系重构

> **Status**: spec | Owner: 布偶猫/宪宪

## Why

Clowder AI console 经过 F001-F168 的迭代，功能越来越丰富，但信息架构出现了三个系统性问题：

1. **功能入口散乱**：6 套导航系统（顶栏/侧边栏头部/侧边栏主体/Hub 弹窗/独立页面/右侧面板）、38 个功能触点。同一功能有多个入口（如"记忆"有 3 处入口），"Hub" 一词被 4 个不同概念复用。新功能没有确定的"应该放哪里"的标准。

2. **配置散乱**：6+ 个配置文件（.env/cat-template.json/capabilities.json/credentials.json/accounts.json 等），仅 10 个键支持热更新但 UI 不标明哪些需要重启。连接器配置散落在 env-registry → allowlist → bootstrap → adapter 4 层。

3. **外部依赖不可管理**：语音（TTS/STT）、Embedding 模型、Playwright 等外部服务需要手动 SSH 安装/启停，console 无法感知它们的状态。

**设计目标**：用户对 Clowder AI 的所有功能管理都能在 console 页面完成，最多做一下重启。新增功能有明确的放置规范和依赖管理范式。

## What

### Phase 1: 信息架构重构（前端为主）

#### 1a. Activity Bar + 一级入口收敛

**Before**: 顶栏 7 按钮 + 侧边栏头部 4 按钮 + Hub 齿轮 + 8 条独立路由

**After**:
```
侧边栏 Activity Bar（固定 4 个一级图标）:
  💬 对话 → /                  核心工作区
  📡 信号 → /signals            收件箱 + 信号源管理
  🧠 记忆 → /memory             evidence feed + 搜索 + 状态
  ⚙️ 设置 → /settings           所有管理和配置

顶栏精简为操作栏（不做导航）:
  Logo | 线程标题 | 导出 | [语音伴侣(条件展示)] | 主题 | 通知角标
```

**移除**：
- 侧边栏 Bootcamp 按钮 → 降级到对话创建流程或设置
- 侧边栏 Memory Hub 按钮 → 被 Activity Bar 🧠 替代
- 侧边栏 IM Hub 按钮 → 被设置 → IM 对接替代
- 顶栏信号铃铛 → 被 Activity Bar 📡 角标替代
- 顶栏 Hub 齿轮 → 被 Activity Bar ⚙️ 替代
- 侧边栏 Mission Hub 大卡片 → 降级为对话列表上方小入口

**语音伴侣条件展示规则**：
- TTS/STT 服务健康检查通过，或 WHISPER_URL + TTS_URL 已配置 → 显示按钮
- 否则 → 隐藏

**路由重定向**：
- `/mission-control` → `/mission-hub`（已有）
- 旧书签和外部链接通过 Next.js redirect 兼容

#### 1b. Hub 弹窗 → /settings 独立路由页

**Before**: `CatCafeHub` 是 85vh 的模态弹窗，16 个 tab，modal-on-modal

**After**: `/settings` 独立路由页，VS Code 式布局（左侧分类导航 + 右侧详表）

```
/settings
├── 成员管理
│   ├── 猫猫总览（名册 + 排序 + 可用性 + 默认猫选择）
│   └── 成员编辑/新增（内联或侧栏展开，不再 modal-on-modal）
│
├── 账户与密钥
│   ├── API 密钥管理（credentials.json）
│   └── 账号注册表（accounts.json）
│   └── 实际存储路径展示（~/.cat-cafe/ 或 CAT_CAFE_GLOBAL_CONFIG_ROOT）
│
├── IM 对接
│   ├── 飞书（配置卡片：App ID/Secret/Token/模式 + 状态灯 + 测试连接）
│   ├── 钉钉（配置卡片）
│   ├── 企微（配置卡片）
│   ├── Telegram（配置卡片）
│   └── 微信（配置卡片）
│
├── Skill 管理
│   ├── Skill 市场（浏览 + 安装）
│   ├── 已安装 Skills（启用/禁用 + per-cat 开关 + 分类展示）
│   └── 外部依赖状态（通过 Service Manifest 内联展示）
│
├── MCP 管理
│   ├── MCP 市场（浏览 + 安装向导）
│   ├── 已安装 MCP
│   │   ├── 连接表单（参考 Codex 模式：STDIO/HTTP 切换）
│   │   │   ├── STDIO: name + command + args[] + env key-value pairs + working dir
│   │   │   └── HTTP: name + URL + Bearer token + custom headers
│   │   ├── 全局/per-cat 开关
│   │   ├── 内置 cat-cafe 回调 env（只读回显）
│   │   ├── 外部 MCP env 配置（可编辑 + 保存后自动 sync CLI 配置）
│   │   └── 连接状态（持续健康监控）
│   └── 外部依赖（playwright 等，通过 Service Manifest 安装/启停）
│
├── 插件/集成
│   ├── 已安装插件（GitHub PR Tracking、Email、Calendar 等）
│   │   ├── 启用/禁用开关
│   │   ├── 配置表单（per-plugin 参数）
│   │   └── 连接状态 + 最近同步时间
│   ├── 可用插件（浏览 + 安装）
│   └── 插件开发指南入口
│
├── 语音管理
│   ├── 服务状态（TTS/STT 健康检查，Service Manifest 内联）
│   ├── 术语纠正 + 内置词典
│   ├── 语言设置 + Whisper prompt
│   └── 模型管理（当前模型信息）
│
├── 系统配置
│   ├── 对话默认值（Bubble 展开策略：thinking/CLI 默认折叠或展开）
│   ├── A2A 设置（Agent-to-Agent 协作开关 + 策略）
│   ├── 记忆 F3-lite 配置（自动记忆、证据阈值等运行时参数）
│   ├── Codex 执行配置（代码执行沙箱策略、超时等）
│   └── 治理配置（Hyperfocus 刹车阈值、自动审批规则等）
│
├── 通知（Web Push 设置，原 PushSettingsPanel 不变）
│
└── 运维监控
    ├── 使用统计（原配额看板 + 工具统计合并）
    ├── 排行榜
    ├── 记忆索引状态（原 HubMemoryTab + IndexStatus）
    ├── 系统健康（治理看板 + Hyperfocus 刹车）
    ├── 审计日志
    ├── 命令速查
    └── 紧急救援（原布偶猫救援）
```

**组件复用策略**：
- 现有 Hub tab 组件（CatOverviewTab, HubCapabilityTab, HubEnvFilesTab 等）大部分可直接复用
- 改变的是容器（modal → page）和导航（accordion → 左侧固定导航）
- modal-on-modal 改为 inline 或 slide-over panel

### Phase 2: 配置体验升级（前后端联动）

#### 2a. 配置状态标签 + Pending Changes Banner

**后端改动**：`env-registry.ts` 每个变量声明增加元数据：
```typescript
{
  name: 'FEISHU_APP_ID',
  category: 'connector',
  group: 'connector-feishu',       // 新增：UI 分组
  restartRequired: true,           // 新增：是否需重启
  dependencies: ['FEISHU_APP_SECRET'], // 新增：关联变量
  // ...existing: sensitive, runtimeEditable, hubVisible, description, defaultValue
}
```

**前端改动**：
- 每个配置项展示状态标签：🟢 即时生效 / 🟡 需重启
- 修改了需重启项后，页面顶部出现 Pending Changes Banner：
  "X 项变更需要重启生效 [查看变更] [重启服务]"

#### 2b. 连接器独立配置卡片

每个 IM 平台（飞书/钉钉/企微/Telegram/微信）一个独立配置卡片：
- 包含该平台全部所需字段
- 连接状态灯 + 最后心跳时间
- 测试连接按钮
- 保存后明确提示"需重启连接器生效"

**后端**：新增 `/api/connectors/:platform/config` 统一接口。

#### 2c. 配置搜索

Settings 页面顶部 VS Code 式搜索框，跨所有分区搜索配置项。

#### 2d. 废弃配置清理

- 移除 `cat-config.json` 的 UI 引用（已被 cat-template.json + cat-catalog.json 替代）
- 审计 env-registry.ts 中 80+ 变量，标记废弃项
- 清理代码中残留的 20+ 处 cat-config.json 引用

### Phase 3: Service Manifest 框架（后端架构）

#### 3a. ServiceManifest 接口定义

```typescript
interface ServiceManifest {
  id: string;                    // 'whisper-stt'
  name: string;                  // 'Whisper 语音转写'
  type: 'python' | 'node' | 'binary';
  port?: number;                 // 9876
  healthEndpoint?: string;       // '/health' or URL

  prerequisites: {
    runtime?: string;            // 'python3.10+'
    venvPath?: string;           // '~/.cat-cafe/whisper-venv'
    packages?: string[];         // ['mlx-whisper', 'fastapi']
    models?: { name: string; size: string; autoDownload: boolean }[];
  };

  scripts: {
    install?: string;            // 'scripts/install-whisper.sh'
    start?: string;              // 'scripts/start-whisper.sh'
    stop?: string;               // 'scripts/stop-whisper.sh'
    uninstall?: string;
  };

  enablesFeatures: string[];     // ['voice-input', 'connector-stt']
  configVars: string[];          // ['WHISPER_URL', 'NEXT_PUBLIC_WHISPER_URL']
}
```

#### 3b. 已知服务注册

| Service ID | Name | Port | 使用方 |
|-----------|------|------|--------|
| `whisper-stt` | Whisper STT | 9876 | 语音输入, 连接器消息转写 |
| `mlx-tts` | MLX-Audio TTS | 9879 | 语音输出, 语音伴侣 |
| `llm-postprocess` | LLM 转写纠正 | 9878 | 语音转写后处理（可选）|
| `embedding-model` | Embedding 模型 | - | 记忆系统语义搜索 |
| `playwright` | Playwright | - | 浏览器自动化 MCP |

#### 3c. 后端 API

```
GET  /api/services                    → 所有注册服务 + 状态
GET  /api/services/:id/health         → 单个服务健康探测
POST /api/services/:id/install        → 触发安装脚本（异步任务）
POST /api/services/:id/start          → 启动服务
POST /api/services/:id/stop           → 停止服务
GET  /api/services/:id/logs           → 最近日志
```

#### 3d. 前端集成

Service Manifest **不是单独的设置页**，而是嵌入到各功能区域：
- MCP 管理 → 安装 playwright MCP → 内联展示 Service Manifest 安装状态
- 语音管理 → TTS/STT 服务状态卡片
- 记忆状态 → Embedding 模型状态
- 各处展示统一的服务状态灯：🟢 运行中 / 🔴 未运行 / 🟡 安装中

#### 3e. MCP 配置增强

- 安装后 env vars 可编辑（当前冻结），保存后自动 sync 到 4 个 CLI 配置文件
- 内置 cat-cafe MCP 的回调 env（CAT_CAFE_API_URL 等）只读回显
- 外部 MCP 的 env vars 可编辑（API key、模型 ID 等）
- 持续健康监控（60s 心跳）替代安装时一次性探测

### Phase 4: 新功能接入规范（输出标准）

#### 4a. Feature Placement Decision Tree

```
新功能上线：
├─ 用户每天用? → L1 Activity Bar（极慎重，当前仅 4 个）
├─ 管理/配置? → L2 /settings 分区
├─ 只读/分析? → L3 /settings 子 tab
└─ 特殊场景? → L4 独立路由

有外部依赖? → 注册 ServiceManifest，声明安装/启停脚本
有配置项? → env-registry 注册，标记 restartRequired + group
有 MCP? → 通过 MCP 管理安装，env vars 可编辑
有 IM 连接? → IM 对接分区添加配置卡片
```

#### 4b. 新扩展服务接入 SOP

1. 在 `service-manifests/` 目录创建 `{service-id}.json`
2. 编写安装/启停脚本放入 `scripts/`
3. 在 env-registry.ts 注册相关环境变量
4. 在对应的设置分区（MCP/Skill/语音/记忆）内联 Service Manifest 状态组件
5. 如果服务启用条件影响 UI 展示（如语音按钮），在前端添加条件判断

#### 4c. 新功能入口接入 SOP

1. 确定功能层级（L1-L4）
2. 如果是 L2，确定归属的 /settings 分区
3. 创建组件，复用 Settings 页面的布局框架
4. 在 settings 导航配置中注册新分区/tab
5. 不新增顶栏按钮或侧边栏按钮（除非经铲屎官批准升级为 L1）

## Acceptance Criteria

### Phase 1
- [ ] AC-1a: 侧边栏 Activity Bar 展示 4 个一级图标（对话/信号/记忆/设置），点击切换路由
- [ ] AC-1b: /settings 独立路由页替代 Hub 弹窗，左侧分类导航 + 右侧详表
- [ ] AC-1c: 移除顶栏信号铃铛、Hub 齿轮，移除侧边栏 Bootcamp/Memory Hub/IM Hub 按钮
- [ ] AC-1d: 语音伴侣按钮仅在 TTS/STT 服务可用时展示
- [ ] AC-1e: 现有 Hub tab 组件在 /settings 中正常渲染和交互
- [ ] AC-1f: 旧路由（/mission-control）重定向到对应新路由
- [ ] AC-1g: MCP 管理页面支持 STDIO/HTTP 双模式连接表单（参考 Codex 模式）
- [ ] AC-1h: 插件/集成页面展示已安装插件列表 + 启用/禁用 + 配置表单
- [ ] AC-1i: 系统配置页面展示运行时配置项（Bubble 默认值、A2A、记忆、Codex、治理）

### Phase 2
- [ ] AC-2a: env-registry 每个变量带 restartRequired 元数据，前端展示状态标签
- [ ] AC-2b: 修改需重启配置项后，页面顶部展示 Pending Changes Banner
- [ ] AC-2c: IM 连接器各平台独立配置卡片 + 状态灯 + 测试连接
- [ ] AC-2d: Settings 页面搜索框可跨分区搜索配置项
- [ ] AC-2e: cat-config.json 相关代码引用清理完毕

### Phase 3
- [ ] AC-3a: ServiceManifest 接口定义 + 至少 2 个服务注册（TTS/STT）
- [ ] AC-3b: /api/services/* API 支持查询状态/安装/启停/日志
- [ ] AC-3c: 语音管理页面内联展示 TTS/STT 服务状态和操作按钮
- [ ] AC-3d: MCP 安装后 env vars 可编辑，保存后自动 sync CLI 配置
- [ ] AC-3e: 内置 cat-cafe MCP 回调 env 只读展示

### Phase 4
- [ ] AC-4a: Feature Placement Decision Tree 文档化并纳入 SOP
- [ ] AC-4b: 新扩展服务接入 SOP 文档化
- [ ] AC-4c: 至少 1 个新功能（如 Embedding 模型管理）按新规范接入验证

## Dependencies
- F041 (能力中心): MCP/Skill 管理基础
- F099 (Cat Café Hub): 当前 Hub 组件可复用
- F102/F163 (记忆系统): 记忆索引状态展示
- F340 (配置架构清理): accounts/credentials 架构
- Issue #569 (知识库): 未来可能新增 L1 入口

## Risk
1. **Hub → Page 迁移**：Hub 弹窗允许边聊天边配置，改为独立页面后需确保快速返回对话的体验不退化
2. **配置热更新扩展**：连接器配置本身需要重启 Adapter 实例，不能伪装成热更新
3. **Service Manifest 安全**：subprocess 启停需要严格权限控制，避免命令注入
4. **组件复用度**：部分 Hub 组件深度耦合 modal 上下文（如 HubCatEditor），需要解耦

## Open Questions
1. 记忆和知识库（#569）是否最终合并为一个 L1 入口？—— 待 #569 spec 明确后决定
2. Mission Hub 降级后放在哪？—— 对话列表上方小入口 or /settings 子项？
3. /settings 页面是否需要保留一个"快速返回"齿轮按钮在顶栏？—— 待 Pencil 设计验证
4. 一键重启按钮的技术实现方式？—— 后端需要 graceful restart 机制
