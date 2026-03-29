---
feature_ids: [F142]
related_features: [F088, F127, F132, F137]
topics: [connector, slash-command, extensibility]
doc_kind: spec
created: 2026-03-27
---

# F142: Connector Slash Commands — 跨平台 /slash 扩展框架

> **Status**: done | **Owner**: Ragdoll | **Priority**: P2

## Why

team experience（2026-03-27）：
> "跨平台的 slash，因为在自己家里似乎用不到 slash，有什么直接抓你这大头猫问问不就好了？所以我们 scope 得收敛一下？家里什么可视化界面都有，slash 用的比较少，但是在飞书、微信的时候有的时候就可能需要的？"

Hub 有完整可视化界面（侧边栏、面板、命令速查），slash 命令是锦上添花。但在飞书/微信/Telegram 等纯文字 IM connector 里，**slash 是唯一的结构化交互入口**——用户没有 UI 可以点击，只能打字。

当前问题（Maine Coon review 发现）：
1. **Registry 与执行漂移**：`command-registry.ts` 注册了 25+ 命令，但 connector 侧 `ConnectorCommandLayer` 只实现了一小部分；部分命令（如 `/game status`、`/game end`）注册了但无 handler
2. **双轨分裂**：Web 端 `useChatCommands` 和 Connector 端 `ConnectorCommandLayer` 是两套独立系统，无统一命令注册/冲突策略
3. **无扩展机制**：加命令 = 手改代码，不支持 skill/MCP 动态注册
4. **关键命令缺失**：`/commands`（列出可用命令）、`/cats`（查看猫猫）、`/status`（thread 概览）在 connector 端都没有

## What

### Phase A: 漂移清理 + Connector 核心命令

**Scope 边界：不给 Web 端加新功能/新类型定义。A0 允许碰 Web `command-registry.ts` 做减法（删幽灵命令），但不加新字段/新命令。`useChatCommands` 不碰。**

**A0 — 注册表漂移清理（前置，仅减法）**：
- 从 `command-registry.ts` 删除幽灵命令（注册了但 Web/Connector 均无 handler 的，如 `/game status`、`/game end`）
- 在 connector 侧加注册表-执行器一致性测试（声明的命令必须有可执行的 handler）
- 目标：建立"声明 = 可执行"基线

**A1 — 3 个 connector 核心命令**：
- `/commands` — 列出当前 connector 可用的所有 slash 命令（含用法和描述）
- `/cats` — 查看当前 thread 的猫猫（已加入 + 可调度但未加入 + 不可调度）
- `/status` — thread 概览（标题、创建时间、参与猫数、最近活跃）

**A2 — 聚合 API**：
- `GET /api/threads/:id/cats` — 返回结构化猫猫数据（含 connector binding owner 权限校验）
- `/cats` 口径绑定现有路由逻辑：`routableNow = registeredService ∩ isCatAvailable`（复用 `AgentRouter` + `cat-config-loader`）

**返回结构**：
```typescript
{
  participants: CatActivity[];       // 已加入 thread 的猫（含最近活跃时间）
  routableNow: CatSummary[];         // 当前可调度（有 service + available）
  routableNotJoined: CatSummary[];   // 可调度但未加入当前 thread
  notRoutable: CatSummary[];          // 已注册但 available=false（忙闲细分见 OQ-2）
  routingPolicy: string;             // 当前路由策略（round-robin/preferred/etc）
}
```

### Phase B: Skill 声明式命令注册 + 统一解析

**Scope：命令扩展框架 + `surface` 维度 + 解析器统一。**

1. **命令注册统一**：
   - `CommandDefinition` 增加 `surface: 'web' | 'connector' | 'both'` + `source: 'core' | 'skill' | 'mcp'` 字段
   - 冲突规则：`core > skill > mcp`，同级禁止重名
   - `GET /api/commands?surface=connector` — 返回按 surface 过滤的命令列表

2. **Skill 命令声明**（走现有 manifest/capabilities 链路，不直接扫 SKILL.md）：
   - `manifest.yaml` 新增 `slashCommands` 字段（zod schema 校验：命令名 `/^\/[a-z][a-z0-9-]{1,30}$/` + 可选 `subcommands: string[]`、描述长度上限 200 字符、纯文本）
   - 后端启动时通过现有 capabilities 扫描机制发现 → 注册到统一命令表
   - 执行统一走服务端命令网关，不允许前端直拼 skill 调用
   - 启动缓存 + 文件变更增量刷新，禁止每次输入触发磁盘扫描

3. **统一命令解析器**：
   - 最长匹配 + 参数切分，替换当前混用的 `isCommandInvocation` / `startsWith`
   - Connector 和 Web 共用解析器，handler 按 surface 分发

4. **可观测性**：
   - 每次 slash 执行打审计事件（命令名、来源 surface/source、耗时、成功/失败）

## Acceptance Criteria

### Phase A（漂移清理 + Connector 核心命令）
- [x] AC-A1: 飞书/Telegram connector 中输入 `/commands` 返回当前 connector 可用命令的文字列表
- [x] AC-A2: `/cats` 在 connector 中返回：participants（已加入）+ routableNow + routableNotJoined + notRoutable（available=false），口径 = `registeredService ∩ isCatAvailable`
- [x] AC-A3: `/status` 在 connector 中返回 thread 标题、创建时间、参与猫数、最近活跃时间
- [x] AC-A4: 清理幽灵命令（`/game status`、`/game end` 等，仅从 registry 删除，不加新条目），注册表-执行器一致性测试通过
- [x] AC-A5: `GET /api/threads/:id/cats` 聚合 API 可用，返回上述结构
- [x] AC-A6: `/api/threads/:id/cats` 有 connector binding owner 权限校验（thread participants 是猫 ID 非人类用户），非授权请求返回 403
- [x] AC-A7: `/cats` 口径绑定 AgentRouter 现有逻辑，有快照测试覆盖
- [x] AC-A8: 现有 connector 命令（`/where` `/new` `/threads` `/use`）行为无回退

### Phase B（Skill 声明式注册 + 统一解析） ✅
- [x] AC-B1: `manifest.yaml` 支持 `slashCommands` 字段，后端启动时通过 capabilities 链路自动发现并注册
- [x] AC-B2: skill 命令不能覆盖 core 命令（冲突即拒绝注册 + 启动告警日志）
- [x] AC-B3: `slashCommands` 字段 zod 校验：命令名白名单正则 + 可选 subcommands 数组、描述长度上限 200 字符、纯文本（禁止 HTML/脚本注入）
- [x] AC-B4: skill 命令执行统一走服务端命令网关，禁止前端直接拼 skill 调用绕过权限
- [x] AC-B5: 命令发现使用启动缓存 + 文件变更增量刷新，不在每次输入时触发磁盘扫描
- [x] AC-B6: 统一命令解析器替换现有混合解析方式，有解析器单元测试
- [x] AC-B7: slash 执行审计事件（命令名、surface、source、耗时、成功/失败）可在日志中追溯
- [x] AC-B8: `CommandDefinition` 包含 `surface` + `source` 字段，`/commands` 按 surface 过滤

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "查询有什么 /slash" | AC-A1 | connector 端实际输入测试 | [x] |
| R2 | "查询某个 thread 现在有多少猫猫可以使用（已加入）以及可调度的猫猫" | AC-A2, AC-A5, AC-A7 | connector 端实际输入 + API 快照测试 | [x] |
| R3 | "支持自定义 /slash" | AC-B1 | manifest 声明命令 → connector 可用 | [x] |
| R4 | "通过插件或容易的方式集成" | AC-B1, AC-B2 | 写 manifest 即扩展，无需改核心代码 | [x] |
| R5 | scope 收敛到 connector 端（飞书/微信） | AC-A8, AC-B8 | Hub 无变化，connector 有增强 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）— N/A，本 feature 无前端 UI 改动

## Dependencies

- **Evolved from**: F088（Multi-Platform Chat Gateway — connector 基础设施）
- **Related**: F127（猫猫管理重构 — `/cats` 命令数据源）
- **Related**: F132（钉钉/企微 — 更多 connector 平台受益）
- **Related**: F137（微信 — 更多 connector 平台受益）

## Risk

| 风险 | 缓解 |
|------|------|
| Skill 命令与 core 命令冲突/劫持 | core > skill 优先级 + 冲突检测 + 拒绝注册 + 启动告警 |
| ConnectorCommandLayer 改动影响现有飞书/Telegram | Phase A0 先清理漂移建基线，A1 增量添加 + 回归测试 |
| `/cats` 数据准确性（猫状态是动态的） | 口径锚定 `AgentRouter.isCatAvailable`，不另造计算逻辑 + 快照测试 |
| 新 API 数据泄露（thread 猫列表） | `/api/threads/:id/cats` 强制 connector binding owner 权限校验 |
| Skill 元数据注入（命令名/描述含恶意内容） | zod schema 校验 + 白名单正则 + 纯文本 |
| 命令发现磁盘扫描频繁导致性能抖动 | 启动缓存 + 增量刷新，不随输入实时扫描 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Scope 收敛到 connector 端，Hub 端不动 | team lead明确：家里有 UI，slash 主要用在飞书/微信 | 2026-03-27 |
| KD-2 | 扩展机制选 Skill 声明式（不是 MCP 优先） | 90% 扩展需求是 skill 驱动，已有 manifest/capabilities 链路 | 2026-03-27 |
| KD-3 | 命令注册增加 surface 维度（Phase B） | 避免"注册了但当前入口不能用"的用户困惑（Maine Coon建议） | 2026-03-27 |
| KD-4 | Phase A 不给 Web 端加新功能/新类型，A0 仅允许减法（删幽灵命令） | Maine Coon v2 P1：A0 清理碰 registry 跟"不碰 Web"矛盾，明确只做减法 | 2026-03-27 |
| KD-5 | `/cats` 口径锚定 AgentRouter 现有逻辑 | Maine Coon P1：不另造计算口径，绑定 `registeredService ∩ isCatAvailable` | 2026-03-27 |
| KD-6 | Skill 命令走 manifest/capabilities 链路 | Maine Coon P2：已有元数据扫描机制，不直接解析 SKILL.md 避免双份解析器 | 2026-03-27 |
| KD-7 | API 权限用 connector binding owner（非 thread participant） | Maine Coon v3 P1：thread participants 是猫 ID 非人类用户，权限校验应绑 binding owner | 2026-03-27 |
| KD-8 | Skill 命令声明支持 subcommands 数组 | Maine Coon v3 P2：单段正则无法覆盖 `/xxx yyy` 多段命令风格 | 2026-03-27 |
| KD-9 | notRoutable 不区分忙/闲，仅反映 available=false | Maine Coon v3 P2：上游 status API 仍是占位值，忙闲拆分等上游就绪（OQ-2） | 2026-03-27 |

## Review Gate

- Phase A: Maine Coon review（已深度分析现状 + connector 双轨架构）
- Phase B: Maine Coon review + team lead确认扩展机制
