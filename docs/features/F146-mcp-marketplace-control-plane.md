---
feature_ids: [F146]
related_features: [F041, F043, F129, F142, F145]
topics: [mcp, marketplace, plugin, connector, capability-center]
doc_kind: spec
created: 2026-03-28
---

# F146: Capability Marketplace Control Plane — 一键接入 + 多生态聚合

> **Scope 扩展（2026-04-18 team lead拍板）**：不止 MCP，覆盖 plugin / skill / tool / connector。UI 标签"能力市场"。

> **Status**: in-progress | **Owner**: Maine Coon + Ragdoll | **Priority**: P1

## team lead愿景

> “我想问你，我们搞设计有什么 MCP？到时候你就可以直接去 Claude 官方的 Hub 市场、Codex 官方的市场、OpenClaw 的市场，一搜——哎，把官方推荐的、最不容易被下毒、最可靠的那些东西拉回来。”
>
> “以后我要新增一个 MCP，是跟你讲我想要一个怎么样的 MCP，然后你接入之后我能看到——不需要我人类自己去编辑。”
>
> “OpenClaw 一定得兼容，现在太火了。”
>
> “Connectors 比如 Figma 那种 app connector 也要。L1、L2、L3 都得做。”

**一句话**：team lead说一句自然语言需求，猫就能去多家市场搜索、比较、安全评估、一键拉回来安装——人类不碰 JSON、不碰命令行。

## Why

team lead诉求（2026-03-28）：

1. 不接受继续手改 `capabilities.json` 作为 MCP 新增主流程
2. 既然我们已有能力中心看板，就要支持”一键添加 MCP / 一键下线 MCP”
3. 希望接入多生态发现与分发，不只看本地配置：
   - Claude 生态
   - Codex 生态
   - OpenClaw / ClawHub 生态
   - Antigravity 生态
4. 架构分层要清楚：`L1 MCP`（执行层）/ `L2 Skills`（方法层）/ `L3 Plugins/Connectors`（分发层）
5. App connectors（如 Figma）也要纳入 L3 视野——不只是 MCP

F145 已经解决了”新机器可移植”和 `requires_mcp + doctor`，但还停在”声明式配置 + CLI 诊断”。F146 要补的是”能力中心的写路径 + 市场接入路径”。

## What

### 目标分层（固定）

- **L1: MCP 执行层（主干真相源）**
  - 统一登记 MCP server（stdio/remote）
  - 统一健康状态（ready/missing/unresolved/disabled）
  - 统一版本与来源策略（pinned/channel/source）
- **L2: Skills / workflows 方法层**
  - 只声明依赖（`requires_mcp`），不负责安装
  - 由能力中心根据 L1 状态提示“可用/缺失”
- **L3: Plugins / Connectors 分发层**
  - 负责发现、安装、认证、分发体验
  - 不是唯一真相源；最终回写 L1

### L3 内部状态模型（采纳云端有效建议）

L3 不直接写入 L1，内部拆成三个状态面：

1. `catalog_cache`：发现到的 marketplace 条目（可展示，不代表可执行）
2. `install_lock`：已安装/已固定版本的工件状态（不代表认证完成）
3. `binding_state`：授权/审批/绑定状态（不代表安装成功）

只有通过 Verify Gate 后，才把可执行能力回写到 L1。

### Phase R: Research Mode B（先收敛再动手）

在进入实现前，先完成一轮云端咨询调研，避免我们在“看起来相似”的生态接口上误判。

调研聚焦六个问题：

1. Claude / Codex / OpenClaw / Antigravity 的插件/连接器格式交集有多大
2. 哪些生态支持“程序化发布/安装 API”，哪些只支持 UI/CLI 手工路径
3. 能否安全地做统一 adapter（最小公共字段 + 各家扩展字段）
4. 供应链风险最小化策略（官方认证、签名、审核、安装门禁）
5. 外部文档 URL 有效性与内容一致性（防止基于失效链接立项）
6. F129 Pack 与 marketplace 条目模型如何一一映射（Pack 作为 L3 可分发单元）

产物：
- 跨生态 schema 对照矩阵
- adapter 可行性结论（直接可做 / 需降级 / 不建议）
- Phase A-B 的实现边界收敛稿
- F129 Pack ↔ Marketplace 条目映射契约（字段与 installPlan 对齐）

### Phase A: 能力中心写路径（One-click Add/Remove MCP） ✅

在 Hub 能力中心新增 MCP 管理能力：

1. 新增 MCP
   - 先 `install preview`（dry-run）展示变更
   - 模板添加（官方/内置推荐）
   - 自定义添加（命令/参数/env/remote URL）
2. 更新 MCP
   - 启用/禁用（已存在）
   - 升级版本（pinned → 新版本）
   - 修改 source（例如 npm → marketplace source）
3. 删除 MCP
   - 软删除（保留历史）
   - 硬删除（从声明态移除）

后端新增写 API（草案）：
- `POST /api/capabilities/mcp/preview`
- `POST /api/capabilities/mcp/install`
- `PATCH /api/capabilities/mcp/:id`
- `DELETE /api/capabilities/mcp/:id`

并发与一致性要求：
- 写入能力必须串行化（锁）或带版本号 CAS，避免双猫并发安装导致覆盖
- 所有写操作都通过同一编排入口，保证 `capabilities.json`、CLI 配置、probe 状态一致

### Phase B: Marketplace 聚合（4 生态）✅

**核心原则（Phase R 结论）**：搜索统一，安装分流。

- **L1 搜索层**统一返回四家 catalog 元数据
- **L2 安装层**按 `installPlan.mode` 四条通道分流：`direct_mcp | delegated_cli | manual_file | manual_ui`
- **L3 绑定层**按需加载安全字段（hash/policy/secret_refs）

**接入顺序（修正）**：Claude → Codex → OpenClaw → Antigravity(read-only)
- Codex 已确认 CLI + JSON-RPC 双通道，字段格式与 Claude 最接近
- OpenClaw bundle 一词多义需额外 adapter 逻辑，排在 Codex 后
- Antigravity 仍在 preview，先做 read-only adapter + manual handoff

**三层字段递增**：
- L1（搜索卡片）：artifact_kind, display_name, ecosystem, source_locator, trust_level, component_summary, transport, artifact_id — 8 个展示字段
- L2（安装）：+ version_ref, install_scope, tool_policy, installPlan — 加安装字段
- L3（绑定）：+ binding_snapshot_hash, policy_verdict, secret_refs, publisher_identity — 加安全字段

**Auth 不碰**——遇到需动态授权的包，生成带占位符的配置，Auth 交给引擎原生流。

**字段级映射不可行**——同名不同义（OpenClaw `mcp` 一词两义）、同厂不统一（`serverUrl` vs `httpUrl`）、字段拓扑不同（Codex 拆四份 env）。Adapter 必须按 `host_schema_family` 分模板。

统一输出模型：
- `packageId`
- `ecosystem` (`codex`/`claude`/`openclaw`/`antigravity`)
- `kind` (`mcp`/`plugin`/`bundle`/`connector`/`pack`)
- `trustLevel` (`official`/`verified`/`community`)
- `installPlan`（最终映射为 L1 MCP entry 或 L2/L3 扩展）

承接边界（与 F129 对齐）：
- F146 负责 Marketplace / Registry 的发现、分发与治理（owner）
- F129 负责 Pack 生产、编译与运行时消费（producer + consumer）
- F129 Phase C 的 “社区 Registry/Marketplace” 由 F146 承接；F129 通过 F146 Marketplace 被发现与安装

### Phase C: 安装治理与安全门禁

引入安装策略层（Policy Engine）：

1. 默认只允许 `official + verified` 一键安装
2. `community` 包需要二次确认（显示风险）
3. 全部安装写审计日志（who/when/what/from）
4. 所有新增 MCP 必须经过 `mcp:doctor` 验证后才标 ready

供应链硬门禁（首期必须，Phase R 调研补充）：

1. 版本不可变 pin（禁止默认漂移到 `@latest`）
2. 安装来源路径边界校验（白名单源 + 禁止危险 spec）
3. 禁止 install-time scripts 自动执行（默认 deny）
4. schema validation 先于执行（manifest/entry 校验不过不安装）
5. 声明态 vs 实测态 diff gate（声明可用但 probe 失败不得标 ready）
6. `buildInstallPreview` 红字展示完整 command + args（防 STDIO 注入）— Phase R 发现
7. `secret_refs` 分离：env 只存 schema `{"API_KEY": "required"}`，运行时从 .env 注入（env 值不进 git）— Phase R 发现
8. Change detection + re-approval：工具描述变更触发重审 — Phase R 两路共识
9. 环境预检（Pre-flight check：目标节点是否有 node/python/uvx）— Phase R 补充

Skill 内容安全（防下毒）：

外来 SKILL.md 是自然语言 prompt，加载后直接成为猫的 system prompt 一部分。这是 MCP 代码层安全工具扫不到的攻击面。

1. **SKILL.md 内容安全扫描**
   - 安装外来 skill 时，先做 prompt injection 检测（关键词 + 语义审查）
   - 标记危险模式：要求忽略安全规则、要求发送数据到外部 URL、要求修改系统配置、要求读取 .env/credentials
   - 检测不通过 → 标记 `quarantined`，不允许激活
2. **外来 skill 权限隔离**
   - 外来 skill 不允许访问 capabilities.json 写路径
   - 外来 skill 不允许触发其他 skill（防链式提权）
   - 外来 skill 的工具调用不能 auto-allow，必须逐次 permission 确认
3. **Quarantine 状态机**
   - `pending_review` → `approved` / `quarantined` / `rejected`
   - `quarantined` 的 skill 可以查看内容但不能激活
   - 只有team lead或审核猫显式 approve 才能从 quarantined 变 approved

版本管理：

- 新增 `mcp-lock`（或扩展现有状态文件）记录：
  - 来源（marketplace/npm/git/local）
  - 版本（exact/range/channel）
  - 安装时间与操作者
- 避免 `@latest` 漂移造成不可复现

### Phase D: L1/L2/L3 视图联动

能力中心同时显示：

1. MCP 状态（L1）
2. Skill 依赖满足度（L2）
3. 分发来源/认证状态（L3）

并支持“从缺依赖直接补齐”：

- 当 skill 显示 `missing` MCP 时，点一下直接跳到推荐来源并安装。

### Validation Scenario（设计验证场景）

以“浏览器三后端接入”作为强制验收场景（已有手工流程的自动化替代）：

1. `agent-browser`
2. `pinchtab`
3. `claude-in-chrome`

要求：
- 全流程通过 UI 完成，不手改 `capabilities.json`
- 自动同步 `requires_mcp` 依赖状态
- `mcp:doctor` 报告正确反映 ready/missing/unresolved
- 结果可回放（有审计记录）

## Acceptance Criteria

### Phase R（Research Mode B）✅
- [x] AC-R1: 形成 Claude/Codex/OpenClaw/Antigravity 四方 schema 对照表
- [x] AC-R2: 明确三类能力边界：可自动安装 / 需人工确认 / 仅可发现
- [x] AC-R3: 给出统一 adapter 最小字段集（必填）+ 各生态扩展字段（可选）
- [x] AC-R4: 形成”先做什么、不做什么”的实施收敛结论并回写 F146
- [x] AC-R5: 外部文档 URL 逐条验真（可访问 + 内容匹配），形成证据表
- [x] AC-R6: 形成 F129 Pack ↔ Marketplace 条目映射契约（kind/metadata/installPlan 对齐）

### Phase A（能力中心写路径）✅
- [x] AC-A1: Hub 可通过 UI 新增 MCP（无需手改 `capabilities.json`）
- [x] AC-A2: Hub 可通过 UI 删除 MCP，并触发配置重编排
- [x] AC-A3: 新增 MCP 后自动触发 `generateCliConfigs` + `mcp:doctor` 探测
- [x] AC-A4: 所有 MCP 写操作有审计日志（用户、时间、变更 diff）
- [x] AC-A5: 并发写入安全（锁或 CAS）可验证，双写场景不丢配置
- [x] AC-A6: `install preview` 可显示”将写入项 + 将触发探测 + 风险提示”，用户确认后才执行

### Phase B（Marketplace 聚合）✅
- [x] AC-B1: 支持统一搜索接口返回 Codex/Claude/OpenClaw/Antigravity 四方结果
- [x] AC-B2: 结果带 `trustLevel`，可按 `official/verified/community` 过滤
- [x] AC-B3: 能把 marketplace 条目映射成可执行 `installPlan`
- [x] AC-B4: 支持统一搜索接口返回 Antigravity 结果（至少 discovery + metadata）
- [x] AC-B5: Antigravity 结果与现有 `pencil` resolver 策略保持一致性（不互相冲突）
- [x] AC-B6: 统一搜索结果支持 `kind=pack`，可发现并安装来自 F129 产出的 Pack

### Phase C（治理与版本）✅
- [x] AC-C1: 默认策略阻止一键安装 `community` 包（需二次确认）
- [x] AC-C2: 安装后写入版本锁（source/version/channel）
- [x] AC-C3: `mcp:doctor` 能显示”已安装但未就绪”的具体原因
- [x] AC-C4: 禁止未通过 probe 的 MCP 直接显示 ready
- [x] AC-C5: 禁止 install-time scripts（除非显式审批）
- [x] AC-C6: 声明态与实测态出现 diff 时强制告警并阻断 ready
- [x] AC-C7: 外来 SKILL.md 安装时必须经过内容安全扫描（prompt injection 检测），不通过则标 `quarantined`
- [x] AC-C8: 外来 skill 权限隔离（不允许访问写路径、不允许触发其他 skill、工具调用需逐次确认）
- [x] AC-C9: quarantined skill 只有team lead或审核猫显式 approve 后才能激活
- [x] AC-C10: 外来 skill 安装时记录不可变指纹（source + version + hash/signature），运行前校验一致性，不一致自动降级 `quarantined`
- [x] AC-C11: 外来 skill 首次运行默认最小权限（dry-run/只读），涉及写文件、网络外发、高危工具必须二次确认
- [x] AC-C12: 一键 `revoke`（全端停用 + 清理挂载 + 禁止再次激活），60s 内传播到 Hub/CLI/connector 侧

### Phase D（联动体验）
- [ ] AC-D1: Skills 页可从 `requires_mcp missing` 直接发起补齐
- [ ] AC-D2: 能力中心可按 `L1/L2/L3` 分层过滤
- [ ] AC-D3: UI 中可追踪每个 MCP 的来源生态（Codex/Claude/OpenClaw/Antigravity）

## Dependencies

- **Evolved from**: F145（MCP portable provisioning + doctor）
- **Evolved from**: F041（能力中心看板）
- **Related**: F043（MCP 归一化 server split）
- **Related**: F129（Pack / plugin 生态边界）
- **Related**: F142（connector 命令可发现性与扩展机制）

## Risk

| 风险 | 缓解 |
|------|------|
| Marketplace API / schema 漂移 | 每个 adapter 单独版本化；增加 contract tests |
| 三家生态概念不一致（plugin/bundle/connector） | 统一中间模型，禁止 UI 直接耦合源字段 |
| 恶意包/供应链风险 | trustLevel 策略 + 安装审批 + 审计日志 + 默认 deny community auto-install |
| 自动安装破坏本机环境 | preview/install 两阶段，先 dry-run 显示变更 |
| 把 L3 当真相源导致状态漂移 | 明确”最终真相源只写 L1 capabilities” |
| Skill 下毒（SKILL.md prompt injection） | 内容安全扫描 + quarantine 状态机 + 外来 skill 权限隔离 |
| 低质量/冒充 skill（名字像官方但无关） | trustLevel 过滤 + community 二次确认 + 来源追踪 |
| 指纹漂移（安装后上游替换内容） | 运行前指纹校验 + 不一致自动 quarantine（AC-C10） |
| 撤销传播延迟（已判恶意但仍可运行） | revoke SLA 60s + 全端停用（AC-C12） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 立项必须覆盖 L1/L2/L3 三层，不做单层优化 | team lead明确要求“完整立项，不只一层” | 2026-03-28 |
| KD-2 | 以 L1 capabilities 为唯一真相源 | 避免 marketplace 状态与本地真实可用状态漂移 | 2026-03-28 |
| KD-3 | Phase A 先解决“手改 JSON”痛点，再做多生态聚合 | 先交付立即价值（一键添加） | 2026-03-28 |
| KD-4 | 三家生态先统一 discovery，再逐步统一 install | 降低首期复杂度与安全风险 | 2026-03-28 |
| KD-5 | Antigravity 不是“可选”，首期必须纳入 discovery 与一致性约束 | 我们已有活跃 `pencil` 生态，不能与 F145 resolver 脱节 | 2026-03-28 |
| KD-6 | Runtime Connect / OpenAI connectors 在本 feature 里降为 P2 | 对我们当前主路径不是首要堵点，避免 Phase A 扩 scope | 2026-03-28 |
| KD-7 | 承接 F129 的 Marketplace/Registry owner 职责，Pack 纳入 L3 分发统一模型 | 避免双 Feature 重复建设分发层，明确 owner/consumer 边界 | 2026-04-04 |
| KD-8 | 字段级直接映射不可行，Adapter 按 `host_schema_family` 分模板 | Phase R 发现同名不同义、同厂不统一、字段拓扑不同 | 2026-04-17 |
| KD-9 | 接入顺序修正：Claude → Codex → OpenClaw → Antigravity(read-only) | Codex CLI+JSON-RPC 双通道确认，字段与 Claude 最接近；OpenClaw bundle 语义歧义需额外 adapter | 2026-04-17 |
| KD-10 | Phase B 只做 MCP Server 类能力，Plugin/Skill 做 delegated 降级展示，Apps/Connectors 搁置 | Phase R 两路共识：四家仅 MCP 是公共交集 | 2026-04-17 |
| KD-11 | trust_level 分级不够用，必须加 version pin + hash + change detection + re-approval | Phase R 假设 5 被反对，两路+规范一致 | 2026-04-17 |
| KD-12 | 统一 Auth 握手明确搁置，交给各引擎原生流 | 鉴权生命周期异构，Phase R 两路共识 | 2026-04-17 |

## Review Gate

- Phase A: Maine Coon author + Ragdoll严格 review
- Phase B/C: 跨家族 review + 安全视角复核（至少一轮）
