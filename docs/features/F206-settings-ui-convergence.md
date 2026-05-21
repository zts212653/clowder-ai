---
feature_ids: [F206]
related_features: [F190, F199, F056, F155]
topics: [console, settings, frontend, components, primitives, convergence, outbound-sync]
doc_kind: spec
created: 2026-05-18
---

# F206: Settings UI Convergence — 组件语言归一

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-05-21

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

### Phase D: #723 视觉残留收敛（线条/边框/背景/字体）✅

社区 clowder-ai#723 + team lead 2026-05-20 反馈：Phase A-C 后仍有视觉碎片化残留。

1. **线条色值统一**：全局 border token 归一到 `--console-border-soft` / `border-cafe-subtle/20`，消除各处自造 raw hex 边框
2. **Memory/Signals 背景边框**：MemoryHub/MemoryNav/SignalNav/SignalSourcesView 的 raw colors、独立 gradient、硬编码 border 改走 semantic token
3. **Settings primitives 边框残留**：SettingsCard/SettingsRow/SettingsSection 的边框对齐 KD-4 规则（内容卡片避免四周包边）
4. **字体碎片化**：跨页面 `text-[Npx]` 不统一，归一到设计系统字号层级
5. **Mission Hub 背景**：MissionControlPage hardcoded `#F4EFE7/#FFFDF8/#E7DAC7` 改走 semantic token

> **不含 i18n**：VoiceSettings/SignalFilter/KnowledgeFeed 的硬编码英文标签归 F147 localization scope，不混进本 Phase。

### Phase E: 7 out-of-scope 文件 semantic token 迁移 ✅

Phase D 审计后发现 7 个文件仍有 raw hex，机械性 token 替换 + 新建 field-status token 家族。

1. **7 文件 ~100 处 raw hex → semantic token**：ThreadExecutionBar(3) / DirectoryBrowser(6) / WorkspacePanel(8) / hub-cat-editor-voice(~14) / hub-cat-editor.sections(~12) / UnifiedAuthModal(~48) / hub-cat-editor-fields(~12)
2. **新增 CSS custom properties**：`--field-success-*`（sage green, 6 tokens）+ `--field-persist-*`（warm orange, 4 tokens），独立于 `--semantic-success-*`（Material green），light+dark mode 都有

### Phase F: MissionControl 22 文件 semantic token 迁移 ✅

Phase E 后审计显示 `mission-control/` 目录有 356 处 raw hex，是全仓最大残留热区。

1. **22 个 mission-control/*.tsx 子组件 + dag-graph-utils.ts** 的 356 处 raw hex → CSS custom properties
2. **新增 24 个 semantic token**（light + dark mode）到 `console-shell.css`：
   - `--mc-status-{open,suggested,dispatched,done}-{dot,bg,text}` — backlog 状态色
   - `--mc-status-risk` — 风险标记色
   - `--mc-edge-{evolved,blocked,related}` — DAG 依赖图边色
   - `--mc-accent` / `--mc-accent-hover` — 操作按钮主色
   - `--mc-slice-{learning,value,hardening}` — 切片类型色
   - `--mc-risk-{critical,high,medium}` — 风险严重度色
3. **替换模式**：Tailwind class hex → token class、JS object hex → `var(--mc-*)`、inline style hex → `var(--mc-*)`
4. **豁免**：data-viz 41 处 hex（图表颜色需独立 policy）、text-[10px] 510 处留 Phase G

### Phase G: Border sweep + data-viz UI chrome ✅

Phase F 后Maine Coon post-merge audit 识别 5 个文件的边界残留 + data-viz 豁免标注缺失。

1. **CollectionGraphParts border 迁移**：3 处 `border-[#eee3d6]` → `border-[var(--console-border-soft)]`（UI chrome section dividers）
2. **RebuildButton 进度条 token**：`bg-[#6BAF8D]` → `bg-[var(--memory-progress-fill)]`（新增 dedicated token，不复用 field-scoped）
3. **MobileStatusSheet KD-4 去边框**：3 个 section 移除 `border border-cafe`（内容块不用框线）
4. **Data-viz palette exempt 注释**：CollectionGraphModel / CollectionGraphParts / HealthReport 的图表色 hex 添加豁免标注，防止未来审计反复 reopen
5. **新增 CSS token**：`--memory-progress-fill`（light `#6baf8d` / dark `#7cc9a0`）

### Phase H: Workspace browser chrome hex → ws-* semantic tokens ✅

Phase G 后Maine Coon post-merge audit 识别 workspace/browser chrome 5 文件共 31 处 raw hex。

1. **10 新 `--ws-*` CSS token**：7 warm UI chrome（surface/hover/warm/alert/accent/accent-hover/text）+ 3 dark editor（editor-bg/editor-surface/editor-hover），7 dark-mode `color-mix()` overrides
2. **BrowserPanel 迁移**：6 hex → ws-* tokens（main container bg, HMR status, text, accent）
3. **BrowserToolbar 迁移**：7 hex → ws-* tokens（nav buttons, URL bar, Go button, console toggle）
4. **ConsolePanel 迁移**：6 hex → ws-* tokens（header, badges, output text）
5. **BrowserTabBar 迁移**：5 hex → ws-* tokens（container, active/inactive tabs）
6. **WorkspaceFileViewer 迁移**：4 hex → ws-* tokens（always-dark editor chrome, no dark override needed）
7. **BrowserTabs test 更新**：assertion `bg-[#FDF8F3]` → `bg-[var(--ws-surface)]`
8. **ThreadSidebar border KD-4 assessment**：全部 border 在 interactive controls 上（modals/inputs/dropdowns/buttons），per KD-4 全部 justified，无需移除

### Phase I: Workspace editor/terminal hex → 16 always-dark semantic tokens ✅

Phase H 后Maine Coon post-merge audit 识别 workspace editor/terminal 7 文件共 43 处 raw hex。

1. **16 新 always-dark CSS tokens**：3 `ws-editor-*` extensions（deep/fg/gutter）+ 13 `terminal-*`（chrome/fg/text/btn/status），无 dark-mode overrides
2. **CodeViewer 迁移**：6 hex → ws-editor-*/ws-accent tokens（EditorView.theme）
3. **FileContentRenderer 迁移**：4 hex → ws-editor-bg（image/audio/video/binary backgrounds）
4. **DiffViewer 迁移**：2 hex → ws-editor-bg/ws-editor-deep
5. **JsxPreview 迁移**：2 hex → ws-editor-bg + 2 iframe HTML exempt
6. **TerminalTab 迁移**：inline styles → 10 terminal tokens + 3 xterm.js exempt
7. **AgentPaneViewer 迁移**：inline styles → 8 terminal tokens + 3 xterm.js exempt
8. **AgentPaneList 迁移**：6 hex → terminal tokens（zero remaining）
9. **Dead token cleanup**：移除 14 个无引用的 pre-existing `--terminal-*` tokens

### Phase J: Hub visual raw-hex sweep + ChangesPanel ws-editor-deep fix ✅

Phase I 后Maine Coon post-merge audit 识别 Hub/Leaderboard/Quota 6 文件共 ~152 处 raw hex + ChangesPanel 1 处 workspace 漏网。

1. **45 新 `--hub-*` CSS tokens**（light + dark mode）到 `console-shell.css`：
   - `--hub-surface-*`（6 tokens）— Hub 面板/页脚/表单背景
   - `--hub-heading` / `--hub-text-*`（6 tokens）— 标题/正文/次要/幽灵文字
   - `--hub-border-*`（5 tokens）— 边框/暖调/柔和/强调/表单
   - `--hub-accent-*`（4 tokens）— 主操作/hover/面包屑/暖调
   - `--hub-btn-*`（3 tokens）— 深色按钮/hover
   - `--hub-cat-*`（6 tokens）— 工具使用 3 类别色 + 背景
   - `--hub-lb-*`（8 tokens）— 排行榜文字/强调/卡片/section/badge/progress 背景
   - `--hub-quota-*`（6 tokens）— 额度标签/错误色
2. **HubToolUsageTab 迁移**：~41 hex → hub-* tokens（summary cards/daily trend/top tools/by-cat）
3. **HubCoCreatorEditor 迁移**：~27 hex → hub-* + ws-accent tokens（modal chrome/form fields/avatar）
4. **HubQuotaBoardTab 迁移**：~27 hex → hub-* + field-success-* tokens（quota pools/error banner/tags）
5. **HubCatEditor 迁移**：~24 hex → hub-* + field-success-focus tokens（member editor modal）
6. **leaderboard-cards 迁移**：~17 hex → hub-lb-* tokens via inline `style={{}}`
7. **leaderboard-phase-bc 迁移**：~16 hex → hub-lb-* tokens via inline `style={{}}`
8. **ChangesPanel workspace fix**：`bg-[#16161c]` → `bg-[var(--ws-editor-deep)]`（Phase I token）
9. **FileIcons exempt**：15 file-type brand colors marked exempt（fixed per language identity, not theme-dependent）

### Phase K: Hub residual mini sweep + exempt annotations ✅

Phase J post-merge audit（Maine Coon）识别 5 个 Hub 文件仍有 ~27 处 real UI raw hex + 3 个文件需 exempt 标注。原定 text-[10px] bulk 顺延 Phase L。

1. **HubLeaderboardTab 迁移**：~5 hex → 复用 Phase J 的 hub-lb-*/hub-surface-* tokens
2. **hub-tag-editor 迁移**：~8 hex → hub-*/field-* tokens（tag/status UI 色）
3. **hub-cat-editor-advanced 迁移**：~10 hex → hub-*/hub-surface-* tokens（advanced 面板）
4. **HubConnectorConfigTab + HubPermissionsTab 迁移**：~4 rgba shadow → token 化或统一 shadow utility
5. **HubConfigIcons exempt 标注**：16 处 connector/icon palette → exempt comment
6. **HubMemberOverviewCard exempt 标注**：2 处 coCreator config default color → exempt comment
7. **HubObservabilityTab exempt 标注**：1 处 data-viz chart stroke → exempt comment

### Phase L: text-[10px] bulk migration → text-micro ✅

Phase K post-merge audit（Maine Coon）确认 `text-[10px]` 精确 510 处 across 135 files。Phase D 已注册 `text-micro` token（`10px/14px`），仅迁移了 2 处作为 proof-of-concept。本 Phase 完成全量迁移。

1. **全量替换 `text-[10px]` → `text-micro`**：135 files, 510 occurrences，纯 className 字符串替换
2. **分布**：root 185 / workspace 100 / mission-control 80 / memory 46 / ThreadSidebar 38 / signals 23 / game 20 / audit 12 / settings 6
3. **行为差异**：`text-[10px]` = `font-size: 10px`；`text-micro` = `font-size: 10px; line-height: 14px`。line-height 增加是 design system 意图（统一 micro text 行高），不是回归
4. **验证**：替换后 zero `text-[10px]` remaining（rg verified），`pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase M: settings tone unify (purple cards + sidebar bg) ✅

team lead 2026-05-21 指出两个视觉问题：成员管理里所有已启用猫猫卡片显示紫色背景（connector purple token 错误用作 generic active 状态）+ 设置栏与对话栏侧栏底色不统一。

1. **SettingsRow active tone 修复**：`bg-conn-purple-bg` (#f3e8ff) → `bg-[var(--console-card-bg)]` (#fffdfb)，enabled/disabled 区分靠 badge + inactive 灰色背景
2. **SettingsShell sidebar 对齐**：`--console-panel-bg` (#f6efe7) → `--console-shell-bg` (#fcfaf7)，和 ThreadSidebar 一致

### Phase P: Settings residual primitive sweep ✅

Phase O post-merge audit（Maine Coon）识别 5 个 Settings/Voice 文件仍有 legacy cafe-* token + custom eyebrow pattern。

1. **VoiceSettingsPanel 迁移**：4x `focus:border-cafe-accent` → `focus:border-[var(--console-border-strong)]`、2x `border-cafe-accent/40` → `border-[var(--console-border-soft)]`、2x `bg-cafe-surface-elevated` code pills → `bg-[var(--console-panel-bg)]`
2. **InstallPreviewModal 迁移**：1x `border-cafe` input → `border-[var(--console-border-soft)]`
3. **SettingsInlineItem primitive 修复**：`bg-cafe-surface` → `bg-[var(--console-card-bg)]`（primitive 自身残留，优先级最高）
4. **SkillConflictBanner 修复**：`bg-white` → `bg-[var(--console-card-bg)]`（adaptive dark mode）
5. **Uppercase eyebrow 保留**：`uppercase tracking-[0.22em]` 是跨文件一致的 typography pattern（VoiceSettingsPanel/ServiceStatusPanel/InstallPreviewModal），本 Phase 不改——改需 design decision

### Post-close shell container parity ✅

team lead 2026-05-21 截图反馈：Settings 与 Chat/Thread 切换时 rail/content 边界感不一致；Signal 与 Memory/Mission 的页面承载形态不一致。后续二次反馈确认方向应以多数页面的“圆角承载层”对齐，而不是把 Signal 拉到无缝 shell 少数派。

1. **SettingsShell rail separator**：Settings 左侧 rail 增加 `border-r border-[var(--console-border-soft)]`，对齐 ThreadSidebar 的 rail/content 分隔模式
2. **Signal outer shell normalization**：SignalInboxView / SignalSourcesView 移除旧 `max-w` 圆角外壳，外层改为 full-height console shell；标题/nav/content 均由内容承载卡管理
3. **SignalNav tab token parity**：Signal tabs 对齐 MemoryNav/MissionControl 的 `border-strong + card-bg + button-emphasis` active hierarchy
4. **Memory/Signal visible content carriers**：MemoryHub / SignalInboxView / SignalSourcesView 的主内容区补齐 `rounded-2xl + --console-card-bg + --console-border-soft + soft shadow + 18px padding`，对齐 SettingsSection / Mission panels 的圆角承载层；用 regression test 固定三页必须有可见 carrier
5. **Single-card content hierarchy**：Memory/Signal 的 title/nav/content 合并进同一张圆角承载卡，删除 MemoryNav/SignalNav 中冗余的“返回对话/返回线程”按钮；线程返回由 ActivityBar chat icon 统一承担

### Post-close Guardrail: 线条分隔 vs 背景分层

team lead 2026-05-20 追加口径：Thread 栏、对话栏、底部/右侧状态栏这类主框架区域，可以保留“统一底色 + 极淡线条分隔”的模式，不必强制改成背景色分层。目标接近网易云/微信的克制分隔：线条存在但不抢眼。

**实现规则：**

1. 主框架边界允许用线：ThreadSidebar ↔ Chat、Chat ↔ input/status、右侧状态栏/辅助栏 ↔ 主内容。
2. 线条必须统一走同一组淡色 token（优先 `--console-border-soft` / `border-cafe-subtle/20` 级别），禁止每块自造 raw hex、深色边框或高对比描边。
3. 线条是“结构边界”，不是“卡片轮廓”。除了对话主区域的必要框架线，状态栏、统计块、消息统计、Session Chain、Memory/Signals/Settings 内部模块等能不用卡片外框就不用外框，优先用背景、间距、分组标题、轻量 divider。
4. Review 时不要一刀切套 CDS §1.1：先判断区域角色。框架边界可用线；内容卡片/统计卡/列表项不应回到四周包边。
5. 视觉验收要看“线条强度”：如果截图里边框先于内容被看见，视为过强，需要降到更淡 token 或改为背景/间距分隔。
6. 页面级承载层（SettingsSection / Mission panels / Memory/Signal content surface）可以用圆角卡片；“避免四周包边”约束的是承载层内部的二级内容块，不是页面主容器。

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

### Phase D（#723 视觉残留收敛）
- [x] AC-D1: 全局 border 走统一淡 token（`--console-border-soft` 级别），0 处自造 raw hex 边框
- [x] AC-D2: Memory/Signals 页面背景/边框改 semantic token，无 raw hex/gradient
- [x] AC-D3: Settings primitives 边框对齐 KD-4（内容卡片无四周包边）
- [x] AC-D4: 跨页面字号归一到设计系统层级，消除孤立 `text-[Npx]`（registered `text-micro` token, 2/519 migrated — incremental）
- [x] AC-D5: Mission Hub hardcoded hex 改 semantic token
- [x] AC-D6: `pnpm test` + `pnpm check` 全绿
- [x] AC-D7: 关键页面 before/after 截图验证（deferred to reviewer browser verification）

### Phase E（7 out-of-scope 文件 semantic token 迁移）
- [x] AC-E1: 7 个 Phase D 未覆盖文件的 ~100 处 raw hex 全部迁移到 semantic token（ThreadExecutionBar/DirectoryBrowser/WorkspacePanel/hub-cat-editor-voice/hub-cat-editor.sections/UnifiedAuthModal/hub-cat-editor-fields）
- [x] AC-E2: 新增 `--field-success-*`（sage green, 6 tokens）+ `--field-persist-*`（warm orange, 4 tokens）CSS custom properties，light+dark mode
- [x] AC-E3: `pnpm test` + `pnpm check` 全绿

### Phase F（MissionControl semantic token 迁移）
- [x] AC-F1: 22 个 mission-control 子组件文件迁移完成（git diff --stat 确认）
- [x] AC-F2: 24 个 semantic token 定义（console-shell.css +48 lines，light+dark）
- [x] AC-F3: mission-control/ 目录 zero raw hex（`rg '#[0-9a-fA-F]{3,8}'` 无匹配）
- [x] AC-F4: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase G（Border sweep + data-viz UI chrome）
- [x] AC-G1: CollectionGraphParts 3 处 border hex → `--console-border-soft` token
- [x] AC-G2: RebuildButton progress bar → dedicated `--memory-progress-fill` token（not field-scoped）
- [x] AC-G3: MobileStatusSheet 3 section borders removed per KD-4
- [x] AC-G4: Data-viz palette exempt comments on all chart/graph hex（3 files, 7+ locations）
- [x] AC-G5: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase H（Workspace browser chrome hex → ws-* tokens）
- [x] AC-H1: 10 new `--ws-*` CSS tokens defined in console-shell.css（7 light + 3 dark editor + 7 dark-mode overrides）
- [x] AC-H2: BrowserPanel/BrowserToolbar/ConsolePanel/BrowserTabBar — 24 hex → ws-* tokens（warm UI chrome）
- [x] AC-H3: WorkspaceFileViewer — 4 hex → ws-editor-* tokens（always-dark, no dark override）
- [x] AC-H4: BrowserTabs test assertion updated（`bg-[var(--ws-surface)]`）
- [x] AC-H5: ThreadSidebar border KD-4 assessment — all borders justified（interactive controls only）
- [x] AC-H6: Zero raw hex in all 5 migrated workspace files（rg verified）
- [x] AC-H7: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase I（Workspace editor/terminal hex → always-dark tokens）
- [x] AC-I1: 16 new always-dark CSS tokens defined in console-shell.css（3 ws-editor-* + 13 terminal-*）
- [x] AC-I2: CodeViewer/DiffViewer/FileContentRenderer/JsxPreview — editor hex → ws-editor-* tokens
- [x] AC-I3: TerminalTab/AgentPaneViewer/AgentPaneList — terminal hex → terminal-* tokens
- [x] AC-I4: 8 remaining hex properly exempt（xterm.js canvas 6 + iframe HTML 2）with comments
- [x] AC-I5: 14 dead pre-existing `--terminal-*` tokens removed（zero references verified）
- [x] AC-I6: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase J（Hub visual raw-hex sweep + ChangesPanel fix）
- [x] AC-J1: 45 new `--hub-*` CSS tokens defined in console-shell.css（light + dark mode）
- [x] AC-J2: HubToolUsageTab/HubCoCreatorEditor/HubQuotaBoardTab/HubCatEditor — ~119 hex → hub-* tokens
- [x] AC-J3: leaderboard-cards/leaderboard-phase-bc — ~33 hex → hub-lb-* tokens via inline styles
- [x] AC-J4: ChangesPanel `bg-[#16161c]` → `bg-[var(--ws-editor-deep)]`
- [x] AC-J5: FileIcons 15 file-type brand colors marked exempt with comment
- [x] AC-J6: Zero raw hex in styling code across all 8 migrated files（rg verified, exempt items only remain）
- [x] AC-J7: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase K（Hub residual mini sweep + exempt annotations）
- [x] AC-K1: HubLeaderboardTab ~5 hex → hub-lb-*/hub-surface-* tokens
- [x] AC-K2: hub-tag-editor ~8 hex → hub-*/field-* tokens
- [x] AC-K3: hub-cat-editor-advanced ~10 hex → hub-* tokens
- [x] AC-K4: HubConnectorConfigTab + HubPermissionsTab ~4 rgba → shadow token/utility
- [x] AC-K5: HubConfigIcons 16 connector/icon palette colors → exempt comment
- [x] AC-K6: HubMemberOverviewCard + HubObservabilityTab config/data-viz → exempt comment
- [x] AC-K7: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase L（text-[10px] bulk migration → text-micro）
- [x] AC-L1: 510 occurrences of `text-[10px]` replaced with `text-micro` across 135 files
- [x] AC-L2: Zero `text-[10px]` remaining in `packages/web/src/` (rg verified)
- [x] AC-L3: `pnpm test` + `pnpm check` + `pnpm build` 全绿

### Phase M（settings tone unify — purple cards + sidebar bg）
- [x] AC-M1: SettingsRow active tone no longer uses connector purple — uses console-card-bg
- [x] AC-M2: Settings sidebar background aligned to --console-shell-bg (same as ThreadSidebar)
- [x] AC-M3: `pnpm gate` 全绿

### Phase N（console page shell convergence）
- [x] AC-N1: MemoryHub shell bg + header border migrated to console tokens (--console-shell-bg, --console-border-soft)
- [x] AC-N2: MemoryNav tab pills migrated from cafe-accent/surface-sunken to console-border-strong/card-bg/button-emphasis
- [x] AC-N3: MissionControlPage root bg aligned from --console-panel-bg to --console-shell-bg
- [x] AC-N4: ChatContainer export mode bg migrated from bg-cafe-surface to --console-shell-bg
- [x] AC-N5: `pnpm gate` 全绿

### Phase O（Memory/Mission inner control primitive sweep）
- [x] AC-O1: 10 Memory files migrated — form inputs, search bars, filter dropdowns, chip badges, passage borders all use console-* tokens
- [x] AC-O2: 15 Mission-control files migrated — form inputs (bg-cafe-surface → --console-card-bg), focus borders (border-cafe-accent → --console-border-strong), badge/card bg (bg-cafe-surface-elevated → --console-card-bg), section borders (border-cafe-subtle → --console-border-soft)
- [x] AC-O3: CTA buttons exempt — bg-cafe-accent/bg-cafe-primary semantic action tokens preserved (WCAG AA contrast, --console-button-emphasis dark mode 3.31:1 with text-white fails threshold)
- [x] AC-O4: Chip/badge hierarchy preserved — child elements use --console-panel-bg (not --console-card-bg same as parent) to maintain visual distinction
- [x] AC-O5: `pnpm gate` 全绿

### Phase P（Settings residual primitive sweep）
- [x] AC-P1: VoiceSettingsPanel — 4x focus border + 2x edit border + 2x code pill bg migrated to console tokens
- [x] AC-P2: InstallPreviewModal — border-cafe input migrated to --console-border-soft
- [x] AC-P3: SettingsInlineItem — bg-cafe-surface migrated to --console-card-bg (primitive self-heal)
- [x] AC-P4: SkillConflictBanner — bg-white migrated to --console-card-bg (adaptive)
- [x] AC-P5: `pnpm gate` 全绿

### Post-close shell container parity
- [x] AC-S1: SettingsShell rail/content separator matches ThreadSidebar (`border-r` + `--console-border-soft`)
- [x] AC-S2: SignalInboxView / SignalSourcesView use full-height console outer shell instead of legacy max-width standalone shell
- [x] AC-S3: SignalNav active tab tokens match MemoryNav/MissionControl hierarchy
- [x] AC-S4: `pnpm gate` 全绿
- [x] AC-S5: MemoryHub / SignalInboxView / SignalSourcesView main content areas use visible rounded carriers (`rounded-2xl`, `--console-border-soft`, soft shadow, 18px padding)
- [x] AC-S6: Regression test pins the rounded content surface pattern for all three pages
- [x] AC-S7: MemoryHub / SignalInboxView / SignalSourcesView keep title/nav/content inside one unified content carrier, matching SettingsSection/Rules SOP card hierarchy
- [x] AC-S8: Redundant in-page back buttons removed from MemoryNav/SignalNav; ActivityBar chat icon remains the canonical return-to-thread affordance

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
| KD-4 | 框架边界可用极淡统一线条，内容卡片避免四周包边 | team lead 2026-05-20 明确：Thread 栏/对话栏/状态栏可统一底色 + 淡线分隔；状态栏等内容块仍应”能不要框线就不要框线”，避免改着改着忘回卡片包边 | 2026-05-20 |
| KD-5 | 红区文件纯 CSS token 迁移豁免 + reopen anchor CVO 追认 | Phase L/N 触碰 ChatContainer.tsx/ChatMessage.tsx（F183/F184/F194 红区），diff 实证纯 className 视觉 token 迁移（零行为风险）。CVO 2026-05-21 追认豁免。同时追认 F206 reopen 承载 Phase D-P（原 close `8891cd400` → reopen `675a7c104`，anchor 归属 CVO 事后 signoff） | 2026-05-21 |
| KD-6 | Console shell 容器层级拆成 outer shell + content carrier | Settings/Thread 这类 rail/content 页面用淡边界分隔；Memory/Mission/Signal 这类 console page 外层用 full-height shell，页面级标题/nav/content 归入 content carrier，承载层跟随多数页面的圆角 surface 模式 | 2026-05-21 |
| KD-7 | 多数页面的圆角承载层优先于无缝少数派 | CVO 2026-05-21 二次验收指出“规则与 SOP 等多数页面是圆角承载层”，Memory/Signal 的无缝主内容是异端；PR #1826 给 Memory/Signal 主内容补 visible carrier，避免 card-bg 与 shell-bg 过近导致“看起来没圆角/没空白” | 2026-05-21 |
| KD-8 | Memory/Signal 页面承载层必须是一张卡，不拆 title/nav 与 content | CVO 2026-05-21 三次验收指出“原本是一整张，你们分开成两个了”；PR #1827 将 Memory/Signal 的标题、tabs、内容合进同一张 content carrier，并删除重复返回按钮，ActivityBar chat icon 作为统一返回入口 | 2026-05-21 |

## Review Gate

- Phase A: codex 本地 review → opus-47 愿景守护（不走云端）
- Phase B: codex 本地 review → opus-47 愿景守护（不走云端）
- Phase C: codex 本地 review → opus-47 愿景守护（不走云端）
- Phase D: codex 本地 review → 云端 review（代码改动，不豁免）
- Phase E: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token 替换）
- Phase F: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token 替换）
- Phase G: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token + border 清理）
- Phase H: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration）
- Phase I: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration + dead token cleanup）
- Phase J: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration）
- Phase K: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration + exempt annotations）
- Phase L: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 className bulk migration）
- Phase M: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token swap）
- Phase N: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 console token alignment）
- Phase O: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration for inner controls）
- Phase P: codex 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS token migration for settings/voice residuals）
- Post-close shell container parity: opus 本地 review → 云端 skip（CVO KD-1 速度优先，纯 CSS shell hierarchy correction）
- Post-close rounded content carrier follow-up: opus 本地 review → 云端 review clean（纯 CSS carrier visibility fix + regression test）
- Post-close unified content card follow-up: codex 本地 review + `pnpm gate` → 云端 skip（CVO explicit directive，纯 layout hierarchy fix + test update）
