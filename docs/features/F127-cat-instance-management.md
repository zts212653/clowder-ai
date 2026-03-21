---
feature_ids: [F127]
related_features: [F062, F061, F004, F033, F051]
topics: [hub, template, cat-management, account-profile, runtime, antigravity]
doc_kind: spec
created: 2026-03-18
community_issue: "#109"
---

# F127: 猫猫管理重构 — 账户配置与猫猫实例分离，支持动态创建猫 + 自定义别名 @ 路由

> **Status**: design-approved | **Owner**: 金渐层 + 缅因猫 GPT-5.4
> **Issue**: #109
> **UX Wireframe**: `docs/designs/F127/F127-hub-ux-wireframe.pen` (7 screens)

## Why

当前问题：
1. **账号配置硬编码**: `provider-profiles.ts` 只支持 Anthropic，无法管理 Codex/Gemini/任意 API Key 账号。
2. **模板和运行时真相源混淆**: `cat-config.json` 实际承担了“模板”和“运行时事实源”两种角色，导致运行时动态创建/编辑猫猫没有干净落点。
3. **配置分散**: Session 策略、Codex 推理参数散落在不同 Tab，不在成员详情页统一管理。
4. **别名路由固定**: `mentionPatterns` 写死在静态配置里，无法动态调整 @ 路由。
5. **Antigravity 没有显式特例位**: 它走 CDP bridge，不依赖账号凭证，但当前模型把所有成员都当成普通账号驱动成员。

## What

分 4 个 Phase 实施，从账号抽象到运行时成员目录，再到 Hub UI 重组：

- **Phase A**: 账号配置泛化（内置 OAuth + API Key CRUD + `provider` 绑定）
- **Phase B**: Runtime Cat Catalog 域（`cat-template.json` bootstrap + `CatCatalogStore` + `ResolvedCatCatalog`）
- **Phase C**: 动态别名路由 + 自动补全
- **Phase D**: Hub UI CRUD 重组（成员协作 Tab 重构 + Antigravity 特例）

## Iron Laws (不可变约束)

> 这些约束在整个 F127 实施过程中不可违反。

### IL-1: `cat-template.json` 只作为模板
Repo 根的 `cat-template.json` 是受版本控制的模板文件，只用于首次 bootstrap 或人工 reset。

运行时不再把它当作热路径事实源，也不保留 `cat-config.json` 兼容读写。

### IL-2: 运行时成员真相源单独落盘
运行时成员目录统一持久化到 `.cat-cafe/cat-catalog.json`。

`ResolvedCatCatalog` 以 runtime catalog 为主，再叠加少量 volatile runtime 状态；不再依赖“模板 + overlay diff”双读模型。

### IL-3: 成员绑定具体 `provider`，不是 `authType`
成员配置必须显式选择具体 provider（provider 名称或唯一 id），例如 `Claude (OAuth)`、`Codex (OAuth)`、`Gemini (OAuth)`、`Name1 (API Key)`、`Name2 (API Key)`。

`authType` 仅作为账号自身元数据（`oauth` / `api_key`），不再作为成员侧外键。

成员解析规则：
- 普通成员：`(client, provider, model)` 必须完整且自洽。
- `model` 必须属于所选 provider 的 `models[]`。
- `provider` 必须能唯一定位到一条账号配置。

### IL-4: Owner 不可创建或删除
`cat-template.json` 中的 `owner` seed（ME/铲屎官）只可编辑，不可创建或删除。

在总览页以金色边框 + 🔒 徽标显示在首位。

### IL-5: 运行时持久化即时生效
所有配置修改在运行时即时生效，并自动持久化。重启后自动恢复。

- 环境变量修改 → 回填 `.env`
- 成员/别名/高级参数/Antigravity bridge 参数 → 持久化到 `.cat-cafe/cat-catalog.json`
- API Key 凭证 → 持久化到 `.cat-cafe/provider-profiles.secrets.local.json`（gitignored）

### IL-6: Antigravity 是特殊成员通道
Antigravity 不参与账号配置 CRUD，也不选择 OAuth / API Key。

它的成员侧配置是：
- `commandArgs`
- `defaultModel`

其运行依赖 CDP bridge，而不是账号 profile。

## Client → 账号来源矩阵

| Client | 可选账号来源 | 成员侧字段 | 说明 |
|--------|-------------|-----------|------|
| Claude | `Claude (OAuth)` + 任意 API Key provider | `provider` + `model` | OAuth 为内置 provider，API Key 可多 provider |
| Codex | `Codex (OAuth)` + 任意 API Key provider | `provider` + `model` | OAuth 为内置 provider，API Key 可多 provider |
| Gemini | `Gemini (OAuth)` + 任意 API Key provider | `provider` + `model` | OAuth 为内置 provider，API Key 可多 provider |
| OpenCode / Dare / 其他 | 任意 API Key provider | `provider` + `model` | 无内置 OAuth |
| Antigravity | 不走账号配置 | `commandArgs` + `defaultModel` | CDP bridge 特例 |

**注意**:
- 成员侧 UI 不再暴露 `Auth Type` 选择器。
- Provider 下拉展示为具体 provider 标签，例如 `Claude (OAuth)`、`Codex (OAuth)`、`Gemini (OAuth)`、`Name1 (API Key)`。
- `authType` 只在账号配置页作为只读 badge 展示，不再参与成员级绑定。

## Hub 命名变更

| 原名 | 新名 | 层级 |
|------|------|------|
| 猫猫与协作 | 成员协作 | 一级标题 |
| 猫猫总览 | 总览 | 二级标题 |
| 猫粮看板 | 配额看板 | 二级标题 |
| 新建猫猫 | 添加成员 | 操作按钮 |
| 猫猫配置 | 成员配置 | 二级标题 |

## Screen 设计 (7 screens in .pen file)

### Screen 1: Hub 结构变化 (`QDkZp`)
命名变更 5 行 + 配置收敛说明 + 模板/运行时分离说明 + F127 不改的部分。

### Screen 2: 总览 — 摘要卡片模式 (`9mNrc`)
- Owner/ME 卡片在顶部，🔒 徽标 + 金色边框，只可编辑不可创建删除
- 每只成员一张卡片：名称、Client、账号/桥接信息、模型、别名标签、状态徽标
- Antigravity 卡片显示 `commandArgs` 摘要 + `defaultModel`
- 默认显示基于 install.sh 结果（Claude/Codex/Gemini）和 runtime catalog 的可用成员
- "＋ 添加成员" CTA 按钮

### Screen 3: 成员配置 — 编辑 (`gxiRW`)

**身份信息** (9 字段):
| 字段 | 类型 | 说明 |
|------|------|------|
| Name | 文本 | 合并 name + displayName |
| Nickname | 文本 | 如 "宪宪" |
| Description | 文本 | 原 roleDescription |
| Avatar | 缩略图 + 上传 | 圆形缩略图 + "点击上传新头像覆盖"（不显示文件名） |
| Background Color | 色块 + 调色盘 | 两个色块(primary/secondary) + "点击调色盘"（不显示 hex 编码） |
| Team Strengths | 文本 | |
| Personality | 文本 | |
| Caution | 文本 | 空时斜体占位符 |
| Strengths | 标签选择 | 紫色 chip + "选择" 按钮 |

**Voice Config**: 折叠区域，提示“需对接和启用语音功能后才支持配置”

**账号与运行方式**

普通成员 (3 字段, 仅选择):
| 字段 | 交互 | 说明 |
|------|------|------|
| Client | 下拉选择 ▾ | Claude/Codex/Gemini/OpenCode/Dare/Antigravity/... |
| Provider | 下拉选择 ▾ | 具体 provider 标签（如 `Claude (OAuth)` / `Name1 (API Key)`） |
| Model | 下拉选择 ▾ | 从所选 provider 的 `models[]` 列表中选择 |

Antigravity 特例 (2 字段, 仅 Client=Antigravity 时显示):
| 字段 | 交互 | 说明 |
|------|------|------|
| CLI Command | 文本/Token 编辑器 | 传给 `antigravity` CLI 的命令/参数，默认值来自 `cat-template.json` |
| Model | 文本 + 建议值 | CDP bridge 启动后的默认模型 |

⚠️ 约束：
- 普通成员必须显式绑定 `provider`，不再通过 `Auth Type` 推断。
- 切换 provider 后，模型列表立即按该 provider 的 `models[]` 重算。
- Antigravity 隐藏 provider 选择器，直接显示 `CLI Command + Model`。
- “认证凭证”的新增和编辑统一在“账号配置”中完成；Antigravity 不在此列。

**别名与 @ 路由**: 默认含 `@catId`，可添加自定义别名，唯一性校验自动进行。前端自动 `@` 仅提示每个成员的首个 mention；后续别名仍可在路由解析时生效，但不进入前端提示列表。

**高级运行时参数** (11 项):

通用参数 (8 项):
| 字段 | 类型 | 交互方式 |
|------|------|---------|
| Max Prompt Tokens | 数值 | 输入框 |
| Max Context Tokens | 数值 | 输入框 |
| Max Messages | 数值 | 输入框 |
| Max Content Length Per Msg | 数值 | 输入框 |
| Session Chain | 枚举 | 下拉选择 ▾ (`true` / `false`) |
| Session Strategy | 枚举 | 下拉选择 ▾ (`handoff` / `compress` / `hybrid`) |
| Session Warn Threshold | 百分比 | 拖动滑条 + 场景提示（⚡ context 填充到此比例时前端弹出警告） |
| Session Action Threshold | 百分比 | 拖动滑条 + 场景提示（🔥 context 填充到此比例时触发策略动作） |

Codex 专属参数 (3 项, 仅 Client=Codex 时显示):
| 字段 | 类型 | 可选值 |
|------|------|--------|
| Codex Sandbox 🏷️ | 枚举 | `read-only` / `workspace-write` / `danger-full-access` |
| Codex Approval 🏷️ | 枚举 | `untrusted` / `on-failure` / `on-request` / `never` |
| Codex Auth Mode 🏷️ | 枚举 | `oauth` / `api_key` / `auto` |

**持久化说明**: 橙色 banner “💾 运行时持久化 — 所有配置修改在运行时即时生效，并自动持久化到 `.cat-cafe/cat-catalog.json` 文件”

### Screen 4: 添加成员 (`HEhjg`)
普通成员流程：Step 1 选择 Client → Step 2 选择 Provider → Step 3 选择 Model。

Step 1 的 Client 选项分两行展示，避免 pill 越界：
- 第一行：Claude / Codex / Gemini
- 第二行：OpenCode / Dare / Antigravity

Antigravity 流程：Step 1 选择 Client=Antigravity → Step 2 配置 CLI Command（默认值来自 `cat-template.json`）→ Step 3 选择 Model。

完成后跳转到成员配置页做进一步调整。

### Screen 5: 配额看板 (`Th7Yk`)
- **按账号配置维度归类**（不按 Provider 或成员分）
- OAuth 额度组：Claude 订阅 / Codex 订阅 / Gemini 订阅
- API Key 额度组：各 API Key 账号独立
- Antigravity 单独一组 bridge 卡片，不混入账号池
- **每个额度池反向显示关联成员标签**（紫色 chip）
- 默认关闭（需 `QUOTA_OFFICIAL_REFRESH_ENABLED=1`）

### Screen 6: 账号配置 (`N1EAh`)
- Filter tabs: 全部 / Claude OAuth / Codex OAuth / Gemini OAuth / API Key
- **3 个内置 OAuth provider**（`Claude (OAuth)` / `Codex (OAuth)` / `Gemini (OAuth)`）: 🔒 内置标识，不可新增或删除，只能管理支持的模型列表和激活状态
- **API Key provider**: 可新增/编辑/删除。每个 provider 持有：
  - `provider`
  - `displayName`
  - `authType=api_key`
  - `baseUrl`
  - `models[]`
- “＋ 新建 API Key 账号”按钮（仅支持新建 API Key 类型）
- Antigravity 不出现在此页，由成员配置页单独处理
- Secrets 存储: `.cat-cafe/provider-profiles.secrets.local.json`（gitignored, worktree 间共享）

### Screen 7: 环境 & 文件 (`upDmY`)
- 环境变量从只读改为可编辑，保存后自动回填 `.env`
- **不包含认证凭证**（API Key 等统一走“账号配置”）
- 敏感变量 masked 显示
- 文件区显式展示：
  - `cat-template.json`（只读模板）
  - `.cat-cafe/cat-catalog.json`（运行时成员真相源，只读展示/可跳转）
  - 其他数据目录

## Phase 实施计划

### Phase A: 账号配置泛化
**目标**: 把 `provider-profiles` 从 Anthropic-only 扩展到通用 provider 配置模型，并让成员侧绑定 `provider`。

**当前代码状态**:
- `provider-profiles.types.ts`: `ProviderProfileProvider = 'anthropic'`（硬编码）
- `provider-profiles.ts`: Anthropic-only CRUD + `modelOverride`
- `provider-profiles.ts` / probe route: 只会用 Anthropic 风格 header 做连通性测试
- `HubProviderProfilesTab.tsx`: Anthropic-only UI

**改动范围**:
1. 用通用 provider 配置替换当前 `ProviderProfile` 心智模型，核心字段为 `provider` / `displayName` / `authType` / `models[]` / `builtin`
2. 内置 OAuth 三项固定为 `Claude (OAuth)` / `Codex (OAuth)` / `Gemini (OAuth)`
3. API Key provider 支持任意 `displayName` + `baseUrl`
4. 成员配置从“选择 `authType`”改为“选择 `provider`”
5. 账号配置 Tab 与 probe/test 路由按账号类型重写
6. Antigravity 明确排除在账号配置系统外

### Phase B: Runtime Cat Catalog 域
**目标**: 把 repo 模板与运行时成员目录彻底拆开。

**当前代码状态**:
- `cat-config-loader.ts` 默认读取 repo 根 `cat-config.json`
- 多处 UI / 文档仍把 `cat-config.json` 当成运行时事实源

**改动范围**:
1. `cat-config.json` 一次性重命名为 `cat-template.json`
2. 不保留 `cat-config.json` 兼容读取、双写或迁移桥
3. 新增 `CatCatalogStore`: 文件持久化到 `.cat-cafe/cat-catalog.json`，保存完整运行时成员目录
4. bootstrap / reset 时从 `cat-template.json` 导入初始数据
5. `ResolvedCatCatalog` 统一读取 runtime catalog，并负责与 `ConfigStore` 的少量 volatile 状态对接
6. AgentRegistry reconcile: runtime catalog 里的新增成员自动注册到 AgentRegistry

**不改动**:
- `CatRegistry` 保持 append-only
- `ConfigStore` 现有 14 个 hot-updatable keys 继续存在，后续再收敛

### Phase C: 动态别名路由 + 自动补全
**目标**: 让 @ 路由从运行时成员目录读取，而不是只读模板。

**改动范围**:
1. 别名存储: runtime catalog 中的 `mentionPatterns`
2. 唯一性校验: 全局别名不可重复
3. 前端自动补全: 输入 `@` 时仅从 `ResolvedCatCatalog` 拉取每个成员的首个 mention
4. 路由解析: 消息发送时仍从 `ResolvedCatCatalog` 查找全部 mentionPatterns

### Phase D: Hub UI CRUD 重组
**目标**: Hub 命名变更 + 成员配置统一表单 + 添加成员流程 + Antigravity 特例。

**改动范围**:
1. 成员协作 Tab 组重命名
2. 总览卡片模式：Owner 在首位 + 成员卡片 + 添加成员 CTA
3. 成员配置统一表单：身份 + 账号/桥接配置 + 别名 + 高级参数一站到位
4. 添加成员双分支流程（普通成员 / Antigravity）
5. Session 策略 + Codex 推理参数合并到成员配置页
6. 配额看板按账号配置维度展示，并为 Antigravity 保留独立 bridge 区
7. 环境变量可编辑 + 文件区明确展示模板与运行时目录

## Code Debt to Clean Up (F127 顺手清理)

| Item | 位置 | 说明 |
|------|------|------|
| `codex.execution.model` | `ConfigStore.ts` L86-89 | 注册了但运行时无消费者，`CodexAgentService` 用 `getCatModel()` |
| `ProviderProfileProvider = 'anthropic'` | `provider-profiles.types.ts` | Phase A 直接替换为账号配置模型 |
| `DEFAULT_CAT_CONFIG_PATH` / `CAT_CONFIG_PATH` 命名 | `cat-config-loader.ts` / `env-registry.ts` | Phase B 一次性改成 template/runtime 语义 |
| 77 个 `process.env` 触点 | 散布各处 | 不在 F127 全量迁移，后续 feature 处理 |

## Explicitly NOT Doing

1. ❌ 不做统一 `config.json + secrets.local.json` 大合并
2. ❌ 不做 `cat-config.json` 的兼容双读、双写或迁移桥
3. ❌ 不做 `CatRegistry` 直接可写
4. ❌ 不做 77 个 `process.env` 触点的全量系统配置清理（deferred）
5. ❌ 不做 OpenCode / Dare 的 install.sh 支持（当前只有 Claude / Codex / Gemini）
6. ❌ 不把 Antigravity 硬塞进账号配置抽象里

## Dependencies

- **F062**: Provider Profile Hub（Phase A 在 F062 基础上泛化为账号配置）
- **F061**: Antigravity 接入（特殊 bridge 通道约束来自 F061）
- **F004**: Runtime Config（`ConfigStore` 机制继续使用）
- **F033**: Session Strategy Configurability（Session 策略参数合并到成员配置页）
- **F051**: Real Quota Dashboard（配额看板按账号维度重组）

## Risk

| 风险 | 级别 | 缓解 |
|------|------|------|
| `cat-config.json → cat-template.json` 一次性改名波及面大 | High | repo-wide grep + loader/tests/UI 一起改，不保留旧名 |
| Provider 配置与成员绑定关系写歪 | High | `provider` 唯一定位校验 + `model ∈ provider.models[]` 校验 |
| 运行时 catalog 并发写入 | Medium | 单进程文件锁 + write-through cache |
| 别名冲突 | Low | 全局唯一性校验 + 创建时 pre-check |
| install.sh 结果与 template/runtime catalog 不一致 | Medium | 总览默认只显示 install 结果，未安装的标为 unavailable |
| Antigravity 特例与通用成员表单分叉失控 | Medium | 单独 UI 分支 + 单独测试覆盖 |

## Timeline

Phase A → B → C → D 顺序实施，每个 Phase 独立可验证、可合入 main。
