---
feature_ids: [F322]
related_features: [F056, F083, F147, F229, F232, F269, F277, F283, F284, F290, F294, F297, F305, F307, F309, F310, F315, F317, F321]
topics: [frontend, ux, discoverability, navigation, continuity, accessibility]
doc_kind: spec
created: 2026-09-27
description: "把日常主屏与跨面板操作整理成看得懂、找得到、能继续的工作体验，并逐项结算已有前端承诺。"
description_source: model
description_author: codex-astra
description_updated_at: 2026-09-27T00:55:00Z
tips_exempt: "本次整治首先让已有入口和状态自解释，不用主动 tips 弥补不清楚的图标；若实施新增可独立发现的用户能力，再按具体 delta 贡献 tip。"
---

# F322: Everyday Work Experience｜看得懂、找得到、接得上

> **Status**: in-progress / 新壳#4947、图标#4950、catalog准入#4949、记忆导航#4952及待办S3-2a #4969已合；含修复的冻结cut bf0716ba5f已补full gate绿，默认classic、当前runtime激活未核；原八项输入映射已闭，记忆导航独立Alpha、滚动C、领域接线与整段验收仍开放 | **Owner**: 小星星·Maine Coon（@codex-astra, gpt-6-astra），指挥责任由本 thread Astra 与 Opus 5.5 共同承担 | **Priority**: P1
>
> **operator source**: `[thread-id]#private-source-id` — 点名图标含义不明、hover 说明迟迟不出现，要求 Astra 与 Opus 讨论并交付可执行 roadmap；允许立项跟踪及整合旧 UI/UX feature。
> **Original source**: `private-source-id` — 比较 Codex 新版与 Clowder AI，要求分析体验差距与学习路径。
> **Execution source**: `private-source-id` — 本 thread 负责指挥/理论与验收后 vision 守护；各 Phase 独立执行；runtime 重启后验收另列；执行由 Astra、Sol6、Sol5.6、Kimi 承担，内部解决技术/review/合入，架构/愿景/范围取舍才升级；PR 不拆碎，可多 commit。引用批注授权旧项“该 close close”。

Architecture cell: `hub-action-surface`、`thread-navigation`。

Map delta: none。F322 拥有本批整屏体验与交付结算，不新建 runtime、registry、store 或业务权威；F056 视觉真相、F277 分组、F297 Sidebar snapshot、F307 topology 和各领域生命周期继续由原 owner 维护。

## Why

用户每天打开家里时，应该认得入口、知道当前要做什么，并在对话和作品间继续工作。现在图标含义常藏在原生 title 中，多个功能的 metadata 与维护信息又同时争夺注意力；局部功能存在不等于整张界面顺手。You 要的是实际可用的体验提升，而非一份新的设计原则或一次主题换色。

F322 统一导航、日常主屏、操作连续性和旧项结算的交付责任。F315 的原范围是 Workspace 页面可读性，不能单独覆盖这次新增的 global rail / chat / sidebar 旅程；F322 以明确批次关联原承诺，不重写原 owner 边界，也不把新编号当作旧项完成证据。

## Current State / 现状基线

立项时的代码基线为 `f3dbdaa426610553176fac5d1c38d902ff0d8386`；下列问题保留为原始对照，09-30已合新壳的当前状态见Phase B与执行组织段。operator两轮截图保存在原thread。

- `ActivityBar.tsx` 的导航、固定设置与 pinned sections，及 `AttentionRailButtons.tsx` / `ConciergeRailToggle.tsx` / `F307WorkbenchControlRail.tsx` 主要使用原生 title 提示。operator 报告等待与含义不明；本轮未测毫秒数，不把截图当性能诊断。
- `ThreadCatStatus.tsx` 把状态投影为带颜色/动画的猫形符号，tooltip 使用 `${status}: ${presence.cats.join(', ')}`；需要把当前事实表达为可读名称与状态，而非原始枚举和 catId。
- `ThreadSidebar/ThreadItem.tsx` 同行呈现全部参与者、首选猫、标签、状态和时间；F297 AC-D6 仍记录 crowded-row 反例，要求 12 participants 场景下 terminal/unread/mention/time 可见。
- `CompactLabel.tsx` 已提供 overflow/copy 全文恢复提示，它不是通用图标说明组件。迁移不能无差别替换所有 title 或损伤 iframe/内容语义。
- F305 已 done；F284/F307 的早期文档状态与后续实现有时间差。F315 文档仍称 #4293 OPEN，当前 GitHub 为 CLOSED，而后续 Team #4425、Evolution #4319 已 MERGED。旧 AC 的核验必须消费后续实现，不能只读旧勾选框。
- 界面参考是 operator 提供的 Codex 截图。主题、窗口和负载并非完全相同；尚无 Codex 动态时延对照数据。

## What

### 2026-10-02 新版界面中英切换

- **范围**：只作用于v2。沿CVO1309，经典v1除#5027恢复状态与会话外不改；共用组件也不能借换词改变经典界面。翻译对象是界面标签、提示、空态、操作反馈和无障碍名称，不改用户/猫消息、文件内容、真实ID、模型/工具名及原动作语义。
- **用户结果**：可主动选择中文或English，偏好持久保存；刷新以及classic→v2往返后保留v2语言选择。切换不重建Chat/owner、不丢草稿、阅读位置、选区、作品版本或焦点，不影响当前执行、路由和权限。
- **实施约束**：v2新增/迁移文案从同一中英词典取值，两种语言有相同key及参数；动态数量/状态用完整句模板，不靠中英文碎片拼接。Git、MCP、Token、ChatGPT、PR等通行名按认可用词表保留。`Running/运行中`等共同术语沿同一表，F295/F323的现有专名须由原owner共同确定后再改。
- **接续**：复用[F147国际化需求](F147-i18n-hub-locale-switch.md)作为旧承诺来源，本批由F322 B承接v2交付，不重复新建国际化Feature，也不关闭F147整Hub范围。现仓尚无UI locale状态/词典框架；语音识别的language不是UI语言。具体模块/库选型、开关入口与覆盖顺序由原B沿已定设计接续；未画出的新控件不先实现。#5015执行/停止切片已按原scope合入8992e02af7，双语作为其后的v2交付，不把记录需求变成该PR已实现或重新全量验证的依据。

### 2026-09-29 电脑版联合交付目标（最新）

operator `[thread-id]#private-source-id` 要求整个 Workspace 重构，包含今天画的主页外壳与最早以作品为中心、多猫协作的 Studio；明确先走通全部电脑版，手机暂不设计。随后同现场 `private-source-id` 对“保8天还是全部一起做、交期重估”的引用批注明确说“你们评估工作量是不准的，别评估的喵。。。哈哈哈”。本指挥撤回这道期限/范围选择题和按天排程，保留原范围，按依赖推进并报告真实走通的路线。最初“8天”的用户目标保留原始来源，不将本次纠正写成用户已明确取消该愿望；它也不是猫的工期预测、完成保证或自动发布授权。

本批新手机设计和 390px 专项交付后置；原移动/触屏 AC 保持开放，既有路径不退化。Café 与 Collective、完整草稿/选择/滚动/布局返回、既有暗色可用性没有被删减。以作品为中心的五类桌面场景逐项核真实主动作，F315 19 目的地继续逐项结算，不以今天稿件或 token 替换自动关闭历史承诺。默认发布依据 Alpha 实物、独立验收与 operator 判断；不足则具体报告而非改称完整交付。

**用户可见分段已接受**：0.5出1.6稿；1换新外壳；2走通主页→作品→带原草稿返回；3交小信箱“需要我处理＋全部工作”；4交作品Studio的批注/版本/采用，再推进阅读/视频/会议；F290共同体、F321记忆在共同规则和接缝清楚后并行；收尾交剩余管理页迁移、独立整页与Alpha/operator实物判断。重点看1、2、4。1与2/3可按文件/接口并行，不等整壳全完；哪个阶段替换旧入口，就在哪个阶段保真下线。原A–E继续作责任/AC坐标，不因用户分段另建同scope任务。

**推进原则**：每个可看的开发结果直接贴运行截图到chat，带入口/版本/视口及真数据或fixture说明，让You即时反馈；忘记的约定先查原消息/记忆/md。按CVO967与F314复盘G例，进入第二轮review或更早出现重复时，作者/reviewer先就地判断是否改善用户结果或防住有证据的安全、数据、授权、正确性风险；取消无增量确认、无收益机制和无关重跑，修复/证明范围一次说清。不是“用户看不见就不修”，也不是两轮后自动放行，不新设第三棒审查。具体原则与证据见Roadmap，不以截图或流程完成代替必要验证。

### 2026-09-29 统一设计与交付分工（当前）

operator 在 `[thread-id]#private-source-id` 要求按整个 Workspace 重构考虑，先统一主页设计，再分清作品 Studio 与其他页面的责任。Astra 在同现场 `private-source-id` 提供修订分工与功能清单；Opus 5.5 通过 `coord-27df8b98-c38f-4c5b-8de4-54da56035289` 的 terminal Release（hop 1）全部接受。此次是分工收敛，**不是主页、70/30 布局或 D 页面已经通过 Design Gate**。

- **Astra 负责整屏结果与交付**：A–E 顺序、场景与功能保真、跨领域接线、旧账和验收不转移。其他 Workspace 页面由原执行猫按同一语言先出整页稿，Opus 校对一致性，不要求他亲画 19 页。
- **领域责任不变**：F309 管作品内交互；F322 B 管外壳/Café 侧栏，C 管连续性；F307 管布局，F290 管世界/权限/Collective 目的地，F317 管陪伴/会议。指挥协调这些 owner，不接走其实现与数据权威。默认左右作品姿态与显式整窗沿F307布局合同；10-02 KD-25已收窄KD-7的固定物理位置，保Chat挂载/数据权威，R10/AC-D5仍未实现。不能以静态稿或合同登记冒充运行交付。
- **先设计的范围**：新增或实质改变布局/交互先看真实尺寸整页稿，未接受的新布局不进生产。错字、已定样式回归、tooltip/键盘缺陷沿原授权修；不新增“先停 A/B”审批。原 AC 与 A→B→C 的共享文件依赖不因设计集中而消失。
- **独立验收重排**：Opus 是 B 本批设计作者，撤销“B 由 Opus 独立终验”的固定安排；各批次另选未参与该设计/实现审查的猫，operator 仍看实物。D 当前修订作者为 Sol6，不能再将 Sol6 记为该修订的独立验收者。

### Phase A: 看懂入口

先处理主导航、常用图标按钮，以及侧栏 ThreadCatStatus / ThreadItem 的猫形状态、首选猫靶心与标签色点说明。F290 KD-3 / Host Contract 已要求 global rail 作为世界切换器，不能因整理 Café 主页删除；页面目的地迁入当前世界的侧栏。导航目的地不依赖 hover 才能被理解，陌生图标使用可见文字或明确的文字菜单；短 tooltip 只补充用途与真实存在的快捷键。鼠标、键盘、触屏可完成同一发现任务，保留审批、Needs Me 与静音前台猫的稳定召回。共用 primitive 从真实消费者需求提取，控件测试与产品修复同批交付。

### Phase B: 整理日常主屏

**10-02执行/停止已合，独立Alpha局部通过**：ROOT核[#5015](https://github.com/zts212653/clowder-ai/pull/5015)于2026-10-03T04:43:02Z合入`8992e02af7bc90aafecd0b65ea07a8fe9f84b730`，终稿`7de246240b397b5e9868e4c75e4f8a72b18bdb22`；[#5017](https://github.com/zts212653/clowder-ai/pull/5017)于04:46:16Z关闭且未合，原diff影响classic，所需v2停止行为已随#5015交付。下方494–1049等段落是各时点历史，不再代表这两张PR仍OPEN/DRAFT或等待旧门禁。

以真实空闲/繁忙/出错、长中文标题和拥挤多猫列表对照，整理 sidebar 元信息、聊天空态、composer 上下文、重复工具层级和非阻断维护提示。收纳低频信息时保留完整恢复路径；不自动启动索引扫描，不因空态关闭用户主动打开的页面，不硬编码全局图标/按钮数量预算。

**第1段消费现有可调主题**：operator `[thread-id]#private-source-id` 的配色提醒及主页README §5（`3f9dc903506c39fa96f1a49cfbd67f9299b8e446`）已消费。`themeStore`支持浅/深色参数覆盖及两套自定义，沿现有`ThemeApplier`/`buildCSS`生成与注入；保已选主题、覆盖参数和自定义偏好，不另造主题store或将T1十六进制样值固化进组件。外壳使用现有表面层级、文字、边界、强调和语义状态角色token；内容图片与猫猫球等角色素材保自身颜色。首份可操作外壳即在深色与一套调过的自定义主题下检查表面层次、文字/图标/焦点和浮层对比，记录真实结果；主题能力存在不算验收通过，原深色可用性承诺保持。同提交的Studio j1–j6是能力/契约核对中的首稿，不属于已确认1.6实现基准。

| 位置 | 已定收纳 |
|---|---|
| 全局窄栏 | 上方为F290权威世界目录，超量“全部世界”名单只从窄栏末尾“…”打开；下方依次小信箱（唯一待办入口）、前台猫、头像。保留用户自定义；设计稿将已钉快捷入口放小信箱上方、细线隔开，默认不钉，原pin迁移后仍显示。头像直接进“设置与管理”，不再开杂物菜单 |
| Café侧栏 | 新对话、搜对话、全部作品（当前世界）、世界级记忆、对话列表；移除待办行与重复世界下拉。Collective侧栏同称“全部作品”，由F290承接；F321侧栏记忆页归一重构`/memory`，原页功能都有去处后旧入口才下线 |
| 对话顶栏 | 当前对话的作品N、任务N与Workspace入口；任务沿F160当前thread保留创建、详情、改状态。跨对话托付工作在小信箱“全部工作”，不计入需人处理的数 |
| Workspace | 只收这条对话/这个项目的工具，**记忆（保留）**展示本对话里猫用了哪些记忆，由F321原地改进。审批、Needs Me、产品Schedule入口收进小信箱；任务/产物入口迁至对话顶栏，保原对象、动作与可恢复访问 |
| 头像→设置与管理 | 1.6当前目标一级10项：猫猫团队、调度、能力进化｜连接与扩展、系统、主题｜社区、猫猫星球、Mission Hub、信号；评估并入能力进化二级。**已合导航仍11项，待领域承接后迁移**。现14个设置分区均有二级去处，默认猫猫团队→成员与运行时；产品Schedule与后台调度管理仍分开 |

小信箱不再在侧栏或头像菜单放副本，前台猫也不在头像菜单重复；旧1.3双具名入口与1.5“A＝侧栏行＋窄栏”被本决定替代。**第1段第一份可操作shell就验AC-A1/B5/J3**：不悬停、不提示点头像，辨认并打开小信箱/前台猫/头像，能返回原处；不足在原位置加短标签，不重开A/B或恢复副本，不拖到最终收尾才首次看。静态hover/ARIA不算通过。作品准入与版本族仍由F232/F309落实，不用附件数冒充作品数。

**设置呈现迁移已合，独立验收待做**：#4947在 `fe050e8e55` 实现11项一级导航与14个原section的消费，另含主题/界面版本设置；本次不宣称所有子页内容已重构。主页README `f352e25a7f` 的“旧入口→新位置”表已覆盖 `settings-nav-config.ts` 的14个分区（本thread回执 `private-source-id`）；模型账户与密钥进“连接与扩展”，不再用不存在的You个人账户页顶替。原renderer、section ID、`/settings?s=…`及附加定位参数继续有效，默认仍承接`members`；未迁内容从同一设置入口可达，本轮不要求重画全部子页。后续 `8abc184852` 已明确演示浮窗开关保留在窄栏，只在`presentationSurface`存在时出现，保跨页面收起/召回；不算第四个常驻入口。

**1.6增量已消费（`203c28bd66`、`465fb108ee`）**：operator `[thread-id]#private-source-id` 指出两处“作品”难区分，设计作者将世界侧栏命名为“全部作品”，顶栏保“作品N”（当前对话；共同体为当前频道），保留顶栏的解读不冒称operator逐字指令。“全部”仍受当前世界和原权限约束，不是跨所有世界的集合。operator同thread `private-source-id` 明确保留窄栏自定义，撤销pin待判断项；设置与管理一级/二级均可钉是设计作者的待实现方案。现`usePinnedSections`为浏览器本地存储、最多8项，`ActivityBar`仅解析14个设置section；不能据此宣称全目的地已可钉。原pin及偏好迁移后仍可达，默认不钉不清空已有选择。

F290共同体前端归一、F321记忆页由CVO942/967交原领域负责猫；Opus已通知 `[thread-id]` 与 `[thread-id]`。本路线登记共享设计/宿主/整页验证依赖，不代接领域实现；分段已接受，相关交付尚未完成。

**记忆范围已定，不再等待“新去处”**：operator `[thread-id]#private-source-id` 更正后，[F321 KD-6、AC-A6/A7](F321-memory-sky-experience-loop.md)已在 `9d20cf1ae9` 重写，主页README同步于 `96162c2eea`。对话级`RecallFeed`留在Workspace，新旧外壳都可打开，F321原地改文案/说明/样式；没有You认可且已上线的替代不下线。“之后没观察到读取”是观察，不能写成“忽略”。世界级侧栏记忆承接原`/memory`的知识动态、搜索、索引状态、健康度、图书馆、知识图谱及F321新页面，原功能都有明确去处才下线旧入口。两处数据范围不同，不以“每样只放一处”误删对话级入口。

F310 已通过本 thread `private-source-id` 接受统一注意力的产品/只读聚合合同归 F310：联合 F246 合法审批与满足原门槛的 Needs Me，不将后者的 Task/Artifact 门槛加给所有审批。`projectCompanionDecisions` 的统一只读扩展已由 #4936 交付独立事项/可证总数、partial 与独立于 Live 的 Host 读取（见下）；跨源映射仍须原领域见证，小信箱实际消费与动作旅程仍待交付。F322 不另造算法或数据账本。F246 的 `private-source-id` 确认复用 canonical item 与原 producer renderer，保双锚、历史/筛选/安全批量能力；三种处理结果的逐项重读尚非现成实现。具体能力边界与 F310 原工作视图执行坐标见 Roadmap 当前设计节；原权限、动作 revision 与精确返回不变，领域回执不算界面或业务验收通过。

**消费合同与剩余责任**：显式 `view=unified`；当前Host路由上限20，交付README所写50已向原作者发更正1903，按源码20消费。总数只用完整coverage与verified一致性时提供的totalCount，partial保可读项、不补0；冲突variant保留。`UnifiedAttentionVisibleApproval`复用canonical `ApprovalHubItem`并只省owner；先核根identity等于可信session，还原owner仅满足读取身份要求，动作还须匹配原审批store中的producer/proposal/版本/生命周期并走原renderer复验，不能直接把只读DTO交卡当动作已通。原B作者Sonnet已实际收到landed消费包 `[thread-id]#private-source-id`，沿原1486工作包继续接线、逐项结果重读与准确返回；此前cd15候选/独立批准仅保留为历史。后续S3-1已随#4959合入，整高面板又随#4969交付（见下）；原动作/全部工作与AC-B5、第3段、整页验收仍开放，不用读API或单片绿灯替代。

**S3-2a已合，AC-B5仍开放**：原B终报 `private-source-id`、gh及[合入清单5926167907](https://github.com/zts212653/clowder-ai/pull/4969#issuecomment-5926167907)已核，#4969于06:43:33Z合入 `edb42c7b5cbf86b331211b9ad68205aebd8bfee5`。整高非模态待办、单行展开、旧行禁操作及按真实能力定位/具名列表降级已交；设置/记忆→已记住对话只落坐标不跳转的P1经独立浏览器红绿关闭。Opus55 typed2491与Sol6.1 typed2498批准c9dd8b8c85，八提交range-diff全等承接final1eb1820a9c/based532。targeted/exit3只分类，欠项由规范浏览器09018fe2四单元全绿和231单测等补齐；首跑84f37bb9缺依赖构建红保留，未跑full。作者非空统一读是夹具；原观察者2577随后在edb报告真实Alpha整高/关闭/空集增量PASS，行展开与旧行禁操作为合成标记样本；真实非空及整轮删除/归档未终态。

F310在本thread `private-source-id` 进一步核定：Collective原请求的“交给它持续处理”是主动操作，按钮可见不证明本人欠一次接纳，不直接计入小信箱；standingWork已有授权可自动接责，不能重复要求人批准。原请求上保Host接纳、准确工作链接/resume，新位置保住这些能力前不删抽屉。真实接纳后同一Task进入“全部工作”，未接纳请求不冒充已有工作。未来只有F290权威证明current需本人接纳的状态才接统一注意力；不伪造Task/Artifact或借result producer补资格。

F290原owner的本thread回执 `private-source-id` 及 main `8d11d6d85c` 已确认两项迁移合同：保期限澄清、公共/私人准确来源查看、Host接纳/按当前revision续办及返回，接纳复用同Task不等于不同requestId的resume不重复执行；新承载实际走通前保原抽屉。Roadmap收为共同体侧栏唯一目的地，频道工作卡定位同一world/roadmap/Work节点并保频道筛选、可见选择、往返回源；失效目标不猜首条/替代，置顶/资料及原权限动作不随去标签取消。细节见原Roadmap及[F290合同](F290-ai-native-collective.md#2026-09-29-信息归属家内接纳与唯一-roadmap-目的地)；领域裁定已齐，新页面实现与整段验收仍开放。

operator `private-source-id` 随后指出真实壳间距不如第三版：保世界层，恢复第三版内层节奏。导航与列表工具整合、行内信息靠近、组间留白、去 composer 人工大补白，在同视口真实列表整页比较；不能把固定列宽或生成图当视觉通过。原执行现场继续修订，Design Gate 保持未签收。

**名牌Alpha失败的原B处置**：3264运行版本f2efef029f含c2d7，归档时checkout/后续仅文档差异已核；本owner查看失败原图并核调色器→持久主题→名字CSS角色→名牌消费链，接受该P1可读性缺口。3268已实际投Sonnet沿现有writer优先RED→GREEN并检查同角色相关消费者、保存恢复与经典保真；独立修复#4985现已合70f653fcea，原观察者增量复验3539已获3589 scoped PASS，详见下段。人的#4983经历3412可见性批准、3499暗色文字P1与后续不透明8位色P1后，已由Sol6.1 typed3639批准32c0；10-02合入c20213de，绿票与连续性见下段。旧866d是历史候选，不再记待复审。不重置用户主题、不放宽阈值。active-streaming hover与organic compact只记未验证；前者已有真实80行执行历史，但紧时序补采被安全面拒绝，不绕过。修后沿独立Alpha相关delta复验，body-lg/代码块/首次观感/whole B与待办仍开放。

**#4983合入证据与运行边界（10-02／439）**：已核[PR及E1–E5清单](https://github.com/zts212653/clowder-ai/pull/4983#issuecomment-5946780656)、typed3639批准和`5cde2678`终态原件：run `48c3e1bd-5e95-4176-9970-fbfdecb1499e`在冻结HEAD `0a717485`／base `175c4921`退出0，用时680373ms，最后check自测676/676；之前bridge移交红这次通过不等于根因已修，仍归Task512。本owner复核reviewed32c0→final`f8cd3051764fda372bbe67ecd5efd95b1cbd347c`的15项range-diff（12相同／3仅policy上下文与版本）、policy外补丁一致及final→landed的43/43 authored blobs一致；rebase后37测试、planner51/0、census183与tsc为作者清单证据。新main的#4992守卫由其自身验证承担，不把旧冻结票外推。`main=landed`、`live=dormant`；不重启runtime或覆盖保存配色，作者439报告运行配置仍为旧`#815b5b`，本轮未重查runtime。独立Alpha沿445已回513 scoped FAIL：布局、分段、真实配置链与代表文字对比通过，但opaque8回复背景缺失；该缺口已由#4998修复并获773/775独立Alpha scoped PASS；旧513保留为历史失败，详见下段。#4989→#4986→#4988及原B其它欠项保持，AC-B5不勾完成。

**过程可见性状态纠正**：You2792与Studio README §0.7及#4977已确认三层、记录默认收起、一行状态、个人默认＋本对话覆盖的方向。待补的是召回N计数/定位、状态证据、执行归属和具体档位合同及实现；不再写成方向“未授权/仍讨论”，也不把过程模型改动顺带放入外观切片。

**F290接缝回执2970及Release2990**：原合同owner已确认现有同Service会话viewer与event human actor足够，不改身份/鉴权合同；未知viewer保留左侧实名呈现，属于本人的猫不算本人。Topic/legacy/首猫演示需补显式viewer透传。原领域writer Sol6.1、`[thread-id]`（原Claim1388）已实际释放所请求呈现/透传片段，完整源为B执行现场 `private-source-id`，已直接路由Sonnet；本owner已full核。文件占用等待解除，Sonnet按原2975工作包在独立PR/worktree消费；CollectiveWorkspace/auth/Host/MemberPanel/Work及shared合同仍归原F290，未交接整包或移动Task038/266/676。共同体呈现与主题实际交付仍在B未完成范围，Release不等于实现/验收。

**677/692门禁阻塞与已定路线**：#4988实存外层timeout与browser44green/7cancelled已核；原timed_out凭据/清理证明存在，但后继resume run与原stop run身份不匹配。689已交Full Gate原Astra/Task512核合法恢复入口，必要时独立修复，不fresh/手拼绿票；ROOT保有效canonical终态及实际合入的依赖监护。#5017/#5015当前OPEN/DRAFT d61607412f/4fc95bd416，连续性为作者692证据；5017 canonical在daemon-state断言failed已核，单跑绿不抹红。703已明确原作者在其额度恢复时间21:29:13Z后依次续#5017→#5015，#4988等owner路径；细节见原Roadmap，不据局部证据解除共享房间Alpha前置。

**717更新：#4988现有恢复路径已核通**：原Task512在私有副本完成冻结身份/plan/正式resume与拒绝反例，713已实际给Sonnet原树 `pnpm gate --resume 8ed4af4b-42a5-4216-a9e0-d4fe033ce8f2`。ROOT核投递及验证文件哈希；无需为本次恢复新开PR，当前等待作者按原配额/顺序执行。44复用/7待执行是副本准入结果，原库未执行；browser/guards/lint/check尚欠，未有canonical绿/合入/Alpha，不解除原B/E终态条件。

**895/897顺序调整**：5017新canonical实读F190字号守卫唯一失败，main上#5016引入的media-compare CSS四处裸12px与守卫相符；原Sol6.1已在894收修复证据。897已实际回原Sonnet，先用713合法入口续#4988（本地仍原冻结树、无该CSS），5017→5015等修复合main后继续，替代703先后。恢复绿仍须最终main连续性/适用验证、cleanup和merge truth，不扩写为可直接合入。

**971/984更新**：5022已合6d3c，字体依赖解除；4988 browser gen2确为51绿，但三次canonical末段因进程等待/清理失败，最新27363760仍failed。PID32031在ROOT复核时同boot已恢复health200，日志却证实曾有约9分钟请求延迟，根因仍未确定。975已实投原Task512 Astra沿C/D作PID/API与Gate关联只读诊断，984回原Sonnet保持停止重复重负载续跑，待具体验证条件/处置再续4988→5017→5015。未重启/kill/改runtime或豁免E5，原B/E及合入后验收边界保持。

**1004继续条件已给**：原Task512已将1003直接投Sonnet，区分started readiness超时与真实live≠dead；失败时进程proof仍缺。e510自然终态按全stage/browser身份/cleanup与资源归还证据判本候选，绿后仍核merge连续性，红则只采具体反例而不再完整check试运气。API当前短测恢复不证明历史长延迟根因已消失；另一个sweep证据非法问题已由原owner投F167原Task320，未混作延迟原因。

**1023冻结候选已绿，合入连续性待完成**：ROOT实核e510退出0/870401ms、canonical `26012f9e-8484-4480-9a68-c56348cbe31b` terminal green（执行817808ms），仍为03bc/tree2b3c/base32921/full/effe；九required stage全绿，八项复用、check本次通过。browser gen2为51/51（44复用、7执行），51份cleanupProof均proven；check资源回执released且本轮token-scoped后代清理proven，三次空扫描跨度701ms超过要求250ms。作者撤回971的主机过载根因断言；历史失败因果仍未知。限定证据已实际投Task512的1030与原Sonnet的1031。#4988仍OPEN，由原作者完成最终HEAD/main连续性、适用验证及原review后合入；#5017/#5015仍暂停新增重负载，独立Alpha和whole B/E未通过。

**1049已合入，独立Alpha续接1066**：gh实核#4988于2026-10-03T00:59:54Z合`84d67f3eecdab8da11db3de192e03a7f7b856ca5`，final`989e39fdb27ed18f9613ef83c5379316ae772201`；ROOT逐blob核37/37作者路径与merge全同，final base到merge parent只多本主账两文档。原typed1057、冻结绿票与最终连续性/定向验证清单已消费，最终组合未复跑嵌入浏览器，真实设置/整房间仍待独立Alpha。1066已实际交原观察者Sol5.6沿1346续接，先核占用与含merge的真实Alpha，再验Host→Service→Client和保存主题/人色/状态保持，不据合入勾whole B/E。Task512的1040/1044已给串行继续条件：4988连续性处置后5017→5015一次一个canonical准入重任务，不另并行full-web/check，同类RED先采证；Sonnet1049已沿该顺序续办。install/build/check本次仍执行，历史cleanup/API因果调查保Task512，不再作为无关PR无限停工前提。

**986/988合流边界**：5008已核合c195，5000已核合d6f；C982已实际收到Host landed Release，可沿原reading consumer续接，不再等旧候选，最终B挂载仍等C相关实现进main。F307 Task1034的真实generation1等待新Web包含c195，当前runtime同boot32921恢复health不等于激活；R10及整J5仍开放。另988的e510 gate在984暂停处置送达前已启动，ROOT核running，993已补投Task512，不追溯取消；其后仍暂停新增重负载续跑，既有终态不冒充根因修复。

**C704首份找回往返实物**：远端branch d68a7ec3f45fdc73d3ca11b43c6a4caa7422c80d与作者README已核，人的多结果/点时来源复核/原阅读owner刷新定位/切换与exact return已有受控浏览器实物。137前台/24API和3条Chromium为作者证据，非main/Alpha；其测试产品head f4696b3f91与d68的注册/证据增量分开记。三处c30 Host文件逐字未改，原挂载顺序保持。原C701已请Opus55独立branch审查，consumer full、原查询与Host合流、全猫/远程人/F321/冷历史及整J5仍未闭合；ROOT不增派重复review。

**执行行第一份实物（494）**：#5015 OPEN/DRAFT@`3782256a36f05de7a1101b27d7c0106ce5cc5daf`交独立ExecutionRow/展开面板与20项动作矩阵，尚未挂载；原B Sonnet已取得独立树，215的该项容量阻塞解除。ROOT核PR原件/14路径，183单测、9变异及planner 6单元0缺口为作者报告，尚无browser/gate/视觉验收通过。509已交作者补组件preview、旧reset误报与“已中断”标签后在原B请Sol6.1正式独立review；F220508已告知。512实投C的挂点顺序为F307已释放Host→C搜索/reading-port→B Header菜单及同Chat footer；ChatInput内部停止按钮可独立先做。保全部队列信息，foreign_principal按真实主体说明；缺确切正在输出的消息目标则不做假跳转。旧入口未保全不删，wholeB仍open。

**566增量：作者预览已补，review已实际请求**：#5015更新为OPEN/DRAFT@`7fe97d20a476f74e3f7dd07f2aa6c2bbb69e9c41`，作者交193单测与7条组件browser/4变异证据；#5017 OPEN/DRAFT@`d92b392671d6e5917e1118ff349c7271aa2dca9d`交ChatInput停止按钮独立条件、190单测及3条browser。ROOT核PR、549/565审查请求和组件证据边界，Sol6.1独立review未由此批准。`interrupted`更正：queue targetStates producer不输出此态，消息回执另有投影；新增标签/未知态兜底属于防御性兼容，不记现存线上缺陷。旧reset失败误报与processing参与reorder的400由作者红绿修复。C530已释放`c30ec7f0d3`三处Host hunk，但含未合#5000/#5008；574/575明确标题菜单独立先做，挂载等相关实现进入真实main，不把冻结分支当main。完整gate、生产同屏/真实API及Alpha仍未由这些预览覆盖。

**原B第3段现在与第1段并行**：已向Sonnet实投1131续原2b-1c/1d，安排在独立树消费已合F310统一读取和F246原卡动作/attempt/reconcile规则，先交“合法事项→原动作→双源重读→准确结果/返回”的可操作mailbox实物；不等wholeB Alpha，不热改#4988冻结树。ChatContainer/Header/Chrome只串行必要hunk，C/F307未Release的恢复/几何片段不并写。此为原B已授权交付的续接，不代表动作接线已完成，不新建Task或移交领域authority。

### Phase C: 连续工作与响应

每批都走完整用户旅程，C 再专门结算跨表面的恢复和实测响应缺口。打开作品、临时主区阅读、返回、换对话与刷新沿 F307/原 owner 契约运行；后台事件不抢 focus。区分首反馈、数据就绪、流式输入与滚动性能，用相同环境 trace 定位问题后修复，不先假定架构必须重写。

**09-30滚动P1原C续接**：Alpha源1623/1620的Back与刷新恢复缺口按AC-C1/C3现在推进，不等待B全部收尾、不塞入记忆导航#4952。已沿人类149原授权typed resume原C Task `private-source-id`；责任仍由主thread Astra持有。operator新指令 `private-source-id` 明确将本C执行猫由Sol5.6换为Sol6.1；旧提案 `proposal_muop0v47jp76j8ye` 已withdrawn且未创建child。替换提案 `proposal_muos03ufey8a5pe6`（卡片1806）仍绑定原Task，链首为Sol6.1（codex61-sol）、Opus55可作非作者review，final-only。后续实时核已approved并创建 `[thread-id]`，自动首帖1811已具完整原工作包与回流路由；不重复派发，完成仍以实际交付为准。代码确认模块Map不跨刷新，但已有messageAnchor/布局校正；Back漂移与是否由新壳触发仍需版本对照/trace，不把“旧build也红”当早于#4947的证明。用户阅读锚点/可见偏移与草稿、底部follow和显式跳转意图一起验，算法尚未预定。Sol6.1作为本C作者，不独立验自己的滚动修复；交付时另选未参与其设计/实现/review的独立观察者；原#4950局部PASS保留，整段连续性不提前签收。

**第2段在实施，完整作品旅程未完成（10-02）**：#5000当前OPEN@`408515fb599424833395e89d414d4d810152bffe`，原C Sol6.1已交共用查询实现，Opus55 typed1118批准治理/鉴权增量；canonical gate仍沿原作者闭环，不据局部批准签完整J5。1128已续原C结果卡/顶栏/原阅读往返；已向F307原Sol5.6实投1129，按已接受KD-25/R10/AC-D5核具名writer与窄接口接续，旧activation Task不冒充R10已开工。第4段已向Opus55实投1130，先做原F309 K1/K2内容/context/接口准备，就绪K3/K4沿原scope与释放续接，不等所有UI，也不提前动未交付的同composer/return装配。具体真实停点在Roadmap同节，不把找回切片当整窗作品完成。

**10-02第4段准备回流与开工安排**：Studio143交付§1.5五张静态稿及消费清单（`7179c9ad2c`），F309原owner已核并登记R28–R32/OQ-4–6（`ebc12cb9e7`），五项均未完成。ROOT已实投F309原owner165核原载体并接续Sonnet前端/Sol5.6后端。另已full读operator Studio156（`private-source-id`）“设计的差不多的都让他们开始干活”：原B/Sonnet的一行执行可直接沿现有状态/动作做独立组件；K3由F309核writer后接Sol6.1；K1/K2后端先冻结OQ-4与F063引用版本接缝，前端消费已冻结接口。读取/视图的真实数据仍等原契约，不把设计就绪、通知送达或缺口登记冒充实现接纳。OQ-6唤醒策略仍为待校准建议；R32缺聊天回执/主动送达，不是猫完全读不到已有记录。

**231回流后的真实停点**：F309父Task909 r17仍只持规划/交接/产品审视。后端Sol5.6的212与K3 Sol6.1的217均确认无当前实施载体、无文件claim/PR：前者拿Studio156在另一owner线程解析会被source-scope拒绝；后者不在旧proposal的`codex6-sol/codex-sol`批准名单，已终结批次不能因显示名或阵容替换复活。ROOT核原904、Task与委派源码，已交原F309 owner核已接受窄工作单元→原线程resolver→真实子工作/唯一获准执行载体的路径；未宣称接纳成功，不复制909或借B/C lease。B执行行另由Sonnet215接writer，无树准备继续，但创建独立树被实测40/40容量门禁拒绝，原B Task保留该阻塞。

**255补全前端事实**：Sonnet在F309的`private-source-id`也确认K1/K2/K4无当前实施载体、未claim文件；三位指定执行者目前都未接纳K实施。K4可先复用已有selection→quote→composer，仍须合法载体与worktree；K1/K2消费等待OQ4/R30/R32接口。其原B先获准的执行行优先使用自己#4988/#5006真正合入清理后的第一个名额，K前端随后，不占或清理其平行会话的树。F309父Task由原owner续至r19；ROOT267已实投原线程解析具体工作单元的下一步，未据此写成实施中。

**308续接实证：子工作已接纳，执行委派待批准**：原F309 owner已用本线程CVO904经resolver接纳后端Task287=`private-source-id`与K3 Task288=`private-source-id`，各r1/todo、parent为909，acceptedRevision均`ebc12cb9e7`，分别绑定既有计划的“修改请求与真实返回”及`artwork-focus-experience`。ROOT核Task原件及实时proposal GET：`proposal_mur8xkpjsuspuutc`仅绑定287/目标Sol5.6，`proposal_mur8xktpj941zxzi`仅绑定288/目标Sol6.1；均pending、尚无createdThreadId，卡片300/301在F309原现场。因此原“没有可接纳单元”阻塞已解除，当前等具体委派批准，不写实施中。父909仍持原规划/产品回流职责；K前端与B执行行顺序、容量和接口停点不变。

旧账明确承接两处既有承诺：其他文件 `file_change(Y)` 进入不抢焦点的 Activity signal；在现行 F307 宿主恢复 Presentation Lock 的合法入口与互斥呈现，并覆盖 Files 最右动作的键盘可达性。对应 F284 R4/R11/R16/INV-15；不能以“书面说明暂不做”结算为旧 feature 完成。

### Phase D: 兑现已有页面承诺

原D Task169已实际登记runtime Web包含2ac的单次部署等待（generation1，autoRenew=false，state_only），状态blocked；就绪回调后只读原真实多会话入口并给operator看，不自动重启。Hub预览unconfirmed；B1633的Alpha d52不含2ac，不能用于签D/F315。下方恢复候选/等待合入叙述是历史，整D/F315与operator populated同入口接受继续开放。

F315 原三页最新实现核验与方案修订同 A 启动，不等全量 census；随后按原有批次处理 Status / Sessions、Approval 与剩余已登记目的地。F315 B1–B4、P1–P3、C1–C4、D1–D3 在其原文中保持 canonical，F322 用逐 AC 映射承接实施/验收，不能重新解释成泛化的换皮任务。F056/F269 与本路线直接相关的 delta 同样逐项关联。

2026-09-30 operator 在原 D 现场 `private-source-id` 要求闭环 #4906；Status / Session Chain 回修已合入 `a7b2d4a0cc6fe78f88227d80ed176dfe87d87320`。运行猫计数与未封存记录分离、歧义目标保护、具名详情与操作入口已进入 main，Sonnet 的独立批准经四笔 patch-equivalent rebase 延续，最新定向测试 381/381、Web 类型检查通过。该局部交付不等整套 T1；真实多会话的视觉验收及 Phase D / F315 C1/C2/D2 仍开放，不能用 fixture、PR 合入或作者自验替它们签收。这份呈现在10-02再次被operator退回，恢复要求以下段为准。

原作者Sol6.1已交[PR #5027](https://github.com/zts212653/clowder-ai/pull/5027)，早期gh核OPEN/DRAFT@`53134448f2f25482dfdece771f496efc67a9d75f`；原版检查先51/82失败、作者恢复后398/398及变基后386/386为作者证据，浏览器原申请排队超时、测试未执行，后继有界托管仍待实际结果，未有正式批准/合入/Alpha通过。1213=`[thread-id]#private-source-id`已把最新中文/ID直接复制/小卡与就地禁用理由对齐到同PR；保留#4906单一运行信号、歧义目标保护和live用量归属，不改后端权限/存储，不全树回滚。窄Workspace420/300px与全viewport390分开验；原Sonnet非作者审查、原作者自治门禁合入，合入后独立Alpha与operator同入口接受仍开放。原D Task169由ROOT继续持有，未新派writer或镜像Task。

**1263纠偏：v1恢复与v2设计分开**：operator `[thread-id]#private-source-id` 追问为何v1未恢复、F322究竟在做旧页修补还是北极星。ROOT核ChatContainer两个入口共用RightStatusPanel，状态页无classic/v2呈现分支；不能把Studio1226的两版融合讨论当成再次改造经典页的接受。1295=`[thread-id]#private-source-id`已撤回ROOT1249追加的第三版布局，Studio已由1300知悉。作者1305已将未提交的10个tracked改动、7个新文件及日志留存后撤出，ROOT核manifest、分支干净且远端#5027仍OPEN/DRAFT@`61c95f020d70abf234dee4f1ef88acb3d1eb5ece`。407/407仅属撤出的第三版，不计入v1；当前恢复候选390测试为作者证据，实际浏览器/正式review/合入/Alpha仍未完成。原1086/1167紧凑原版、直接事实/复制与#4906正确性保护继续有效。 随后1335和gh实读确认发布HEAD更新为31badd559f69dd7df6c20f8acceda50564f9cbe9：原恢复范围内修正ID换值/迟到剪贴板反馈，作者391/391；第三版仍未并入，浏览器/独立review未完成。

迁移账 v2 区分 B4/P1/P3 当前成立或已落地、B3 待独立核对、B1/B2 部分成立、P2 仅 finding 与 C/D 未终态项；不把 14 条一律当作尚未开发，也不统一打勾。三页消费 F293/F310/F311 的最新载体，补真实数据、populated/窄屏与批次验收，避免覆盖原领域正在推进的工作。

### Phase E: 随批次结算并收口

逐项记录旧 AC 的当前证据、唯一责任与 disposition。新 feature 管交付节奏，旧领域 owner 管行为和数据；尚未完成/未移交的明确开放。F284/F315 可在承接与独立证据齐全后提出归档/关闭，F307/F277 保留运行机制与分组 owner，F305 保持 done，F283 保持 frozen且不进入实现范围。关闭跟踪 feature 不删除 canonical 架构契约。

### 执行组织与部署后验收

按上述Execution source，主thread `[thread-id]` 保指挥责任，不接收逐PR审查。CVO967历史阵容为Sonnet/Sol6主前端，A原Sol6、B交付Astra、C原Sol5.6；D已由Sol6接#4906。当前新分配沿Sol6.1偏好，本C另按CVO1803明确替换为Sol6.1；不改Sol5.6的F307/F290原领域责任与历史验收来源。Kimi曾交的D/E材料保留，但不作为本轮可用新执行/审查人力。执行thread自治选择非作者reviewer并完成适用门禁；一可独立验收单元一PR、多commit，D按整页批次，不逐控件拆PR。作者/审查者因阵容变化重合时，重新选非作者，不复用自审。

**独立现场不等于依赖消失**：原 A→B→C 顺序在 09-29 联合交付中细化到文件和接口；C 从起步核返回契约，独立文件可并行，共享路径按单写者和实际依赖合流。D 原修复不等整套 T1，E 持续对账，关闭仍依赖实物与验收。operator 在 `private-source-id` 追问后撤回的 B/C/重启后验收提议保持 withdrawn；新安排不是已创建执行现场或已取得 lease。

**09-30原B首批实现已合**：`gh`核[PR #4947](https://github.com/zts212653/clowder-ai/pull/4947)于20:25:05Z squash合入 `fe050e8e55e02ee2a1b6caf5a7afc8b3baa8f9e0`，最终head `643887f8b44ae0119cb9e670d2a076221a749909`。提案 `proposal_muod0io8crggs1lp` 实时为approved，真实执行thread=`[thread-id]`；原B Task/owner/scope不变。已落地52px窄栏、Café侧栏/文字状态、当前thread顶栏、11项设置导航、共用图标与150ms提示；入口为 `?shell=v2`、设置与管理→主题→界面版本或旧主题菜单“试用新版界面”，默认classic。`main=landed`、`live=dormant`；不是第1段全部旅程或B验收完成。作者终报 `private-source-id` 已消费，未登记development_return的事实保留，不对已返回结果虚设等待。

**独立验收与明确未交付**：Sol5.6（`codex-sol`）已在原执行thread获具名Alpha验收/本批愿景核对工作包 `private-source-id`；其未参与本批UI设计、实现或实现review，已在原执行thread消息1356第一人称接责并受管启动Alpha；作者Sonnet/设计Opus55/reviewer及测试作者Sol6.1不自验。独立终报1623已到：Alpha build为9204b5ad9b，图标局部PASS；真实滚动恢复P1、记忆完整返回及You首次观感仍未闭合，总体AC-E3开放。侧栏“全部作品”和顶栏“作品”实际同开当前产物面板，F307 `artifact-list{scope}`与`capability-evolution`尚待落实，后者现在落Workspace launcher；作品数未定义不显示N。F290新rail目录hook当前恒unknown，没有真实世界列表/溢出；F310统一读取已合03df，原B小信箱消费仍待完成、不加旧数；F321世界记忆仍待归一。上述是原范围内未完成项，未获删减授权，不能因如实呈现unknown而签收AC-B1/B4/B5/C1或第1段完整旅程。390px新设计后置，原路径可用性仍需验。

**世界记忆路由已合，独立Alpha仍开放**：[PR #4952](https://github.com/zts212653/clowder-ai/pull/4952) 于2026-10-01T03:37:03Z合入 `2d8fc5238bb0c82a261a18e50b9fdb33e1788efc`，最终head `0d1912e861cbe34801e8a9d757898a61fb9cd351`；原B终报2199和[合入清单5924216497](https://github.com/zts212653/clowder-ai/pull/4952#issuecomment-5924216497)已核。Opus55 typed1827批准cc18的UI/删除归档修复，Sol6.1 typed1860批准3f073的policy增量；正式full run `6b838db3-c573-4cb5-8663-17cba740554d` 在冻结d1f22267ba/baseed1dd8e161终态green，本指挥实核三提交到最终head的range-diff全等价。首跑managed-runner测试失败及同冻结resume才绿的事实保留；该空marker测试竞态随后由原作者在#4967合入78eea7ced7修复，后续修复不抹掉当时红灯。

真实ThreadSidebar仍未被壳自动化旅程挂载，14单元预检/单测不替代真实记忆侧栏。已沿1346原独立观察责任，实际交Sol5.6续验源 `[thread-id]#private-source-id`：官方Alpha包含2d8，真实对话→记忆→子页刷新→原对话、click/Enter/当前选中，以及仅用Alpha可丢弃线程的删除/归档对照；不操作用户已有线程。当前发出验收包不等于已通过，滚动P1仍由原C承接。该合入的生产激活本轮未核，不从main或旧runtime观察推断当前live状态。

**独立Alpha已追加S3-1**：原2203续验包已通过 `[thread-id]#private-source-id` 更新版本条件为包含77704912f0及4952的2d8。同一原观察者Sol5.6沿受管Alpha核真实记忆导航和待办入口/session+unified读取；若当前采证已开始，在自然断点更新，已包含则复用。尚未取得Alpha终报；真实非空条目、部分源失败的实物仍未验，作者dev真路由仅空集，合成版式不作真实数据证据。此为S3-1当时边界；后续整高侧滑已由#4969合入，原同轮Alpha2540继续补验，就地动作和全部工作仍未交。

**目录准入修复的已合cut已补验，原八项输入映射已闭**：#4949已合 `3725849089187658931a37780a39ba933c3df38f`，head ceb4129b50获Sol6.1 typed批准1537；#4951关闭未合。零差异cut `bf0716ba5faf8c78e5fc8d4abe17a41c48d6bf90` 含该修复，正式run `ef1fc48b-9d3b-4243-a8c3-ae1c6d99ab5a` 已核full / terminal green / reuseEligible，next build47/47、web1026文件8073测试与lint/check通过；该cut的full和build欠项已补齐。合入前E5未过及错误授权归因的更正记录保留，不追认当时通过。bf0716→c7cf27含F317代码及policy/planner变化，并非仅docs；已回作者1742，作者1743已就地更正PR评论并经本指挥复读；绿灯不自动外推当前main或其它候选。#4953已合bdf8a9302fad67d56d615f55ca8c31167127ac63：自身reviewed head9a08cfbd00的正式full green与四笔等价rebase连续性已核，七项原映射缺口关闭；最后一项ChatContainerHeader已由#4960在 `7506789a288945b980106c457905e3b42312ed69` 闭合。现有shell夹具手工接同一store挂真实v2 header并登记f322映射，无新增旅程文件/配额，不把它称为ChatContainer真实接线或Alpha看过。原B整体验收及四消费线各自验证责任保持。

**测试欠项已结清，产品验收继续**：原B终报 `private-source-id` 与gh核[PR #4967](https://github.com/zts212653/clowder-ai/pull/4967)于05:36:11Z合入 `78eea7ced7a758564958b055158af4f1f0a9424f`。空marker竞态改为等待调用方接受的文本；shell旅程进入web根并在结束还原cwd，managed-runner测试映射补入原control组。四个测试/策略文件，无生产源码变更。Sol6.1 typed2308批准与正式full均为exact9880974928/baseaf04ea61b2，full及四browser单元全绿；[合入清单5925426369](https://github.com/zts212653/clowder-ai/pull/4967#issuecomment-5925426369)保红绿、变异与定时器清理P2修复证据。只结清这两项测试欠账与对应选路，未把配置层`content.relative`、真实ChatContainer或Alpha验收算作完成。原B作者接续S3-2，原Task不增不迁，整段与S3-3继续开放。

独立验收按实际批次作者/审查参与关系安排，不将角色名永久绑定为通过权威。Sol6 可统筹其他非其作者批次，不能独立验其 D #4906；Opus 负责 B 设计一致性，不独立终验自己设计的 B。最终愿景守护选未参与该批设计/实现审查的猫，具体接棒时具名，未选定不冒充已有签字。原 owner 回执不能冒充独立关闭判断。

运行态重启由 operator 或已授权正式运维动作执行。已合入改动仍先走 Alpha；合法重启后在真实 runtime 用户入口补验，记录独立 build/runtime revision，不把 runtime 冒充 Alpha。结果完成后回主 thread 作 vision 守护与旧项结算。分工、文件写入顺序、proposal/Task 原责任坐标见 Roadmap 的启动编排段。

## User Journey

### Primary Journey: 找到入口，做完后回到同一现场

- **Scope unit**: thread + workspace
- **Actor**: You / 第一次使用该入口的人
- **Entry**: 普通 Clowder AI 对话 URL 的主导航、侧栏和输入区。
- **Flow**:
  1. 用户从可读名称认出目的地；鼠标提示、键盘焦点或触屏文字菜单可辅助确认用途。
  2. 找到一个对话，不展开详情也知道有无未读、是否出错、谁在工作、自己是否留有草稿。
  3. 写入陌生草稿，工作进行时继续输入或阅读；真实反馈与后台完成状态不混淆。
  4. 从当前对话打开作品，进入主区阅读，再返回同一对象和对话现场。
  5. 切换对话并返回；刷新时恢复原契约承诺持久化的内容与布局，不伪造未授权的自动动作。
- **Success evidence**: 真实壳 desktop / 390px before-after、陌生草稿浏览器旅程、键盘/触屏路径、恢复断言、必要性能 trace、operator 体验判断与非作者观察。
- **Non-goals**: 通用 Experience Runtime / PDL / 自动布局、Electron 化、平行主题系统或未审页面的批量换皮、国际化/租户品牌/彩蛋新功能、领域数据迁移、删除多猫能力、把所有业务页面压成万能卡。已选视觉方向的既有 token 整合按 09-29 分工与消费页抽验实施。

### Supporting Journeys

| ID | Scope unit | 用户结果 | 证据 |
|---|---|---|---|
| J2 | global destination + workspace surface | 从设置与管理进入Team/能力进化，从小信箱进入需人处理事项；看懂当前状态、下一步且完整来源可查 | F315 原finding、领域回执及真实populated/empty/error/narrow复验；入口迁移不丢原动作 |
| J3 | navigation | 猫静音、审批待处理或 Needs Me 有事时，稳定入口仍可主动召回 | 对应可发现性、命名和恢复旅程；不靠 hover 独占 |
| J4 | world + human + workspace | Café 带草稿 → Collective A → B → A → 原 Café 对话；世界、身份、目的地和草稿不串 | F290 AC-A2 / OQ1、真实 membership 与权限、可 back/refresh 的导航、direct/embedded、390px；不以配对列表 fixture 代替 |
| J5 | current thread / authorized global + historical messages + reading position | 问任意猫或用顶栏搜索，在当前对话/全局找回多处旧消息；核对来源后由人点击，在结果间移动并回到刚才位置 | operator源197/213/295/301与fd1–fd3；检索范围、时间/相关排序、问句排除和权限在猫人两入口一致，真实长历史/未加载目标/往返与刷新实测，不以静态稿代交 |

## 需求点 Checklist

| ID | 原诉求 | AC | 验证 |
|---|---|---|---|
| R1 | 图标能看懂，hover 不再等半天 | A1–A4 | 同壳体验、鼠标/键盘/触屏浏览器旅程 |
| R2 | 学习 Codex，改善日常整体体验，纳入正在实施的 F290 终态 | B1–B5、C1–C3 | 同条件 before-after、J4 双世界真实旅程、实际 trace |
| R3 | 两只猫讨论并交付可执行 roadmap | E1 | 本 thread 讨论记录、路线与非作者内容 review |
| R4 | 可立项跟踪、旧 UI/UX 项统一收归 | D1–D3、E2–E3 | 原 AC 映射、owner/证据/缺口、独立收口 |
| R5 | 本次新版界面支持中文/英文切换，使用认可命名 | B6–B8 | 双语实际页面、偏好刷新保留、工作现场连续及classic不变 |

## Acceptance Criteria

### Phase A（入口可理解）

- [ ] AC-A1: 承诺范围内的导航有可读目的与稳定文字发现路径；第1段首份可操作shell即由operator或首次使用者在不悬停、不读旁白的默认态辨认小信箱/前台猫/头像并能打开、返回，后续随各模式复验。认不出的在已定原位置加短标签，不重开A/B或添加副本；既有pin/深链及演示浮窗恢复路径保真，必要召回不丢。
- [ ] AC-A2: 共用提示在 hover/focus 下按统一策略出现，可 Escape 关闭、指针移入阅读且不裁切；触屏有等价可发现入口。应用提示不与原生 title 双弹，快捷键只显示真实绑定。
- [ ] AC-A3: working/done/error 与猫身份表达为人可读状态，关键信号不只靠颜色；accessible name 与可见名称语义一致。
- [ ] AC-A4: 外壳迁移范围逐项有真实入口、键盘/触屏和 tooltip 浏览器证据；旅程断言已迁移控件不带原生 title、常驻入口 accessible name 非空且不泄露原始枚举/ID。测试随实现交付，不把 source 扫描或消息行测试当导航行为证明。

### Phase B（日常主屏）

- [ ] AC-B1: 同窗口、同数据下，空闲/繁忙/出错和长列表都有主次明确的真实壳对比，operator 接受相关信息结构；F056 暖色与猫身份保持。第1段猫消息按DESIGN「对话」的已定名牌/无外层气泡呈现，人的方案3与可可由同阶段后续切片接入真实sender/viewer及主题链；宽聊天与作品旁窄聊天共用，浅/深/自定义及经典回退保真；不据外观授权新增过程/折叠行为。整屏含 F290 已有世界 rail，不能仅以私人 Café 单页签收。
- [ ] AC-B2: F297 crowded-row 场景仍可见 terminal/unread/mention/time，工作猫与草稿可识别；复用 F277 AC-C7 的组合 fixture 和 exact SidebarSnapshotRow join，取得 F277 owner 契约回执；收纳的成员、标签、筛选及完整标题有明确恢复路径，canonical truth 不变。
- [ ] AC-B3: 非阻断维护与低频操作让位于当前工作；过滤零结果仍可清除筛选、用户主动开的空页仍可查看历史；没有借 UI 整治自动扫描或删除能力。
- [ ] AC-B4: 消费 F290 KD-3 / Host Contract / AC-A2：个人 Café 与获准 Collective 世界入口、唯一当前世界和随世界切换的目的地可理解；超量名单从窄栏末尾“…”打开命名选择器，同名世界可区分，已加入未配对不消失。Host/Client 只保留一份 rail/领域侧栏，F307 独占工作区布局；F290 世界目录 adapter、权限与导航真实接通并有原 owner 回执，不能拿 Connector fixture 或静态图结算。世界选择统一在窄栏，不在Café标题或头像重复；审批与F310 Needs Me从唯一小信箱可达，前台猫独立召回。
- [ ] AC-B5: 单一小信箱消费同一认证owner的F310统一只读合同与F246原决定权：合法审批与current/eligible/preparedArtifact的judgment/repair各守原门槛，按可证canonical决定去重，不按Task/标题猜；聊天未读与“全部工作”不计入待办数。完整覆盖、身份及版本可证才报精确独立事项总数；有事项、真实空集、首次读取中、部分/全部失败与确知需登录可辨，不伪造零、陈旧数或Host自减。默认态无需悬停或提示点头像即可发现；辨识不足在原入口加文字，不复建侧栏/头像副本。逐项保来源双锚、原producer动作、历史/筛选/安全批量，结果未知先重读；跨世界只打开F307承载的同一待办面，不改world selection或直接批准。Host持续消费原同步/失效链，不因换世界丢订阅或重复复制；返回沿AC-C1恢复准确原场景，与来源分开。

- [ ] AC-B6: 已承接且设计就绪的v2页面可在中文/English之间切换，可见标签、tooltip、placeholder、操作反馈和无障碍名称按同一认可词表成套显示；动态数量/时间表达正确，两种语言均无缺失key或占位符裸露。
- [ ] AC-B7: v2语言选择默认持久化，无TTL；刷新、页面往返及classic→v2后保持。切换不重建Chat/owner、不丢草稿/阅读位置/选区/作品状态或打断执行，经典v1呈现与行为不变。
- [ ] AC-B8: v2新增文案集中维护中英词典，并有风险匹配的key/参数一致性检查与实际页面验证；长英文、中文、窄聊天及已承诺主题下控件可辨、全文可达。覆盖清单区分已迁移与未迁移页面，不能以两份静态稿或部分字符串替换宣称整版双语完成。

### Phase C（连续与响应）

- [ ] AC-C1: 从普通入口完成陌生草稿→作品→主区→返回→切换→刷新旅程，并覆盖 J4 的 Café / Collective 往返；草稿/选择/滚动/布局按原 owner 契约恢复，后台事件不抢焦点。切回 Café 不触发 leave/revoke；失效世界、换 Human 或旧 iframe 回执不得串到另一世界。
- [ ] AC-C2: 折叠/换 tab 不终止运行，关闭 tab 不删除对象；mouse/keyboard/touch、窄屏返回和关键错误恢复均有覆盖。
- [ ] AC-C3: 代表性真实负载下建立首反馈、内容就绪、流式输入和滚动基线；每个确认卡点有 trace、修复或明确不在本轮的理由，不把未测项标通过。此处的性能处置不豁免已承接的旧功能承诺。
- [ ] AC-C4: F284 R4 的其他文件 `file_change(Y)` 可见为 Activity signal，当前文件变化仍原位提示；事件不切换用户正在阅读的 surface、不抢焦点，真实事件路径与回归测试均覆盖。
- [ ] AC-C5: F284 R11/R16/INV-15 的 Presentation Lock 在现行 F307 的 Launcher 与 active Dev surface 有合法、互斥且可发现的入口；状态机、解除与恢复语义保真，Files 工具栏最右动作可用键盘到达。修复后取得现行宿主上的独立验收证据。
- [ ] AC-C6: J5在猫人共用检索合同上完成当前对话/全局的消息级多命中、时间/相关排序、精确排除本次问句、同源结果卡与人点击跳转，再沿原阅读owner完成n/m结果间移动及回到刚才；覆盖未加载旧消息、刷新/旧请求、不可读/失效来源。范围、截断和索引新鲜度有实际证据，“第一次”和总数不能越过覆盖证明；所有猫与人可用相同能力。按第2段计划交实物与独立验收，不把新旅程塞进旧返回/刷新P1切片。

### Phase D（旧承诺）

- [ ] AC-D1: F315 原 14 条开放 AC 逐项关联到最新实现、执行责任和验收证据；前三页核验不受 census 阻塞，不用方案被接受冒充生产完成。
- [ ] AC-D2: F056 / F269 与本次直接相关的 AC 有明确实施/保留边界；未承接的国际化、品牌等原承诺不静默取消。改动表面的既有暗色模式不退化，保已选主题与自定义偏好；第1段首份实物在深色及一套调过的自定义主题下验证表面层次、文字/图标/焦点和浮层对比，不用静态T1样值或主题能力存在代替验证。
- [ ] AC-D3: 每个领域页面保留完整事实、来源、权限与合法 action；跨页一致性由 F322 收口，业务修法沿原 owner，不增加平行状态源。

### Phase E（路线与结算）

- [x] AC-E1: roadmap 有原诉求、批次/依赖、源码入口、保真边界、适用验证命令与两猫讨论结论；分歧如实保留且文档内容经非作者 review。Opus 5.5 内容放行：`private-source-id`；附带的 F284 结算单位修订已同次纳入，回执明确无需复审。
- [ ] AC-E2: 每个被迁移的旧 AC / Requirement / Invariant 有唯一承载与双向引用；F284 以 R1–R17、INV-1..17 为结算单位，在现行 F307 宿主逐条验证。旧 feature 的关闭/归档区分交付完成和范围转移，持有独立证据与适用授权，未完成项不打勾伪装完成。
- [ ] AC-E3: 相关实物在 Alpha 经 operator 体验判断和独立实际旅程验收；合法 runtime 重启后在单列验收现场核对真实用户入口、恢复与版本，回指挥 thread 由非作者/非实现 reviewer 完成 vision 守护。公开交付说明列明实际收益与重要剩余项，feature truth 检查通过。

## Dependencies

- **Evolved from**: F284（contextual shell）、F315（Workspace 页面可读性）、F056（既有视觉语言迁移）。这是交付演进关系，不表示旧项已关闭。
- **Related**: F147国际化（本批仅v2双语，整Hub旧AC保留）、F269 全文恢复、F277 分组、F297 Sidebar snapshot、F307 working set、F294 密度测试先例、F229 前台猫召回、F309 作品协作。
- **Current host dependency**: F290 世界 / membership / 领域目的地与已合入的 Host world-directory adapter（#4830）；F322 外壳消费与整页验收待做。F310 全局 Needs Me 与 F246 审批独立；F322 不接管权限或复制计数。
- **Parallel UI owners**: CVO942已把共同体前端归一交F290、记忆前端与重构交F321。两者进入同一Roadmap，复用设计语言和Host接入边界，原领域数据、权限与执行责任不迁移。F232/F309核作品准入与版本族，F322消费入口与可证计数。
- **Design authority**: ADR-043、DESIGN.md / F056、F083 / F305 和现有 design-in-context checklist。
- **Excluded dependency**: F283 不解冻、不作为本路线前置；不新增控制 runtime 或 eval 的基础设施。

## Risk

| 风险 | 对应边界 |
|---|---|
| 减法导致能力、状态或猫身份消失 | AC-A1/B2，稳定文字入口与真实 crowded-row 验证 |
| 快 tooltip 掩盖名称本身不可理解 | 先目的地语义，再辅助提示；不以 hover 作为触屏/键盘唯一入口 |
| 一份大 roadmap 再次掩盖旧交付 | 三页核验同 A 开始，原 AC 不重写；每批都有实物与结算 |
| 统一整屏 owner 变成抢领域权威 | presentation/交付与 canonical state 分工明确；状态 delta 回原 owner |
| 新 feature 让旧未完账消失 | AC-E2；不以 retired/superseded 的名称代替逐项证据 |

## Key Decisions

| 决定 | 理由 |
|---|---|
| A 先解决 operator 点名的图标、名称与说明 | 每日入口直接受益，避免先做全局换色和全仓审计 |
| A→B→C，D 三页核验与 A 并行，E 随批次进行 | 保留既有承诺，完整旅程与测试不是最后一道补课 |
| F322 单一交付 owner，原领域权威保持 | 整屏有取舍责任，不复制数据与运行机制 |
| 不将 F283 退役、全部空态关闭或一屏单按钮当作共识 | 原冻结范围、ADR-043 C1/C3 与用户主动工作现场均有明确边界 |

## Review Gate

09-29 分工增量复用 CVO511、Astra518 与 Opus terminal Release 的逐项共创确认；它不重签早期 V4，也不替 #4906 的视觉验收背书。普通 docs-only 机械同步使用增量校验，不再召回同一只猫重复确认相同分工。

文档内容由 Opus 5.5 非作者校对；普通 docs-only 轻量校验后 direct push。正式体验改动先给真实壳实物，按 F305 范围取得 operator 判断；实现按风险走 TDD/独立验证，测试与修复同批。已合入用 Alpha，未合入用 feature worktree。性能问题走 traces，不为本路线新增 Eval Hub。最终独立愿景观察与实现作者、reviewer 分离。

## Tips Contribution

首要交付是入口自解释而非新手教学；适用 frontmatter 豁免。若某一批新增真正独立的用户能力，按其实际 delta 再决定 tip，不给每个 tooltip 增添全局提示。
