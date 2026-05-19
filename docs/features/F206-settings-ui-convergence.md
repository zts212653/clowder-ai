---
feature_ids: [F206]
related_features: [F190, F199, F056, F155]
topics: [console, settings, frontend, components, primitives, convergence, outbound-sync]
doc_kind: spec
created: 2026-05-18
---

# F206: Settings UI Convergence — 组件语言归一

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1

## Why

team experience（2026-05-18）：
> "人家的每个按钮的画风统一，我们的不统一……到底为什么我们不统一做了那么多定制"
> "先归一再全量同步……不能5-7天太慢了，社区分叉更大更难合并了"

PR #1758 完成了颜色 token 迁移（hex→semantic），但组件级视觉语言仍碎片化。本 feat 解决结构层归一，完成后才做全量 outbound sync 到开源。

三猫共识（opus-46 + opus-47 + codex）：**归一 ≠ 砍功能学开源**。开源一致是因为功能简单，我们要"功能保留 + 抽象到 primitives"。

## What

### Phase A: Settings Primitives + 4 页面归一 ✅

1. **定义 7 个 Settings Primitives**（`packages/web/src/components/settings/primitives/`）：

| Primitive | 收口问题 |
|-----------|---------|
| `SettingsSection` | section 容器统一（标题+描述+内容） |
| `SettingsRow` | 成员卡/账户行/Skill 行统一：左 icon + 中 title/meta/badges + 右 action |
| `SettingsCard` | 卡片变体（default/highlight），消除 Owner 粉色 vs 普通灰底随机差异 |
| `SettingsFilterTabs` | 成员/Skill/系统三处各自实现的筛选 tabs 收口 |
| `SettingsStatusStrip` | Skill 绿色状态条 + 系统配置绿色提示条收口（info/success/warn/error） |
| `SettingsBreadcrumb` | 账户+系统各自一套面包屑 → 统一轻量 context line |
| `SettingsField` | 表单字段包装（input/toggle/select），内联编辑风格统一 |

2. **迁移 4 高定制页面**（保留全部功能，换 primitives）：
   - **成员管理**：Owner 改 SettingsRow + Owner badge（不要大粉卡），保留筛选/Session Chain/@ 路由
   - **账户与密钥**：默认折叠 SettingsRow 显示"类型 · N models"，展开后编辑 chips
   - **Skill 管理**：保留搜索/分类/状态条，但 row+toolbar 对齐 SettingsRow
   - **系统配置**：右侧提示块改 badge/inline hint，breadcrumb 改 SettingsBreadcrumb

### Phase B: 8 页适配 + Enforcement + 验收 ✅

1. **8 低定制页面适配**：换 SettingsSection/SettingsRow 包装（不主动重构功能）
2. **Enforcement**：
   - `settings/` 目录 Biome lint rule 限制 raw Tailwind atomic class
   - PR checklist 新增 Settings primitive 检查项
3. **重跑截图对比**，确认 12 页视觉节奏一致
4. 全量 outbound sync 准备就绪

### Phase C: Console 非 Settings 页面视觉对齐 ✅

team lead 2026-05-18 反馈：重启 runtime 后发现 Signals 等非 Settings 页面样式与开源差距大。

1. **Signals 列表样式对齐开源**：布局从卡片式改紧凑行式，Tier badge 修复（`text-[11px]` + `shrink-0 whitespace-nowrap` 防圆形溢出），功能保留（批量操作/学习次数/笔记等）
2. **Mission Hub 去重**：对话侧栏顶部 Mission Hub 卡片去掉（左侧导航已有入口）
3. **侧栏导航图标加 tooltip**：hover 显示功能名称（对话/记忆/Mission Hub/信号等）

## Acceptance Criteria

### Phase A（Primitives + 4 页面归一）
- [x] AC-A1: 7 个 primitives 组件创建并 export，有 TypeScript 类型约束（实际产出 20+ primitives）
- [x] AC-A2: 成员管理页使用 SettingsRow/SettingsFilterTabs/SettingsCard，功能无损
- [x] AC-A3: 账户与密钥页使用 SettingsRow（折叠态），展开编辑模型 chips 功能保留
- [x] AC-A4: Skill 管理页使用 SettingsRow/SettingsStatusStrip/SettingsFilterTabs，功能无损
- [x] AC-A5: 系统配置页使用 SettingsField/SettingsStatusStrip/SettingsBreadcrumb，功能无损
- [x] AC-A6: 4 页面层 0 个 raw Tailwind atomic class（`bg-*`/`text-*`/`border-*`/`rounded-*`/`px-*`/`py-*`），raw class 只能存在于 primitives 内部
- [x] AC-A7: `pnpm test` + `pnpm check` 全绿

### Phase B（8 页适配 + Enforcement）
- [x] AC-B1: 8 个低定制页面使用合适 primitives 包装（Resource/List 类用 SettingsRow，非列表页用 SettingsSection，不强塞 row）
- [x] AC-B2: 编译期 enforcement 落地（Biome lint rule / TS contract 至少其一），PR checklist 作为加固而非替代
- [x] AC-B3: 新旧截图对比确认 12 页视觉节奏一致
- [x] AC-B4: Outbound sync 就绪（lint 通过 / 0 raw atomic class in page layer / 12 页截图复测一致），sync 动作本身独立 close

### Phase C（Console 非 Settings 视觉对齐）
- [x] AC-C1: Signals 列表样式对齐开源（紧凑行布局 + Tier badge 不溢出 + 间距统一），功能无损
- [x] AC-C2: 对话侧栏 Mission Hub 卡片移除，左侧导航入口保留
- [x] AC-C3: 侧栏导航图标 hover 显示 tooltip（功能名称）

## Dependencies

- **Evolved from**: F190（Console Settings 骨架 intake）、F199（Settings parity audit）
- **Related**: F056（Console 底层）、F155（场景引导）

## Risk

| 风险 | 缓解 |
|------|------|
| Primitives 粒度不对（太粗/太细） | Phase A 先做 4 页验证，Phase B 再扩；不一口气抽所有变体 |
| 功能回归（迁移过程破坏现有交互） | 每个页面迁移后浏览器实测 golden path |
| 社区分叉持续扩大 | CVO 设定时间盒，快速路不走云端 review |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不走云端 review，opus coding + codex review + opus-47 愿景守护 | CVO directive：快速路，减少社区分叉。Guardian 47 是同 family (ragdoll) 不同个体（fallback path per 五条铁律 #2），CVO 指定。理想 cross-family 选项是 @gemini，本次因速度优先 + 47 未参与 review 而采用 fallback。 | 2026-05-18 |
| KD-2 | 归一 ≠ 砍功能学开源 | 开源一致是功能简单，我们要功能保留+抽象到 primitives | 2026-05-18 |
| KD-3 | 先归一再 outbound sync | 同步出去的代码是社区二次参考点，混乱版污染下游 | 2026-05-18 |

## Review Gate

- Phase A: codex 本地 review → opus-47 愿景守护（不走云端）
- Phase B: codex 本地 review → opus-47 愿景守护（不走云端）
- Phase C: codex 本地 review → opus-47 愿景守护（不走云端）
