---
feature_ids: [F290]
related_features: [F044, F077, F128, F168, F195, F202, F232, F246, F254, F276, F277, F282, F283, F284, F287, F299, F305, F307, F309, F310, F322]
topics: [ai-native-collaboration, multi-human, multi-agent, collective, cafe, channel, topic, asset, annotation, rich-message, task, vote, team-memory]
doc_kind: spec
created: 2026-08-08
updated: 2026-10-19
tips_exempt: "Renewed 2026-10-18 for Task038 and the project-management v1.2 first slice: the Project entry and its list/dependencies/board views are persistent primary navigation, while accept/claim/result-file actions appear on the exact Task or result that can use them; proactive tips would duplicate visible contextual affordances before a relevant object exists. The first-entry guide remains directly visible and replayable from members and 我的 Café."
description: "让多个独立 Café 在同一个 Collective 中围绕对话、资产、工作与关系持续协同；私人空间不被吞并，承诺、来源与团队记忆也不会掉线。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-29T18:45:00-07:00
design_gate_claim_contracts:
  - docs/design-gate-claims/f290-canonical-client-assembly.json
  - docs/design-gate-claims/f290-host-assembly.json
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F290-ai-native-collective.md"
mcp_admission_claims:
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_artifact_command
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_current_context
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_read_context
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_set_interest
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_reply
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_propose_work
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_suggest_project_work
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_accept_work
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_continue_work
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F290-ai-native-collective.md"
    toolName: cat_cafe_collective_progress
    resourceFamily: collective-participation
    boundaryKind: resource-entry
    decision: accepted
---

# F290: AI-native Collective — 多人·多 Agent 共同世界

> **Status**: in-progress / 2026-10-19：旧同Café选猫/失效责任邀请两P1与R1状态反例已在5739 Alpha转绿；原266在5744关闭C-UAT-1/2，并在5748 Alpha `8ae121bd2a` / boot166关闭C-UAT-3，原三处页面纠偏全部通过。图组密度5737已由原414补验并释放。正式5201按You494单独恢复，Host/3003/3004保持e8c/boot38，六待办来源完整可读、原Work文件已绑定，原设计141限定通过；成果漏计修复5745已装入同一Alpha，但独立计数验收与正式Host加载仍待续。完整v1.2、真人OAuth/文件打开、双真人双Café、真实模型与整项验收继续开放。
> **Owner**: 小星星·Maine Coon (@codex-astra, GPT-6 Astra；operator 2026-09-06 交接)
> **Design / implementation provenance**: Sol + Fable 共创原设计；Sol 负责既有 runtime/provider 纵切片
> **Priority**: P1
> **operator kickoff**: `[thread-id]` / `private-source-id`

## 2026-10-18 项目管理 v1.2 衔接

You在设计原线程`[thread-id]#private-source-id`
冻结项目总览、看板、单项目三张v1.2；规则已进入DESIGN.md，原稿与图册保留。
先接真实项目/四列看板与状态合同，再补猫的项目上下文及触发，接同一份待办完成整段验收。
实施仍归原038，独立验收归266，加载后244一次对稿；不自动扩大已结束UI701子包责任。

命名“工作→任务、Roadmap→项目（依赖图在项目内）”、执行者泳道、待确认独立列、
阻塞横幅及未分配置顶已接受。实施前源码核验另明确两项真实缺口：当时commit会把当前Human记为负责人，
尚不能表达已接纳未分配；当时setWorkDependencies没有completed禁改。按计划补合同和验证，
不把候选当承诺，也不只靠折叠UI保护已完成记录。日期、外部材料待分拣仍属后续范围。
原指挥线程`private-source-id`的Argon独立内容审查已批准该计划，
覆盖SHA256 `1e4d0f19db5b8ab1a66738c0fb16c6a43e8d65b79c0ba92ede6eb8e24da084ae`，无P0/P1/P2；
这是实施计划审查，不是代码或整项验收结论。
You随后在同一设计原线程`private-source-id`明确授权：
“ok 咱们这些可以交给F290去开发了～”。605已回读本人原消息；开发按上述原责任链推进，
不再重复询问设计/开发许可。2404不授予正式环境启停或关闭整项F290的权限。

完整v1.2仍未交付。You488禁止动3003/3004、494授权其余修复后，605已完成
原Work和历史保持、原684字节成果绑定。Host仍为e8c/boot38，5739/5737不随此次操作装入Host；

### 第一可操作切片已加载 Alpha，隔离数据验收限定通过（2026-10-18）

原038已通过 PR #5725 把首段真实使用路径合入 main：Human可以接纳任务但保留未分配，
之后由Human或当前获授权Cat认领同一个Work；未分配不产生assignment、不启动模型，重启后仍可恢复，
Host冷启动也能沿新的接责历史建立原Task而不复制Work。completed/declined/cancelled任务的依赖由Service拒绝修改。

共同体侧栏和触达页面已统一显示“项目/任务”；项目默认进入真实项目列表，并可切换跨项目依赖与全局看板。
看板按稳定Work ID去重，使用待开始/进行中/待确认/已完成四列和执行者泳道；未分配置顶，blocked留在原列并显示横幅。
原单项目计划/依赖图/与我相关、来源消息往返、历史和结果验收继续消费同一批Service记录。

fresh-context 预扫补齐了同一条可操作性不变量：已接纳的未分配任务在Cat认领前仍会通过精确来源上下文暴露
原`intendedOutcome`；终态任务不再显示后端必拒的依赖编辑器，未完成项目和已取消任务也不再暴露必拒动作；
从全局看板打开的任务始终留在项目画布中，共享任务优先保留用户刚才所在的项目语境。以上均有原失败测试、
Service/Connector或Client回归和真实浏览器旅程，不把预扫当作正式review放行。

正式 review 首轮又找出两处投影真相丢失：单项目详情曾只拿项目成员集解析依赖，导致真实的跨项目A→B显示
“没有前置任务”；全局看板曾把所有`status=blocked`都解释成依赖阻塞。现已把项目可见节点与已授权依赖解析全集
分开，详情显示外部任务及来源、不可读引用显示明确计数而不扩权限；看板复用Service权限与当前Host准入语义，
区分执行撤回、待准入、准入拒绝和真实未完成依赖。新的组件测试覆盖四种阻塞原因，真实浏览器夹具改成两个
互不重叠项目间的依赖，并复验来源往返与外部任务不被偷加进当前项目。

作者自验事实：Shared 802项、Collective Service 135项、Collective Client 307项、Connector 56项通过；
API完整Collective通讯套件254项通过/1项按环境跳过；真实Service+Client浏览器旅程通过项目列表、跨项目依赖、
全局四列看板、单项目与原话题往返、1440/390、明暗主题和窄屏内滚动。Hub自动预览仅返回
`unconfirmed/no_matching_client`，因此不记录为本人已看到页面。正式非作者 reviewer 在最终
`a72638e27b19003c0b56875f2d9cfe188f03e0d2` 上另跑39项定向检查与两条真实Service→Client浏览器旅程并批准，
PR #5725 随后 squash 合入 `4ab46ecdba5b29a067ba80c32ad3a86262663a85`。这些证据仍不替代合入后Alpha、
原266独立验收或原244按三张v1.2稿对照。

原266随后在12:11通过实际3011 Host的“连接已有Service”入口，进入使用Alpha已构建生产模块的
临时测试家园，完成13项检查：页面接纳未分配→本人认领同Work、授权fixture Cat认领、终态依赖保护、
项目三视图/四列看板、四种阻塞因果、跨项目来源往返及390px边界。
已在`215b3d2d7c`归档；Client JS/CSS与共享5211及Alpha dist逐字节相同，API boot157前后不变。
Human动作走浏览器HTTP，Cat与准入检查使用生产Service公开方法及fixture协议；未配对真实Host、
未执行模型或真人OAuth，未写共享5211。自有浏览器、Service和临时数据已清理，资源回执为released/proven。
605已核回执、文件哈希并亲看桌面看板/390px详情；消费该限定结果，不重复运行探针或将其记成真人双家通过。

仍开放且没有被本切片降级：项目页直接创建项目/任务的原子来源操作、跨Human指派请求/接受、可编辑分组、
完整作品/上下文、猫的项目读取/建议/前置与评论触发、F310/F322同一待办。正式runtime/5201未启停，
F290及Task038保持开放。实施边界、consumer证据和迁移说明见

### 剩余 v1.2 已加载，运行与设计验收要求修正（2026-10-18）

正常创建、跨Human接受/拒绝、同一请求退出两入口、分组/候选/作品读取成立，但两项新P1阻塞：同Café选择第二只猫却提交第一只；
任务完成后Host撤回、项目仍保留无效责任邀请，动作409。原038已接修，非整段通过；真人OAuth/真实模型/共享后端全链未被fixture证明。
重点是去掉双顶栏与重复待办、恢复独立单项目页和任务表、真实筛选/下一次交付/上下文。按页修正后原266复验，不召回244逐轮复审。
原266已释放共享窗口，当前含5733的641285/boot161仅代表加载成功；图组实际验收另归原414。下面保留合入实现及作者检查证据。

原038的隔离分支已实现首片之后的完整同一路径。PR #5732 的首轮一次性高风险审查
`changes_requested`；四项阻塞Red→Green后，Kimi在exact HEAD `3434669b52062b82f2fc20e0a478f20b09fd1830`
完成常规非作者复审并批准，随后 squash 合入 `7b4c330a223c7d245ab3235824de72f9036f7dac`。代码已在main，
605已实际加载Alpha `29ca83de97`并核126个包文件与受审HEAD一致；原244/266整包验收仍未完成：

- 项目与任务可从真实项目页创建，来源事件和对象原子绑定；跨Human责任先形成具名请求，目标Human接受/拒绝后才改变承诺，
  接受时可以选择自己Café里的执行猫。
- 项目看板可按执行者/负责人/项目分组，单项目使用冻结的计划/看板/依赖图/作品四视图；作品读取区分空、拒绝和不可用。
- Cat拿到权限过滤后的项目目标、完成前置及结果出处，并可用新MCP工具提出持久项目任务/前置候选；Human接受时原子重验。
  前置完成与任务评论回到原私人Task；离线评论先可见、wake保留并在恢复后复用同一消息。
- F310统一待办读取目标Human自己的pending责任邀请，按稳定`accountabilityRequestId`去重；跨Host/跨Human隔离、部分失败、
  迟到身份切换均失败封闭。项目总览的“待办 / 看谁的”直接投影同一Work、责任请求和待验收结果，不另存done；原处打开
  精确项目任务，实际接受/拒绝仍由Collective Service写权威状态，随后同一事项退出项目待办和家里邮箱。

新Work字段对旧记录是可选的，无批量迁移；一旦写入新责任历史、项目建议或wake事件，继续按fix-forward处理，
不能承诺旧Service reader直接回退。首轮审查发现并已修复四类状态边界：项目建议不能绕过项目负责人决定、
Human评论原语义不能被wake覆盖、Host必须复用原评论消息、责任待办分页必须绑定不可变快照；五条原始复现均已转绿。
这些作者证据与独立复审支撑“实现已合入main”；Alpha加载证据另见上述回执，
原244/266整包验收、正式runtime与双真人双Café实际协作仍未完成。
F290与Task038继续开放，详细边界见

修复后作者证据：Shared `808/808`、Collective Service `150/150`、Connector `57/57`、Collective Client
`318/318`、API Collective 通讯 `255 pass / 1 environment skip / 0 fail`、MCP `1000 pass / 1 skip / 0 fail`；
Web受影响的7个文件`177/177`，两个production browser旅程`2/2`并人工查看桌面与390px证据，generic Web build通过。
Web全量基线则是`12301`项中`12250 pass / 51 fail`，失败集中在本次未改的既有ChatStore/Queue/FileBlock等域，
代表文件隔离运行仍可复现；因此这里只记录受影响面通过，不冒充Web全仓全绿。

### 原三处页面纠偏已在Alpha通过，成果计数仍待独立验收（2026-10-19）

全局与单项目1440/390主色/白字、32/13/8/6×10几何、次级表单、实际创建和来源/移动返回均通过，关闭C-UAT-3。
结合原5744已通过的C-UAT-1/2，三处页面纠偏收齐。605核回执与桌面/移动表单实图，
34985于05:43:25.848Z released/proven/tokenZero；684释放固定cut需求。5745、真人/模型与完整F290不由本轮代签。

05:38最新加载：605已把5748与5745共同装入Alpha `8ae121bd2a` / boot166，
本轮C-UAT-3已按上述回执通过，成果计数另验，正式Host仍原boot38。下文保留各轮发现与修复来源。

Human本人执行与混合去重、个人/全部待办往返及身份重置按证据边界通过；C-UAT-1/2关闭。
单项目主动作的桌面/390px尺寸及导航通过，但原有primary底色被基础CSS覆盖，C-UAT-3仍为P2。
raw receipt的passed只签其中行为和尺寸断言，完整视觉结论为corrections-required。
原589已把实图与根因交原038；593释放共享cut，605核实图、规则及34911 released/proven，不重复派实现或召回244。
C-UAT-3修复已在PR #5748把单Project工具栏基础selector降为与primary语义类同级，保留13px紧凑几何并让后置主色生效；
真实browser先复现透明底色，又挡住整段降权造成的16px回归，最终桌面/390px三旅程全绿。Argon在exact HEAD
`ccd9910ac2`独立批准后，代码squash合入`cd8634f5e6`。这只证明实现落main，原266仍需在新Alpha cut复验后才可关闭C-UAT-3。
独立成果漏计P1已由PR #5745在exact HEAD `0dbec3ca9e`完成修复：API计数与Web分组改为消费同一Shared精确判定，
原597指出的前后端漂移及负向验证缺口经Argon R2复核清零，随后squash合入`17aec4dc8b`。
这只证明代码落main；本轮未激活新runtime、未操作正式Host或5201，真人OAuth/模型与完整F290仍开放。

### 5739历史复验：当时发现三处呈现P2（2026-10-19）

列表遗漏Human本人执行、缺“全部待办”、单项目主按钮样式三项P2仍在已接受范围内，由363回原038处理。
下面保留5739作者实现与review的证据边界。

Task038当前候选已在送审前同步最新`origin/main`，保留分段可回滚提交；review请求以PR exact HEAD及提交清单为坐标，
不把会被rebase改写的本地SHA当稳定身份。本节及图片归档只追加证据。UAT-1改为以Service、connection、cat三元参与身份选择同一Café的猫，
真实浏览器选择第二只猫后POST和持久assignment均指向该猫。UAT-2抽出Project/Work共同可操作谓词；completed、
declined、cancelled、已有assignment或非active Project都会同时退出项目待办和任务动作，不再保留必然409的按钮。

总览独占待办并提供真实计数/负责人/完成折叠；看板提供四个真实筛选、显示设置、泳道和卡内责任操作；单Project使用
面包屑、计划/看板/依赖图/作品、新建任务，计划为前置排序的五列表格，右侧读取权限内目标、完成、阻塞、出处与活动。
身份小签、下一交付、阻塞文案和作品空/拒绝/不可用均来自原投影，没有为贴图编造日期或下游。

作者在最终树完成Collective Client `68 files / 329 tests`、直接lint/build、Web production artifact构建；F290 browser目录
在不抬13文件配额的前提下，把两条新旅程并入原Project单元并保留全部case，catalog/retirement/policy `256/256`、
consumer census `1/1`通过。受管浏览器receipt `34731`等待1063秒后以normal pressure获准，三条真实case `3/3`
用时12.95秒，permit持有14.44秒并released、descendant cleanup proven/token-zero；桌面与390px原图见

非作者R1在PR #5739的首个exact HEAD返回`changes_requested`：共享Work从邀请原Project移出或原Project结束后，
详情/计划/卡片仍借另一个active Project展示接受动作；列表/右栏/计划没有优先消费Service执行状态与Host准入；
已完成前置仍被卡片称作“正挡住”。修复没有改写持久邀请或依赖，而是建立两条共同派生合同：pending邀请必须经
`request.roadmapId`找到仍active且仍含该Work的原Project，否则历史保留但所有承诺动作冻结；阻塞先消费当前
execution/Host真相，再把未完成前置与已完成历史分开。failure-mode sweep同时修正依赖图的同型旧文案。

本轮新检查先得到`7 failed / 11 passed` RED，随后详情、计划、卡片、列表、右栏、依赖图组合`25/25`及Client全量
`69 files / 338 tests`、lint/build转绿。受管生产浏览器三case `3/3`再次通过，新增真实双Human场景证明原Project移出
共享Work后，当前Project的详情、计划和看板均不再出现接受/拒绝；合法邀请和同Café第二只猫接受仍成立。
receipt `34825` normal admission、等待1.34秒、持有11.31秒后released；新增实图与回执见
不是reviewer批准、merge或Alpha签字。

正式信箱英文问题也已纳入同一候选：只有精确的`f290.collective_work_result + collective_result_ready`按界面语言
显示系统文案，新Shell邮箱覆盖中英文，中文单语Needs Me面板显示中文；其他producer/Human recommendation保持原文。
两处均先取得中文泄漏RED，最终相关组件与copy检查`51/51`、Web lint、production build及cache policy为绿。

本轮只读运行态诊断另确认：唯一owner-routed connection已精确绑定5201与原Service/Human；当前Connector实际异常为
`ConnectorTransportError` 404 / `NOT_FOUND` / non-retryable。5201进程出生于10月8日，pending route到10月18日
`7b4c330a22`才进入代码；磁盘dist后来包含路由不等于长驻进程已加载。因此责任来源报告`unavailable/partial`是正确的，
不是0，也不是连接或Human授权缺失。恢复须沿既有部署生命周期更新5201，并以同一connection带凭据pending读200、
identity匹配、Host来源`available/complete`及真实零项/有项处置共同验收，不能由checkout或Host boot号代签。
本作者未重启、重配或写入runtime/Service。同一非作者reviewer已在exact HEAD `c72b787e9a`关闭R1全部三项且无open P1/P2，
PR #5739随后以`c791dbb73d`合入；仍须由605协调正确Service加载与Alpha，再由266沿原路径复验；
不召回244逐轮复审，不关闭F290或Task038。

## 指挥与设计入口（2026-10-12）

- **指挥线程**：`[thread-id]`。You 指定“就你们这个吧”，来源
  `private-source-id`；Astra 接住统筹 Task `private-source-id`。
  设计决定、实施进度与整体验收在此汇总；原 Task038、Task266 和设计 Task244 保留原 owner 与执行现场。
- **规范入口**：[DESIGN.md](../../DESIGN.md) 的“对话”“界面上的字”与原稿一起消费；
  图册是展示入口，不替代规范、领域合同或验收记录。
  在总图册第十章；已获下述设计方向认可，仍为目标稿，不据此改变实施范围或验收勾选。

**最新设计确认与纠正**（同指挥线程，2026-10-12 PDT）：

- `private-source-id`：13b 共同体设置、参会台分别获“ok”“ok的”；
  “我的猫”仍需对齐家内体验。认可限所引用的设计方向，不代表整套功能实现通过。
- `private-source-id`：办事旅程与消息下最近两条具名回复预览“没啥问题”；
  **9a 单猫详情管理方案被退回**。参与入口按家里现有成员自动发现、开关带入；不把同一成员背后的
  多个频道/工作上下文当成多只待配置的猫。沿本文件 09-11 默认纳入与显式排除合同，
  以及[通讯模型](../architecture/f290-communication-model.md)的家内身份、频道接收、按事项续接关系；
  不以单猫详情集中私人任务与授权作为入场前置。原认可旅程保留；新参与稿随后获 998 确认。
- `private-source-id`：引用 873 的 9c 稿说“审核ok update吧”“可以了 这些都ok”；
  该设计包列出的 **9c 我的猫、9b 已允许的工作总览、2b 频道菜单、3c 例外卡、13 共同体菜单**
  已获设计确认。已否的 9a 不恢复；未画分支、代码实现、共享产物与双真人整体验收不据此勾选。

## 当前进展与下一步（2026-10-13）

**10-17 W4增量**：10-12的顺序阻塞已由人类启动1394/已接受1399的有界共同作品包解除；
原Sol6.1 writer已在PR5670接通双Human Markdown、retained PNG/MP4、版本/批注/候选/采用、来源与Work回流，
codex-sol已独立R2批准306516，070467合流验证通过；正常retained picker第2版CAS/409已在4b66修复。cloud第二轮的请求回执/权限变化问题已在2ea59修复，经Service128、API19与真实丢回包browser3复验；第三轮review5556385646又确认cancel/reject在明确409后缓存旧CAS；aad6修复后Client10、build/types与真实Markdown browser1通过，未知回包与并发新意图仍受保护。第四轮终态6230566212已明确aad6无重大问题；正常合流冻结main7add至4d5e，作者patch-id相同，build/API47/Web49/browser3全过，E1–E5闭合，Task3254恢复普通g11。PR5670已于10:57:04Z合入main4a26e9c8a8，工位同源released/removed，代码包交付完成。runtime只读99355fa不含该merge，live=dormant；605继续协调合法加载及非作者266验收，未称真人/双家或完整Feature完成。验收仍沿605/266，
**10-18 UI增量**：Human643与获批UI701的完整整页改版由原Task038子范围交付，PR #5714已合入
`0a7d3762c8529dc44cd00d877c5235f7c86f2e37`。家里与独立Client共用`@cat-cafe/ui`呈现层，频道首行短名@与完整身份、
逐猫真实回执、输入框上方本人的频道活动，以及成员/监听/许可/日程/连接入口已接通；公开短名producer到持久profile/consumer同包完成。
Argon独立批准最终头`1bfd921dd01a542e4217dd50f0acf13feade5468`，typed来源为UI thread
`private-source-id`。最终正常鼠标与完整默认入口5项、家里生产组件20项、完整作品往返及跨包契约/重启检查通过；
只读runtime健康信息仍为`b65746a9d2b452705a121ab48417d76847549d5e`/boot37，不含该merge，`main=landed/live=dormant`；
加载继续由605消费，266在匹配版本Alpha验收，再由原设计244一次整体对稿。Service reader须先升级，Host/Connector/Client按匹配切面更新。
本UI现场不迁移038/605/266/W4责任，不关闭F290或勾选真人/整体验收AC，新的Roadmap日期与权限合同仍未加入。

**10-18 UI701设计纠偏已合、加载/终核待原线**：原设计1837整体对稿未过的六项差距，沿续办1844由原作者在PR #5720修正，
`b4a8f20abc8b97140504f1435e98bed3c540fa55`已合入。频道作品改紧凑列表并保留本频道资料库/正文/原处往返；
公共成员按真实Human/endpoint分家，同端点多连接显式选择；工作提议浅虚线、接手实线与真实责任；
全部作品两列/16:10类型占位与真实筛选；登录、标题行搜索、监听标识和双语窄屏一并校准。
目录没有独立批注统计或缩略图reader，不补0、不隐式读取正文。Argon对exact40b22ce632独立typed批准2225，
作者Client299、Host112、owner HTTP3、生产构建/类型、真实完整Host纠偏浏览器1项与15张实物已核；
最终主线机械合流后Client301通过，合入tree与该受测tree完全相同。
正常Web全仓lint的base5712错误保留归因，原作者2148在其未合入分支已修；本包受影响ESLint10文件与
[PR门禁及合流证据](https://github.com/zts212653/clowder-ai/pull/5720#issuecomment-6247204560)。
只读runtime Git仍为`b65746a9d2b452705a121ab48417d76847549d5e`、不含本merge，`main=landed/live=dormant`；
本现场没有启停或覆盖Alpha/runtime。605加载、266独立验收，原244按1837约定只核这六项变化；
设计终核未过之前不把local代码批准当设计通过，双真人/真实模型UAT及F290整体验收保持开放。

下方10-13及更早的接口缺口/等待描述保留为当时事实，不覆盖上述有界批准与当前代码状态。

**产品目标**：不同家的人和猫，把讨论变成共同工作；各自在自己的 Café 推进，成果回到同一个
Channel / Work / Artifact，团队能一起查看、修改、判断，并看见它推动了哪一步路线。

本节是当前进展入口；后文带日期的实现、未加载和阻塞描述保留为历史节点，不覆盖本节的新证据。
本轮核对本地 main 提交、原 Task、源 thread 与既有验收原件，未重新执行真人 UAT，也未在线复核
新的 GitHub 状态。**代码已合、版本已加载、实际旅程通过分别记录，
不把任何一层外推为完整交付。** 更新授权：
`[thread-id]#private-source-id`。

### 已经做到哪里

| 用户能力 | 已核事实与证据 | 仍未得到的结果 |
|---|---|---|
| 从 Café 进入真实共同体首页与频道 | #5205（`b7bb55fb82`）首页已合；原 Task704 的父 Alpha 走过首页→general→chat→状态→刷新，后续 #5209/#5225 修复运行链 | 有界首页与模型回复不代表完整 Collective 页面或团队使用已交付；见原现场 `[thread-id]` / Task704 |
| 日常入口、刷新与会话恢复 | #5304（`92be37e99b`）已合；Task266 于 10-09 核 runtime `3ca4c4af` / boot20 的侧栏进入、reload、settings warm、back/forward。#5473 于 10-13 合入 `42282f9368`：Client 仅在 `/api/me` 明确 401 时清会话，503/网络错误保留凭据；生产组件浏览器旅程以模拟 503 证明 unavailable 后同一会话回到原共同体 | #5473 没有实际重启 Alpha/runtime，也不证明关标签页后持久登录；Task266 仍须在加载该 merge 的 Alpha 复验真实重启。该轮隔离 context 与 fixture Human/猫执行都不代验真人登录后的完整频道协作 |
| 讨论形成 Work、依赖、历史、投票与结果判断 | 已有 `RoadmapPanel`、Service Roadmap/Work 生命周期、结果验收及普通成员退出实现；退出切片 #4646（`ab9e935f31`）保留公开历史并撤销 endpoint | 真实 Meeting/Issue→跨 Café 执行→验收→版本发布的团队流程未闭环；管理者交接与未结责任处置仍需完成 |

### F322、F309、F307、F310 怎样接到 F290

| 责任面 | F290 消费什么 | 当前接缝与下一验证 |
|---|---|---|
| [F322 日常体验](F322-everyday-work-experience.md) | 新版入口、待办、导航与连续工作体验；Collective Client 的领域页面仍由 F290 交付 | F322 已从 v2 修补推进到按旅程组织的 v3，部分已合/Alpha 通过、部分待加载或设计；不能把 F322 整屏进度等同于 F290 页面完成。按同一 Channel→Work→私人进度→成果返回实走 |
| [F309 内容协作](F309-collaborative-content-plane.md) | 同一内容的版本、选区、批注、修改候选、采用与回执 | **W4 的实际依赖仍是 F309 AC-B6**：两个不同 authenticated Human 围绕同一 canonical Markdown 完成 read/annotate/propose/apply/version/revoke，重启后撤权仍有效。单 owner 文件/Studio 与不可变作品审阅均不能解除该依赖 |
| [F307 通用宿主](F307-composable-workbench.md) | owner surface 的挂载、布局和返回位置 | typed content surface mount 已有；F290 仍须提供 Artifact lineage、领域权限和精确结果目标，完成自己的 consumer，不能把它记成等待 F307 全项完成 |

**可并行边界**：入场、登录恢复、真实接活/回流、基础 Roadmap 和界面整合不必等 F309 全部媒介完成；
共享内容修改必须消费内容 owner 的双 Human 授权与版本能力。F290 不另建正文 store 或编辑器。

**10-12 晚的依赖回执**：F309 原 owner 已把 [AC-B6 交付包](F309-collaborative-content-plane.md#ac-b6-bounded-owner-ready-delivery-packet2026-10-12提案尚未准入)
落在 `e44013ec0ef3a8475d3e60c5d78e4b68d065da3b`；来源为指挥线
`private-source-id`。复用内容 owner/F309/F307，限定双 Human Markdown 的读取、批注、
修改建议、采用新版、撤权与重启恢复。该包是**待准入的具体方案，不是可消费实现**：原 F309 Review Gate
要求完整 AC-A4 后再进入共编 B，本切片先行需 operator 确认顺序例外。建议实施作者 Sol6.1，F309 owner
仍是 Sol5.6；尚无 AC-B6 实施 Task，W4 保持阻塞，其余首轮路径继续。Task266 的

### 10.9 团队会议带来的产品输入

来源：`[thread-id]#private-source-id` 的原始转写与说话人对应；
重点核读 19:15–28:22、01:03:49–01:05:54、01:11:36–01:12:50、01:17:54–01:21:18。

- **团队想完成的工作链**：Issue / 会议事项→讨论→认领→各家猫开发与协作审查→共同查看和修改产物→验收→看见进入哪个发布版本。项目/版本管理是多人协作中的能力，接回 J2/J3/W3/W4，不另立第二份工作真相。
- **产物能力共用**：个人 Café 与 Collective 围绕同一套产物展示、批注和修改能力协作；会议提出通过独立模块/嵌入复用，具体接法继续遵守现有 F307/F309 owner contract，不由会议措辞直接冻结新架构。
- **部署与现实分工**：会上吴浪暂牵头多人协作及共享服务器准备；徐方瑜接 Issue 初筛；谢泽丰牵头代码合入、验收与内外同步流程，并与伙伴推进 Windows/多平台体验。这是会议中的人类分工，不自动转移现有猫的 Task、代码责任或授权。
- **范围边界**：会议没有完整列出 10/24 功能清单，发版频率、测试规则也未全部定案。共享部署尚需实际环境与伙伴使用证据；不能因“准备服务器”写成已经部署。上述长期目标不自动成为 10/24 交付承诺。

### 剩余工作与建议推进顺序

下表整理原 W1–W6 / J0–J8 的下一落点，**是推进建议，不是新 Phase、开工派令或范围缩减**。
10/24“新版界面中的真实双人双 Café 协作与一份共同产物”只作为候选目标，尚未冻结。

| 顺序 | 要交付的结果 | 原责任与验收落点 |
|---|---|---|
| 1 | 让总览、原 Task 与实际代码一致，清除已经过时的停工理由 | Astra 汇总；Task038/266 保留原 owner。Task038 仍记录 10-05 首页交接权限阻塞，但 #5205 已于 10-06 合入；该阻塞已被后续事实超过，需原 owner 结算记录，不据此宣称整任务完成 |
| 2 | 两位真人各带自己的 Café/猫进入同一共同体，完成两件真实工作、反馈修改与回流 | W2/W3/W5、Task038/266；结合会议中的共享部署安排核实实际场地/操作者。#5473 已修复“任意恢复失败都清 session”的明确缺口并完成模拟 503 旅程；Task266 仍须在真实 Alpha runtime 重启中复验，且尚未证明它是用户那次掉登录的唯一根因 |
| 3 | 新版 Channel、工作卡、例外授权、私人进度和成果返回形成一条可用旅程 | F290 原实现现场与设计 Task244，消费 F322 原壳/待办；先核最新稿与现有行为，再在真实入口整页验收，不能把静态设计或局部修补当整版交付 |
| 4 | 两位成员对同一份 Markdown 批注、让猫修改、由有权人采用并保留版本/来源；撤权真实生效 | F309/content owner 交 AC-B6，F290 接 W4/J7；复用个人内容能力，单独证明跨 Human 授权和 Collective 回流 |
| 5 | 一件真实团队 Issue/会议事项贯穿 Roadmap、依赖、执行、验收与发布去向 | W3/W6、J2/J3；将会议中的人类工作分工变成真实使用场景，验收仍沿原 Feature 与 Task，不另造一套项目账本 |

不能被上述近期顺序漏掉的原范围：共同资料库/树/版本与派生、团队记忆与决定可找回、私人想法获准发布
（J1）、外部贡献唤回及原处回流（J2）、会议到工作（J3）、成员治理和完整部署恢复（J5/J6/W5）。
Office 实时共编与可编辑视频保持 F309 原开放范围，不挪成 F290 自研；跨频道日报 J8/R23/AC-C4
保留已有“完成门槛讨论暂缓”的状态，不写成已做、遗忘项或本轮新承诺。既有 AC 本轮不改勾选。

Architecture cell: collective-runtime, plugin

Map delta: `new collective-runtime cell + plugin cell anchor update`

Why: `collective-runtime` 拥有独立 Service、canonical Client、成员/连接/事件顺序与 endpoint
协议真相；`plugin` 继续只拥有 Clowder AI Host 的官方安装、生命周期和 builtin runtime seam。
Workbench、内容协作、Cat Agent runtime 与工具权限仍由 F307/F309/既有 runtime owner 持有。

**通讯实现阅读入口（2026-09-30）**：[通讯模型与执行上下文](../architecture/f290-communication-model.md)。
该文统一说明家内猫身份、每频道接收关系、事项续接、默认自决、公私上下文、并发与跨频道汇总；
列出已定约束、代码差距及待定接口。本 spec 保留范围/验收，原计划保留实施顺序，文档更新不代表运行能力已交付。

10-16 W4 的有界共同作品接线沿人类启动 `private-source-id`、
已批准执行现场 `private-source-id` 与 F309 owner 裁决
`private-source-id`，登记 `collective_artifact_command` 为上述 family 的同来源入口。
Host 从当前 invocation / durable public source 派生作品坐标和具名 Cat；`read` 读取固定 owner 版本与原批注，
`respond` 只向既有 F309 journal/proposal 返回修改建议。每次复核请求人、猫主人、参与声明与资源权限；
采用仍由有权 Human 发起并消费 owner receipt，Work/Task 验收保持原协议。
该登记覆盖已批准 W4 包必要的工具接线，完整旅程和部署状态见

首猫 MCP admission 索引登记已冻结计划的 current-context/read/reply 三个来源与回流入口；A2
另登记 cat-authored set-interest 入口，W3 登记只生成公共提议、不创建 Task 或承诺的 propose-work 入口，归正式
collab server 的 `collective-participation` family；读取与发送仍分别校验当前 invocation、授权来源
和 opaque refs，回复 operation 由现有 outbox owner 分配/恢复，standing interest 只能修改当前
Café×Channel 的未来显式回应请求值守。首猫切片中，Work 提议只保留当前来源与候选结果，负责人、分配须 Human
明确接受；私人工作另经 Host owner admission，可消费范围匹配的既有 standing grant。工具本身不能扩大
读取或 owner 权限。**这段首猫实现边界不再定义终态的
默认人工流程**：2026-09-30 operator 已选择默认猫自决，见下文“默认自决与两轴设置”；委托消费已随
#4955 交付软件与真实模型证据，双真人/双 Café 的完整使用验收仍开放，见开头当前进展。
首猫切片依据为 operator 授权
`private-source-id`、Sol 文档批准 `private-source-id`，以及
这里没有批准新增私人执行权限，也不代替实施 thread `[thread-id]` 的代码 review、
真实双 Human UAT 或完整 F290 验收。

## 前端设计阅读入口（2026-09-20）

其中明确区分静态目标、既有通讯能力与尚未实现的共同体设置；前端当前状态以本文开头对账为入口。

operator `private-source-id` 要求当前版本完成家内协作、同 Channel 多任务并行和成果回流；
原 09-24 两机入场仍是接入过程，不能替代这段验收。原计划统一记录代码缺口、责任与贯穿验收；
已否决的私聊/协作间原型不恢复，本入口更新不代表实现或完整 F290 已通过。

其中区分区域图、两种 Client 装配、体验 Gate 和实施计划的职责，并列出已合入切片与尚未验收的边界。
当前版本纳入 operator `[thread-id]#private-source-id` 的更新要求：
紧凑产物卡、Topic 动态摘要、Work 来源关系、消息视觉重量及同一现场的导航连续性。
它深化区域图 R8–R11/R17/R20 与 J4/J7 的呈现，不引入组织树，不改变 Host/Service、F307/F309/F310 分工，
也不把方案或 PR 合入当成整页体验签字。后文带日期的基线与决策继续作为历史证据。

## Why

Clowder AI 已经解决了 You 不必在自家猫之间充当人工路由器，却还没有解决跨真人、跨 Café 的
断裂：吴浪、社区贡献者、PR / Issue、会议结论与各自猫的执行散落在不同世界。一个高价值事项
被 You 忘记以后，组织也会跟着失忆；一只猫若在别的 Thread 冷启动，只能重新猜我们讨论过
什么。

You 对立项完成定义的原话是：

> “我们曾经的讨论，甚至包括语音转文本的各种 link、各种思考，包括未来要做的事那个 thread
> 的原本触发……都关联进去。不然未来另一只猫在别的 thread 想要冷启动……他就傻眼了。”

F290 因而不是“给 Chat 加几个团队按钮”，也不是一份最终会拆掉的 MVP。它负责建立一个终态
产品对象：**多个独立的一人多猫 Café 可以加入 Collective，在 Channel 中长期生活、表达、判断
与工作；私人 Thread 仍然属于家里，值得公开的东西通过 Living Projection 生长；人不再搬运
消息和上下文，猫也不被降成匿名工具。**

## Product Thesis — 资产代谢与社会环

Collective 的工作协同围绕**资产代谢**展开：对话是资产的重要孕育现场，资产是对话形成的
可持续结晶，猫维持对话、资产、Work、证据与团队记忆之间的活连接。完整循环不是单向的
“聊天变文件”，而是：

```text
对话 / 会议 / 外部事件
→ 候选资产
→ 阅读、批注、分歧与判断
→ 被确认的版本
→ Roadmap / Work
→ 产物与证据
→ 更新资产与团队记忆
→ 触发下一轮对话
```

资产代谢不能独占 Collective 的全部定义。人、猫、Café、Bond 与 Membership 是主体和关系，
不是资产；Channel、灵感公地继续承担共同在场、弱连接、关系生长和方向再对齐的**社会环**。
缺少资产代谢，组织热闹但失忆；缺少社会环，组织高效但没有温度。

`Asset / Artifact` 是内部统一信封，不是要求用户学习的总称。纪要、方案、Decision、Roadmap、
PR、代码、数据、Demo、视频和作品保留各自的人类语言与动作；它们共享 id、owner、lineage、
版本、权限、批注面及与 Work / 证据的关系，并按来源与生长关系组织，而不是退化为按文件类型
分文件夹的网盘。

## Current State / 立项基线

截至 2026-08-08：

| 证据 | 已成立的事实 | 仍未成立的事实 |
|---|---|---|
| 原始录音 | 两份 ASR 已有路径、说话人边界与 SHA-256 | 其中黄挺交流开头约两小时未录，不能冒充完整事实 |
| `feat/collective-experience-gate` | `91b8c38ec` 做出首支带导览前端；`9fa225fadcac85301c971d77bcff5aa2d40476cf` 画出四栏空间语法 | 第一稿被 You 明确反馈“不太是我想象中的”；低保真是 Design Gate 证物，不是冻结 UI |
| 既有 Feature | F044/F077/F128/F246/F276/F277 等提供 Channel、身份、开 Thread、判断、关系与注意力器官 | 没有一个旧 Feature 拥有多 Café Collective 的产品整体 |

因此本次状态迁移是：**方向 5 正式登记为 F290；Experience Design Gate 继续进行；未授权真实
后端、联邦协议或生产 UI 实现。**

## 2026-08-26 Scope Reset — 回到 Collective baseline

F290 的 baseline 不是右侧 Workspace，也不是一个 Artifact 编辑页。它是
跨世界旅程：用户从自己的 Café 出发，经 global rail 进入 Collective，看到该世界的目的地、
Channel、Roadmap、共同资产与成员活动；各 Café 仍在自己的信任域里执行，值得公开的结果再回到
Collective 的准确对象。

2026-08-25 至 26 的连续纠偏证明，我们把两个不同问题绑在了一起：

- **F290** 要回答“多个真人、多个 Café、多只猫怎样进入同一个共同世界并持续协作”；
- **[F307 Composable Workbench](F307-composable-workbench.md)** 要回答“一个用户怎样让 Chat、File、
  Browser、Artifact、Review 与 Agent Run 同时留在自己的工作集里”。

因此 F290 不再拥有 tab、split、sidecar promotion、layout persistence 或全局 restore。F290 只向
F307 提供 Channel、Topic、Roadmap、Artifact、Review 等领域 surface descriptor、权限投影、
lineage 和 exact result target。PR [#3981](https://github.com/zts212653/clowder-ai/pull/3981) 的
working-set、恢复与 Agent Run tab 代码保留为 F307 原型证据；它仍然 OPEN，不是 F290 交付，也不
构成 F307 Gate 通过。

“共同工作集”也不是 F290 要注册进 Workspace launcher 的产品对象。共同工作台就是现有
application Workspace 的整体升级；F290 的对象以后进入这张共享工作台，但 F290 不在工作台里
再造一个同名房间。

## 2026-08-28 First Runtime Vertical — `#1401` executable contract

社区讨论 [clowder-ai#1401](https://github.com/zts212653/clowder-ai/issues/1401) 已收敛的第一条
真实链路冻结如下；完整状态表、崩溃窗口与验收命令见

| 收敛结论 | 本轮可执行契约 | 不得偷换的边界 |
|---|---|---|
| 一个 canonical Web client | 独立 Service 托管唯一 Client 与 human/Channel truth；直接浏览器与 Clowder AI `/collective` iframe 打开同一 Service route/build | Clowder AI 不复制 Channel、登录、membership 或第二套 Workbench |
| deployment / Human login / endpoint connection 三件事 | Service 是独立进程/端口/持久化身份；provider subject 绑定稳定内部 `humanId`，Human session 在 Service；endpoint credential 只在 Host Connector `0600` store | Service 不是插件子进程；Connector 不托管 Human 身份；endpoint credential 不是 Human 登录 |
| 一次性 owner bootstrap | 首启只保存 bootstrap digest；消费后仅可建立首个 Collective/steward 并删除原始 link；邀请成员、配对 endpoint 与日常协作前必须完成 Human auth binding | bootstrap 解开 self-host 首启 provider 循环，但不兼任日常登录；显示名不能创建普通成员 |
| 自动 pairing 主旅程 | 已登录 member 为自己的 Café 生成短期、nonce + Host-origin 绑定 intent，经 exact iframe window/origin `postMessage` 交给已启用官方 Connector exchange | 不让用户粘贴 endpoint secret；不要求 steward 代成员持有 endpoint authority；不把意图生成当连接成功 |
| Human 与 Agent 分型 | Human actor 来自 auth-bound Service session；Agent 是该 connection 绑定 Human 下的结构化扩展，由 endpoint credential + Host 已登记 Cat + durable invocation execution receipt 构造 | Agent 没有独立 Service 登录/token，不伪装成人；Service 不能调用本地 Agent/tool |
| typed target 与 Host ingress | Service 只保存 Channel/message/Human/Agent target；默认 Channel 进入 Host 配置的 ingress Thread，Human/Agent target 由 Host 显式映射到 notification Thread / local Cat route | Service/Connector payload 不携带本地 Thread/Cat authority；没有映射时 fail closed，禁止猜投 |
| Service canonical order | accepted event 在同一持久事务内获得 stable `eventId` 与 Collective 内单调 sequence；`clientEventId` 重试返回原事件 | requested / persisted / accepted / ACKed / acted 必须分开表达 |
| replay + ACK | Connector outbox 先落盘后发送、inbox 先落盘后 ACK；崩溃或断线按旧 cursor 重放并去重 | ACK 不得超前、倒退或跨 connection；“收到”不等于猫已处理 |
| 稳定 namespace | wire/store 全程保留 `serviceInstanceId / collectiveId / connectionId`；UI 本轮只选一个 active connection | 不为单连接 UI 抹掉多 Service/多 Collective 数据模型 |

### 本轮产品旅程

1. **Server provider / owner**：从干净 Clowder AI 选择“部署新 Service”，在产品里确认本机部署位置与
   数据目录 → 产品安装并启动独立 Service → 通过 GitHub App Manifest 在 GitHub 页面确认创建 identity
   provider，凭据直接回到 Service 的 mode-`0600` store，不经终端、聊天、剪贴板或 URL bearer →
   一次性 bootstrap 建立首位 owner session 与第一个 Collective/steward → 当前 Café 自动配对 →
   ready check 通过 → 在 canonical Client 进入 Channel 并创建邀请。纯 Service 安装入口必须复用同一个
   setup state machine、credential store 与 bootstrap truth，不能另造管理后台。
2. **Collective member**：在另一个真实浏览器会话打开单次邀请 → 完成 GitHub Human authentication →
   原子建立独立 Human binding/session/membership → 进入同一个 Collective 的同一个 Channel → owner 与
   member 双向发信并看到对方消息 → 刷新浏览器与重启 Service 后，membership、session 可恢复关系和
   canonical message order 仍成立。只生成邀请、fixture provider 或单边发信均不算 Journey B 已交付。
3. **Clowder AI endpoint**：从官方插件目录显式安装并启用 Connector → 从 global rail 打开
   `/collective` → canonical Client 发起配对 → Host 托管凭据并显示 redacted live/ACK 状态 → 可重连或
   双边撤销。

### 本轮明确未证明

其他 IdP/OIDC provider、真实 GitHub 账号下的 Manifest 创建/授权 dogfood、TLS/公网 ingress、跨机
endpoint pairing、backup/restore 运维、完整多连接切换 UI、跨 Service federation、registry-distributed
Connector、Artifact/Roadmap/Action Space、F307 tab/split/restore 与全部 F309 内容面均未证明。5102
experience gate 只保留为旅程 baseline；PR #3981 只保留为 F307 原型证据，不能恢复为 F290 第二套
Workbench。

### 当前未完成能力（2026-10-12 对账）

当前已交付证据、责任接缝与顺序统一见开头“当前进展与下一步”，这里保留原缺口的验收范围：

1. **入场与部署**：provider #4296 已合，既有登录入口可用不等于干净安装、两位真实 GitHub Human、跨机部署及恢复全部验收；AC-L1/L2/L3 继续开放。
2. **整页体验与登录恢复**：首页 #5205、入口 #5304 已交有限范围；#5473 已合入临时不可达不清有效会话的修复与浏览器回归。最新 Collective 设计、真人世界切换、真实 Alpha runtime 重启及关闭标签页后的持久登录仍未收口。
3. **团队工作流程**：Work/Roadmap/Vote 已有基础实现，真实 Meeting/Issue 输入、跨 owner 协作、验收与发布去向仍需完整运行证据。
4. **共同产物与记忆**：共享 Markdown 依赖 F309 AC-B6；资料库、版本/派生、批注→Topic、修改裁决、团队记忆及原处回流仍未形成完整团队体验。
5. **成员治理**：普通成员无未结责任时的 self-leave 已随 #4646 实现；管理者交接、未结责任处置、完整权限/公开投影与实际跨 Café 恢复仍开放，不能再写“成员退出全部未实现”。
6. **真实团队 dogfood**：软件/模型证据不能替代 You 与吴浪或社区协作者的完整 J0–J7 / AC-D1/D2 使用验收。
7. **领域宿主接入**：F307 typed mount、世界目录和首页已有；Artifact/Review 的领域权限、lineage 和返回位置由 F290 接通，不等待整个 F307，也不复制布局或内容状态。
8. **首猫及多猫参与**：#4396/#4955 与后续修复已提供实现和运行证据；两个不同真人、真实家内接力/并行、refresh/restart/revoke 与 AC-A8/AC-C3 仍须按原范围验收。

### 2026-09-06 Takeover — 从连接在线到首猫真实参与

operator 在 `private-source-id` 将 F290 推进交给 Astra，并要求接齐原设计、F309/F310

- **设计 anchor 仍在**：`feat/collective-experience-gate`；最后 UI `4c479dd6e53cacad4eb1cd274a14afbf63176ac3`，
  分支 audit HEAD `a981211f1bcc5bd2b432e457be5f31deeabc667e`。复用产品语法，不复制 fixture 或旧外壳。
- **本机观察不等于完整激活验收**：operator 已在本机 canonical Client 发过 Human 消息与 Topic 回复；
  2026-09-06 只读核验发现 Service 与两个 endpoint connection 在线，但它们绑定同一 Human/Collective。
  这不是两个真实 Human 的 AC-L2，也未证明干净首次配置、重启恢复或 Agent 发言。L1–L3 保持未勾选。
- **下一条完整用户旅程**：从既有部署/登录/pairing 继续，让人带第一只具名猫进入共同现场，猫经
  正式工具读到被授权的公共上下文、回复原消息；有明确委托时再进入私人执行并回传可公开结果。
  先证明真实人与猫能协作，再扩展产物协同与其余目的地；不以配置按钮可点或 callback 存在交付。
- **依赖事实**：F309 GenOffice DOCX 的准入实现仍在隔离分支，未完成发布、宿主装配和真实编辑验收；
  它是后续共同产物的内容协作依赖，不阻塞首猫 Channel 旅程。F310 继续拥有全局 Needs Me 与委托闭环。
  F290 只提供自己的来源、公共对象和权限裁剪后的回流；既有 F307/F309/F310 ownership 不变。

### 2026-09-06 First Cat Implementation — landed，真实验收继续开放

[PR #4396](https://github.com/zts212653/clowder-ai/pull/4396) 已合入 main，merge SHA
`a267881e72067c1fdd3940ef618983a19dc25600`。公开请求先进入限域 participation grant，正式挂载
current-context/read/reply 三个工具；持续私人执行独立核验本地 owner admission，并复用 canonical
Task。当前来源与持久回复 operation 在重启、丢响应和撤权时维持原位置、原署名与不重复发送。
首版公共执行只启用经过装机隔离探针验证的 Codex provider；其他 provider 明确不可用。

Terra 完整 INV-1～8 审查与实际合流差异审查、Opus 4.7 独立 full PR 审查均批准，无 open P0/P1/P2。
后者按 merge-gate 接替已实核额度耗尽的云端来源；typed verdict
`[thread-id]#private-source-id` 覆盖 exact `d8bf1bace31c`。
完整安全门禁 run `f8b58613-98cd-4461-ad3e-1bc9dd9fb563`、当前合流点定向验证、Redis 174/174、
实际 direct/embedded 浏览器旅程与 native Codex policy 均通过，完整证据和 continuity 见 PR。

`main=landed:a267881e72`；`live=dormant`：合入后只读核验 runtime HEAD 仍为 `510e3d53ee`，
未加载目标提交。浏览器身份仍是 synthetic；AC-L1/L2/L3、AC-A8、AC-C3、双 Human 真实 GitHub
UAT 与完整 F290 acceptance 保持开放。这里只完成实施/review/合入子任务，不关闭主 thread 的整体责任。

### 2026-09-11 Usable Release Handoff — 自动带入 Café，而不是逐猫配置

operator 在 `private-source-id` 明确纠正“带猫加入”的默认旅程：Host 应自动发现
自家已配置且具备公共参与资格的伙伴、默认带入，用户只处理显式排除和必要的频道例外；打开
「我的 Café」先看到当前现场相关的工作、伙伴活动、待人判断与返回入口，参与管理退到次级入口。
随后 `private-source-id` 要求在 2026-09-14–20 交付完整可用版本，并把实施交给
Sol。Astra 保留总体计划/架构责任，Sol 是当前唯一实施与集成接手人。可执行范围、日期、风险和

自动接入保持三份真相：Host 的 desired policy（默认纳入、显式排除、频道 override）、运行时观测到的
eligibility，以及实际物化的 Café×Channel cat associations。资格暂失或恢复不改写用户偏好；reconcile
只物化策略允许且当前有资格的交集；排除/撤回优先于默认值和旧 connection。接入仍不等于唤醒、
私人委托或 owner authority。该计划不缩减 J0–J7 / R1–R22，也不构成生产激活或 Feature 关闭授权。

### 2026-09-13 W1 Checkpoint — 具名、持久、可收回的消息 reaction

canonical Client 现已在 Channel 与 Topic 的同一公共消息上提供 `👍 / ❤️ / 🎉 / 👀 / 🐾` 渐进回应。
每次操作发送明确的 `active=true/false` 目标状态与幂等 request ID，不使用可能因网络重试反转两次的
blind toggle；Service 以已认证 Human、精确 Collective 与公共 Channel event 三重核验后保存每人的
reaction lineage；公开 Channel 内 `@Human` / `@Cat` 的具名寻址与 Topic 回复仍可回应，未知 event、
没有公共 Channel 坐标的旧记录与非支持 glyph 均拒绝。所有当前成员看到同一具名汇总，刷新与
Service 重开后仍保留；桌面 hover/focus 与触屏都有添加入口，撤回只改变当前投影而不伪造另一位成员。

两位隔离 Human session 的 Store/HTTP 回归与 production Client browser journey 已覆盖并发汇总、
重复请求、添加→刷新→收回和成员姓名；这仍是 fixture 证据，不替代真实 GitHub 双 Human UAT。
W1 的 reaction 子项因此有实现证据，但 Markdown、附件、语音与可交付产物仍按各自 owner/公开边界开放，
不能把本 checkpoint 扩称为整项 W1 或 AC-A3 已完成。

### 2026-09-11 W3 Checkpoint — 讨论长出公共 Work 与活的 Roadmap

本节保留当日实现证据；其中 Human 手动接受与分配不是 09-30 更新后的终态默认旅程。

当前 feature 分支已把公共协作对象落到 Collective Service：Work 提议保留原消息和 Channel，Human
明确接受后才出现 accountable human，并可把执行精确分配给自己 Café 在当前频道已声明的猫；该分配
生成一条原处可见的持续处理请求，Host 仍独立决定是否准入私人 Task。猫的精确回复先进入
`result_ready`，accountable human 确认后才完成。依赖关系以 revision/CAS 更新，未完成的前置会阻塞
下游，完成历史不会被路线重算覆盖；Roadmap 与 Work 消费同一批 Service 记录和历史。

canonical Client 在原消息下呈现 linked Work 卡，提供“交给自家猫 / 由我负责 / 先不跟踪”，只有真实
Roadmap 存在时才显示 Roadmap 标签，并提供阶段路线、依赖关系和我的路线三种视角。正式公共调用新增
`cat_cafe_collective_propose_work`：猫只能从当前获准来源创建无负责人提议，不能据此创建 Task、分配
他人或扩大权限。隔离 Service + 原生 Host 浏览器旅程已覆盖提议、承诺、私人 Work、结果回原讨论、
Human 确认；这仍是 fixture 证据。Roadmap 随后补齐同频道多路线选择与持久 `active/completed` 生命周期：
只有 accountable Human 能修改、完成或重开，未完成 Work 会阻止路线假完成，已完成路线重开前不可改动，
每次状态变化保留 revision 与历史。真实 Meeting/ASR、跨 owner binding authority、双 Human 真实事项和
独立验收仍开放，因此 R6/R7/R12、AC-A3/A6/D1 均不勾选。

同一 W3 分支现已加入明确非约束的 `informal_poll`：它保留原消息/Topic 位置，固定标注
`preference_only`、实名 ballot 与“当前成员可参与”，支持 2–8 个选项、1/3/7 天截止、每人一张可修改
ballot、并发投票、发起人/管家手动结束和重启恢复。Client 原消息内联起草、投票与计数，不提供 binding
模式，也不会从票数生成 Decision 或 Roadmap 承诺。两位隔离 Human session 的真实浏览器/HTTP 旅程已覆盖
创建、各自投票、改票、权限、刷新和结束；它仍是 fixture 证据。

binding Vote 采用 architecture owner 收敛的最窄 authority：只有 Roadmap accountable Human 能对自己
已有权负责的精确路线 revision 开票；开票冻结当前已认证 Human 名单、来源、选项、截止、规则版本与
`floor(N/2)+1` 的 quorum/pass 门槛。Human 一人一票，可改、撤或弃权；弃权计参与不计支持，平票、未过半
或人数不足均不形成决定。名单成员失权或路线 revision/负责人变化会让整轮失效，不能缩小分母凑通过；
晚加入者等下一轮。通过时只幂等生成带完整票决 provenance 的 Decision，绝不自动修改 Roadmap、认领 Work、
分派私人猫或替其他 owner 承诺。两位隔离 Human 的 browser/HTTP 旅程已覆盖冻结、投票、越权、结算、Decision
与路线未变；跨 owner 授权仍须既有可验证委托，因此 R7/AC-A3 在合入和真实验收前仍不勾选。

公共 Work 的结果验收现已与 Host 私人 Task 形成可恢复的终态闭环：canonical Client 只通过当前
iframe bridge 上报公开的 Work/assignment/result/revision 坐标，不接触或携带私人 Task id；Host 先用
本地 owner session、frame source/origin、bridge generation 与 Human/connection 坐标拒绝伪造，再由
Connector 使用该 Café endpoint credential 向 Service 重读“确实分配给本 endpoint 且已由 accountable
Human 验收”的当前 Work。Host 随后只沿既有 assignment event → inbox route receipt → source Message
找到唯一 Task，并调用 F310 `EntrustedWorkLifecycleService.close` 写入 `satisfied` 与三条公开 evidence ref。
错误 result/revision、另一 endpoint、撤权连接和错误 source 均不改 Task；丢回执会由 Client 重试，成功
回执停止当前 bridge 的重复写，刷新/重连后重复通知返回 `already_closed`。真实 production browser 旅程
已证明 `result_ready → Human 确认 → public completed → private todo/open 变 done/satisfied`；它仍是隔离
Service fixture，不替代两位真实 GitHub Human 或 J3 Meeting dogfood。

非作者复核随后发现两处恢复/authority 竞争并已在同一分支修复：Service 重读、Host route/inbox/source
核验与 Task close 现在共享 Connector 的单一 connection authority fence，`revoke` 与消费结果严格线性化；
Host 只对 `closed` 或 evidence 完全一致的 `already_closed` 发 iframe ACK。Task 尚未 admission 时返回可重试
`not_admitted`，不同 evidence 的既有终态返回显式冲突并保持原 closure；Client 在未收到 ACK 前持续重试，
收到 ACK 后才停止。仓内回归同时覆盖 close-first/revoke-first、迟到 admission、CAS 竞争终态与 typed ACK。

同日吸收 #4477 后，旧 `experienceGate=f290-assembly` 两份结构披露已改为真实 product-integration
claim：直连 Service 默认 `/` 必须到达唯一 `collective-product-shell`，Clowder AI 默认 `/collective`
必须到达唯一 `collective-launch-surface`；两条 `(testPath, journeyId, surfaceTestId)` 在同一份专用
browser 文件中实际注册、执行和完成。该证据只证明默认入口与 production mount 成立，不替代上述
双 Human UAT、完整 Work/Vote/Roadmap、内容协作或 Feature completion 签字。

### 2026-09-13 W4 Dependency Census — Markdown owner 仍未成立

代码、Feature 与测试三路核对后的结论是：F307 mount 已就绪，但 F290 目前没有可合法消费的跨 Human
Markdown 内容 owner。F307 的 `createContentEditorSurface` 与 `F307OwnerSurfaceRenderer` 已能保存并挂载
带 `contentRef + sessionRef` 的 typed owner surface；它不拥有内容或权限。F309 的
`ProjectContentOwnerService` 已能持久化 bytes、owner revision 与 settlement receipt，现有
`WorkspaceEditorService` / `NamedCatContentService` 却只实现 DOCX，并把 Human 访问限制在 Host 的单一
`ownerUserId`。这不能证明两个已认证 Collective Human 对同一公开 Artifact 的 read/annotate/propose/apply/version/revoke。

F063 `/api/workspace/file` 对 Markdown 的能力是本机 worktree read 与 SHA-256 CAS edit session；F232 是
Artifact 列表和正文 renderer。二者都不签发 Collective principal authority，也不拥有 F309 annotation、
proposal、version lineage 或 revoke。`packages/web/src/app/dev/f290-asset-collaboration/` 仍是 localStorage
fixture，不能进入 canonical Client 或充当第二内容 store。

W4 因此保持未交付并进入 09-14 工期重估。责任边界是：F309/content owner 先提供 owner-backed Markdown
slice 和双 Human fresh authorization/revocation，F307 继续只 mount，F290 只消费 domain permission context、
Artifact lineage、Channel/Topic 与 exact result target。此结论不阻塞 W3 Meeting/Needs Me 或 W5 生命周期；
不得为赶日期在 Collective Service 内复制 Markdown bytes/version truth。F309 owner 的独立复核已随
`main@4ff6177e25` 落为 R24/AC-B6 与 ownership cell；F290 以该 AC 的两 Human + revoke/restart 证据作为唯一
解锁条件，不维护第二份 Markdown 协作契约。

### 2026-09-03 Server Provider Closure — 身份提供方不是手工前置条件

GitHub 官方协议与当前 `github-human-auth-provider` 已完成契约级对照：GitHub App Manifest 会把
`client_id` / `client_secret` 经一次性 conversion response 返回给创建方；GitHub App 的 user-to-server
授权仍使用现有的 `authorize → access_token → GET /user` 链路，而且 Human 可以授权未安装的 App。
因此 F290 不需要更换 Human principal、引入 Agent token 或预置项目方共享 OAuth App。

实现必须同时守住以下边界：

- Manifest registration、Human OAuth 和 endpoint pairing 是三个独立 state machine，各自使用一次性
  state/nonce，不能互相代偿或共享 completion bearer；Manifest 临时 code 必须在一小时内兑换。
- self-host provider 创建 public GitHub App，使受邀 Human 可以授权；只请求身份所需的最小权限，
  不借登录索取 repository/organization authority。
- Service 只持久化当前登录链必需的 `client_id` / `client_secret` 与可公开 app metadata；返回的 PEM、
  webhook secret 等未使用高权凭据不得进入 Host、日志、浏览器或通用配置投影。
- 凭据落盘、Service restart 与 provider readiness 必须由真实测试证明；官方文档对照只证明协议兼容，
  **不能替代首次真实 GitHub 创建/授权 dogfood**。
- 若真实 GitHub dogfood 证明 GitHub App user-to-server flow 无法满足本契约，停止本地激活；不得自行
  降级为共享 OAuth App/device flow。该退路会把 identity provider 绑到项目方运营账号，必须由
  operator 重新拍板。

### 两档激活门（消除“未激活所以无法 dogfood”的循环）

1. **Local self-host usable**：仅当一台干净 Clowder AI 在产品内完成部署、Manifest provider setup、
   bootstrap、当前 Café pairing，且两个真实 GitHub Human 在同一 Channel 双向发信并在刷新与 Service
   restart 后恢复，才打开本机入口。它不宣称公网可用。
2. **Public multi-Café**：另以 TLS/公网 ingress、跨机 endpoint pairing、外部恢复与真实多 Café
   dogfood 为开关条件。第二档未通过不阻止第一档本机使用，但 UI 必须明确标注本机边界，不能把
   localhost ready 投影成 public ready。

## Stable Product Coordinate System

| 对象 | 稳定含义 | 不是什么 |
|---|---|---|
| **Café** | 一个人与其多只猫长期生活的身份、信任与委托单元 | 组织的下属账号、公共猫池 |
| **Collective** | 多个 Café、人和治理清晰的组织猫共同进入的团队世界 | 必须是公司或传统 Org |
| **Channel** | Collective 内人猫共同驻留的长期现场 | 无尽 LLM session、纯工单流 |
| **Thread** | Café 内私人生活/思考房间，或有边界的工作上下文 | 默认组织资产 |
| **Topic** | Channel 某条根消息展开的局部讨论视角 | 新的主内容世界、另一条私人 Thread |
| **Living Projection** | 从私人来源发布出的、可持续生长且保留 lineage 的公共生命 | 私人原文复制或一次性贴文 |
| **Asset / Artifact** | 可被阅读、批注、修订、引用、体验或继续接棒的版本化共同对象 | 文件附件、静态网盘条目或无来源摘要 |
| **Work / Task** | 从表达中形成、具备责任和状态的承诺对象 | 任意消息自动任务化 |
| **Vote / Decision** | Collective 的轻量意见聚合或有约束力判断；二者必须显式区分 | reaction 数量、猫替人拍板 |

品牌层保持：`clowder-ai — run your own cat café.`；Café + Bond 是世界观核心，
Collective / Channel / Thread / Living Projection 是稳定产品对象，“长桌 / 前厅 / 里屋 / 街区”
只属于可变体验语言。

### 设计铁律：不增生概念，也不强行耦合（2026-09-24）

**不准把一个东西变成一堆概念；也不准为了“归一”，把本来不同的东西硬耦合。**
这是同一条设计要求的两面：按对象真实的职责、权限与生命周期决定边界，不能按页面名字或
局部实现方便来拆合。沿用[元审美 §3.1 的最小充分表达](../canon/meta-aesthetics.md)，
不另造一套与既有对象、规则冲突的体系。

- **应当归一的必须归一**：已有对象能准确表达的权限、可见性、成员和状态差异，保留为该对象的
  属性与行为；不另造产品概念、平行资产或独立真相。多个入口可以服务不同操作，但必须指向
  同一对象和权威来源，不能各自长出一套规则。
- **应当独立的保持独立**：不同的职责、授权或生命周期，不能为了少一个名称、复用一张页面而
  合并。共享展示和基础能力，不等于共享身份、上下文、数据权限或责任。
- **本次落点就是 Channel**：公共与邀请制是同一种 Channel 的权限和可见性差异；初始“我和我的猫”、
  后来邀请好友，是成员变化。首句也是正常频道消息，不再出生“伙伴私聊 / 伙伴协作间”这套平行产品。
  猫身份、频道接收上下文与 Work 的来源关系仍各负其责；不能把私人 Thread 并入 Channel，
  也不能让用户先学会这些实现关系才能发第一句话。

**本次反例与停止状态**：为解决“百人频道不应围观第一问”，我们先后把引导画成“我的 Café 私聊”、
“Alpha 伙伴私聊”和独立“伙伴协作间”，又在首问上堆入工作选择。作者与整体验收者（包括 Astra）
反复验证局部交互，却没有及时质疑新入口本身是否必要；原型点通不能证明产品模型正确。
operator 已于 2026-09-24 停止本轮实现。上述候选不构成 Design Gate 签字，也不因修正文案自动恢复开发。

**新授权与新版 Gate（2026-09-25）**：operator 在
`[thread-id]#private-source-id` 亲手点过
这次只批准沿现有 Channel 的“未连接入口 → 真实名册确认 → 本地四拍演示 → 公共频道真实首问”。
前段停止的私聊/协作间候选没有恢复；演示不产生 Service 事件，真猫原处具名回复必须另以
Alpha 真实账号验收。吴浪 B 机依 operator 顺序暂停，直到 A 机单人带猫链路通过。
随后 source `private-source-id` 仅授权上述“两台 Mac 续办”范围，旧候选仍停止。
邀请制 Channel 的真实权限仍未交付；本次记录不把设计纠偏冒充权限实现或验收通过。

来源：`[thread-id]#private-source-id`（铁律两面与停止授权）；
同 thread `private-source-id`（本质是 Channel 权限与可见性）、
`private-source-id`（邀请制 Channel 与平行 Thread 追问）。

## Product Boundary

### Channel 接收端与多 Thread 关系（2026-09-07 原设计查漏）

沿用 vision §5.1–5.3：每 Café×Channel 有一个 Host 侧逻辑接收端（还须校验 Service / Collective
范围），保存持久游标、standing interest、上下文胶囊与多猫参与关系。接收端不是某次 LLM
session，也不是“一只猫一条跨频道公共 Thread”；同一猫参加多个频道时，频道上下文分开。
系统管理接收 Thread，用户只需理解成员/范围，不逐条手填 Thread ID 或照搬 F247 的网页会话绑定。

无 @ 消息的注意力沿各家已声明的关注和值守关系安排，当前产品方向支持下节“只听 @ / 值班猫看全部”两种设置；
不能把这里的端点关系解释成所有模式都要让模型读取所有消息。表达允许安静，提问/
邀请须显示尚未接住或已回应，不能落库即等同于有人处理。显式具名 @ 优先且保持直接寻址。
一个端点可以关联多项 Work 与私人 Thread；续接必须有精确来源、工作关系与有效家内准入，
不能让公共引用自己授予 owner 权限，或以最近 Thread / 固定映射兜底。

**2026-09-07 查漏时的代码基线（历史记录，不代表今日实现）**：当时已自动建接收 Thread，
但仍以 connection 内 human:cat 为单位；无 @ 只落默认 ingress，多 Work 自然续接也未完整实现。
当前进度应结合本文带日期的合入记录与实际代码核验，不能继续把这份旧基线当作现状。
来源：operator `private-source-id`、`private-source-id`、
`private-source-id`；Fable 查漏 `private-source-id`。

### 2026-09-30 默认自决与两轴设置（operator 已定方向）

来源：`[thread-id]#private-source-id` 原问题与
`private-source-id` 引用批注。You 明确要求“默认的话就是猫猫自己决策”，
保留研究建议及来源；建议不自动成为已接受架构。

- **接活默认由猫按家规与主人的有效授权决定**；用户可以改为必须人工批准。常规请求不以主人逐单点击
  “交给家里”、选猫或选 Thread 为必经路径。猫可以消费覆盖相应责任的主人委托来形成公开承诺与 accountable human，
  仍保留真实执行猫和授权来源；这不等于外部发言自动成为主人指令。
- **听什么与怎么决策是两条独立轴**：只听 @ / 值班猫看全部；猫自己决定（默认）/ 必须人工批准。
  看见消息不等于接下工作，也不等于所有猫都被唤醒。“只听 @”与持久传输、已有工作反馈的关系，
  听取模式的默认值及配置层级仍须在原讨论收敛，不能把Ragdoll的小团队/大频道建议写成 operator 已定事实。
- **人保留必要判断**：人工批准模式、超出有效委托或确需主人决定的事项才进入相应判断入口；
  普通表达、灵感与进度查询不自动长成 Work 或审批。采用作品版本与验收工作继续分开，
  “少打断”不删除已经约定的结果验收，也不把公开接住等同于工作完成。
  operator 293 认可的例外入口保留“允许这一次 / 不允许 / 以后这类都允许”；一次许可与可撤回的同类持续规则分开，
  不能只做允许/拒绝二选一。细节由通讯模型 §4 持有。

本节取代“首猫的人工接受是所有日常工作的默认入口”这一解释；09-29 的 Host 动作保留、来源重验、
幂等、原处返回及私人信息边界继续适用。**本次只同步产品方向，不改运行中的权限，也不宣布自动接活已交付。**
Host / Service / Task / 内容 owner 分工、一个 Work 一个 current assignment、真实署名和持久回流保持原合同。

**已落盘的通讯约束**见[通讯模型](../architecture/f290-communication-model.md)：授权与事项定位分开，
先沿精确来源续接，按权限装配相关上下文；不同 Work 可并行，同 Work 的责任/版本不能被旧执行覆盖。
下述“待确定”是 09-30 冻结时点的记录：主人委托的登记/撤回及 Service 验证接口、物理 Thread 创建策略、
听取设置细节、调度/预算与共享写入机制。前几项已有 #4955 的软件交付，具体已实现边界见
不把“每个 @ 新建 Thread”或“一个固定 Thread 承载所有工作”写为终态。实现与验收接回

### 2026-09-30 同一套猫身份、频道基数与跨频道汇总

operator `[thread-id]#private-source-id` 明确：进入 Collective 的就是
家里的既有猫，沿用原身份、配置和模型绑定，不另建公共人格。同一家也可能有同名猫；以稳定身份和公共
provenance 寻址，界面沿用既有身份信息辨认，不能只靠“You 家”或昵称区分。多现场不等于多只新猫。

operator `private-source-id` 提出的 10×10 例子：一家若获准参与全部 100 个频道，
就有 100 份逻辑接收关系，不再乘猫数，也不要求 100 个常驻运行的模型。物理接收 Thread 可何时建立尚未定。
主人可从一个频道向自家猫请求跨获准频道汇总；读取权、执行权与向当前读者公开的权限分别核验。
用权威消息/Work 记录及有来源索引聚合，不广播唤醒所有现场；记忆不是当前状态或统计的唯一依据。
完整跨世界/私人报告回到仅该主人可见的家内承载，原频道只呈现获准公开部分，无需为交付路由再逐次确认。
具体机制及反例见通讯模型 §6、§8–9；该目标作为 J8 / R23 / AC-C4 保持未验收，完成门槛讨论暂缓，当前先完成 UI/UX 北极星。

### F290 包含

- Collective、Membership / Join、Channel、Topic、Living Projection、Work、Vote / Decision 的
  产品关系与生命周期。
- Café 本地 endpoint 与共享 Channel 之间的投影、离线、送达、唤醒、身份、authority 与回流。
- 给人的 AI-native IM 与给猫的 harness 作为同一个产品的两面。
- Channel 与私人 Thread 共享同一富消息语言，同时保持不同的受众、权限与隐私边界。
- 团队记忆、集体注意力、Meeting → Roadmap → 各自猫执行 → Channel 回流的闭环。
- 从受邀、观察、带 Café 入席到干净退出的成员旅程。
- 组织代谢循环与社会环：既能推进工作，也保留意外发现、共同在场与关系温度。
- Collective 对宿主提供的领域 surface 契约：Channel、Topic、Roadmap、Artifact 与 Review 保留
  objectRef、权限、lineage 与 result target；宿主如何 tab/split/restore 由 F307 决定。
- Asset / Artifact 的树、引用、派生、lineage、权限与 Collective result target；正文/version 归内容
  owner，跨媒介 SelectionAnchor、human-edit awareness、annotation 与 Agent patch lifecycle 消费 F309。

### F290 不包含

- 用临时数据模型或一次性页面冒充终态对象的 MVP。
- 把 Slack / 飞书 / Raft 的布局和功能逐项复刻。
- 把所有私人 Thread、记忆或猫的内部路由公开给 Collective。
- 把每条普通聊天自动变成 Task、审批或唤醒所有猫。
- 用预设“专家”标签替代具名猫的关系与 track record。
- 在现有 Workspace 内注册“共同工作集”模式、入口或第二套 working-set persistence。
- 把 reaction 当批准，把 informal poll 当组织承诺。
- 在 Experience Design Gate 前启动真实联邦后端、生产 schema 或迁移。
- 顺带重做单 Café 的所有上手体验；F290 只定义“带着 Café 入席”的跨域旅程。
- 自研富文本、代码、Office、图片、视频或白板编辑器内核，或拥有通用 SelectionAnchor、annotation、
  human-edit change receipt、patch proposal/accept/reject/undo/remap 存储；这些机制归 F309，正文/version
  与 renderer/editor transaction 归内容 owner，F307 只负责宿主布局。
- 把 Action Space runtime、IM / 日历 / webhook connector、Skill 编辑器或安装运行时吞进 Collective；
  F290 只消费执行主体、权限 / 能力摘要、触发来源与 exact result-return。

## Collective Entry and Host Contract

F290 只冻结 Collective 世界本身所需的空间关系：

1. **Global rail**：世界切换器，包含个人 Café、已加入的 Collective；宿主可同时呈现 F310
   拥有的全局 `Needs Me` 入口，但它不是 Collective 对象或 F290 truth；
2. **Collective destination**：当前 Collective 的 Channel、Roadmap、资产库、成员与固定入口；
3. **Collective scene**：Channel、Roadmap、Artifact、Topic、Review 等领域对象及其权限/lineage；
4. **Host adapter**：F290 把这些对象交给当前产品宿主；若宿主是 F307 Workbench，tab / split /
   sidecar / restore 全由 F307 决定，F290 不写第二份 layout truth。

Topic 的领域关系保持稳定：它必须锚定 Channel 根消息、复用同一消息与 lineage，关闭或换宿主不
创建第二种 Topic。Topic 默认呈现在哪里、能否晋升 tab/split，是 F307 的宿主策略，不再是 F290
本体契约。

### 双向望窗：能望见另一个世界，但不把两个世界混成一个

- 人在 Collective / Channel 时，现有右栏的**我的 Café 窗**承载经过权限过滤的自家动态、Work
  状态与待判断摘要，不搬运私人 Thread 原文。其入口可按下节迁移，但家内动作与原处返回必须保住。
- 人在 Café / 私人 Thread 时，右栏可打开**相关 Channel 窗**：显示相关公共讨论、Living
  Projection 反馈、承诺与请求的摘要，不把完整 Channel 复制成第二套 IM。
- 望窗限制的是“看”的密度，不限制“说”的长度；从窗内发言会正常进入另一边。正式认领、批准、
  授权变更等签字类动作必须进入对象所属的完整现场、读到足够证据后再确认。

双向望窗及上述信任边界是 F290 已确认的跨域关系；摘要密度、进入动作、back-stack 与窄屏形态
由宿主 Design Gate 验证。

### 2026-09-29 信息归属：家内接纳与唯一 Roadmap 目的地

来源：F322 `[thread-id]#private-source-id`、本线
`private-source-id`、F310 原 owner 回执
`[thread-id]#private-source-id`，以及
本节是 F290 对 R6/R7/R15 的迁移保留合同；不更改权限、工作对象或实现状态，不代表新入口已交付。
09-30 默认行为更新后，下列“保留接纳动作”指保留 Host 能力与必要的人工入口，不要求每单展示人工批准；
现有 standing grant 是实现基线，新默认委托的消费按上节收敛和验证。

**家内动作可以换承载，不能随抽屉一起删除。** 小信箱可作为全局待办唯一入口；私人工作进度由
Host 的既有 Task 读模型呈现，公共频道只显示获准公开的回执。公共 Work 与家内 Task 保持来源关联，
不是同一权限对象；不能把全部公开 Work、点名、送达回执或猫运行态都算成需要主人决策的待办。

- 必须保留查看准确公开来源与家内接收 Thread、接纳为持续工作、查看已接纳 Task/私人 Thread、
  按当前 Task revision 继续执行及返回原频道现场。接纳时保留原有期限澄清与截止时间输入；自动接纳只沿
  既有有效 standing grant，不因移动入口扩大。参与/撤回与带猫设置可移到成员页的家内操作入口，仍由 Host 核权。
- 候选展示来自 Connector 持久 inbox / route receipt 与本地 owner Thread/Task 的只读拼接。
  `collectiveOwnerParticipationView` 不读取 source participation identity 或 Service assigned Work authority，
  不能独立授予待办资格或执行权限；列表可见不能代替下述动作时的权威重验。
  `CollectiveWorkRequests` 的“有 messageId、无 Task、非 attentionRequest”只是现有按钮显示条件，
  **不是** F310 待办准入判据；普通聊天可供主人主动转为工作，不因此全部自动进入小信箱。
  本轮裁定先保留原请求位置的 Host 主动操作，不为迁移新造待办 producer；`resume` 对 open Task
  可见也不等于此刻必须人按一次。未接纳请求不进入“全部工作”，匹配既有自动授权的请求不重复要求主人批准。
- 动作仍由 `collective-owner-participation-routes.ts` 的 `/work/admit`、`/work/resume` 执行：
  要求本地 Host 的已认证 owner 会话。admit 重读 exact source participation identity，并经 `resolvePublic`
  核当前 Service participation 与 Host binding；resume 经 `withSynchronizedAssignedWorkAuthority` 核当前
  Task、assignment、revision/反馈来源。手动接纳要有明确动作，自动接纳要命中既有有效授权；看卡片、打开
  小信箱、读公共消息或外部参与者点击均不得替主人授权。重复接纳复用同一 Task；同一 resume requestId
  幂等，但现 UI 每次点击生成新 requestId，可能再次执行。新承载须防止一次用户意图因重复点击生成多个
  requestId，不能把有意再次续办与同一请求的重试混为一谈。
- `F290CollectiveWorkResultProducerAdapter` 只投影已经有 Task、prepared Artifact 与 current result
  publication 的结果判断，不能代替尚未接纳的请求来源。F290 负责提供可重验的精确来源、动作资格和过期状态；
  F310 已核定：现有统一读尚不覆盖接纳前状态；仅未来确有“当前必须由本 owner 接纳”的领域事实时，
  F290 再提供精确委托/本人/有效来源/未处置且无可复用授权的只读资格和原动作，F310 沿原接口消费与去重。
  缺 grant、尚未看到 Task、投递失败均不能单独推导该资格；本轮不冻结新 pending schema，不伪造 Task、
  Artifact、结果 receipt 或 Approval 来迁就现有门槛，也不复制待办 store。
  接纳已形成 Task 但 dispatch 失败时保留同一 Task 与准确恢复状态，不退回“未接纳”或重复建 Task。
- 新承载尚未走通接纳/续办/私人查看/原处返回，以及未登录、撤权、过期与重复动作反例前，保留现有
  “我的 Café”按钮与抽屉；主动操作不藏入纯参与设置。私有 Thread 标识、正文、执行细节与 Host 操作不传入公共 Service/Client。
  移除条件是替代旅程成立，不是图上已删按钮；完整场景返回继续受 F290 Client / F307 的 owner 分工约束。

**同意 Roadmap 收为共同体侧栏的唯一目的地，取消频道内重复的 Roadmap 标签。** 卡片“在路线里看”
是定位到同一 Roadmap 的快捷动作，不是第二个 Roadmap 产品或第二份数据。导航须携带准确 world、
roadmap、Work 节点与来源频道/消息坐标，进入后保留明确频道筛选及可见选中节点；目标被默认“当前重点”
筛掉时须按显式定位展示。一个 Work 属于多条路线时使用已有明确关联或让用户选择；不存在关联时不得猜第一条。
失效/撤权/对象不存在须解释并保留合法现场。`RoadmapWorkspace` 当前只在 roadmapId 缺失/失效时
回退首条路线，显式指定失效 roadmapId 时不得沿用；`RoadmapPanel` 的失效 workId 当前是无详情，
不得猜替代 Work。有效但被 scope 筛掉的 Work 可有详情却不在 canvas，新入口须使对应节点也可见。
从节点回消息/结果、再回路线时保留原过滤、观察方式、选中节点及 owner 持有的滚动/草稿。

R7 的其余能力不随标签条一起砍掉：对话仍为频道主现场；置顶保留频道范围的原消息引用入口；资料/作品
保留频道范围的筛选与原对象入口，复用同一内容 owner，不能用共同体全量列表替代。当前
`ChannelContentTabs` 只实现对话/Roadmap，置顶与完整资料页仍是开放交付项。已有的多路线选择、
阶段/依赖/我的路线、工作图/看板、历史、权限内编辑与 binding Vote/Decision 均随原 Roadmap 目的地保留。
这些迁移仍待新桌面默认入口的整段验收，不把区域归一记录当作实现或 UAT 通过。

## What We Learned from Agent Workspaces — 结论路由到 F307

2026-08-25，operator 把 Clowder AI 当前单槽 Workspace 与 Codex、Floatboat 等真实 Agent 产品并排
观察。外部资料来自各产品的一手页面，只能证明其公开设计与能力，**不能证明它们天然优于我们**；
以下结论来自多家独立产品的结构收敛、operator 实际使用截图与 F290 连续失败的交叉推断。

| 观察 | 与 Clowder AI vision 的关系 | 正确 owner / disposition |
|---|---|---|
| Codex / Cursor / Devin 把 Chat、File、Browser、Terminal、Review 等异质 surface 放进可组合工作区 | 符合 W8：人猫共同面对工作对象，而非只交换回复 | **F307**：typed working set、split、restore；不照抄 IDE 皮肤 |
| 多个 Agent run 可并行，离开当前 surface 后仍继续，结果回到任务 / diff / 文件 | 符合“猫是 Agent”与可追溯回流 | **F307 + runtime owner**：运行连续性与 exact result-return；F290 只定义 Collective target |
| Floatboat 在同一 living document 中同时允许人直接改、精确批注与 Agent 改写 | 符合资产代谢：对话不是产物的替身 | **F309**：human edit adapter + anchor + annotation + agent patch + confirm + version receipt / provenance |
| 工作区可开多个 tab、保留上下文并按需分屏 | 符合用户拥有注意力与工作集 | **F307**：application-level Workbench；F284/F290 都不重复造壳 |
| Agent Action Space 聚合 IM / webhook、目录、技能与活动 | 能解释一次动作由谁、以什么权限执行 | **只消费最小投影**：actor、capability / permission summary、triggerRef、resultTarget；runtime / connector 仍由其 owner 负责 |
| 一次成功工作可被整理成 Skill | 符合团队能力从实践中生长，但“成功一次”不等于通用 | **后置**：F290 可呈现 `episode / artifact lineage → candidate skill → human confirm`；Skill 编辑器、安装、权限与真实复用归 Skill / Action Space。首条 dogfood 不因它扩 scope |

### 外部一手证据（2026-08-25 读取）

- [OpenAI: Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)：项目内多线程、
  并行 Agent、diff review 与 app / CLI / IDE 连续性；
- [OpenAI Help: built-in browser](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)：
  一个任务中打开多个 browser tab，并对页面精确标注；
- [Cursor 3.0](https://cursor.com/blog/cursor-3)：multi-agent sidebar 与 diff / file / browser 的统一工作区；
- [GitHub Copilot agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)：
  多个隔离 session 按 repository 组织并可并行存在；
- [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)：shell、IDE、browser
  共存与 human takeover；
- [Floatboat Flow Mode](https://floatboat.ai/zh/blog/introducing-flow-mode)：同一文档里的手动编辑、
  Agent 改写、批注与会议产出。

这些学习现在拆成三类：F290 保留 Asset/Artifact lineage、权限与 result target；F309 拥有跨媒介
SelectionAnchor、annotation、patch proposal/disposition 与 remap/orphan 协作契约；F307 只负责
真实 Workbench 宿主，正文/version 与 renderer/editor 仍归内容 owner。旧

## Visual Weight Grammar（2026-08-09 Gate 1 v2 审美收敛）

一条公理统摄画面规则（ADR-043 C2 出生证不变量在视觉层的镜像）：

> **每一克视觉重量都要有语义付款人。** 元素的显眼程度必须正比于其语义重量；付不出
> 语义的重量（底板、胶囊、粗字、强调色）一律拆除。

四级付款人（从重到轻）：

1. **需要人行动**（Approval / Judgment / binding Vote）——可临时获得最高视觉重量；
2. **可拿走使用的产物**（PDF / Demo / 设计稿 / 代码版本）——紧凑可打开的产物卡；
3. **状态陈述**（Task 进行中、回复数、在场）——纯文本 + 小圆点级；
4. **元数据**（来源、身份、时间、标签）——muted 纯文本，永不占底板。

执行规则（Kimi 五根因实测诊断 + Maine Coon产物判据的收敛，全文见线程
`0001786259862540-001149` / `0001786262324014-001157`）：

- **纸与铅笔印**：内容直接躺在画布上；底板与边框只给第 1/2 级付款人；盒中盒禁止；
- **胶囊与色彩预算**：pill 基本只给 reaction；一屏语义强调色 ≤3 处；
- **动作跟意图**：对象上的动作（表情/回复/更多）hover 才浮现；reaction 有计数才占位；
- **hover 的边界**（防 ADR-043 C7 极简失联）：hover 只藏**对象上的动作**，不藏**世界的
  入口**——导航、搜索、Needs Me 永远可见；hover 隐藏的动作必须有触屏/长按等价路径；
- **动效纪律**：安静是基线，动是事件——状态变化用最小淡入，禁止常驻 pulse/闪烁；一屏
  会动的元素必须比静的少一个数量级；
- **字重纪律**：小号字（≤12px）一律 400/500 字重；eyebrow 大写加字距降级或删除；
- **右栏低一个声调**：底色与中栏一致、排版密度更轻——它是耳语，不是第二个嗓门；
- **温度来自生命迹象**：贴贴感靠 presence（谁在、猫在干嘛、最近脚印），不靠暖色贴纸与
  装饰图形；暖米画布是家的资产，保留。

语义皮肤对照（互不共用）：**reaction** = 计数 pill；**Task** = 左 accent 竖条 + 标题 +
一行灰 meta；**产物** = 图标 + 文件名 + 格式的紧凑卡；**Approval / binding Vote** = 带
行动按钮的高重量卡；**claim** = 纯文本状态行。

审美参照的边界：Slack / Raft / GenTeam 提供**呼吸节奏判据**（progressive disclosure、
色彩预算、产物卡），不提供审美目标——学它们的呼吸，不学它们的脸；Clowder AI 的脸来自
自己的画布与 taste 体系（F221）。

## Asset Collaboration Layers（2026-08-24 收敛，operator "很好" 确认）

资产页由四层构成，缺一层协同就退化（外部输入：刘赫伟"比 diff 更深一层"之问 +
operator "还得有团队协同的记录"，`0001787558675982-000004`）：

| 层 | 回答什么 | 载体 |
|---|---|---|
| **结果层** | 当前版本是什么 | 资产正文 |
| **变更层** | v(n-1)→v(n) 改了什么 | diff / 版本历史 |
| **对话层** | 大家说了什么 | 批注 + Topic |
| **轨迹层** | 这个版本怎么被决定出来的 | **协同时间线**（新增） |

**协同时间线 = 纯投影，零新对象**：把资产八步 Gate 既有事实（批注 → 修改提案 →
接受 / 部分接受 / 保留分歧 → 新版本）按因果串成可点回原文的时间线。双重身份：
**对人是审计线**（结论怎么来的），**对猫是学习材料**（团队记忆与自进化的食物——
组织代谢循环"进入团队记忆并修正自身"的实现层；F299 单猫 invocation 轨迹的
Collective 升维）。UI 文案叫"协同记录 / 历程"，"轨迹层"是设计词不上屏。

配套两条：① 资产页内**读 / 改 / 聊三态微地貌**（阅读=纸感安静、编辑=工作边框
焦点、批注对话=对话密度）——Terrain Grammar 的页内应用，解"全是一样的线框、
不知道自己在干什么"（operator `0001787547580643`）；② **UI 实现一律消费 F305
UI Design Gate 的共享设计与组件**，不再自造视觉——"像家"从手调变为结构性继承。

### Asset Collaboration true-frontend contract（2026-08-25 operator 纠偏）

2026-08-25 第一版 `/dev/f290-asset-collaboration` Alpha 只能切换预写好的阅读、审阅与批注画面：
批注占位是 `span`，发送、接受与保留分歧按钮没有行为，右侧记录也不会因用户动作生长。此前
以截图和模式切换给出的视觉 KEEP 作废；根因不是间距，而是交付物类型做错了。

随后 PR [#3945](https://github.com/zts212653/clowder-ai/pull/3945)（merge
`11dc4c9d598eee127f878b709026bfca5fec1fd8`）把该切片改为**真实前端、模拟后端**：fixture
只提供起点，用户编辑、批注、讨论、disposition 与历程由真实输入和事件处理产生，并保存在
当前浏览器。这个 landing 证明 Artifact surface 的局部 true-frontend contract，**不证明
Composable Workspace、Channel 汇聚、多人实时或 F290 umbrella 已完成**。

#### 一眼看懂的工作面

- 中央始终是**当前产物本身**；阅读是默认态，`编辑` 是对产物采取的动作，不再把
  “阅读 / 审阅修改 / 批注”做成三个平级世界。
- 右栏是跟随当前焦点的上下文工作面，只保留三个用户词：
  - **批注**：绑定到一段原文或一次文本选择；回答“大家对这里说了什么”。
  - **讨论**：绑定到整个产物；回答“还有哪些不属于某一段的协作对话”。
  - **历程**：由真实动作自动形成；回答“这个版本怎样走到今天”。
- 选中原文或点击段落旁的“批注”后，右栏直接打开该段批注；点击“讨论”打开全局对话；
  点击历程中的记录返回对应原文、批注或版本。右栏不是成员档案，也不是静态信息仓库。
- 当前状态必须用用户能行动的语言表达，例如“有 1 处修改等你确认”“这一段有 2 条批注”，
  不显示 `canonical`、`projection`、`inspector`、`judgment gate` 等内部设计词。

#### Alpha 必须真实完成的动作

1. **编辑产物**：点击编辑后，正文进入真实可输入状态；保存会更新正文、版本与修改时间，
   并追加一条可回看的历程记录。
2. **逐段批注**：从具体段落或选中文本发起；输入、发送、取消都可用。发送后新批注立即出现，
   数量更新，历程新增记录；空内容不能提交。
3. **围绕产物讨论**：讨论输入框可聚焦、输入和发送；新消息立即出现在对话中，并保留
   speaking-as 身份。讨论不伪装成逐段批注。
4. **处理修改建议**：接受会把建议真正写入当前正文；保留分歧会保持正文不变。两种结果都要
   关闭待处理态、记录决定与理由，并追加历程。
5. **状态连续**：在批注、讨论、历程与正文之间来回切换不丢当前选择、草稿和滚动位置；刷新后
   仍能恢复本次 Alpha 中产生的数据。开发层可以提供“重置演示数据”，但默认产品面不展示。
6. **诚实边界**：Alpha 不接生产后端，不承诺跨浏览器或多人实时同步；界面只需低声说明
   “本次体验数据保存在此浏览器”，不能因此把输入和状态变化做成假的。

#### 行为守卫（截图不能替代）

以下旅程必须由自动化测试和真实浏览器操作共同验证；只测按钮、文案或预设画面存在不算通过：

- `输入并发送批注 → 批注正文、数量与历程同时增长`；
- `输入并发送讨论 → 消息以当前身份出现，逐段批注数量不变`；
- `编辑正文并保存 → 正文和版本变化，刷新后仍存在`；
- `接受修改建议 → 建议落入正文、待处理态消失、历程记录决定`；
- `保留分歧 → 正文不变、理由可回看、待处理态消失`；
- `历程记录 → 能返回产生它的原文 / 批注 / 版本，而不是只切换一块说明文字`。

产品体验 Gate 的灵魂测试改为：**不给讲解，只给一个可运行页面；第一次看到它的人能否亲手
修改一段正文、发送一条批注和一条讨论，并从历程回到其中任一动作。** 任一步不可操作，整稿
判 TUNE；截图好看、单元测试全绿或预设状态齐全都不能覆盖这个结论。

这张 true-frontend Alpha 已证明一个 **Artifact surface** 的局部交互，不等于 F290 Product Shell。
后续 Gate 必须从 Channel / Destination 的真实入口打开同一 Artifact，并保留它与来源 Channel、
关联 Topic 或 Review 的领域关系；是否以 tab / split 共存由 F307 验收。不得再把单页截图称为
“最新 F290”。

### F309 content-collaboration consumer contract

F290 的差异化在 Asset/Artifact tree、lineage、Collective permissions 与 result target，不在重造编辑器
或拥有公共协作协议。Artifact 向 F309 提供 `contentRef`、domain lineage、permission projection 与
exact result target；F309 返回 versioned anchor、human-edit change notice、
annotation/patch/disposition/provenance references。
正文/version 的读写、resolve/apply/invert 仍由对应内容 owner 通过 F309 adapter 完成。

F290 可以依据 Collective permission、当前 Work/Topic 与具名猫职责决定哪些 change notice 值得进入
团队注意力；但不把每个 edit event 广播给所有猫，也不让 F309 决定 invocation。版本 receipt 与 patch
有效性是 F309/content owner 的事实，谁应关注和行动仍是 Collective/runtime consumer 的责任。

一次 living artifact 动作仍可消费 Action Space 的最小执行投影：`actorRef`、capability/permission
summary、`triggerRef` 与 F309 anchor/patch reference。IM、日历与 webhook 是入口，不是事实真相源；
连接器、目录授权、Skill runtime、编辑器安装与协作内容存储都不由 F290 实现。

## Channel Interaction Grammar

顶层期待契约是：**表达允许沉默；请求不能假装被接住；承诺不允许失踪。** 分享与玩笑无需
强制回应；提问、邀请与请求必须让“尚未被接住”可见；一旦形成承诺，就进入责任、状态与回流
账本。这条语义先于具体的投递、关注、唤醒、入上下文与处理五层机制。

### Shared rich language

私人 Thread 与 Channel 复用同一个 message / rich-block substrate：

- 交互式 Markdown 与引用；
- 图片、文件、语音与录音转写；
- HTML / Artifact / Demo 预览；
- Approval / Judgment、Task、Roadmap、Living Projection 与 Vote 卡；
- 原消息、来源、作者、speaking-as 与 authority 的可追溯关系。

**能力不按作者物种分配。** 人类输入框默认简单，通过 `+` 渐进展开语音、图片、文件、卡片和
模板；猫可以自然产生适合内容的丰富表达。人可以发富消息，猫也可以发普通文字。Channel 与
私人 Thread 的差异来自 public audience、permission、identity / provenance 与信息密度，不是
“人只能简单、猫才能高级”。

### From message to Task — no modal

1. 人或猫先用自然语言表达；原消息永远保留为消息。
2. 明确勾选“作为任务”时，由当前负责处理的猫理解语义并生成一张与原消息相连的持久 Task 卡，
   不要求人填写标题、owner、优先级等弹窗表单。
3. 缺少真正阻止承诺成立的信息时，猫在卡内用最少问题补齐，而不是让人重抄一遍。
4. 没有明确勾选时，猫可以主动提出
   `[创建任务] [先继续讨论] [不用跟踪]`，并说明为何值得跟踪；没有 authority 时不得静默替
   Collective 形成承诺。
5. Task 成立后仍能追溯到原消息、Topic / Channel、责任猫与 accountable human；进展以卡片或
   projection 回流，不把施工日志刷满 Channel。

### Low-friction Vote

Vote 是 Collective 的一等互动，不是当前高摩擦表格的复制：

1. 人先自然表达“大家选 A 还是 B”；猫把上下文整理成可编辑的紧凑 Vote 卡；
2. 发起人只需确认选项、截止与“随手问问 / 会形成决定”，不填写一大堆字段；
3. 参与者在消息流里一键投票，卡片原位显示仍在收集 / 已结束与结果；
4. informal poll 只表达偏好；binding vote / approval 必须显式展示 eligible voters、规则、
   authority、provenance 与结果去向；
5. 有约束力的结果可以生成 Decision / Roadmap 节点，不能靠 reaction 数量暗中升级。

### Two collaboration entries, one lineage

Channel 回复和资产批注都是协同，但不合并成两套聊天真相：

- **Channel 回复**锚定共同现场与根消息，适合发散、交换看法和召集参与者，回答“大家怎么看”；
- **资产批注**锚定 asset id、版本和具体位置，适合质疑、补证据与请求修改，回答“这里哪里要变”；
- Channel 回复可以引用资产；资产批注可以展开 Topic；二者通过 exact lineage 相连，不复制正文、
  不静默互相升级；
- 猫可以恢复外部聊天反馈与资产的关系、提出候选修改，但没有 authority 时不能直接改写 canonical
  版本或把评论冒充组织决定。

### Reactions and identity cards

- Reaction 是低成本的社会信号（看见、共鸣、好笑、担心），不等于批准、认领或投票。
- 点击人或猫头像在右栏打开成员卡。猫卡优先显示具名身份、所属 Café、accountable human、
  speaking-as、track record 与当前公开状态，而不是先暴露 runtime 配置。
- 表情、贴纸、语音与富内容不是装饰性次要需求；它们承担共同在场、情绪带宽与人类可读性。

## User Journey

### J0 — 人带第一只猫入场，并完成一次真实协作

**Scope unit**：每 Café×Channel 的接收端及其具名猫、公共来源与多个获准私人 Work / Thread 的关系；
首猫只定义体验起点，不限制端点只能一猫或一项工作。
从成员/「我的 Café」接引、Channel 输入框 @、按相关 Work 回家与原处回流；同一 Client 的
direct/embedded 装配先过体验确认，再进行整页接入。2026-09-07 查漏补入无 @ 参与路径，
端点单位与期待状态已明确，可开隔离体验实现 thread；该候选不改变以下权限契约，也未取得本轮 operator 体验签字。

人从 Café 进入已登录的 Collective → Host 自动发现自家已有且具备公共参与资格的伙伴并默认带入，
用户只确认允许参与的公共范围、显式排除与频道例外 → Host 配置可解释、可撤回的接收上下文，
公共成员卡显示具名猫、所属 Café 与 accountable human →
人在 Channel 向它发出明确请求 → 猫以正式工具读取本次允许的上下文、以自身身份回复同一消息。
所属 Café 的显示名与稳定 endpoint/connection provenance 分开；改名不改变身份或 authority。
公共位置与收件猫独立记录，当前请求与返回引用由 invocation 自动解析；公共参与执行默认只具有
获准范围的上下文读取与精确回复权限，自动 prompt 历史也按该范围裁剪，不继承本地 owner 权限。
需要持续工作且委托成立时，执行仍在 Café 的有边界私人 Thread，结果、必要判断与产物引用回到
原 Channel/Topic/Work。Task 只链接 source owner 的持久来源引用；跨 invocation/重启后重新校验
授权并签发临时返回凭据，发送操作由服务端持久化和恢复，丢响应不产生第二条消息。撤权或来源
不可用时明确返回失败，不改投别处。普通表达可以沉默，不自动创建 Task。撤回参与后停止新投递与公开发言，
历史署名与已承诺工作的处置仍可追溯。用户不需要填写 Thread ID、复制凭据或扮演猫发言。

### J1 — 私人灵感变成公共生命

You 在私人 Thread 与猫把想法聊清楚 → 猫主动邀请发布 → You 确认表达 → Living
Projection 出现在 Collective → Channel 讨论、猫爪、会议、原型、Roadmap 与成果沿它积累，
私人原文留在 Café。

### J2 — 社区 PR / Issue 不再被遗忘

贡献进入 Channel → endpoint 猫按各 Café 的关注判断 → 高价值但未成熟的事项留在前瞻记忆 →
自然断点重新浮现 → 人或猫形成 Work → 结果回流原贡献者与 Channel。

### J3 — Meeting → Roadmap → 各自猫执行

会议 ASR 与团队历史共同进入理解 → 猫补出认知缺口与候选决定 → 人确认承诺 → Roadmap 分解到
各 Café → 自家猫在私有 Thread 执行 → 必要进度、判断点、产物与证据回流 Channel。

### J4 — 在 Channel 里从聊天长出工作

09-30 默认行为更新：人在频道自然提出请求，猫按已生效的主人授权自行决定接活，系统定位新事项或已有工作；
主人无需逐单“交给家里”或选择 Thread。人工批准模式或超出委托范围时，才显示需要人的决定。
确认接手后，来源关联的工作卡呈现责任与 accountable human，施工离开公共消息流，结果回同一来源。
普通聊天和查进度仍留在原处；对结果的反馈续接同一工作，采用作品版本不自动验收工作。
这是待实现验证的目标旅程，不能从卡片文案推断准入已经成立。

09-20 呈现更新：沿同一公开 Work 明示“来自这条消息”、推进者、负责人和真实状态；
回访者能够找到结果及下一步，并精确回到来源讨论。复用现有卡片和状态，不另建一份工作记录。

### J5 — 从受邀到把自己的 Café 带进 Collective

新人收到邀请 → 先观察公共世界 → 接引猫用人话完成权限、endpoint 与上下文配置 → 新人带自己
的 Café 入席 → 先能参与，再随真实关系增长理解 → 退出时权限、记忆与投影有可解释解绑。

### J6 — 权限控制的完整旅程（登记占位，Gate 打磨序列第 4 项）

operator 2026-08-09 指定（`0001786287171493-000047`，原话"权限控制的用户旅程！这个得是我们的
第四个！我怕我之后忘记了"）：邀请、可见性、委托、撤权、干净退出在真实场景中的完整走查，
接 Open Questions 6 的权限矩阵与 AC-B1 撤权契约。在 Gate 1–3（主界面 / 接入 / 灵感孵化）
之后展开；此处登记防丢，未展开前不冒充已设计。

### J7 — 真实 Markdown 分享触发资产协同

You 把一篇真实 Markdown 分享给同事 → 同事在外部聊天中给出点评 → 该点评以原始来源挂回
Markdown，而不伪造成当时就在资产页发生的批注 → 后续参与者既可以在 Channel 围绕整件事回复，
也可以在资产页对具体段落批注 → 批注可展开 Topic → 猫关联它影响的既有判断并提出候选修改 →
有 authority 的人选择接受、部分接受或保留分歧 → 新版本说明“什么变了、为什么”，原点评、旧版本
与讨论仍可追溯。

09-20 呈现更新：获准产物以紧凑入口承接讨论成果，直接打开对应对象/版本并可回源；
当前成果、变化与需要谁处理应可辨认，不能要求用户翻完整段聊天才找到结果。
这些信息由内容及工作 owner 提供；#4631 的私人 prepared Artifact 返回链不等于公共 J7 已实现。

这条旅程按同一个 Gate 分两段验证：第一段只做到“打开资产 → 分享到 Channel → 位置批注 →
批注长出 Topic”；第二段再验证“猫识别影响 → 提议修改 → 人确认 → 新版本”。分段是降低体验
判题密度，不是把后半环降级为可选尾巴。

### J8 — 在任一频道请求跨频道日报（设计场景，当前先完成 UI/UX 北极星）

主人在一个 Channel @ 自家猫询问“今天所有频道发生了什么” → 猫按真实发问者及有效授权确定读取范围、
日期/时区 → 聚合权威频道/Work 记录与带来源索引 → 完整报告交付给主人可见的家内承载，原频道仅返回
对当前读者可公开的部分及适当回执。无须逐个唤醒频道或让主人重新选择猫/Thread；无权/未同步的范围
明确为覆盖缺口，不写成“没有发生事情”。这条目标旅程的读取、交付承载和权限反例均仍待实现验证。
记录依据为 operator 331 的能力问题及 348 的落盘要求。operator 随后在
`[thread-id]#private-source-id` 明确先完成 UI/UX 北极星，门槛问题提得过早。
本场景保留，不新增本轮收尾条件、不要求现在决定；当前设计优先级与纠偏依据见通讯模型 §9。

## Requirements Checklist

| ID | 需求 | Acceptance Criteria | 当前状态 |
|---|---|---|---|
| R1 | 正式 F 号与唯一入口，未来猫可冷启动 | AC-A1 | [x] |
| R2 | 原始 Thread、方向图、录音、竞品稿与原型证物可追溯 | AC-A1 | [x] |
| R3 | Café / Collective 能在全局 rail 切换，Collective destination、Channel 与个人 Café 边界不混淆 | AC-A2 | [ ] |
| R4 | Topic 锚定 Channel 根消息并复用同一消息/lineage；换宿主不复制领域对象 | AC-A2 | [ ] |
| R5 | 人猫共享富消息语言，Composer 渐进展开 | AC-A3 | [ ] |
| R6 | 自然语言无弹窗长出 linked Task card | AC-A3 | [ ] |
| R7 | Vote 一键参与，并区分 poll / binding judgment | AC-A3 | [ ] |
| R8 | 私人来源、身份、authority 与 public projection 边界可解释 | AC-B1, AC-C1 | [ ] |
| R9 | 多 Café 离线、送达、唤醒、执行和回流不混为一个状态 | AC-C1 | [ ] |
| R10 | 用 You + 吴浪 / 社区真实工作完成首条终态 dogfood | AC-D1 | [ ] |
| R11 | 同一真实 Artifact 同时支持 Channel 回复与经 F309 绑定的版本/位置批注，且保持一条 Collective lineage | AC-A5 | [ ] |
| R12 | Roadmap 从 Channel / Meeting / Decision 生长出 Work、依赖、历史与结果回流，而非静态任务栏 | AC-A6, AC-D1 | [ ] |
| R13 | Collective Artifact 保留 lineage/权限/result target，并消费 F309 的 SelectionAnchor、human-edit change notice、annotation、agent patch 与 owner version receipt | AC-A5, AC-B1 | [ ] |
| R14 | 私人 Café / Agent 执行的结果回到 exact Collective Channel / Work / Artifact，且不泄露私人过程 | AC-A7, AC-C1 | [ ] |
| R15 | Feature surface、对象详情与 Product Shell 在交付物和验收声明中明确分层，单页不得冒充 F290 整体 | AC-A2 | [ ] |
| R16 | F290 由个人 Café 的真实 world switch 进入 Collective；独立 `/dev` 壳只能作为 Design Gate 证物 | AC-A2 | [ ] |
| R17 | Server provider 不开终端、不手抄 secret 即可部署或接入独立 Service，完成 GitHub provider setup、bootstrap、当前 Café pairing 与 ready check | AC-L1 | [ ] |
| R18 | 两个真实 Human 经邀请进入同一 Channel、双向发信，并在刷新与 Service restart 后恢复 | AC-L2 | [ ] |
| R19 | Connector / Service / Human / Endpoint 状态分层且诚实；本机与公网激活条件不可互相冒充 | AC-L1, AC-L3 | [ ] |
| R20 | 首猫有自动发现、默认带入且可显式排除的入场旅程、正式 MCP/skill、授权上下文和精确回流；连接在线不冒充接住请求 | AC-A8, AC-C3 | [ ] |
| R21 | 每 Café×Channel 逻辑端点支持多猫、独立频道上下文与多个 Work / 私人 Thread；desired policy、runtime eligibility 与实际关联分离，接引不要求逐猫逐频道保存或手配 Thread | AC-B1, AC-C1, AC-C3 | [ ] |
| R22 | 无 @ 也有有界注意力与可解释期待状态；显式 @ 优先，普通表达不制造全员唤醒/回执，承诺形成后可追溯 | AC-A8, AC-C1, AC-D1 | [ ] |
| R23 | 跨频道汇总设计场景：按权威记录取数并保留日期/覆盖/来源；读取与发布权限分开，完整私人报告安全回家，不靠全端点唤醒；完成门槛讨论暂缓，当前先完成 UI/UX 北极星 | AC-C4, AC-B1 | [ ] |

### Coverage check

- [x] 每条当前需求都映射到 AC。
- [x] Experience claim 使用 operator 可体验 Gate，不用实现完成度替代。
- [x] 后端/稳定性 claim 留给后续契约测试与运行观测，不在前端稿中假绿。

## Acceptance Criteria

### Local self-host activation gate

- [ ] **AC-L1**：从一台干净 Clowder AI 打开 Collective Connector，选择“部署新 Service”后，只通过
  产品 UI 与 GitHub 的确认页面完成安装、独立进程启动、Manifest provider setup、mode-`0600`
  credential persistence、一次性 bootstrap、首个 Collective、当前 Café pairing 与 ready check；
  全程不要求终端、环境变量、手抄 secret 或寻找本地 bootstrap 文件。重启 Clowder AI 与 Service 后能
  重新识别同一 `serviceInstanceId`、数据目录和恢复动作。纯 Service provider 从独立安装入口完成时，
  必须进入同一个 setup state machine 和 Service truth。
- [ ] **AC-L2**：使用两个真实 GitHub Human 与两个隔离浏览器会话：owner 创建邀请，member 打开邀请并
  登录加入；双方落在同一 Collective/Channel、各发至少一条消息且双方都看到；刷新两边并重启
  Service 后，membership 与完整消息顺序仍可见。fake provider、单浏览器换 cookie、只创建邀请或
  Playwright fixture 不能作为该激活证据。
- [ ] **AC-L3**：产品分别投影 Connector installed/enabled/live、Service absent/provisioning/
  awaiting-setup/ready/failed、Human unauthenticated/bound、Endpoint unpaired/live/offline/revoked；
  Local self-host 只有 AC-L1/AC-L2 通过才可启用，Public multi-Café 继续关闭直到 TLS/public ingress、
  cross-machine pairing、外部恢复与真实多 Café dogfood 通过。

### Phase A — Truth and Experience Design Gate

  形成唯一入口；Source Map 覆盖三个源 Thread、两份 ASR（含 SHA-256 / 缺录边界）、核心衍生稿、
  既有 Feature 边界与 exact prototype commits。一个没有本 Thread 上下文的猫只读这两份即可
  说清 Why、稳定对象、已确认决定、未决问题和下一验证动作。
- [ ] **AC-A2**：operator 从个人 Café 的真实 global rail / world switch 进入 Collective（不是直接落入
  独立 `/dev` 复制壳），看到该 Collective 的 destination、Channel、Roadmap、成员与资产入口；
  从 Channel 打开同一根消息的 Topic / Artifact 后能返回来源，权限与 lineage 不丢。验收证据必须
  包含真实用户入口、世界切换、宿主 mount 关系与返回个人 Café 的路径；预设 tab、单个资产页、
  右侧 Workspace 或自造 chrome 都不能冒充 F290 Product Shell。tab / split / restore 另由 F307 验收。
- [ ] **AC-A3**：同一 Gate 可重放 Thread / Channel 共享富消息、渐进 Composer、reaction、头像卡、
  无弹窗 Task 与低摩擦 Vote；每个动作都展示原消息与派生对象的关联，poll / binding judgment
  不混淆。
- [ ] **AC-A4**：Gate 的每个关键状态有 fixture、交互说明与截图；operator 反馈逐条回写 Design Gate，
  不靠聊天记忆维护 UI 真相。
- [ ] **AC-A5**：用 2026-08-10 真实 Markdown 分享事件做确定性 fixture，第一段可重放“打开资产 →
  分享 → 经 F309 位置批注 → Topic”，并保留“点评原本发生在外部聊天”的事实来源；第二段另行验证
  F309 human-edit notice、patch proposal、人类 disposition、owner version receipt 与 Collective 回流，
  不用导览文本冒充行为。
- [ ] **AC-A6**：在真实 Channel / Meeting fixture 中形成或更新一项 Roadmap Work；Roadmap 展示来源、
  accountable human / 执行 Café、依赖、状态历史、阻塞与结果回链。它必须从团队对话生长并反向更新
  Collective，不得用静态卡片、预写任务或 shell tab 数量冒充 operating model。
- [ ] **AC-A7**：一个 Café 在私有 Thread / Agent runtime 中执行 Collective Work；Collective 只看到
  必要状态、判断请求、产物与证据，完成结果回到 exact Channel / Work / Artifact，并能追到 trigger、
  actor、authority 与 source version。私人原文与猫的内部施工过程不得被宿主或共享层默认读取。

- [ ] **AC-A8**：在同一 canonical Client 的真实入口，人无需 ID/secret/终端或逐猫保存即可自动识别
  自家已有且当前具备公共参与资格的伙伴、默认带入并只处理显式排除/频道例外；「我的 Café」默认先显示
  当前现场相关的工作与伙伴活动。人能确认公共参与范围、看到真实具名成员卡并发出请求；未接收、已送达、已唤醒、已接手与失败有各自
  证据，不以“在线”或 ACK 冒充。Direct 与 Café 内嵌入口消费同一状态；退出/撤回有可解释结果。

### Phase B — Stable object and trust contracts

- [ ] **AC-B1**：Café、Collective、Membership / Join、Channel、Topic、Living Projection、Work、
  Vote / Decision、Artifact 的身份、生命周期、provenance、authority 与 persistent truth 已冻结；
  用户可见对象默认 TTL=0，退出/撤权/遗忘另有显式契约。
- [ ] **AC-B2**：architecture cell 定名并写入 ownership map；与 F044/F077/F128/F246/F276/F277 等
  双写边界，生成器和 doc guards 通过。

### Phase C — Federation, attention and memory

- [ ] **AC-C1**：两个隔离 Café fixture 证明 Channel shared truth、每家 endpoint、断线重连、幂等
  投影、权限撤销与冲突可见；`deliver → interest hit → wake → context admission → claim/act` 五层
  可区分，私人 Thread / 记忆不被共享层读取。
- [ ] **AC-C2**：Collective memory 对事件、关系、决定与前瞻事项的确认、纠错、放下与 subject
  权利有 owner、来源和可验证读写边界。
- [ ] **AC-C3**：猫通过正式 MCP/skill 发现被授权的 Collective 上下文，读取和回复真实 Channel
  请求；具名身份、当前来源与精确返回目标由 authenticated invocation 在服务端解析，跨断线/
  重试/切世界保持。非 owner 的公共执行 grant 同时约束工具与自动 prompt/context，不能继承
  私人文件、记忆或 owner-only 能力；持续委托经独立可证明的本地 owner admission 后形成责任。
  Task 通过 admission.sourceRefs 链接 F290/Message owner 的持久来源；后续 invocation 从该来源与
  当前 Task revision/admission 重验并重签临时返回凭据，撤权/来源不可用有 typed 失败且零错投。
  服务端保存回复操作身份，accepted 后丢响应可查询/恢复，不依赖模型记 UUID、不重复生成事件。
  退出、错误路由、同名猫及不同 Human/connection 不会越界。Service 的 accepted/ACK 不等于猫已接手或工作完成。
- [ ] **AC-C4（候选验收；完成门槛讨论暂缓）**：J8 以多个 Collective/Channel 的真实记录验证跨频道汇总；同一既有家猫按真实发问者
  的有效权限读取，不因公共发问获得 owner 权限，不枚举未授权来源。日期/时区、覆盖和同步缺口可辨认，
  结论有精确来源；完整报告与原频道公开部分按各自读者权限交付，不泄露私人标题/摘要，不要求逐频道唤醒。
  10×10 频道多猫基数、局部离线、撤权、同名身份与重试另以定向契约检查覆盖；具体场景见
  [通讯模型 S1–S10](../architecture/f290-communication-model.md#8-编码与验收时必须过的场景)。

### Phase D — Real dogfood

- [ ] **AC-D1**：You 与吴浪或一条真实社区 PR / Issue 完整跑通 Meeting / Channel → Roadmap →
  各自猫执行 → 判断 → 结果回流；全程无需 You 复制粘贴消息/上下文，责任与证据未丢。
- [ ] **AC-D2**：dogfood 同时证明工作循环与社会环：除了任务完成，还出现至少一次非任务化的
  共鸣、意外发现或方向再对齐，且未制造唤醒风暴。

## Terminal Phases

1. **Phase A — Collective truth + Experience Design Gate**：把个人 Café → world switch → Collective
   destination → Channel / Roadmap / Artifact 做成可体验、可纠偏的终态切片；整体验收仍开放，实现进度见开头对账。
2. **Phase B — Stable objects + responsibility**：冻结产品对象、持久真相、authority 与 ownership
   cell；不交付临时 schema。
3. **Phase C — Multi-Café federation + memory**：实现跨信任域同步、注意力、离线、撤权、冲突与
   团队记忆。
4. **Phase D — Real team dogfood**：用真实工作而不是虚构脚本闭环。
5. **Phase E — Social adoption**：接引、模板、Vote 与社会环完成新成员采用，同时保持具名关系与
   track record，不退回预设专家团。

每一 Phase 都落终态对象的一条可存续纵切片；Phase A 不是“先做完会丢掉的 Demo”，而是 operator
判定产品世界的 Experience Gate。若判断错误，修改的是设计真相，不把临时代码包装成资产。

## Key Decisions

| ID | 决定 | 来源 |
|---|---|---|
| KD-1 | 面向终态；不做可丢弃 MVP | `private-source-id` |
| KD-2 | 一人多猫不变，Café 加入 Collective | vision §3.1 / §4.1 |
| KD-3 | Global rail 切个人 Café / Collective；这是 F290 产品入口，不等于右侧 Workspace 或 F307 Workbench | `private-source-id`, `private-source-id`, `private-source-id` |
| KD-4 | Channel 是重要共同现场；Topic 必须锚定根消息、复用同一消息与 lineage，具体宿主形态由 F307 决定 | `private-source-id` |
| KD-5 | Channel 与私人 Thread 共用富消息底座；人猫能力同权、Composer 渐进展开 | `private-source-id`, `private-source-id` |
| KD-6 | Message → Task 由猫生成 linked card，不弹表单；无 authority 不静默造承诺 | `private-source-id` |
| KD-7 | Vote 必须低摩擦；poll 与 binding judgment 分开 | `private-source-id` |
| KD-8 | 私人 Thread 永远留在家里；公开的是 Living Projection | `private-source-id` |
| KD-9 | Work owner 可以是具名猫；现实后果的责任链必须解析到 accountable human，而不是把猫降为执行注脚或让人甩掉责任 | `private-source-id`, vision §19.12 |
| KD-10 | `clowder-ai` 是伞牌，Café + Bond 是世界观核心；Collective / Channel / Thread / Living Projection 是稳定对象，空间隐喻留在体验层 | `private-source-id`, `private-source-id`, `private-source-id` |
| KD-11 | 表达允许沉默；请求不能假装被接住；承诺不允许失踪 | vision §19.17 |
| KD-12 | Café 与 Collective 通过双向望窗互相可见：说话自由、窗看摘要、签字类动作进入所属现场完成 | `private-source-id`, `private-source-id` |
| KD-13 | Collective 的工作协同围绕资产代谢展开，同时保留不被资产化的社会环；资产是内部统一信封，不是强迫用户学习的 UI 总称 | `private-source-id`, `private-source-id` |
| KD-14 | Channel 回复与资产批注是两种协同入口、一条 lineage；外部反馈挂回资产时保留真实发生位置，不伪造历史 | `private-source-id`, `private-source-id` |
| KD-15 | **Superseded by KD-19**：曾把可组合 working set 继续挂在 F284/F290；保留为错误演进记录，不再定义 F290 scope | `private-source-id`, `private-source-id` |
| KD-16 | F290 自建资产树、lineage 与协作 adapter 契约，不自研编辑器 / Action Space runtime；一次成功只可形成 candidate skill，不能自动晋升通用能力 | `private-source-id`, `private-source-id`, `private-source-id` |
| KD-17 | PR #3966 的独立 `/dev` 页面只保留为组件实验；operator 否决其 Product Shell / F290 交付身份，后端闭环不得从该页继续 | `private-source-id`, `private-source-id`, `private-source-id` |
| KD-19 | F290 回到多人、多 Café、多 Agent Collective；全局 working set/tab/split/restore 独立为 F307，#3981 只作 F307 原型证据 | `private-source-id`, `private-source-id`, `private-source-id` |
| KD-20 | F290 不等待完整 F307；先补真实 world switch、Roadmap、共同产物系统、多 Café 后端与团队 dogfood | `private-source-id` |
| KD-21 | 通用跨媒介 SelectionAnchor、human-edit awareness、annotation、Agent patch/disposition、remap/orphan 与协作 metadata ledger 抽离为 F309；F290 只提供 Artifact lineage/permissions/result target、决定 Collective attention 并消费它 | [F309](F309-collaborative-content-plane.md) |
| KD-22 | 全局 Needs Me 与 Growing 端到端旅程归 F310；F290 只是一类 Collective producer/consumer | `private-source-id` + `[thread-id]#private-source-id` |
| KD-23 | Human 通过 provider binding 登录；Agent 没有独立 login/token，而是 Human 下的结构化扩展；endpoint credential 只证明机器连接。Channel 默认进入 Host ingress Thread，显式 Human/Agent target 由 Host 映射，Service 不接管本地 Agent runtime/tool authority | [clowder-ai#1401](https://github.com/zts212653/clowder-ai/issues/1401)（`mindfn` 收敛） |
| KD-24 | self-host 的 GitHub identity provider 通过 GitHub App Manifest 由 Server provider 一次确认创建；凭据直接回到 Service 的受限 store。Manifest、Human login、endpoint pairing 保持三条独立状态机；真实 GitHub dogfood 是激活证据，官方文档对照不是 | `private-source-id`, `private-source-id` + GitHub 官方 Manifest/user-token 文档 |
| KD-25 | 激活拆成 Local self-host 与 Public multi-Café 两档；第一档让本机真实可用，第二档再要求 TLS/公网、跨机 pairing 与多 Café dogfood，避免“必须先激活才能 dogfood、又必须先 dogfood 才激活”的循环 | `private-source-id`, `private-source-id` |
| KD-26 | binding Vote 只能约束发起人已有权限的精确 Roadmap revision；冻结 Human 名单与简单多数规则，通过只生成 Decision，不自动改路线或替其他 owner 承诺 | `[thread-id]#private-source-id` |
| KD-27 | 公共 Work 验收只能以当前 Service Work + 指派 endpoint + assignment/result/revision 的服务端重读为 Task terminal signal；iframe 不获得私人 Task id/authority，Host 只沿既有 route receipt 找唯一 Task 并走 F310 typed closure | `[thread-id]#private-source-id` + W3 browser journey |
| KD-28 | 设计铁律：同一对象不增生平行概念，真实独立边界不强行耦合；Channel 的权限与可见性差异不另造产品。详见上文“设计铁律”。本轮实现按 operator 要求暂停 | `[thread-id]#private-source-id` |

## Open Questions / Design Gate

2. **Resolved to F310**：全局 Needs Me / Judgment 入口的 eligibility、去重、显著度与 exact-return
   归 [F310](F310-growing-real-delegation.md)；F290 只提供 Collective-owned canonical items 与当前
   predicate。准入红线保持：**只收等待人类判断或修复的事项，FYI / 热闹永不进入。**
3. 双向望窗的摘要密度与“走进去”动作如何表达，同时不泄露私人 Thread；sidecar/tab/split 的
   通用宿主策略转交 F307。
4. Task 建议卡在 public Channel 中由谁可见、谁可确认、哪个动作形成 Collective 承诺？
5. **Resolved for the Roadmap scope**：informal poll 为实名偏好；binding Vote 冻结已认证 Human 名单、
   简单多数、截止与既有 accountable authority，改/撤/弃权保留历史，平票与未过半不形成决定；通过只
   生成 Decision。跨 owner 或其他领域的 binding authority 仍须消费该领域既有可验证委托，不由 F290
   的 steward、发起人身份、猫或 UI 开关发明。
6. Reaction、Vote、Approval、Claim、Task checkbox 的视觉与语义怎样保持明确不同？
   （方向已收敛，见 Visual Weight Grammar 末段语义皮肤对照：reaction=计数 pill、Task=
   左竖条+文本行、产物=图标+文件名紧凑卡、Approval/binding Vote=带行动按钮的高重量卡、
   claim=纯文本状态行——五者不共用皮肤；剩余为具体视觉稿验收）；
7. 人/猫成员卡的默认公开字段随紧密团队、开放社区如何分级？
8. Membership / Join 是否作为一等持久对象的最终状态机与退出义务是什么？
9. first dogfood 选 You × 吴浪协作，还是一条真实社区 PR / Issue；选择判据是完整闭环而非最省事。
10. 页面级回退语义：跨目的地跳转（对象空间 ↔ Channel ↔ 名片）后的后退路径与导航历史
    （operator 实测"图 2 点到图 1 后回不去"，`0001786282169541-000108`）。
11. 猫运行状态的可见性：猫正在启动 / 思考 / 执行时，人看到什么——防"不知道是猫在跑
    还是系统挂了"的黑盒焦虑（operator 同上消息；接联邦五层链的唤醒后半段与在场绿点；Raft
    左下角 agent 状态为参照；它是组织可观测性的微观版，也是黄挺可信度边界的 UI 面）。
12. 批注原语：资产（纪要、文稿、产物）上的位置锚定评论——Agent 时代批注不只给人看，
    也是**资产上的期待入口**（批注可为表达 / 提问 / 请求，猫接住后按期待契约处理）；它与
    Topic（消息的讨论分支）的关系与皮肤差异（外部企业用户一手需求，
    `0001786346182279-000000`）。
13. 团队记忆的人可浏览前台：事实记忆（已确认决定）与产物的"结论性信息同步空间"——
    团队记忆不能只是猫的检索后端，人要能直接逛、获取（如"火山/阿里聊完的文字稿"）、
    批注、追问下一步（同上外部需求；与灵感公地 / 作品并列的对象空间候选，落位待 Gate）。
    **答案原型已被 operator 点破（`0001786346947339-000006`）：把 Clowder AI 单 Café 版的
    docs 真相源纪律产品化**——VISION / features / decisions / discussions + git lineage +
    记忆索引，就是这个前台的手工版；协议同构模式的资产版（单 Café 已验证 → 联邦升维）。
    资产类型系统：Artifact 为基类，doc / deck / PR / video / code / pipeline / dataset 为
    子类型，共享 id / owner / lineage / 版本 / 权限 / 批注面接口，各有渲染器与动作集；
    **Decision 本身也是资产**（家里的 ADR 即活样本）；资产库按 lineage 与 Work 挂靠组织，
    不按文件类型分文件夹（那是网盘，不是团队记忆）。产品方向已由 KD-13/KD-14 确认；仍待
    Gate 的是人类可见入口名称、默认落位、浏览密度以及与 Search / Needs Me 的关系。
14. 场景严肃度谱系：对话主导（家庭 / 小团队的 Channel 中心）↔ 资产主导（企业的结论
    空间中心）的默认视图权重可配置——"对话态不适合严肃协同场合"不是否定 Channel，而是
    企业侧入口的默认权重不同（与成员密度谱系正交的第二根配置轴）。
15. 猫作为灵感作者：灵感公地的 Idea `author` 显式包含具名猫（operator 2026-08-11 方向，
    `0001786464088803-000119`："灵感的来源未必是人提的，有可能是猫"）——不只是"猫建议
    发布人的想法"（既有 §3.3 / KD-8），而是猫自己发起 Idea 并署名；责任链照旧锚到
    accountable human（KD-9 无缝覆盖）。配套微旅程待公地 Gate 展开：猫在工作/巡逻中发现
    机会 → 在公地发布署名 Idea → 猫爪与讨论 → 可能长成 Work；主动发起的合法区判据接
    甜甜圈 / AVI（F282/F287 个人尺度已验证）。本 thread 的设计过程即活样本：愿景稿与本
    spec 的多条 KD 作者是猫。
16. Artifact 内容 owner 的成熟 editor/renderer、稳定 SelectionAnchor、Agent patch review、版本/undo、
    remap/orphan 与首条异质媒介切片由 F309 Design Gate 决定；F290 只验证它们保持同一 Artifact
    lineage、权限与 Collective result target。
17. 首条 F290 Experience Gate 验证 `Channel → Artifact → F309 human-edit notice/annotation/patch → owner new version →
    Channel / Work 同步` 的领域关系，以及 private execution 的结果回 exact Collective target。若当前
    宿主采用 tab/split，其连续性由 F307 验收；F290 不把多模态 adapter 或协作 ledger 拉回本 Feature。
18. **Delivered implementation item — Collective product icon**：Collective Connector 已改用同源的
    三节点连接 glyph，并由组件测试锁定，替换通用四宫格；后续 destination 若增加独立入口，继续复用
    这套身份而不另造不相关图标。

## Human Disposition Feedback Contract

F290 中“猫建议把消息变 Task / Vote / Living Projection”的交互，出生即遵守 F281 三件套：

| 部分 | F290 契约 |
|---|---|
| **feedback expression** | `[创建任务] [先继续讨论] [不用跟踪]`；可附结构化原因、其他文本或跳过，不能只有二元接受/拒绝 |
| **episode truth** | producer-owned canonical decision + F281 content-free receipt/index，owner scoped、TTL=0；原消息与 suggestion subjectRef 保持 exact lineage |
| **consumer** | 只校准该 exact message / suggestion 的任务化策略；单次“不用跟踪”不得泛化成“以后少主动”或全 Channel policy |

Vote 的“不同意某选项”是投票内容，不自动成为对猫的 disposition feedback；只有对“是否该发起
这个 Vote”的裁决才进入上述 feedback 契约。

## Tips Contribution（F244）

公开提示只描述已有产品入口及其执行条件；切片已经实现，不代表完整 Collective 旅程已通过验收。
提示的来源必须能随公开版本导出，不能指向内部实施计划。

### Work 结果反馈与修订

结果处于待确认状态时，当前工作负责人可在原 Work 卡填写具体反馈，再点击“退回修改”。
Service 核对负责人和当前结果版本，将反馈关联到原结果，在同一个 Work 中记录修订请求；
旧结果事件与修改要求保留，不需要另开工作。旧版本的反馈不能冒充当前结果的修订。

后续执行仍须通过当前授权与来源核验，并找到原先已准入且未关闭的唯一家内 Task。
有效时沿原工作继续；权限失效或原执行现场不可用时，不会因退回修改自动获得新权限或另建任务。
收到反馈不等于猫已经开工，应以实际执行状态和返回的新结果为准。
新版结果回来后，由负责人确认当前结果并完成工作；采用某个内容版本不等于工作验收。

## Dependencies and Explicit Exclusions

- **Evolved from**: F044（只继承 Channel / Activity 原语，不继承其单 Thread / 游戏 scope）。
- **Related**: F077（多用户身份与安全）、F128（确认式开 Thread）、F168（共享面）、F195（伴随
  会议）、F202（插件）、F232（多 Agent）、F246（判断/审批）、F254（freshness）、F276（关系）、
  F277（注意力导航）、F282/F287（主动记忆与 cue）、F283（对象驱动 surface policy）、F284
  （contextual Workspace v1）、F305（UI Design Gate）、F307（application-level Composable
  Workbench）、F309（跨媒介 anchor/annotation/Agent patch plane）。F290 不拥有 tab/split/restore/
  layout persistence，也不拥有通用内容协作契约；它只登记 Collective surface、权限、lineage 与
  result target，并行消费 F307/F309，不等待二者全部完成才继续自己的 Experience Gate。
- **Excluded**: F076 旧 Mission Hub 已完成且被 F152 取代，不是 F290 的前身；F044 也不是 F290
  的总 feature。
- **Prototype branch**: `feat/collective-experience-gate` 是 Experience Gate 证物；未合入 main 的
  设计路径不能被本文链接成 main truth，只使用 exact commit provenance。

## Source Map / Cold-start Package

### Threads and message anchors

| 来源 | 作用 |
|---|---|
| `[thread-id]#private-source-id`、`#private-source-id` | operator 要求联合梳理 F290、F322、F309 与 10.9 会议中的多人协同需求，随后授权先更新本 Feature 文档；不自动批准候选排期或责任迁移 |
| `[thread-id]#private-source-id` | 10.9 团队会议原始转写入口及六位说话人对应；产品/流程输入、人类分工与未定范围见开头当前进展 |
| `[thread-id]#private-source-id` | 10-09 #5304 在原 runtime 的四条入口路径复验；仅证明入口恢复，不代验完整真人协作 |
| `[thread-id]#private-source-id`、`#private-source-id` | operator 明确掉登录发生在 runtime 重启后；代码存在恢复请求失败即清 session 的缺口，用户那次故障唯一根因尚未证实 |
| `[thread-id]` / `private-source-id` | 三个月方向图将方向 5 交给本专属 thread |
| `[thread-id]` | F290 产品收敛与 Experience Design Gate 主 thread |
| `[thread-id]` | 家庭联邦 / Channel 的早期脑洞，作为演进证据而非冻结 spec |
| `[thread-id]` | GenTeam / Channel 产品学习与人话拆解 |
| `private-source-id` | 第一支纯前端 Gate 被 operator 明确判定偏离 |
| `private-source-id` | 左/中/右与 Channel ↔ 私人 Thread 的关键追问 |
| `private-source-id` | 当前产品实际为四栏；Needs Me 与右栏语义 |
| `private-source-id` | Slack-like Topic / reaction / avatar / emoji 是 Channel 刚需 |
| `private-source-id` | Topic 留右栏；Channel 必须继承 Thread 富内容能力 |
| `private-source-id` | 人猫富消息同权、无弹窗 Task、低摩擦 Vote 与正式立项要求 |
| `private-source-id` | 首个外部企业用户一手需求（You 同事对真 demo 的反馈）："对话是过程、信息资产是结果、两个不同的空间"；对齐=核心场景；结论性信息同步空间 + 批注留言 + 资料库；"Agent 时代的 Google Docs 怎么设计"之问——验证现场/对象空间两类目的地的分离，新增 OQ12–14 |
| `private-source-id` | operator 指出预设状态、假输入与不可操作控件不是前端，要求真实输入产生新状态 |
| `private-source-id` | Floatboat 对 living artifact、精确 SelectionAnchor、Action Space 与 result-return 的产品输入 |
| `private-source-id` | operator 收束：资产树 / lineage 是核心，正文编辑优先集成成熟编辑器，不自研内核 |
| `private-source-id` | 资产页再次被误交付成“最新 F290”，暴露 feature surface 冒充 product shell |
| `private-source-id` | operator 将 Codex / Floatboat 工作区与单槽 Workspace 对照，要求总结 Agent 产品的可组合工作区哲学 |
| `private-source-id` | operator 授权把学习沉淀进前端 Skill 与 F290 优化真相 |
| `private-source-id` | operator 追问个人 Café 与 Collective 是否共用 Workbench，暴露产品层级混淆 |
| `private-source-id` | operator 指出文件与代码/整个 Workspace 才应承载 tab 化，不应由 F290 单独造壳 |
| `private-source-id` | operator 明确 F290 是多人多 Agent Collective，右侧 Workspace 重构是单人多 Agent 的另一个问题 |
| `private-source-id` | operator 确认 5102 Collective Experience Gate 才是 F290 baseline，并要求独立立项 Workbench |
| `private-source-id` | operator 授权完成 F307 立项与 F290 scope reset，并要求记录 F290 当前未完成项 |

### Documents

- [F322 当前路线图与已定事项](F322-everyday-work-experience.md)
- [通讯模型与执行上下文（2026-09-30 编码约束、差距与验收场景）](../architecture/f290-communication-model.md)
- [F307 Composable Workbench](F307-composable-workbench.md)
- [F309 Collaborative Content Plane](F309-collaborative-content-plane.md)

### Original ASR

| 路径 | SHA-256 | 边界 |
|---|---|---|
| `/home/user/Downloads/AI团队协作产品规划讨论.txt` | `9af4b48cc5f3b6d84a2d014a10f3fec909b388c030cd96e8a9935ca15e171810` | You × 吴浪，62 分 28 秒 |
| `/home/user/Downloads/落地认知与工作方法交流讨论.txt` | `daf2213ce9babed2279dbf35fa6498df0f02ccbb09892c754fc9360cebaf6ff6` | 黄挺 / You / 吴浪；开头约两小时缺录 |
| `/home/user/Downloads/AI产品迭代与团队协作规划.txt` | `5dcb5a9b8f9a204d10e788c5a108b9c20d8177d733f5bfb2ec60a93a99b9588b` | 10.9 团队会议；说话人对应在源 thread；本次采用的产品输入保留转写时间戳，未定事项不写成决议；原文不复制进公共文档 |

### Experience prototype provenance

| Commit | 证物意义 |
|---|---|
| `91b8c38ec` | 第一支 guided front-end experience gate；用于记录被纠偏的假设 |
| `9fa225fadcac85301c971d77bcff5aa2d40476cf` | 四栏 spatial grammar 低保真与说明；仍需 operator 继续 Gate |
| [PR #3981](https://github.com/zts212653/clowder-ai/pull/3981) exact `4224d006c1af599d095b506bd578c6847bfd3df1` | working-set / restore / Agent Run tab 的历史原型；方向已被 operator 否决，不算 F290 交付，也不得继续合入 |
