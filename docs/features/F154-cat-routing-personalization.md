---
feature_ids: [F154]
related_features: [F078, F032, F127, F134, F142]
topics: [routing, connector, ux, personalization]
doc_kind: spec
created: 2026-04-09
community_issue: "clowder-ai#385, clowder-ai#391"
---

# F154: Cat Routing Personalization — 全局默认猫 + 首选猫入口 + 单次定向

> **Status**: done | **Owner**: Ragdoll | **Priority**: P2
> **Completed**: 2026-04-12

## Why

team experience（2026-04-09）：
> "这个应该和 #385 的 issue 联合立项，是一个完整的东西"
> "他的飞书那样用，那我们应该自己思考，除了飞书呢？在猫猫咖啡里面如何设定，以及如何知道这个 thread 的首选猫是谁？"

社区 issue #385 原话：
> "把'无历史时谁来接第一棒'的全局默认回复猫做成可配置项"

社区 PR #391 解决的痛点：
> 飞书群聊里 @mention 体验差（要从列表选人、容易选错），需要 @-free 的猫猫路由方式

当前状态：
- `preferredCats` **已存在**于 Thread model（F032-b），Hub 端有 `ThreadCatSettings.tsx` popover 可设置
- `AgentRouter` 已实现完整路由链：`@mention → last-replier(scoped to preferredCats) → first preferred → default cat`
- **但**：Connector 端（飞书/微信）无法设置/查看 preferredCats；全局默认猫 hardcoded（`getDefaultCatId()` = `breeds[0]`）；Hub 端缺少明显的"当前首选猫"指示器

## What

### Phase A: Connector 首选猫入口 + 全局默认猫可配置 ✅

**A1 — Connector 命令**：
- `/focus <猫名>` — 设置当前 thread 的 preferredCats 为**单只猫**（复用现有 `threadStore.updatePreferredCats`）
- `/focus` — 查看当前 thread 的首选猫
- `/focus clear` — 清除首选猫设置，回到全局默认
- `/ask <猫名> <消息>` — 单次定向：把这条消息发给指定猫，不改变 preferredCats。**必须走正常 ConnectorRouter → append → route 流程**，禁止旁路 invokeTrigger（KD-4）

**A2 — 猫名解析**：
- 以 `catRegistry` 为猫名真相源（F127 动态别名），不硬编码静态文件
- `normalizeCatId(input)` 查 catRegistry aliases + displayName partial match
- **冲突策略**：多猫匹配同一输入时（如前缀重叠），返回候选列表并拒绝执行（"找到多只匹配的猫：opus, opus-45，请输入更精确的名字"），禁止猜测命中
- 不可路由的猫返回明确错误（"该猫当前不可用"）

**A3 — 全局默认猫可配置**：
- `GET/PUT /api/config/default-cat` — 运行时修改全局默认猫（member overview 面板入口）
- `getDefaultCatId()` 优先读运行时配置，fallback 到 `breeds[0]`
- **权限**：修改全局默认猫需 owner 权限（与 member overview 页面现有权限一致），非 owner 调用返回 403
- **MVP 路径**：Phase A 仅通过 Hub API（member overview 入口）修改，不提供 connector `/config set` 命令（避免群聊权限篡改风险）。Connector 端全局配置入口视需求放入后续 Phase（KD-7）

### Phase B: Hub 可见性 + UX 统一 ✅

**B1 — Thread Header 首选猫 Pill 指示器**（Siamese UX 设计）：
- Thread header 右侧显示 Pill 组件：`[🐱 猫头像 猫名 ▾]`，点击展开 CatSelector popover（复用 `ThreadCatSettings`）
- 无首选猫时 Pill 不渲染（零空间占用），有首选猫时 Pill 内含猫猫品种色带（与猫猫主题色一致）
- Pill 状态反映实时 preferredCats：Hub/Connector 任一端修改后 Pill 实时更新
- 首次设置首选猫时显示 alias teaching tooltip："你也可以在飞书/微信中用 `/focus 猫名` 来切换哦"

**B2 — Member Overview 默认猫卡片选择器**（Siamese UX 设计）：
- 猫猫管理 / member overview 页面用猫猫卡片网格（而非下拉菜单）展示可选默认猫
- 当前默认猫卡片高亮 + "默认" badge；点击其他卡片切换（二次确认）
- 卡片含：猫头像 + 名字 + 品种色带 + 在线状态
- 清晰标注影响范围："新 thread 没有历史时，默认由这只猫回复"
- **实现参考**：社区 PR `clowder-ai#419`（评估结论：问题 welcome，PR as-is 不 merge，但以下设计可参考）
  - Resolver 分离：考虑将 `getDefaultResponderCatId()` 从通用 `getDefaultCatId()` 拆出，避免"默认回复猫"配置影响 reviewer-matcher / invocation 等其他 fallback 场景
  - Config 持久化：Phase A 的 `setRuntimeDefaultCatId()` 是内存变量（重启丢失），B2 必须解决。参考 PR 的 config schema + PATCH endpoint + 3-tier fallback 路径

**B3 — Connector 可见性**：
- `/status` 输出增加"首选猫"信息
- `/commands` 列表包含 `/focus` `/ask`

## Acceptance Criteria

### Phase A（Connector 入口 + 全局默认猫）
- [x] AC-A1: 飞书/微信 connector 中 `/focus opus` 设置 thread preferredCats，`/focus` 查看，`/focus clear` 清除
- [x] AC-A2: `/ask opus 帮我看代码` 单次定向发消息给 opus，不改变 preferredCats
- [x] AC-A3: 猫名解析使用 catRegistry aliases，不硬编码；不可路由猫返回错误
- [x] AC-A4: `getDefaultCatId()` 支持运行时配置覆盖 `breeds[0]` 默认值；修改需 owner 权限，非 owner 返回 403
- [x] AC-A5: 路由优先级链精确语义不变：`@mention → preferredCats scope 内 last healthy replier → first preferred → getDefaultCatId()`；preferredCats 是候选范围（candidate scope），不是直接优先级
- [x] AC-A6: `/focus` `/ask` 有单元测试覆盖（含 stale cat fallback、persistence 不可用场景）
- [x] AC-A7: 猫名解析冲突时返回候选列表并拒绝执行，禁止猜测命中；exact alias match 优先于 partial displayName match

### Phase B（Hub 可见性 + UX）
- [x] AC-B1: Thread header 显示当前首选猫（头像 + 名字），无首选猫时不显示
- [x] AC-B2: Member overview 有全局默认猫选择器
- [x] AC-B3: `/status` 输出包含首选猫信息
- [x] AC-B4: Hub 和 Connector 设置的 preferredCats 实时同步（同一个 thread model）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "在猫猫咖啡里面如何设定（首选猫）" | AC-A1, AC-B1 | connector 输入 + Hub UI 截图 | [ ] |
| R2 | "如何知道这个 thread 的首选猫是谁" | AC-B1, AC-B3 | Hub header 截图 + /status 输出 | [ ] |
| R3 | #385 "全局默认回复猫做成可配置" | AC-A4, AC-B2 | member overview 截图 + API 测试 | [ ] |
| R4 | #391 "飞书 @mention UX conflict" | AC-A1, AC-A2 | connector 端实际输入测试 | [ ] |
| R5 | "除了飞书呢？" — 跨 surface 统一 | AC-A5, AC-B4 | Hub + connector 同一 thread 状态一致 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F032（Agent Plugin Architecture — preferredCats 基础设施）
- **Evolved from**: F078（Smart Routing — 路由优先级链）
- **Related**: F142（Connector Slash Commands — `/focus` `/ask` 使用 F142 框架注册）
- **Related**: F127（猫猫管理重构 — 动态别名，猫名解析复用 aliases）
- **Related**: F134（飞书群聊 — @mention UX 痛点来源）

## Risk

| 风险 | 缓解 |
|------|------|
| preferredCats 存了 stale/disabled 猫 | 路由时必须过 `filterRoutableCats`（AgentRouter 已实现），UI/connector 查询时也标注状态 |
| 全局默认猫改动影响所有新 thread | UI 明确标注影响范围；设置需二次确认 |
| Hub 和 connector 设置冲突 | 同一个 thread model，最后写入者覆盖；UI 实时刷新 |
| 猫名解析歧义导致误路由 | 冲突时拒绝执行 + 返回候选列表（KD-8）；exact alias 优先于 partial match |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不挂 F142（已关闭），独立立项 F154 | F142 是框架，F154 是产品能力；路由优先级变更超出"加命令"范畴 | 2026-04-09 |
| KD-2 | 联合 #385 + #391 概念，跨 surface 统一设计 | team lead："除了飞书呢？在猫猫咖啡里面如何设定？" | 2026-04-09 |
| KD-3 | 猫名解析复用 catRegistry aliases，不硬编码 | 与 F127 动态别名方向一致；社区 PR 的硬编码方式不可维护 | 2026-04-09 |
| KD-4 | `/ask` 必须走正常 ConnectorRouter → append → route 流程，禁止旁路 invokeTrigger | 安全边界：invokeTrigger 绕过 ACL / rate-limit / audit trail；Maine Coon P1 review | 2026-04-09 |
| KD-5 | v1 `/focus` 仅支持单猫，多猫语法暂不实现 | 技术上 preferredCats 是数组，但 UX 复杂度不值得 MVP 投入；Maine Coon P2 review | 2026-04-09 |
| KD-6 | 全局默认猫 MVP 为 system-global（非 per-user），长期可扩展为 per-user | #385 原话 "from the member overview" 暗示全局；MVP 简单，后续按需加 per-user 层 | 2026-04-09 |
| KD-7 | Phase A 全局默认猫仅通过 Hub API（owner 权限）修改，不提供 connector `/config set` 命令 | 群聊 connector 无权限模型，任何成员可执行 = 配置篡改风险；Maine Coon P1 review | 2026-04-09 |
| KD-8 | 猫名解析冲突时拒绝执行 + 返回候选列表，禁止猜测命中 | partial match 歧义会导致误路由，用户应看到候选并精确选择；Maine Coon P2 review | 2026-04-09 |
| KD-9 | Phase B 设计先看现场再画 | 凭想象画设计稿导致与实际 ChatContainerHeader 严重冲突，触发 Design in Context 流程护栏补充 | 2026-04-10 |
| KD-10 | Phase B 先做桌面端，移动端退化策略记为 known limitation | 顶栏 ThreadIndicator 在手机上已很长（thread 标题 + 项目名），加 Pill 会挤爆。退化方案：窄屏隐藏 Pill（用 sidebar ThreadCatSettings 操作）、中屏只显色点不显猫名 | 2026-04-12 |

## Review Gate

- Phase A: Maine Coon review（路由语义 + 安全）
- Phase B: Siamese design review（UX）+ Maine Coon code review
