---
feature_ids: [F269]
related_features: [F056, F255]
topics: [frontend, ux, content-overflow, accessibility, design-system]
doc_kind: spec
created: 2026-07-18
description: "Audit every user-visible text truncation and establish a recoverable, accessible full-content contract across Clowder AI UI surfaces."
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-23T03:32:00Z
tips_exempt: "Overflow recovery is a contextual inline affordance that appears beside the affected content only when measurement proves overflow; it is not a separate user-invokable capability, and its visible buttons must remain discoverable without a tip"
---

# F269: Recoverable Content Overflow — 前端截断审计与全文可达契约

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

## Why

operator发现咱们大量 UI 在遇到长文本时直接截断，却没有任何按钮或详情入口可以看到全文：

> “我发现我们家大多数ui 对于长文本有个内容，他是直接截断，然后也没一个按钮能让我看到全文。”
>
> “那我们是不是可以来个feat 对我们的前端ui做个审计？然后看看到底如何规整我们的这些 被截断的信息？”

截断可以降低列表密度，但不能成为信息终点。省略号向用户承诺“后面还有内容”；如果鼠标、键盘和触屏都找不到恢复路径，用户无法确认审批理由、错误详情、猫猫正文或证据内容，界面对信息的可信度就会下降。

本 Feature 的目标不是删除所有省略号，而是建立一条全家 UI 不变量：**任何有意义的用户或猫猫文本，只要被截断，就必须提供可发现、可访问、可验证的全文路径；合法的紧凑展示必须被明确分类，而不是靠每个组件临场决定。**

## Current State / 现状基线

2026-07-18 在 PR HEAD `462d6fbda5d4802ab0e54671d9a70c0fd9e5981b` 对 `packages/web/src/components/**/*.tsx` 执行宽口径 lexical 扫描（`rg -l 'truncate|line-clamp-' ... -g '*.tsx'` / `rg -o ...`）显示：

| 证据 | 基线 | 解释 |
|------|------|------|
| 含 `truncate` / `line-clamp-*` 的组件文件 | 117 个 | 宽口径包含测试、注释、变量名与合法的文件名/ID/布局用途，不能直接等同于 117 个 bug |
| `truncate` / `line-clamp-*` lexical matches | 238 处 | 当前没有统一 ledger 说明每处内容语义、全文来源与恢复入口 |
| 消费 `ExpandableText` 的组件文件 | 3 个 | `EvidenceCard`、`EvidenceSearch`、`RecallFeed` |
| 消费 `CollapsibleMarkdown` 的组件文件 | 2 个 | `ChatMessage`、`ReplayMessageList`，共 4 个调用点 |

现有能力并非从零开始，但尚未形成一致契约：

- `ExpandableText` 支持点击/键盘切换及 `aria-expanded`，但依赖“整段文字本身可点击”，没有可见的“展开全文” affordance，正好命中operator指出的发现性问题。
- `CollapsibleMarkdown` 有显式 `Show more / Show less`，但只覆盖 Markdown 消息场景，标签硬编码为英文，阈值与阅读面不可复用于一般卡片正文。
- F255 已确认一条正确的长正文范式：列表态只放 `headline + summary`，约 1000 words 的全文进入独立滚动阅读态，不用三行硬截。
- 部分内容不只是 CSS 折叠，而是在 web/API producer 侧被物理切片，例如 `toolPreview.ts`、`useAgentMessages.ts`、`ReplayEventBubble.tsx`。如果完整内容已不在当前 payload，单加展开按钮只会制造“假入口”。`callback-anchor-helpers.ts` 是现有正例：preview 明示 `truncated` / `requiresDrill`，并带回 canonical content 的一跳 `drillDown`。

Kickoff 时缺少：全量审计台账、内容类型与严重度分类、统一组件族、producer/drill 契约、阻止新增无出口截断的守卫，以及跨桌面/窄屏/键盘的回归证据。

### Phase A audit snapshot（merge-tree freshness 修订）

Phase A 首版在启动 SHA `bf94efe026b4e25041c312c1887fab624f534895` 建立 ledger，并由 PR #3081 合入。Post-merge 验证发现：PR 分支自身没有改审计源，但它等待 CI 期间 `origin/main` 的 merge tree 已改动前端源文件，旧检查只看 branch-local drift，因而会误绿。修订版将审计基线刷新到 `f3e788b06ea34d99990f59384ddde0339472fd59`，并记录 `auditFreshnessRef=origin/main`；scanner v2 同时比较启动 SHA、当前分支与最新 main ref，merge-tree source drift 会 fail closed。

| 口径 | 结果 |
|------|------|
| 可复制命令 | `pnpm audit:f269-overflow -- --check` |
| 宽口径 lexical baseline | 139 files / 293 matches |
| 实际 text token baseline | 108 files / 209 matches |
| 已知 physical producer | 58 records |
| 完整 inventory | 347 = 253 classified + 94 explicit exclusions |
| 严重度 | U0 6 / U1 41 / U2 150 / U3 56 / U4 0 |
| 视觉证据 | 尚未归档；不以代码或 payload 证据冒充截图，因此 AC-A3 保持未勾选 |

canonical JSON、完整表、owner 分布、top offenders 与 producer locator 清单见 `docs/features/assets/F269/overflow-ledger.{json,md}`。PR #3089 的 exact HEAD 已由非作者复核，scanner/tests/coverage equations 闭合，因此 AC-A1/A2 完成；截图缺口仍必须真实补齐，AC-A3 保持未勾选。

### Phase B/C migration snapshot（first production slice，历史快照）

在 `FileBlock` 与 `SettingsRow` 接入批准后的 typed primitives 后，当前可重跑 Ledger 为 345 records / 291 raw lexical matches：U0 6 / U1 40 / U2 147 / U3 56 / U4 0。相对 Phase A 基线，4 条真实债务退出分类（U1 −1、U2 −3）；两条新 test lexical noise 作为 explicit exclusions 入账，因此 inventory 净减 2。audit base 为 `4e31bffc081ab7f8e42d2f70f28ddf4e69e5ba24`，`auditFreshnessRef=origin/main`，scanner 为 `f269-phase-a-v3`。

这只是迁移进度，不是 Phase C 完成：U0/U1/U2 仍远未清零，AC-C1 保持未勾选。freshness guard 同步修正为“从 merge-base 检查 upstream audited-source delta”，使 feature 自己有意修复的 source 可以进入新基线，同时 latest main 另行推进 audited source 时仍 fail closed。

### Phase C migration snapshot（U0 recovery wave）

Phase C 第一轮按风险先清理全部 6 条 `permanently-lost` producer：

- tool input/result 不再生成 200/220 字符或 4 行的物理 preview；完整可见内容保留在默认折叠、逐条可展开的 tool detail 中，recall metadata 仍独立提取。
- TaskComposer 的标题 200 / why 1000 是 `/api/tasks` 的真实 schema 上限；前端改为可见计数、`maxLength` 与无障碍说明，不再静默 `.slice()`。
- Mount Rules 保存错误与 Drift 同步错误保留完整 response body；人类摘要始终可见，技术详情通过 Critical Text 显式展开，并限制阅读容器高度而不丢内容。

以实现 commit `64b9ba036df1940f9f283b880edca138ae7602fb` 为 audit base 重跑 scanner v4 后，Ledger 为 331 records / 282 raw lexical matches：**U0 0 / U1 40 / U2 147 / U3 56 / U4 0**。6 条 U0 locator 与 classification 是因对应丢失行为从源码消失而退休，不是降级 severity；工具详情、响应错误与任务限制均有回归测试。

PR #3152 squash merge 后的 main replay 暴露了 Git 拓扑缺口：branch 内的 audit commit 不再是 main 祖先，在 fresh shallow main 中甚至不可达，旧 merge-base guard 会把本次受审 source 误判为 upstream drift。scanner v5 因此额外写入基于 `git ls-tree` 的 `auditSourceFingerprint`：branch 上继续校验 commit provenance；squash main 与 fresh clone 用稳定 source 指纹证明内容等价；任何后续 audited-source 变化仍 fail closed。该修订不改变 Ledger 数量或 severity。

这完成了 U0 recovery wave，但不是 F269 闭环：U1=40、U2=147 仍需后续迁移，因此 AC-C1/C2/C3 继续保持未勾选。

### Phase C migration snapshot（critical / diagnostic U1 wave）

下一轮按风险迁移了现存 20 条 `targetPattern=critical-text` 的 U1。审批理由、daemon/session 诊断、服务状态与错误、schedule failure、toast 详情及 handoff 摘要现在都始终保留人类可读摘要，并通过明确、限高的详情控制提供完整值。Trajectory branch 属于路径型元数据，改用 Compact Label，而不是藏在通用 diagnostic disclosure 里。`CriticalText` 同时隔离按钮的 click/keydown，避免在可点击父行中展开详情时误触父级动作。

`ChatVoiceFeatureControls` 不再只保留 API log 的最后 20 行或 1600 字符。完整非空日志已被保留，因此对应 physical-producer locator 仅在源码切片行为消失、fail-closed scanner 接受新 inventory 后退休。

以实现 commit `538979291f8852e0c2d94d880b27a2462f3ce865` 为 audit base，scanner v5 将 Ledger 重算为 **314 records / 266 raw lexical matches = 223 classified + 91 explicit exclusions：U0 0 / U1 20 / U2 147 / U3 56 / U4 0**。相比上一快照，20 条 U1 退出（其中 1 条是 physical preview）；纯源码行号位移只做映射更新，没有改 severity，3 条新测试 lexical noise 明确进入 exclusions。这是真实地将 U1 减半，不是闭环：剩余 U1=20、U2=147，因此 AC-C1/C2/C3 继续保持未勾选。

### Phase C migration snapshot（prose / reader U1 wave）

剩余 20 条 U1 按内容长度与 canonical source 分成两种恢复面，而不是继续用统一的字符切片：

- 持有全文的 prose DOM surface 迁移到 `ExpandableProse`，覆盖 action 提示、首次运行模板、artifact、mission control、queue、dossier、vote、whisper 与 Git/health commit subject。可点击父卡片同步拆分交互边界，展开按钮不会触发父级导航；固定高度 Dependency DAG 改用 `CompactLabel` + 稳定 detail panel，避免展开破坏图布局。
- Schedule 的 8 字 `subjectPreview` 保持诚实 preview，不渲染假展开；键盘可展开任务行并读取 `lastRun.subject_key` 的 canonical 值。completion toast、World 事件与 concierge peek 保留完整 payload；系统 mention 不复制私密正文到锁屏通知，点击回 canonical thread；cross-feature 卡片退场后仍保留持久 source jump；Story tool result 进入 `LongFormReader`，保留搜索、复制与完整 tail。
- F269 dev preview 不再用生产 `ReplayEventBubble` 冒充历史基线，改为独立冻结的 `LegacyToolResultBaseline`；因此设计证据仍能展示旧问题，生产组件则按新契约验证。

以 fresh-context findings 修订 commit `f6eaf3785aea928f14fe68d0dfb28feb50df26a8` 为 audit base，scanner v5 将 Ledger 重算为 **307 records / 265 raw lexical matches = 203 classified + 104 explicit exclusions：U0 0 / U1 0 / U2 147 / U3 56 / U4 0**。20 条 U1 locator/assignment 仅在对应无出口行为从源码消失后退休；4 条因 import/layout 产生的元数据行号位移继续映射为 U2，没有被误删。作者侧 fresh-context scan 发现的 notification 隐私、假 canonical preview、短命 source jump 与固定图节点膨胀均已由行为回归测试闭合，而不是把 finding 留给 reviewer。

这是 **U0/U1 清零里程碑，不是 F269 闭环**：U2=147 仍需迁移，视觉 close evidence 与 producer drill 契约也尚未完成，因此 AC-C1/C2/C3 继续保持未勾选。

第一批 U2 Compact Label 迁移覆盖产物列表与详情：`ArtifactsPanel` 的产物名、来源元数据、所属对话与分组标题，以及 `ArtifactDetailView` 的 header / download / fallback 标题，都只在真实 measured overflow 时暴露复制全文与 focus tooltip。产物行内复制会隔离父级打开动作；分组折叠与全文恢复拆成合法的 sibling buttons，避免 button nesting。

以实现 commit `f153c64ca0ce63db136fac35b3ee421c399a5b43` 为 audit base，Ledger 重算为 **300 records / 258 raw lexical matches = 196 classified + 104 explicit exclusions：U0 0 / U1 0 / U2 140 / U3 56 / U4 0**。7 条 U2 仅在对应裸 `truncate` 从源码消失并由 3 条 focused behavior tests 覆盖后退休；F269 仍保持 `in-progress`，AC-C1 继续由剩余 U2=140 阻塞。

第二批 U2 Compact Label 迁移覆盖 `DirectoryPickerModal`：当前目录、外部目录、已有项目的名称与完整路径、猫会话标签，以及底部已选路径提示，都只在真实 measured overflow 时提供复制全文与 focus tooltip。项目选项保留显式原生选择按钮承担键盘与读屏语义，同时把非交互的整行内容作为同一选择动作的指针热区；选择按钮与两个 `CompactLabel` 复制控件仍是合法 sibling actions，复制全文不会意外切换目录。共移除 8 个截断点，其中 7 条原本已分类为 U2，另 1 条来自此前被 scanner 误排除的多行动态 `className`。

这次迁移同时将 scanner 升到 v6：多行 template/string `className` 中的 `truncate` / `line-clamp-*` 不再因 overflow token 位于 opener 后续物理行而被当成 lexical noise；回归 fixture 明确把 `className={` 与 `truncate` 放在不同代码行。fail-closed materialization 因而揭出 `HistorySearchModal`、`SplitPaneCell` 与 `WorkspaceTree` 的 3 条真实 U2，并逐条纳入分类。以 fresh-context 修订 commit `cf73103cea9e5323fc6e90619b4448f2999b57e8` 为 audit base，Ledger 重算为 **292 records / 250 raw lexical matches = 192 classified + 100 explicit exclusions：U0 0 / U1 0 / U2 136 / U3 56 / U4 0**。因此本 wave 的 U2 净变化是 `140 → 136`：8 个 DirectoryPicker 截断点退出，同时 3 个历史漏扫问题进入诚实分母；focused UI tests 28/28、scanner tests 12/12、Web TypeScript 均通过。F269 继续保持 `in-progress`，AC-C1 仍由剩余 U2=136 阻塞。

2026-07-24 的生产反馈揭示：#3169 为消除嵌套交互，把三个项目行类别统一迁到 `ProjectOption` 时，也把原有整行指针热区缩成了右侧小按钮。修复以失败回归先证明点击项目名仍保留默认项目，再恢复非交互行内容的选择动作；任何 button/link/form control/tooltip 继续 fail-closed 隔离，原生按钮仍独立承担键盘与读屏路径。该修复不改变 overflow 分类或 Ledger 数量。

2026-07-25 的同类普查把根因扩到当时同一批 F269 迁移：为让 `ExpandableProse` / `CompactLabel` 的恢复控件不再嵌套进外层 button，`TemplateStep`、Marketplace artifact、`MissionControlCard`、Git commit、`WhisperCatSelector`、Artifacts 分组标题与 `ProjectOption` 共 7 个 surface 都把原生语义按钮缩到局部内容，非交互正文因此失去原有主动作。修订引入一个**有界**交互目标 predicate：只隔离当前 row 内的 button/link/form/disclosure/tooltip，不能让 row 外部的交互祖先被无界 `closest()` 误判。各 wrapper 只恢复 pointer 热区，键盘与读屏仍由内部原生按钮负责；内部展开、复制与折叠按钮不会双触发父动作。

文案审计同时确认，全仓可见的补偿型 selection CTA 只有 `ProjectOption` 的 `选择/已选择` 与 `TemplateStep` 的 `选择此模板/已选择` 两处。两者改为既有 selected ring + 小圆勾，Directory Picker 浏览路径的重复 `已选` badge 也被移除；批量选择计数与底部 canonical selection summary 保留，因为它们表达的是集合/提交上下文而不是行内第二个主动作。该修订不让任何 overflow locator 出账，也不改变 Ledger 分类数量。

### Phase C migration snapshot（Session Audit U2 wave）

Session Audit 的运行时会话 ID、conversation ID、身份/绑定标签与 handoff invocation ID 已迁到 measured `CompactLabel`：短值保持原布局且不出现恢复 chrome，只有真实 inline overflow 时才提供复制全文与可聚焦 tooltip。Raw event 不再把完整 JSON 藏在 native hover `title`，而是保留稳定的事件号/类型摘要，并通过 inline `CriticalText` 暴露有界技术详情；完整 JSON tail 仍在当前 payload 中可读。

本轮同时修复了 viewer 的 stale-while-revalidate 类型错配：切换 Chat / Handoff / Raw 时，旧数据继续按其原始 `dataView` 渲染，直到新请求成功；不再把 Chat message 当 Handoff record 读取而产生 `NaN` 或重复 key。22 条 focused tests 覆盖短值零控件、实测 overflow 后复制、完整 JSON tail、跨 view pending 状态、预览 fixture 与既有 viewer 行为。

以实现 commit `78963dab286c30836bc05e5c91541a113dc8df93` 为 audit base，scanner v6 将 Ledger 重算为 **286 records / 244 raw lexical matches = 187 classified + 99 explicit exclusions：U0 0 / U1 0 / U2 131 / U3 56 / U4 0**。相对最新 main 的 292/250，六条 Session Audit U2 locator/assignment 仅在对应裸截断或 hover-only 行为消失后退休；同期 `capability-tips.seed.json` 的 audited-source 变化进入新 fingerprint，但未制造 overflow 记录。F269 继续保持 `in-progress`，AC-C1 仍由剩余 U2=131 与 close evidence 阻塞。

### Phase C migration snapshot（Mission Control labels）

Mission Control 的进行中/已完成 Feature 名称，以及 linked / title-matched thread 标题，已从不可发现的单行省略迁到 measured `CompactLabel`。短内容保持原布局且没有恢复控件；只有真实 inline overflow 才提供可聚焦 tooltip 与复制全文。五条 U2 locator 在源码裸截断消失且行为测试覆盖后退休。

本轮没有用恢复控件缩小原有主操作热区：Feature header 的展开按钮与 thread row 的导航链接都是覆盖整行的原生 sibling overlay，复制按钮独立位于其上层；复制不会展开 Feature，也不会导航 thread。窄屏下恢复动作使用 24px compact density，thread count 让位于名称与状态，避免复制按钮与状态 chip 重叠。作者在生产 preview 上分别以桌面与 390px 视口检查布局；首轮窄屏截图实际发现重叠，修订后复验通过。截图未归档为独立 close evidence，因此 AC-A3 继续保持未完成。

以实现 commit `2bc600cb819aa6614bb8e85f3f1089df93ebf522` 为 audit base，scanner v6 将 Ledger 重算为 **281 records / 239 raw lexical matches = 182 classified + 99 explicit exclusions：U0 0 / U1 0 / U2 126 / U3 56 / U4 0**。F269 继续保持 `in-progress`；AC-C1 仍由剩余 U2=126 与 close evidence 阻塞。

### Phase B/C product correction（dense Queue reader）

operator在生产 Queue 现场指出：虽然 `ExpandableProse` 已让全文可达，但任意长度消息原地展开会撑高排队列表，与 `Steer`、删除和排队状态争夺空间。这个反馈收紧了四模式的选择规则：**可恢复不等于必须原地铺开；内容长度无上界、列表几何需要稳定时，即使正文当前持有全文，也必须使用 Long-form Reader。**

`QueueEntryRow` 因此从两行 `ExpandableProse` 改为紧凑 `LongFormReader`：短内容完整显示且没有额外控制；真实溢出时只增加低强调的“查看全文”，两行摘要保持不变；完整 Markdown 在有内部滚动的阅读面中提供搜索、复制、Esc 关闭与焦点返回。共享 reader 的默认三行/主按钮模式不变，紧凑模式只服务 Queue 一类高密度 surface。reader trigger 通过 `aria-expanded` / `aria-controls` 暴露状态与目标；发生 overflow 后，视觉 clamp 的无上界正文从列表无障碍树中退出，改由有界语义摘要描述入口，全文只在 reader 中读取。focused behavior tests 同时覆盖 CJK/emoji 完整性、父动作隔离、键盘原生语义、ARIA 状态关系和“打开 reader 后列表摘要仍为两行”；设计预览在 Long-form Reader 模式中加入密集列表样例。

这项产品纠偏不改变 Ledger 严重度数量，也不提前完成 AC-B1~B3 或 AC-C1；它修正的是已迁移 surface 的模式选择，而不是把一个 U2 记录重新包装成完成。

### Phase B/C product correction（visual restraint）

operator 在后续生产验收中发现，critical/diagnostic wave 把恢复能力与重型告警容器绑死：Toast、审批卡、session/service/schedule 行即使已经有自己的 surface，内部仍会再出现带背景、边框与大块 padding 的 `CriticalText` panel；一句“处理完成”的短通知也被包装成 diagnostic disclosure，形成“到处贴狗皮膏药”的视觉噪音。

修订后的不变量是 **恢复能力默认视觉透明，容器层级由原 surface 决定**：

- `CriticalText` 默认 `appearance=inline`，保留完整摘要、详情按钮、限高技术内容和父动作隔离，但不再自带第二张卡；只有自身就是唯一告警容器的独立阻塞态才显式选择 `appearance=panel`。
- Toast 恢复原生标题 + 消息层级；短消息完整显示且没有额外控制，消息真实超过两行时才由紧凑 `LongFormReader` 提供低强调“查看全文”。
- 打开 Toast reader 后将“只允许手动关闭”写入 toast store；切换 thread 或临时卸载卡片也不会重新启用倒计时。通知栈更新不重置 reader 焦点；同标题通知的 reader/关闭按钮以栈中序号形成唯一可访问名称。
- 行为测试同时锁住“短成功通知零恢复 chrome”“inline 默认无 panel classes”“panel 必须显式 opt-in”“跨 thread 阅读后不被倒计时移除”“无关通知更新不抢焦点”与“同标题控件可区分”；设计预览以冻结旧 fixture 对照 inline 新态，且预览 Toast 的关闭动作真实生效，避免后续批量迁移再次把能力组件误当布局组件。

这项纠偏本身不让任何 Ledger 记录出账；它修复的是已迁移 surface 的视觉层级与按需出现契约。同步到最新 `main` 后，审计另发现新增的 `ApprovalProvenanceLinks` 来源事件只有 hover `title`，因此诚实分母从 U2 136 变为 U2 137；F269 仍由这些 U2 与 close evidence 阻塞。

## Architecture Ownership

Architecture cell: hub-action-surface

Phase A audit/evidence 归此 cell；逐条 producer ownership 仍由 ledger 记录。

Map delta: none

Why: 本 Feature 在现有前端 action/render surfaces 上建立共享的全文恢复交互与检查器，不新增 Store、Queue、Router 或跨域状态所有者。Phase A 若发现 producer 侧物理截断，将修复责任记回该 producer 所属 cell；F269 只定义跨 surface 的恢复契约与审计入口，不私造并行数据源。

## What

### Phase A: 全量审计与语义分类

Phase A 启动时必须在当时的 `origin/main` 重新跑 scanner，并在报告记录 `auditBaseSha`、scanner command/version 与宽口径原始数；kickoff 的 117/238 只证明问题规模，不作为完成时分母。

建立机器扫描 + 人工语义复核的 `Overflow Ledger`。每条记录至少包含：

| 字段 | 含义 |
|------|------|
| surface / component / field | 用户在哪里看到哪段文本 |
| content kind | identifier / prose / long-form / critical / diagnostic |
| truncation stage | CSS clamp / web physical slice / API preview / canonical source cap |
| full-content availability | 当前 DOM、当前 payload、可 drill source、或已永久丢失 |
| current recovery | 无 / tooltip / inline expand / detail reader / source jump / copy |
| input coverage | mouse / keyboard / touch / screen reader |
| severity | U0–U4 |
| target pattern / owner | 应迁往哪个模式、由哪个 ownership cell 修复 |

严重度定义：

- **U0 — 信息丢失**：关键内容被 producer 物理截断且没有 canonical drill/source；P1 blocker。
- **U1 — 无出口正文**：完整内容仍存在，但有意义正文、审批理由、错误或证据没有明确恢复入口；必须修。
- **U2 — 恢复入口不可发现**：只能点击整段文字、依赖 hover/title，或缺触屏/键盘路径；当轮迁移。
- **U3 — 合法紧凑展示**：文件名、路径、ID 等有可访问 tooltip/detail/copy 或中段截断策略；保留并记录。
- **U4 — 非内容 overflow**：圆角裁切、进度条、容器布局等 `overflow-hidden`；排除并说明。

Phase A 产出覆盖报告、按严重度排序的迁移清单，以及不超过 3 张代表性现状截图。机器扫描总数必须与 ledger 的“已分类 + 明确排除”总数对得上。

### Phase B: 内容溢出契约与组件族

将长文本按语义而不是字符数分成三种主要交互：

1. **Compact Label**：名称、路径、ID 等单行元数据。允许省略；全文通过 hover + focus、复制或详情可达，路径优先保留首尾。
2. **Expandable Prose**：描述、评论、理由、摘要等**长度有合理上界、原地展开不会破坏周边几何**的短正文。默认 2–4 行，只有真实溢出时出现可见的“展开全文 / 收起”按钮，并保持列表位置。
3. **Long-form Reader**：长 Markdown、日志、文章、1000-word 级正文，或 Queue 等内容长度无上界且必须保持紧凑几何的 surface。列表只显示语义摘要；普通 surface 用“阅读全文”，密集列表用低强调“查看全文”进入独立阅读面，提供复制、搜索、来源与返回焦点。

错误、校验、审批决定依据等 **Critical Text** 不允许静默截断；可以显示人类摘要，但完整技术详情必须有醒目入口。

Phase B 升级/收敛现有 `ExpandableText` 与 `CollapsibleMarkdown`，但不做万能 mega-component。共享 primitive 必须满足：

- 仅在实际 overflow 时显示控制；响应容器宽度、字号、缩放和语言变化。
- 使用真实 `button`，支持 Enter/Space，维护 `aria-expanded` 与 `aria-controls`。
- Tooltip 只能补充简短元数据，不能成为段落全文的唯一入口。
- 展开、收起、打开 reader 和返回后保持合理的焦点与滚动锚点。
- 固定高度或高密度列表不得用无上限 inline expansion；两行摘要与列表几何保持稳定，全文进入有内部滚动的 reader。
- 不切断 Markdown 链接/代码块；能提供 summary 时不使用随意字符切片冒充摘要。
- CJK 与 emoji 按 grapheme/语义边界处理，不假设空格分词；中文无词边界时也不能切出半个组合字符、破坏标点语义或让控制错误判断 overflow。

前端 UX 必须经过 Design Gate：在真实页面上给出 Compact Label、Expandable Prose、Long-form Reader、Critical Text 四种代表性文字 wireframe，经operator确认后才进入全量迁移。

### Phase C: 风险排序迁移

按“决策关键度 × 用户频率 × 当前不可恢复程度”迁移，而不是机械替换全部 238 个宽口径 lexical matches：

1. U0/U1：审批理由、错误/诊断、任务 why、用户/猫猫正文、证据与结果摘要。
2. U2：只有 hover/title 或整段可点击、触屏不可发现的正文。
3. U3：路径、ID、文件名等紧凑元数据统一到合法模式。

Phase C 完成时：U0/U1 为 0；U2 为 0；剩余截断全部是 ledger 中可解释、可恢复的 U3，或明确排除的 U4。producer 侧 preview 必须带 `truncated`/`requiresDrill` 与可执行 drill/source；没有全文时不得渲染虚假的展开按钮。

### Phase D: 防回归与持续验证

按“软 + 硬 + eval”闭环防止新债重新长出：

- **Soft**：在 Clowder AI Design System 与 `console-dev` Design-System gate 写入 Recoverable Overflow 选择规则和反例。
- **Hard**：增加静态检查，拒绝新增未分类的正文 `truncate`/`line-clamp-*`；合法 Compact Label 通过明确 primitive 或带理由的窄 allowlist 表达。组件测试覆盖 overflow 检测、a11y 状态和输入方式。
- **Eval**：持续产出 `unclassified / U0 / U1 / U2 / U3` 数量，Playwright 覆盖桌面与窄屏、鼠标与键盘，close 时提供 ≤3 张截图、15 秒录屏和“需求 → 证据”映射。

## User Journey

### Primary Journey: 在紧凑列表中看到完整内容
- **Scope unit**: workspace（单个内容项）
- **Actor**: operator
- **Entry**: 任意包含长描述、理由、正文、日志或证据的卡片/列表行
- **Flow**:
  1. operator看到保留关键信息的预览；如果内容没有溢出，不出现多余控制。
  2. 内容溢出时，旁边出现明确的“展开全文”“查看全文”或“阅读全文”，而不是只有省略号。
  3. 短正文就地展开；长正文进入稳定阅读面，完整内容、复制、搜索和来源可用。
  4. operator收起或返回后，焦点与列表位置仍在原内容项附近，不需要重新寻找。
- **Success evidence**: 桌面 + 窄屏截图（≤3 张）、15 秒录屏、Playwright keyboard path
- **Non-goals**: 删除所有省略号；让路径/ID 默认占满整行；把所有长文塞进 modal；用 tooltip 承载长正文；重新设计所有页面视觉风格

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | 键盘/读屏用户 | Tab 到全文控制 → Enter/Space 展开 → 状态被正确播报 → 返回焦点稳定 | accessibility test + Playwright |
| S2 | workspace | 前端开发猫 | 新增长文本展示 → 选择契约中的 primitive → checker 通过；裸 clamp 正文被阻止 | static-check fixture |
| S3 | message | operator | API 只返回 preview → UI 明示已截断并跳到 canonical source，而不是伪装成全文 | integration fixture |

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：完整性、发现性、一致性、防复发；均由非作者通过报告、测试或视觉证据复核。 -->

### Phase A（全量审计与语义分类）
- [x] AC-A1: 在 Phase A 启动 SHA 重跑 scanner，报告记录 `auditBaseSha` 与 scanner command/version；`packages/web/src` 所有文本 `truncate` / `line-clamp-*` 与已知物理 slice producer 进入 Overflow Ledger，机器总数与“分类 + 排除”总数一致。
- [x] AC-A2: 每条 ledger 记录包含 surface、content kind、truncation stage、全文可用性、恢复入口、输入覆盖、severity、target pattern 与 owner。
- [ ] AC-A3: U0/U1/U2/U3/U4 基线数量、top offenders 和 ≤3 张代表性截图进入审计报告；非作者可从命令重现数量。

### Phase B（契约与组件族）
- [ ] AC-B1: Design System 明确定义 Compact Label / Expandable Prose / Long-form Reader / Critical Text 的选择规则、禁止项与示例，并引用本 Feature。
- [ ] AC-B2: 可见全文控制只在真实 overflow 时出现；鼠标、触屏、Enter/Space、`aria-expanded`/`aria-controls` 以及 CJK/emoji grapheme 边界全部有自动测试。
- [ ] AC-B3: 长正文 reader 支持完整 Markdown/纯文本、复制、搜索、来源、关闭后焦点恢复；窄屏无横向溢出。

### Phase C（风险排序迁移）
- [ ] AC-C1: ledger 中 U0、U1、U2 数量均降为 0；所有剩余截断都有可复核的 U3 恢复路径或 U4 排除理由。
- [ ] AC-C2: producer-side preview 在完整内容不随 payload 返回时，统一暴露 `truncated`/`requiresDrill` 与可执行 drill/source；测试覆盖“不得渲染假展开”。
- [ ] AC-C3: 审批/错误/任务 why/正文/证据等高价值 surface 的“需求 → 截图/测试”映射完整，非作者抽查可逐项到达全文。

### Phase D（防回归与持续验证）
- [ ] AC-D1: 静态 checker 阻止新增未分类的正文 clamp；合法 Compact Label 通过明确 primitive 或带理由 allowlist，fixture 覆盖 pass/fail。
- [ ] AC-D2: 按 claim 记录机制选择：确定性的 overflow 契约由 `console-dev` / Design System 规则与 checker/tests 守护；若出现性能或稳定性问题再接 logs/metrics/traces；只有出现不确定效用且存在 keep/tune/sunset consumer 时才建立 eval。
- [ ] AC-D3: 桌面/窄屏、鼠标/键盘的 Playwright 验证通过；close evidence 含 ≤3 张截图、15 秒录屏和 User Journey 映射。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “大多数 UI 对长文本直接截断，也没一个按钮能看到全文” | AC-A1~A3, AC-B2, AC-C1 | audit ledger + screenshot + Playwright | [ ] |
| R2 | “对我们的前端 UI 做个审计” | AC-A1~A3 | reproducible scanner + ledger review | [ ] |
| R3 | “看看到底如何规整这些被截断的信息” | AC-B1~B4, AC-C1~C3, AC-D1~D3 | design contract + tests + visual UAT | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已定义“需求 → 证据”映射格式

## Tips Contribution（F244）

- 计划新增 1 条上下文 tip：当用户首次遇到可展开长内容时，说明“短内容可展开全文，长内容可进入阅读面”；`sourceRef` 指向最终 Design System Recoverable Overflow 段。
- Tip 不替代可见按钮；如果交互需要 tip 才能被发现，视为 AC-B2 未通过。

## Eval / Tracking Contract

1. **Primary Users + Activation Signal**：前端开发猫在 TSX 中新增/修改 `truncate`、`line-clamp-*` 或共享长文本 primitive；用户侧激活为真实 overflow 内容渲染。
2. **Friction Metric**：`unclassified_overflow_count`、`U0/U1/U2_count`、带理由 allowlist 数量、checker false-positive override rate、用户找不到全文的重复反馈数。
3. **Regression Fixtures**：
   - 裸 `line-clamp-2` 段落且无恢复入口 → fail。
   - Compact Label primitive + focus/copy/detail → pass。
   - 段落仅用 tooltip/title 承载全文 → fail。
   - API preview 标记 truncated 但无 drill/source → fail。
   - Expand/reader 的键盘、窄屏、焦点恢复 → pass。
   - 无空格中文、emoji ZWJ 与组合字符在 clamp/expand/reader 切换中保持完整 → pass。
4. **Sunset Signal**：recoverability 不变量不 sunset；若 lexical checker 的带理由例外率连续两次审计超过 20%，或误报导致开发者普遍绕过，则 sunset 该扫描实现，迁移到 typed primitive/component-contract checker，并保留同一指标连续性。

## Dependencies

- **Evolved from**: F056（设计语言的 Governance / Primitives / Retrofit 分层，为本 Feature 提供设计系统承载面）
- **Blocked by**: none
- **Related**: F255（已验证“摘要列表 → 独立长文阅读态”模式）

## Risk

| 风险 | 缓解 |
|------|------|
| 把 238 个宽口径 lexical matches 都当 bug，破坏紧凑导航 | Phase A 先在新 base 重跑 scanner，再按内容语义与 U0–U4 分类，U3 合法展示明确保留 |
| 只加按钮，但 producer 已把全文切掉 | ledger 强制记录 truncation stage + full-content availability；无 source 不得做假展开 |
| 就地展开超长正文导致列表剧烈跳动 | 短正文 inline，长正文进入 reader；保存焦点与滚动锚点 |
| checker 只扫字符串，误报合法布局或鼓励大 allowlist | U4 排除 + typed primitive + 带理由窄 allowlist + 20% sunset 阈值 |
| 审计范围跨全前端，迁移失控 | 先清零 U0/U1/U2，U3 按统一 primitive 收口；机器总数与 ledger 守 coverage |
| 把 F056 的视觉语言与本 Feature 的信息完整性混为一谈 | F269 独立 truth source，F056 仅作为设计系统承载与 Related feature |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 独立立 F269，Related F056，而不是把需求塞入 F056 新 Phase | F056 主责视觉语言/token/theme；F269 主责信息可恢复性，并可能追到 producer/API preview 契约 | 2026-07-18 |
| KD-2 | “截断是预览，不是终点”作为跨 surface 不变量 | 保留密度收益，同时消除信息死路 | 2026-07-18 |
| KD-3 | 用 Compact Label / Expandable Prose / Long-form Reader / Critical Text 分类，不做一个万能组件 | 不同语义需要不同恢复面；避免 mega-component 与列表跳动 | 2026-07-18 |
| KD-4 | CSS clamp 与物理截断分开审计 | 单加 UI 按钮无法恢复 producer 已丢弃的内容 | 2026-07-18 |
| KD-5 | Tooltip 只能辅助短元数据，不能作为长段落唯一全文入口 | 触屏不可发现，且长内容不适合瞬时浮层 | 2026-07-18 |
| KD-6 | operator 批准四模式 Design Gate，生产迁移由 `@glm52` 绑定 exact HEAD 独立复核 | 视觉方向与实现质量分两道门；不把原型批准误当成生产完成 | 2026-07-21 |
| KD-7 | 高密度列表与内容长度无上界的 surface 使用紧凑 Long-form Reader，不允许无上限 inline expansion | “全文可恢复”不能以列表剧烈跳动为代价；摘要稳定、阅读层内部滚动才能同时保留密度与完整性 | 2026-07-22 |
| KD-8 | 恢复 primitive 默认不拥有容器层级；嵌入既有 surface 使用 inline，独立阻塞态才 opt in panel | 全文可达不能以到处嵌套卡片和常驻恢复 chrome 为代价；短内容应保持原界面的视觉节奏 | 2026-07-23 |

## Review Gate

- Kickoff docs：非作者跨 family 内容 review，重点审 scope、证据基线、AC↔Why 与 F056 边界。
- Phase A：audit coverage 与 severity 由非作者抽样复核。
- Phase B：前端 UX wireframe 已于 2026-07-21 通过operator Design Gate；生产实现仍需 TDD 与非作者 exact-HEAD review。
- Phase C/D：行为改动走 targeted TDD + 非作者 review；checker/`console-dev` 变更按 harness 软+硬+eval 覆盖 final HEAD。
