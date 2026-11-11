# PDL 迁移盘点

当前决策基线已更新为 `design-accepted-r105`。第二轮的逐项建议见 [能力落点清单](placement.md)，确认前不补 PDL、不写迁移代码。本页的 VM、动作、React 三张 TSV 和第一轮检查原文保留为 r104 的历史盘点；“需要 lang 决定”一节已按 r105 改为已定结论和剩余后端项，不再用旧缺口覆盖新决定。

## 基线与工作位

- 当前原型验收：`design-accepted-r105` = `b60115a7f797af3ea91cc6ce0d9f2ac5e2ed9fd0`。已重读该 tag 的 HANDOFF 第 5 节“lang 2026-11-03 的迁移决定”；本轮只读原型，不跟随其工作区当前 HEAD 改基线。
- 第一轮历史基线：`design-accepted-r104` = `5396ab825fc37f99031aa0987b3330ed564ab57e`，当时设计仓 main 为 `56e3d19c2b941b51b7fc6e7ff6c154dbfab451b6`。下面的 70 VM / 325 动作 / 71 demo 统计属于这份快照。r105 是 70 VM / 319 动作，删除 8 个旧动作并新增 download、logsExport；本轮未重生成旧 TSV。
- fork：`origin = mindfn/clowder-ai`；执行 `git fetch origin` 后从 `origin/main` = `42017e0cea` 新建 `../clowder-ai-pdl`、`feat/pdl-migration`。
- 原项目 `AGENTS.md` 已保留，在末尾追加设计仓规则。未读取或执行项目的其他代理配置。
- 未修改 main、develop_base 或其 worktree；未推送、未开迁移 PR。

## 全量表与状态含义

| 表 | 覆盖范围 | 用法 |
| --- | --- | --- |
| [VM 对照](view-models.tsv) | 70 个 VM，契约的 878 个 fields 条目及全部 binds | 名字、状态、项目来源、来源内 API 调用与行号、完整字段、缺口 |
| [动作对照](actions.tsv) | 325 个动作，含 71 个 demo | 每动作一行：原型来源/kind、参数访问、项目落点、真实流程、接口证据、缺口 |
| [React 渲染清单](react-renderers.tsv) | 2743 个JSX/createElement/createPortal 渲染声明（含文件级匿名项），分布在 1545 个文件 | 文件、行号、函数名、归属、是否引擎替代 |

“已有”表示可原样复制的引擎/组件机制，或已标为不迁移的原型工具；“要整理”表示现有业务来源已找到，但还没有契约所需的同形 VM/同名动作；“缺”表示缺完整契约能力或已确认的真实业务落点。部分字段缺口写在该行，不能把“要整理”读成整页已覆盖。

接口证据列是所列来源文件实际出现的 API 调用与行号，保留原始模板；真实动作列说明本行实际要接哪条流程。一个文件包含多个请求时，证据列不表示该动作要调用其中全部请求。这里验证的是静态落点，尚未发业务写请求，也未证明运行时端到端可用。

## 视图模型逐项对照

所有原型名字与字段保持不变；下面先给便于阅读的简表，完整字段和来源列表在 TSV 中。

| VM | 状态 | 现有主要来源 | 要整理或缺的内容 |
| --- | --- | --- | --- |
| accounts | 要整理 | [components/accounts/useAccountDirectory.ts](../../packages/web/src/components/accounts/useAccountDirectory.ts) | 账户列表、归属、登录与额度合成；legacy 不照搬演示记录 |
| cafeHome | 要整理 | [components/new-conversation/useNewConversationAdmission.ts](../../packages/web/src/components/new-conversation/useNewConversationAdmission.ts) | 首页状态、导入、最近作品与 composer 合成 |
| cafeInbox | 要整理 | [stores/approvalHubStore.ts](../../packages/web/src/stores/approvalHubStore.ts) | 待决定、@、已处理、忽略、日程与待查看合成；生命周期由后端给 |
| cafeMemory | 要整理 | [components/memory/page/use-memory-search.ts](../../packages/web/src/components/memory/page/use-memory-search.ts) | 统一搜索、召回、图谱、资料库、状态；people/profile/event/taste 的新增细节另列覆盖缺口 |
| cafeNavShell | 要整理 | [stores/sidebarStore.ts](../../packages/web/src/stores/sidebarStore.ts) | 导航折叠、项目分组、标签与回收站投影 |
| cafeSearch | 要整理 | `packages/web/src/components/message-search/` | 跨消息、对话、作品、记忆分域读取并合成四组；没有现成同形聚合 VM |
| cafeTrash | 要整理 | [components/ThreadSidebar/ThreadSidebar.tsx](../../packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx) | deleted 列表、恢复、彻底删除；映射 items.ctx |
| cafeWsClips | 要整理 | [components/workbench/video-project/VideoProjectList.tsx](../../packages/web/src/components/workbench/video-project/VideoProjectList.tsx) | 列表与卡片视图同源；卡片布局由现有原型 PDL 表达 |
| cafeWsCommunity | 要整理 | [components/CommunityPanel.tsx](../../packages/web/src/components/CommunityPanel.tsx) | 已有插件 API；issue/PR/finding/closure/detail 合成，不使用原型 /api/community 路径 |
| cafeWsEvo | 要整理 | [components/capability-evolution/evolution-program-resource.ts](../../packages/web/src/components/capability-evolution/evolution-program-resource.ts) | active/done、历史、judge/actions 合成；新版 preparation/exploration/solution-gate 尚需覆盖 |
| cafeWsHome | 要整理 | [hooks/useActiveExecutionProjection.ts](../../packages/web/src/hooks/useActiveExecutionProjection.ts) | 执行、作品、等待与详情合成 |
| cafeWsOps | 要整理 | [components/HubQuotaBoardTab.tsx](../../packages/web/src/components/HubQuotaBoardTab.tsx) | 多个取数源合成 sections/facts；不能照搬演示 ops-data |
| cafeWsRecall | 要整理 | [hooks/useRecallEvents.ts](../../packages/web/src/hooks/useRecallEvents.ts) | 召回事件按成员与时间整理成列表 |
| cafeWsSignals | 要整理 | [components/signals/SignalInboxView.tsx](../../packages/web/src/components/signals/SignalInboxView.tsx) | inbox、来源、文章、学习时间线、播客合成 |
| cafeWsTeam | 要整理 | [components/members/useMemberList.ts](../../packages/web/src/components/members/useMemberList.ts) | 成员、路由偏好、事件账本合成；原型 providers/assertions/prefs 的演示结构需映射实际类型 |
| cafeWsVoice | 要整理 | [components/workspace/TranscriptPanel.tsx](../../packages/web/src/components/workspace/TranscriptPanel.tsx) | 实际为音频捕获、转写、会话；原型 recordings 持久列表未确认同形后端 |
| chatComposer | 要整理 | [stores/chatStore.ts](../../packages/web/src/stores/chatStore.ts) | 草稿、附件、补充、悄悄话、队列、目标与发送状态合成；持久草稿逻辑保留 |
| chatHeader | 要整理 | [components/ChatContainerHeader.tsx](../../packages/web/src/components/ChatContainerHeader.tsx) | 标题、成员、当前视角、搜索和布局状态 |
| chatPage | 要整理 | [components/ChatContainer.tsx](../../packages/web/src/components/ChatContainer.tsx) | 流、翻页、刻度、查找、导入和引导；不在 VM 判断弹窗 DOM |
| chatPop | 要整理 | [components/ChatContextPicker.tsx](../../packages/web/src/components/ChatContextPicker.tsx) | 上下文检索、文件浏览、引用、批注与查找结果合成 |
| chatStream | 要整理 | [stores/chatStore.ts](../../packages/web/src/stores/chatStore.ts) | 消息/工具/思考/富块/卡片映射到统一消息模板，流式更新保留 |
| chatWelcome | 要整理 | [components/new-conversation/NewConversationPage.tsx](../../packages/web/src/components/new-conversation/NewConversationPage.tsx) | 欢迎入口已有；具体可见性由 onboarding/quest 后端给 |
| env | 要整理 | [components/HubEnvFilesTab.tsx](../../packages/web/src/components/HubEnvFilesTab.tsx) | 环境变量摘要、编辑、待重启与当前值分离 |
| eval | 要整理 | [components/HubEvalTab.tsx](../../packages/web/src/components/HubEvalTab.tsx) | 总览、值班、评估域、摩擦账本；保留真实 summary 字段 |
| exec | 要整理 | [components/RightStatusPanel.tsx](../../packages/web/src/components/RightStatusPanel.tsx) | 成员执行、session/turn/trajectory 详情投影 |
| execDetail | 要整理 | [components/workspace-home/ManagedExecutionDetail.tsx](../../packages/web/src/components/workspace-home/ManagedExecutionDetail.tsx) | 托管命令状态、tail、取消权限投影 |
| ext | 要整理 | [components/settings/plugin-manager/PluginManagerLiveContent.tsx](../../packages/web/src/components/settings/plugin-manager/PluginManagerLiveContent.tsx) | 插件列表、过滤、选中与生命周期合成 |
| filePage | 要整理 | [components/workspace/WorkspaceFileViewer.tsx](../../packages/web/src/components/workspace/WorkspaceFileViewer.tsx) | 文件读取、文本编辑、引用批注与 worktree 身份保留 |
| files | 要整理 | [hooks/useWorkspace.ts](../../packages/web/src/hooks/useWorkspace.ts) | 文件树、搜索、工作目录合成 |
| filmPreview | 要整理 | [components/workbench/video-project/VideoProjectScreeningPlayer.tsx](../../packages/web/src/components/workbench/video-project/VideoProjectScreeningPlayer.tsx) | 给 media 数据与稳定身份；不移植 React 播放器的外壳 |
| filmProject | 要整理 | [components/workbench/video-project/useScreeningProject.ts](../../packages/web/src/components/workbench/video-project/useScreeningProject.ts) | 项目/素材/版本/比对/审片 ledger 合成；同步移到发消息路径 |
| git | 要整理 | [hooks/useGitPanel.ts](../../packages/web/src/hooks/useGitPanel.ts) | 分支、提交、改动与 diff 合成 |
| guide | 要整理 | [stores/guideStore.ts](../../packages/web/src/stores/guideStore.ts) | 真实 guide-flow 与产品演示是两条已有来源；原型阶段 HTML/message 适配尚缺 |
| hubPanel | 要整理 | [stores/missionControlStore.ts](../../packages/web/src/stores/missionControlStore.ts) | Backlog/认领/租约/依赖/外部项目；不使用 /api/features/items 演示地址 |
| live | 要整理 | [stores/activeExecutionStore.ts](../../packages/web/src/stores/activeExecutionStore.ts) | 执行、等待、部署等待投影 |
| market | 要整理 | [stores/marketplaceStore.ts](../../packages/web/src/stores/marketplaceStore.ts) | 生态/信任/搜索/安装计划合成 |
| mcp | 要整理 | [components/settings/McpManageContent.tsx](../../packages/web/src/components/settings/McpManageContent.tsx) | 列表、来源、异常、详情与发现合成 |
| mcpItem | 要整理 | [components/McpConfigModal.tsx](../../packages/web/src/components/McpConfigModal.tsx) | 配置表单、探测、工具、项目挂载与异常合成 |
| mcpNew | 要整理 | [components/McpConfigModal.tsx](../../packages/web/src/components/McpConfigModal.tsx) | 新建 MCP 表单与测试 |
| mediaPreview | 要整理 | [components/Lightbox.tsx](../../packages/web/src/components/Lightbox.tsx) | 统一媒体源、标题、翻页；不保留 Lightbox 独立壳 |
| mediaReview | 要整理 | [components/content-review/useArtifactReview.ts](../../packages/web/src/components/content-review/useArtifactReview.ts) | 审核上下文、权限、revision、ledger/round、区域与时间范围保留 |
| member | 要整理 | [components/settings/members/useMemberEditor.ts](../../packages/web/src/components/settings/members/useMemberEditor.ts) | 真实表单与保存逻辑；draft/UI selection 留界面状态 |
| memberCard | 要整理 | [components/CatAvatar.tsx](../../packages/web/src/components/CatAvatar.tsx) | 成员身份、模型、角色和运行态合成 |
| memberNew | 要整理 | [components/settings/members/useMemberEditor.ts](../../packages/web/src/components/settings/members/useMemberEditor.ts) | 新增成员、头像、模板与接入分支合成 |
| members | 要整理 | [components/members/useMemberList.ts](../../packages/web/src/components/members/useMemberList.ts) | 目录、排序、默认成员、权限、筛选合成 |
| mountRules | 要整理 | [components/settings/MountRulesPanel.tsx](../../packages/web/src/components/settings/MountRulesPanel.tsx) | 真实挂载规则读取/保存；hint 为 VM 文案 |
| nativeSetup | 要整理 | [components/first-run-quest/useNativeOnboarding.ts](../../packages/web/src/components/first-run-quest/useNativeOnboarding.ts) | native-runtimes 与 cat-templates 合成；勾选放 UI 状态 |
| navThreads | 要整理 | [stores/sidebarProjectionStore.ts](../../packages/web/src/stores/sidebarProjectionStore.ts) | 统一 sidebar projection；分组/过滤/标签/排序不另造线程真相 |
| pcfCatalog | 要整理 | [components/settings/plugin-manager/PluginManagerConfigurationSection.tsx](../../packages/web/src/components/settings/plugin-manager/PluginManagerConfigurationSection.tsx) | 按插件 schema 配置；records 与动态选项有协议差异 |
| plug | 要整理 | [components/settings/plugin-manager/DotConnectionDetail.tsx](../../packages/web/src/components/settings/plugin-manager/DotConnectionDetail.tsx) | 宿主详情与插件专属详情区分；需第 4 节批准清单后搬 |
| preview | 要整理 | [components/workspace/BrowserPanel.tsx](../../packages/web/src/components/workspace/BrowserPanel.tsx) | 预览 tab/地址/console/健康、iframe bridge 合成 |
| profiles | 要整理 | [hooks/useDossierProfiles.ts](../../packages/web/src/hooks/useDossierProfiles.ts) | 档案、模型、证据与加载状态合成 |
| replay | 要整理 | [lib/story-player/useThreadReplay.ts](../../packages/web/src/lib/story-player/useThreadReplay.ts) | 事件、章节、播放、跳转与倍速合成；内容仍由统一消息 PDL 画 |
| rules | 要整理 | [components/settings/RulesPromptsContent.tsx](../../packages/web/src/components/settings/RulesPromptsContent.tsx) | 规则文件、生命周期、编译预览与差异合成 |
| schedule | 要整理 | [components/workspace/useSchedulePanelData.ts](../../packages/web/src/components/workspace/useSchedulePanelData.ts) | tasks/runs/control 已有；月/周网格及按日期聚合需应用 VM 整理 |
| skill | 要整理 | [components/settings/SkillsContent.tsx](../../packages/web/src/components/settings/SkillsContent.tsx) | 文档、挂载、异常、项目同步合成 |
| skillMounts | 要整理 | [components/settings/SkillsContent.tsx](../../packages/web/src/components/settings/SkillsContent.tsx) | 单 skill 的项目挂载列表与规则合成 |
| skills | 要整理 | [components/settings/SkillsContent.tsx](../../packages/web/src/components/settings/SkillsContent.tsx) | 能力目录、分类、成员筛选、异常合成 |
| stHome | 要整理 | [components/RightStatusPanel.tsx](../../packages/web/src/components/RightStatusPanel.tsx) | 状态页概要与成员/session 详情同源 |
| system | 要整理 | [components/settings/HubSystemSettingsTab.tsx](../../packages/web/src/components/settings/HubSystemSettingsTab.tsx) | 系统/环境/版本/桌面更新/推送状态合成 |
| tasks | 要整理 | [stores/taskStore.ts](../../packages/web/src/stores/taskStore.ts) | task 查询、状态、创建/删除与筛选整理 |
| terminal | 要整理 | [components/workspace/TerminalTab.tsx](../../packages/web/src/components/workspace/TerminalTab.tsx) | PTY 会话与只读 agent pane；原型文本 terminal 组件无法确认完整 VT 行为 |
| theater | 要整理 | [components/story-player/TheaterOverlay.tsx](../../packages/web/src/components/story-player/TheaterOverlay.tsx) | 剧场只作为 replay 的投影；不移植独立弹窗壳 |
| theme | 要整理 | [stores/themeStore.ts](../../packages/web/src/stores/themeStore.ts) | 已有外观偏好与 tuner；PDL 完整主题文档、布局编辑、升级逻辑项目缺，来自原样复制引擎 |
| themeBg | 要整理 | [components/chat-background/ChatBackgroundProvider.tsx](../../packages/web/src/components/chat-background/ChatBackgroundProvider.tsx) | 当前背景配置已有；原型个人 Blob/启动单图读取与现有 URL/按对话配置需决定落点 |
| themeThemes | 缺 | [stores/themeStore.ts](../../packages/web/src/stores/themeStore.ts) | 旧 preset 不是 PDL 文档；文档导入导出/归档/升级项目缺，由复制的引擎实现 |
| voice | 要整理 | [stores/voiceSettingsStore.ts](../../packages/web/src/stores/voiceSettingsStore.ts) | STT/TTS 服务安装进度、词条、语言、提示整理；实际 /api/services 与转写接口 |
| work | 要整理 | [hooks/useArtifactContent.ts](../../packages/web/src/hooks/useArtifactContent.ts) | 内容、媒体、二进制、frame 资源与版本整理 |
| works | 要整理 | [hooks/useThreadArtifacts.ts](../../packages/web/src/hooks/useThreadArtifacts.ts) | 当前对话作品列表/卡片、类型/成员/分组合成 |
| worksAll | 要整理 | [hooks/usePagedGlobalWorks.ts](../../packages/web/src/hooks/usePagedGlobalWorks.ts) | 全局分页、筛选、卡片、渐进读取合成 |

## 动作绑定与通用登记点

325 个动作全部逐行列在 [actions.tsv](actions.tsv)。其中引擎和组件库动作按原文复制；业务动作只改应用实现与绑定。表中的 d 参数来自原型函数访问，form/change/input 事件参数还需按原型调用签名绑定，不能只用 d 字段推断完整请求体。

通用动词 `set/toggle/pick/fold/open/dialog/add/remove/rename/setStatus/refresh/reset` 已经存在，但不是业务已经绑定。`features.json` 另外列了 55 个实体、53 个 opener、24 个 dialog、11 个 state root、4 个 reset。迁移时这些既有登记点要接真实 owner，不新增 registry/adapter/service。

| 登记来源 | 项目实际 owner | 迁移边界 |
| --- | --- | --- |
| app/cafe.js 的 thread/group/tag/trash/message/queue/approval/memory 等 | chatStore、sidebarProjectionStore、approvalHubStore、ThreadSidebar、memory/page | 通用 CRUD 必须执行现有请求；消息删除、回收站与永久删除分别保留其领域权限 |
| app/settings.js 的 member/account/svc 等 | useMemberEditor、useAccountDirectory、AccountDirectoryRow、ServiceStatusPanel | 表单草稿和选择属于 UI；保存/删除/切换/服务生命周期由真实接口决定 |
| app/capabilities.js 的 skill/mcp/plugin/mount 等 | useCapabilityState/useDriftSync、McpManageContent、PluginManagerLiveContent | 用真实生命周期 revision、安装计划与配置 schema；不在前端修改模拟数组 |
| app/ws-items.js 的 task/work/backlog/external project 等 | taskStore、useThreadArtifacts、MissionControlPage、ExternalProjectTab | 创建/认领/租约/导入都复用真实领域流程 |
| app/workspace.js 与 ws-ops/ws-status 的 community/evo/assert/pref/session 等 | GitHub 插件、capability-evolution、session/native control、eval workspace | 原型演示实体不等于已有真实类型；pref/assert 等字段差异必须先对齐 |
| app/ws-code.js 的 path/terminal/preview 等 | useFileManagement、TerminalTab、BrowserPanel | 保留 worktree/path/session 身份；不把终端/预览的 DOM 回调作为应用契约复制 |

## demo 动作逐项落点

以本次 tag 的清单为准：71 个 demo。原型工具不接业务接口；仍作为产品入口的动作保留原名并接真实流程。下面逐项列出，参数、源文件和证据在动作 TSV 中。

| demo 动作 | 状态与处理 | 真实接口或流程 |
| --- | --- | --- |
| accConflict | 要整理；绑定 | POST /api/accounts/:profileId/codex/login/start、/cancel、/confirm、/create-new；冲突处理按 provider 实际 action；accConflict 的 drop 可 DELETE /api/accounts/:profileId；非 Codex 登录不能套用 Codex 路径 |
| accLogin | 要整理；绑定 | POST /api/accounts/:profileId/codex/login/start、/cancel、/confirm、/create-new；冲突处理按 provider 实际 action；accConflict 的 drop 可 DELETE /api/accounts/:profileId；非 Codex 登录不能套用 Codex 路径 |
| accQuota | 要整理；绑定 | POST /api/accounts/:profileId/codex/quota；读 quota observation/lastSuccess；原型用 GET /codex/quota 读 observation，真实为 POST 查询动作 |
| accRelogin | 要整理；绑定 | POST /api/accounts/:profileId/codex/login/start、/cancel、/confirm、/create-new；冲突处理按 provider 实际 action；accConflict 的 drop 可 DELETE /api/accounts/:profileId；非 Codex 登录不能套用 Codex 路径 |
| attach | 要整理；绑定 | 原生文件选择 → 现有 upload/multipart POST /api/messages；失败重试复用附件状态；attach 在 proto 中为 no-op；如仍有入口必须接文件选择，原型工具 attach 调用不迁移 |
| avatarClear | 要整理；绑定 | 清头像草稿 → 原成员保存；无独立清空接口 |
| cafeAttRetry | 要整理；绑定 | 原生文件选择 → 现有 upload/multipart POST /api/messages；失败重试复用附件状态；attach 在 proto 中为 no-op；如仍有入口必须接文件选择，原型工具 attach 调用不迁移 |
| cafeAttach | 要整理；绑定 | 原生文件选择 → 现有 upload/multipart POST /api/messages；失败重试复用附件状态；attach 在 proto 中为 no-op；如仍有入口必须接文件选择，原型工具 attach 调用不迁移 |
| cafeAutoClassify | 要整理；绑定 | handleOrganizeWithCat/handleSuggestAll：POST /api/threads 与 /api/messages，读取建议，再用既有标签批量保存；已有真实多步流程；不能只在前端按标题正则分配标签 |
| cafeClSuggest | 要整理；绑定 | handleOrganizeWithCat/handleSuggestAll：POST /api/threads 与 /api/messages，读取建议，再用既有标签批量保存；已有真实多步流程；不能只在前端按标题正则分配标签 |
| cafeExport | 要整理；绑定 | GET /api/export/thread/:threadId?format=md\|txt；POST /api/export/thread/:threadId/selection；POST /api/threads/:threadId/export-image 或 /export-selection-image → 下载；原型 v/id 与选中消息映射到真实请求 |
| cafeImRefresh | 要整理；绑定 | 重新读 /api/local-sessions 列表；bind 复用真实接口 |
| cafeMemRetry | 要整理；绑定 | retry 重新发当前资源请求；warm POST /api/evidence/warmup |
| cafeMemWarm | 要整理；绑定 | retry 重新发当前资源请求；warm POST /api/evidence/warmup |
| cafeMultiExport | 要整理；绑定 | GET /api/export/thread/:threadId?format=md\|txt；POST /api/export/thread/:threadId/selection；POST /api/threads/:threadId/export-image 或 /export-selection-image → 下载；原型 v/id 与选中消息映射到真实请求 |
| cafeNoticeDismiss | 缺；绑定 | 需对应 notice 的真实 owner 确认/关闭接口；原型 notices:dismiss 不可直接迁移；未找到 /api/threads/:id/notices 或 notices:dismiss 同形协议；前端不可存已关闭 |
| cafeReadAll | 要整理；绑定 | POST /api/threads/read/mark-all；由服务端更新未读投影，不能给所有 THREADS.unread 赋 0 |
| cafeReconnect | 要整理；绑定 | 复用 socket 重连、恢复投影和原发送重试；区分首页 admission 失败与网络重连，不能无条件多发一条消息 |
| cafeRichRandom | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| cafeRwRetry | 要整理；绑定 | 重新读最近作品目录实际请求 |
| cafeVoteEnd | 要整理；绑定 | 复用 /api/threads/:id/vote 结束投票请求；不可只删 CS.vote |
| cafeWidgetRetry | 要整理；绑定 | 重读 widget 内容/重建其 frame，由原资源 owner 负责 |
| catalogDemo | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| catalogDialog | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| catalogFilmPreview | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| catalogSpot | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| covArea | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| covGo | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| covMore | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| covStatus | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| extRestart | 缺；绑定 | 实际只有 set-enabled / repair / update 等生命周期写入，未发现 /restart；不能自行用停用再启用模拟重启；需确认原型重启对应哪项能力 |
| ghIssue | 要整理；绑定 | 复用 GitHub 插件社区 issue 草稿/预览/发布流程；具体 repo/title/body 由现有卡片 owner 给，不是 toast |
| ghOpenCommit | 要整理；绑定 | 用 commit 身份打开真实提交/改动视图；外链经 platform；不需要造后端请求 |
| mkOpenUi | 要整理；绑定 | 当前生态的真实外部 URL 经 platform 打开；来源配置的具体 URL 待逐生态确认 |
| mkRefresh | 要整理；绑定 | 重发 GET /api/marketplace/search（当前生态/过滤条件） |
| noop | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| notes | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| openUrl | 要整理；绑定 | platform 外链/新标签；无业务 HTTP 接口；原型 no-op 必须接真实窗口能力，URL 不是作品 title |
| pcfTest | 要整理；绑定 | 现有测试按钮 POST /api/plugins/:pluginId/test；operation 字段另走声明 action；仅 testable 插件显示；响应写在行内，不能保留 tested=true |
| pdlModalDemo | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| pluginShare | 缺；绑定 | 按插件 entry 的目标复用真实转发/带入流程；没有已确认的通用 pluginShare 协议；原型只 toast 且 entry 目标不带统一业务参数；需要插件清单确认 |
| popConfirmShow | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| protoStream | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| protoToggle | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| pushTest | 要整理；绑定 | POST /api/push/test |
| pvNav | 要整理；绑定 | pvNav: 当前 iframe bridge/POST /api/preview/navigate；pvRetry: iframe reload/健康重读；pvShot: POST /api/preview/screenshot；截图先由既有 bridge 获取 dataUrl；不能只报保存成功 |
| pvRetry | 要整理；绑定 | pvNav: 当前 iframe bridge/POST /api/preview/navigate；pvRetry: iframe reload/健康重读；pvShot: POST /api/preview/screenshot；截图先由既有 bridge 获取 dataUrl；不能只报保存成功 |
| pvShot | 要整理；绑定 | pvNav: 当前 iframe bridge/POST /api/preview/navigate；pvRetry: iframe reload/健康重读；pvShot: POST /api/preview/screenshot；截图先由既有 bridge 获取 dataUrl；不能只报保存成功 |
| resetProto | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| reveal | 要整理；绑定 | POST /api/workspace/file/actions/reveal 或 /api/workspace/reveal-project，按目标类型分派 |
| simFail | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| specCat | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| stBind | 要整理；绑定 | POST /api/threads/:id/sessions/:catId/bind；必须带真实 catId/sessionId/绑定选项 |
| tmReconnect | 要整理；绑定 | POST /api/terminal/sessions；WS /api/terminal/sessions/:sessionId/ws；实际 PTY/xterm 连接生命周期保留为逻辑，界面能力需另决定 |
| tweak | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| tweaks | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| vapidGen | 要整理；绑定 | POST /api/push/generate-vapid；保存经 /api/config/secrets；保留 owner 权限与一次性 key 处理，不写演示公私钥 |
| vhintReset | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| vhintSim | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| viewRetry | 要整理；绑定 | 按资源 key 重新执行已有读取；load/error/stale 来自请求；无全局假 retry API，不能只清 simFail |
| wcUpload | 要整理；绑定 | 原生选文件 → POST /api/workspace/upload（multipart，可 overwrite=true）；保留 worktree/path 身份与上传边界校验 |
| wsDiscuss | 要整理；绑定 | POST /api/signals/articles/:id/discuss 或 /study；分别映射 discuss/multiCatResearch 等真实请求字段 |
| wsExtImport | 要整理；绑定 | POST /api/external-projects/:id/import-backlog；name 映射实际 external project id |
| wsFetch | 要整理；绑定 | POST /api/signals/sources/:id/fetch |
| wsNotice | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |
| wsPodGen | 要整理；绑定 | POST /api/signals/articles/:id/podcast；kind/文章 id 与回传 artifactId 对齐 |
| wsQuotaNotify | 要整理；绑定 | 复用浏览器 Notification/platform 通知测试与当前通知权限；系统通知自身是反馈；无需新业务端点 |
| wsRepoSync | 要整理；绑定 | POST /api/plugins/official.github-operations/github/community-issues/sync?repo=...（PR 同步 sync-prs） |
| wsRescue | 要整理；绑定 | GET /api/claude-rescue/sessions；POST /api/claude-rescue/rescue；选中 session 标识与真实结果字段保留 |
| wsScan | 要整理；绑定 | GET /api/claude-rescue/sessions；POST /api/claude-rescue/rescue；选中 session 标识与真实结果字段保留 |
| wsSim | 已有；不迁移 | 原型工具，无需真实接口；从 proto/mock 排除；功能清单仍记其演示来源，不能误算为业务缺接口 |

## 主题 toast 占位

本节是第一轮 r104 的问题记录，现已解决动作身份问题；当前结论以“需要 lang 决定与未确认接口”的 r105 更新和 placement.md 为准，不再请求改一次 toast 声明。

直接 `act: toast` 共 3 处；另有 1 处行入口用 `open.action: toast`，也必须绑定。引擎的通用 `toast` 机制保留；不要重写成一个按 msg 文案分发业务的 toast 动作。

| 原型位置 | 产品含义 | 项目落点与真实接口 | 状态 |
| --- | --- | --- | --- |
| theme/default/views-chat.js:36，富块文件下载 | 下载附件 | AssetAttachmentView、ExportButton 相关下载逻辑及真实附件/作品源；已有 stored attachment、workspace download、published media 等 URL，须由实际消息附件 VM 给 source/filename，不能用演示 rich.file.name 推 URL | 要整理数据身份与下载动作 |
| theme/default/views-chat.js:351，work.bin 下载 | 下载不可预览作品 | useWorkContent/useArtifactContent 的内容 URL；workspace 文件可走 /api/workspace/file/download；版本化作品必须用该版本真实 source，交 platform 下载 | 要整理 |
| theme/default/views-settings.js:37，完整记录导出 | 系统完整记录导出 | 现有 /api/services/:id/logs、audit/session 记录可读；未确认一个定义“完整记录”范围和导出格式的统一接口；不能拿聊天导出冒充 | 缺定义与接口 |
| theme/default/views-cafe.js:246，rec.bring | 将录音/转写带到对话 | TranscriptPanel、ThreadComposerContext、useSendMessage；把实际转写正文/引用写入 composer draft，再由 POST /api/messages 发送，无需一个 bring 专用端点；录音持久 id 与历史源仍需确认 | 要整理，历史 recordings 来源待定 |

第一轮提出的动作身份问题已由 lang 在 r105 解决：下载用通用 `download { source | text, name }`，完整记录用 `logsExport { scope }`，录音带到对话用 `insert`。不再给通用 toast 加业务分发。本轮未修改原型声明。

## React 画界面的全量边界

扫描包括 `packages/web/src`、`packages/ui/src`、`packages/collective-client/src`，并检查了 desktop。TS/TSX/JS/JSX 中有 JSX、createElement 或 createPortal 的有名函数与文件级匿名渲染逐项列出；测试、mock、fixtures 排除。TSV 含局部 render helper，故声明数大于组件文件数；不依赖组件名的大小写或文件名是否带 V2。开发预览被单列，不自动删。

| 类别 | 渲染声明数 | 替代方式 |
| --- | --- | --- |
| Collective 独立客户端 | 181 | frame 内部原样保留候选；宿主入口由引擎画 |
| 现有共享 UI 包 | 42 | 宿主使用处由新组件库替代 |
| React 组合宿主 | 6 | 界面外壳由引擎画；Provider 和业务生命周期保留 |
| 宿主界面 | 2325 | 是：引擎 + 组件库 + 主题 PDL |
| 开发预览与审查工具 | 98 | 产品迁移不挂载；开发工具保留去向待定 |
| 猫猫星球独立界面 | 13 | frame 内部原样保留候选；宿主入口由引擎画 |
| 插件专属嵌入或设置界面 | 28 | 是：插件 PDL 或登记的插件组件候选 |
| Collective 宿主嵌入界面 | 42 | 宿主外壳替代；远端 frame 内部保留候选 |
| 独立文档编辑器宿主 | 2 | 外壳替代；专用 origin iframe 协议需对齐 |
| 宿主终端与嵌入渲染 | 6 | 外壳替代；VT/PTY 渲染能力待原型补齐 |

宿主普通界面包括 AppShell/ActivityBar、ThreadSidebar 全部版本、ChatContainer/ChatInput/ChatMessage、卡片、队列、待办、工作台/F307/v2 外壳、文件/预览/媒体审阅、设置/成员/能力/市场、memory、signals、eval 与 replay/theater。它们的 React 画法均由引擎与相应主题替代；v2 的产品能力也要变成第二套主题，不因文件名含 V2 就保留 React UI。

`ThemeApplier`、socket/Bootstrap 等无 JSX 的逻辑宿主不在“自己画界面”的表中。Provider 和框架 layout 仍可承担宿主/数据生命周期；既有 token/style 注入不能和新主题并行画产品 UI。

插件归类是待审批清单，不是已获准搬迁：

| HANDOFF 四类 | 当前候选 | 对引擎替代的影响 |
| --- | --- | --- |
| 1 宿主通用 | plugin-manager 列表、配置表单、operation、多选一表单、通用 frame；packages/ui 的通用控件 | 进宿主通用组件/PDL；旧共享包若仍供独立客户端用，不能直接删除 |
| 2 插件专用嵌入组件 | 云连接 receipt/recovery 的专有状态内容、GitHub/Collective 仅在消息或宿主卡片内出现的内容 | 普通组合先用 PDL；只有通用组件表达不了且仅插件使用的部件才登记为插件组件 |
| 3 可用宿主组件表达 | CommunityPanel/closure forms、DotConnectionDetail、Collective 连接/参与/权限设置、插件详情和配置 | 随插件走 PDL，宿主仅打开与转发；旧 JSX 不保留 |
| 4 独立界面 | visible-cafe/StarryRoom；已有 iframe 的 CollectiveLaunchSurface 后面的 packages/collective-client；独立视频工作台/桌宠若插件声明另有整页 | frame 内部保留候选；宿主入口与外壳由引擎画。当前片子审片 tab 已有原型 PDL，不因其内容是视频就整体当作保留 React 的 frame |

## HANDOFF 迁移时项目落点

| 事项 | 当前项目落点与现状 | 绑定时处理 |
| --- | --- | --- |
| 片子审片只在发消息时同步 | useProjectReview.ts:21–45 轮询前调用 synchronizeProjectReview；screening-ui/project-review-read.ts:7 发送 POST review/synchronize。messages.ts:749 已在保存消息后调用 importStoredProjectMessage；消息保存后 import 是真实现有链路 | 移除读取时带写的迁移绑定；发消息后沿现有后端导入链路同步。若还需显式 synchronize，只能放发送链路并确认分页补扫语义；不在 VM 或轮询 GET 前写 |
| 成员设置真实接口与勾选状态 | first-run-quest/useNativeOnboarding.ts:93/96 读取 native-runtimes/cat-templates；RecommendedTeamSetup、useMemberEditor 管编辑/保存，selected/invalid 为 UI draft | 复用读取/创建，投影为 nativeSetup/memberNew/members；勾选不写服务端生命周期，也不读 x-demo/native-setup |
| 背景 app 不直接写 CSS | ChatBackgroundProvider GET/PUT config/chat-background；ChatBackgroundLayer/BackgroundImageControls 及 themeStore.applyThemeCSS 负责旧视觉 | 绑定只给背景 asset、透明度与错误状态；PDL_LAYOUT.background/主题与 platform.assets 画与存图片，移除旧产品 CSS 注入；不改复制的引擎/库 |
| 工作台调宽 app 不读写 DOM | sidebarStore width/setWidth/handleResize；workspace/ResizeHandle；F307 workbench/store、WorkspacePanel 负责现有布局/可见性 | 状态值与动作仍在应用，视觉和测量时机用既有引擎/组件绑定；像素上下限换原型既有主题 token，不继续由 app querySelector/style 画布局 |
| rpThread 不判断引导弹窗 | guideStore.session.threadId、useThreadReplay、experience-workbench-store 的 replay surface、theater scope | 明确给 replay 当前来源 threadId：guide/theater/workbench 各自绑定状态；不读 S.popOn.guide 或弹窗 DOM 推身份；guideStore.completedGuides 的本地完成/关闭记忆不直接带入新契约，触发资格改由后端给 |
| 待办通知不重复按 dismissed 过滤 | use-unified-attention、unified-mailbox-state、approvalHubStore 已合成真实来源；useIgnoredItemPreferences 从 /api/config/ignored-items 获取个人偏好。原型 cafe.js:108 还按 dismissed 过滤 | 不迁移原型二次过滤或 NOTICES 缓存。区分服务端个人“忽略”偏好与已过滤 notice；前者有真实 owner，不能作为重复代码一刀删掉。缺通用 notice visible/dismiss 协议先列后端项 |
| 检查分三档 | 项目现有 package scripts、测试和 CI；原型 checks/lib/run.js、catalog/similarity/contrast/role variants | 本轮仅盘点。迁移每次相关 quick；PR 跑 lint/分层/随库检查+核心冒烟，目标 5 分钟；全量每晚/发版前；模拟流程套件由真实逻辑测试替代，不照搬 mock |

## 需要新组件或样式的候选

下表是第一轮 r104 的候选快照，不代表当前待决定项。r105 已确定终端、正文渲染、frame 和背景方案；当前每项能力的字段、动作、落点及旧交互归属已拆在 [placement.md](placement.md)。以下不实现；只有表达不了的能力才回原型补同一个组件。

| 能力差异 | 项目证据 | 原型已有与缺口 | 归属及下一步 |
| --- | --- | --- | --- |
| 完整 VT/PTY 终端与只读 agent pane | workspace/TerminalTab 使用 @xterm/xterm/FitAddon、WS、resize；AgentPaneViewer 同类 | widgets.terminal 只画文本行/光标，不等于 VT 屏幕、控制序列、全屏程序 | 组件能力缺口；先回原型对齐终端组件；是否允许复用现有依赖需 lang 定，不新增依赖或留 React UI 绕过 |
| Markdown 公式与 Mermaid | MarkdownContent 使用 remark-math/rehype-katex；MermaidDiagram | ui.mdLite 是轻量解析、code/text/table；无公式/Mermaid 渲染能力 | 同一正文组件扩展候选；不再另造一个“高级正文”变体 |
| 独立 origin 文档/Office 编辑器 | content-editor/ContentEditorOwnerSurface iframe src、admission/resume、postMessage session bridge | frame.html 为 srcdoc allow-scripts，message 单向发数据；不是现有 URL editor 会话协议 | 通用 frame 的能力与契约缺口；先确认其属于独立编辑器 frame，回原型补通用能力 |
| 插件动态 select options 与 agent-client records | PluginManagerOperationField、PluginAgentClientsField、多选一配置 | widgets 已有 records 画法；engine 待做记录了协议未声明 records、动态 options 未完成 | 协议和数据绑定先补，不自建第二套表单；具体需改主题还是通用组件由确认后的字段定 |
| 记忆 people/profile/event/entity/taste/capsule 的细分流程 | memory/page 下专属详情、编辑、修订、审批与 source provenance | cafeMemory 有搜索/召回/资料库等，但未逐项表达所有新增 owner 页面/交互 | 先补 VM/动作/PDL 字段；以已有表单、列表、统一卡片与 annotation 组合，暂不宣称缺新外壳 |
| 进化 preparation/exploration/solution gate 与谱系 | capability-evolution/preparation、exploration、solution-gate | cafeWsEvo 的 active/done/judge 不足以证明新阶段都覆盖；已有 graph/list/media/split | 先做能力覆盖和 PDL；只有谱系镜头/交互确实无法表达才回原型补 graph 能力 |
| 协作资料、项目/责任/道路图客户端 | packages/collective-client 与 components/collective | features 没有同等全套 Collective VM；宿主已有 frame | 独立客户端 frame 范围待 lang 定；若要原生全迁，先扩契约与原型页面，不能硬塞进 cafeWsTeam |
| 云连接恢复、runtime 更新/恢复、实时语音/呼叫、会议共享、详细审阅流程 | CloudBindingRecoveryCard、RuntimeUpdateRequiredDialog、concierge、MeetingShareControl、content-review、AssetCanonPanel | 有通用消息/表单/notice/media；features 无法直接证明这些协议态与动作已覆盖 | 属应用/PDL 覆盖缺口；先明确 owner 状态与动作，普通内容用现有组件，不为每个 feature 新造组件 |
| v2 的整套页面、控件与 token | 文件清单中所有 v2 与 shell-presentation 分支、packages/ui | 默认主题不是旧 v2；HANDOFF 要同引擎和契约、额外 v2 组件库与 PDL | 需要一套经确认的 v2 主题数据/组件样式；本轮不复制 JSX、不另加样式分支 |

待办月/周日历、片子审片/同步播放、共用媒体批注、作品卡片、统一剧场、个人背景已经有原型组件或组合，不能因项目旧 JSX 不同就再造同义组件。

## 需要 lang 决定与未确认接口

本节已按 r105 的决定更新。已定项不重问；剩余落点建议只在 placement.md 中等待确认。

| 项目 | 结论状态 | 当前结论或后端补项 |
| --- | --- | --- |
| 4 处 toast 占位 | 已定 | 原型已给真实动作身份：通用 download、logsExport、insert；文件/作品/录音 source 经 api.file 给。唯一通用下载实现原样复制，不做 toast 业务分发。 |
| cafeNoticeDismiss | 已定，列后端项 | 原型已去掉提示关闭入口，显示什么由接口决定；不新增前端 dismissed/seen。 |
| envRestart | 已定，列后端项 | 原型已去掉环境重启入口；不把清 pending 当作重启。 |
| extRestart | 已定，列后端项 | 原型已去掉插件重启入口；出错/需重启只显示状态，不用停用再启用模拟。 |
| pluginShare | 已定，列后端项 | 原型已去掉通用插件转发入口；等第 7 步随插件仓声明具体目标和内容，不造万能转发层。 |
| vhintOn / vhintOff | 已定，列后端项 | 原型已去掉语音输入推荐入口；真实录音、朗读和呼叫能力另行落点，不因去推荐而删除。 |
| wsPref / wsPrefRenew | 已定不呈现写入口；后端语义待对齐 | 原型已去掉偏好新建/修改/续期入口。本轮更正上一轮漏查：项目实际有 routing-context/preferences 的真实新建、替代、续期与退休 API，证据见 placement.md O10。仍不恢复入口；是否复用现 owner 对齐原型语义由后端项处理。成员异常信号是另一条已有能力，不一并删除。 |
| 独立 frame | 已定 | 猫猫星球、Collective 独立客户端、独立文档编辑器都按第 4 类保留内部界面；宿主只画入口、必要状态与外壳，不再要求把内部功能拆成宿主页面。 |
| 个人背景 | 已定 | 绑定项目现有服务端背景配置这个真实 owner，沿用原型界面；不坚持另存个人 Blob 作为第二份状态。 |
| Mermaid / 公式 | 已定 | 扩同一个正文组件，库不限；不新造高级正文组件，也不继续询问是否允许复用库。 |
| 终端 | 已定 | 用原型 terminal，只加输出流/输入/尺寸绑定通道；组件内解析控制序列（颜色、光标、全屏程序），WebSocket、鉴权、重连在应用绑定层。 |
| 项目文件里的 Markdown | 已定 | 与作品正文一样默认渲染、可切源码，同一个正文组件。 |
| 完整记录导出 | 已定动作，列后端项 | 名字是 logsExport { scope }；完整 scope/格式/真实接口尚未定义，不用单服务日志或单次 invocation 导出冒充。 |
| 信号播客音频下载 | 已有真实来源，拟绑定 | r105 的剩余占位应接真实来源。本轮已找到 PodcastPlayer 的逐片段 audioUrl 与下载逻辑，见 placement.md O16；按片段接通用 download，不拼造一个完整音频地址。 |
| 录音历史 | 仍待确认 | 已查到当前 transcript、保存结果 transcript_path，但持续历史列表与录音音频 owner 未核实；见 placement.md V12/V14/Q2，不在前端造历史。 |
| 原型没画过的能力 | 清单待批准 | 每项只给已有容器、已有组件和必要入口/信息，旧定制交互归 v2。逐项字段、动作、a/b/c/d 建议和 4 个待决定问题在 placement.md；批准前不改原型。 |

## 第一轮按层变动

- 引擎（通用机制）：无。
- 组件：无。
- 主题数据（PDL）：无。
- 应用（VM、动作）：无代码变动；仅增加本盘点和 3 张全量表。
- 工作位规则：在新 worktree 的 AGENTS.md 末尾追加本仓规则。

看得见的变化：产品界面没有变化；新增可阅读的盘点文档和表格。未截产品截图，因为没有迁移实现或视觉变更。

## 第一轮 r104 检查原文

构建输出：

```text
lint {'pdl-schema': 0, 'file-boundary': 0, 'derived-only': 0, 'css-important': 1} 基线 {'pdl-schema': 0, 'file-boundary': 0, 'derived-only': 0, 'css-important': 1}
features: 70 个视图模型（878 个字段）、325 个动作（其中演示 71）→ app/features.json
built 5788950 bytes
行为检查：../checks/run.sh（结果写进 ../checks/last-run.txt，说明见 ../checks/README.md）
```

全量检查输出原文（118 jobs；5 个有失败的套件，17 条失败，与 HANDOFF 记录的类别一致；节拍套件本次直接通过）：

```text
wall 805.4s, 118 jobs, 6 workers
./catalog/catalog.js  PASS 6  FAIL 0  EXC 0
./catalog/structure.js  PASS 4  FAIL 0  EXC 0
./chat/cards.js  PASS 37  FAIL 0  EXC 0
./chat/chat.js  PASS 15  FAIL 0  EXC 0
./chat/decisions.js  PASS 22  FAIL 0  EXC 0
./chat/exec.js  PASS 53  FAIL 0  EXC 0
./chat/folds-ask.js  PASS 8  FAIL 0  EXC 0
./chat/inbox-review.js  PASS 9  FAIL 0  EXC 0
./chat/jump-command.js  PASS 38  FAIL 1  EXC 0
    FAIL 主题计算器：标题是当前主题，没有保存按钮，没有管理主题的控件  {"save":false,"manage":false,"title":"主题计算器\n切到深色\n编辑布局\n配色\n结构\n对比度\n文\n标题与正文 / 页面\n1"}
./chat/live.js  PASS 11  FAIL 0  EXC 0
./chat/markdown.js  PASS 10  FAIL 0  EXC 0
./chat/messages.js  PASS 50  FAIL 0  EXC 0
./chat/model.js  PASS 18  FAIL 0  EXC 0
./chat/multiselect.js  PASS 9  FAIL 0  EXC 0
./chat/references.js  PASS 10  FAIL 0  EXC 0
./chat/ticks.js  PASS 8  FAIL 0  EXC 0
./chat/works-widget.js  PASS 15  FAIL 0  EXC 0
./composer/lanes.js  PASS 13  FAIL 0  EXC 0
./composer/queue.js  PASS 13  FAIL 0  EXC 0
./composer/top.js  PASS 7  FAIL 0  EXC 0
./copy/copy.js  PASS 3  FAIL 0  EXC 0
./copy/hints.js  PASS 8  FAIL 0  EXC 0
./copy/i18n.js  PASS 4  FAIL 0  EXC 0
./copy/keys.js  PASS 13  FAIL 0  EXC 0
./core/acceptance.js  PASS 347  FAIL 0  EXC 0
./core/anchor.js  PASS 15  FAIL 0  EXC 0
./core/avatar-clip.js  PASS 1  FAIL 0  EXC 0
./core/buttons.js  PASS 20  FAIL 0  EXC 0
./core/calendar.js  PASS 8  FAIL 0  EXC 0
./core/cleanups.js  PASS 31  FAIL 0  EXC 0
./core/clock-signature.js  PASS 7  FAIL 0  EXC 0
./core/elevation-copy.js  PASS 18  FAIL 0  EXC 0
./core/ellipsis.js  PASS 1  FAIL 0  EXC 0
./core/engine-observer.js  PASS 5  FAIL 0  EXC 0
./core/file-navigation.js  PASS 13  FAIL 0  EXC 0
./core/final.js  PASS 8  FAIL 0  EXC 0
./core/fit.js  PASS 1  FAIL 0  EXC 0
./core/fold-units.js  PASS 15  FAIL 0  EXC 0
./core/heads-lists.js  PASS 9  FAIL 0  EXC 0
./core/identity.js  PASS 17  FAIL 0  EXC 0
./core/indicators.js  PASS 18  FAIL 0  EXC 0
./core/inputs.js  PASS 10  FAIL 0  EXC 0
./core/insets.js  PASS 5  FAIL 0  EXC 0
./core/islands.js  PASS 6  FAIL 0  EXC 0
./core/local.js  PASS 6  FAIL 0  EXC 0
./core/media.js  PASS 29  FAIL 0  EXC 0
./core/misc.js  PASS 9  FAIL 0  EXC 0
./core/one-template.js  PASS 9  FAIL 0  EXC 0
./core/partial.js  PASS 10  FAIL 0  EXC 0
./core/proto-tab.js  PASS 2  FAIL 0  EXC 0
./core/review-round.js  PASS 8  FAIL 0  EXC 0
./core/row-inset.js  PASS 1  FAIL 0  EXC 0
./core/row-trailing.js  PASS 5  FAIL 0  EXC 0
./core/rows-hairline.js  PASS 14  FAIL 0  EXC 0
./core/rows.js  PASS 4  FAIL 0  EXC 0
./core/scroll.js  PASS 26  FAIL 0  EXC 0
./core/sequences.js  PASS 85  FAIL 0  EXC 0
./core/signals.js  PASS 13  FAIL 0  EXC 0
./core/spec-page.js  PASS 8  FAIL 0  EXC 0
./core/startup.js  PASS 3  FAIL 0  EXC 0
./core/stick-end.js  PASS 12  FAIL 0  EXC 0
./core/structure.js  PASS 6  FAIL 0  EXC 0
./core/surfaces.js  PASS 17  FAIL 0  EXC 0
./core/toasts.js  PASS 10  FAIL 0  EXC 0
./core/undo.js  PASS 19  FAIL 0  EXC 0
./core/unify.js  PASS 11  FAIL 0  EXC 0
./core/video-project.js  PASS 38  FAIL 0  EXC 0
./core/view-states.js  PASS 22  FAIL 0  EXC 0
./core/views.js  PASS 304  FAIL 0  EXC 0
./data/boundary.js  PASS 5  FAIL 0  EXC 0
./data/mock.js  PASS 17  FAIL 0  EXC 0
./edit/edit-mode.js  PASS 20  FAIL 0  EXC 0
./edit/launcher.js  PASS 81  FAIL 0  EXC 0
./edit/layout.js  PASS 37  FAIL 1  EXC 0
    FAIL 再移回底部  ["composer","stream","stripe.panel"]
./motion/beat.js  PASS 16  FAIL 0  EXC 0
./motion/reveal-switch.js  PASS 8  FAIL 0  EXC 0
./motion/status.js  PASS 6  FAIL 0  EXC 0
./nav/sections.js  PASS 7  FAIL 0  EXC 0
./nav/sticky.js  PASS 4  FAIL 0  EXC 0
./popups/folder-picker.js  PASS 16  FAIL 0  EXC 0
./popups/hover-card.js  PASS 24  FAIL 0  EXC 0
./popups/rules.js  PASS 139  FAIL 0  EXC 0
./popups/stack.js  PASS 15  FAIL 0  EXC 0
./popups/sub-back.js  PASS 14  FAIL 0  EXC 0
./popups/theater.js  PASS 25  FAIL 0  EXC 0
./region/back-head.js  PASS 29  FAIL 0  EXC 0
./region/back-origin.js  PASS 4  FAIL 0  EXC 0
./region/back.js  PASS 6  FAIL 0  EXC 0
./region/cover-backdrop.js  PASS 8  FAIL 0  EXC 0
./region/exec-panel.js  PASS 9  FAIL 0  EXC 0
./region/panel-view.js  PASS 7  FAIL 0  EXC 0
./region/projection.js  PASS 47  FAIL 0  EXC 0
./region/region.js  PASS 19  FAIL 0  EXC 0
./region/settings-entry.js  PASS 9  FAIL 0  EXC 0
./region/split.js  PASS 8  FAIL 0  EXC 0
./region/stripe.js  PASS 49  FAIL 0  EXC 0
./region/transient-exit.js  PASS 9  FAIL 0  EXC 0
./region/workbench-pair.js  PASS 7  FAIL 0  EXC 0
./settings/cap-rows.js  PASS 9  FAIL 0  EXC 0
./settings/eval-paw.js  PASS 22  FAIL 0  EXC 0
./settings/flags-quota.js  PASS 11  FAIL 0  EXC 0
./settings/market.js  PASS 16  FAIL 0  EXC 0
./settings/member-layout.js  PASS 9  FAIL 0  EXC 0
./settings/plugin-states.js  PASS 18  FAIL 0  EXC 0
./settings/plugin.js  PASS 32  FAIL 0  EXC 0
./settings/runtime-oneof.js  PASS 12  FAIL 0  EXC 0
./settings/runtime-records.js  PASS 12  FAIL 0  EXC 0
./similarity/check.js  PASS 0  FAIL 13  EXC 0
    FAIL new middle-band group 94.5% (not in snapshot): part:status:tone@two[tone=info] ~ text:meta ×7958
    FAIL new middle-band group 87.0% (not in snapshot): part:roll ~ text:meta ×7635
    FAIL new middle-band group 86.0% (not in snapshot): part:capsule:m/lead/warning ~ text:body@item ×3506
    FAIL new middle-band group 91.5% (not in snapshot): part:status:tone@two[tone=info] ~ text:meta@item ×2338
    FAIL new middle-band group 88.7% (not in snapshot): part:section-head:nav ~ text:compact ×1213
    FAIL new middle-band group 85.0% (not in snapshot): part:calendar.day:normal ~ text:body ×1065
    FAIL new middle-band group 91.5% (not in snapshot): part:status:tone@two[tone=info] ~ text:meta@two ×964
    FAIL new middle-band group 90.3% (not in snapshot): part:status:tone@two[tone=info] ~ text:meta@line ×749
    FAIL new middle-band group 85.1% (not in snapshot): part:status:tone@tree[tone=warn] ~ text:meta@line ×717
    FAIL new middle-band group 85.3% (not in snapshot): part:calendar.day:normal ~ text:title ×663
    FAIL new middle-band group 86.0% (not in snapshot): part:capsule:m/lead/warning ~ text:body@two ×483
    FAIL new middle-band group 91.5% (not in snapshot): part:status:tone@two[tone=info] ~ text:value ×305
    FAIL new middle-band group 88.2% (not in snapshot): part:who:inline ~ text:compact ×301
./theme/background-layers.js  PASS 21  FAIL 0  EXC 0
./theme/calc.js  PASS 26  FAIL 0  EXC 0
./theme/custom-image.js  PASS 18  FAIL 0  EXC 0
./theme/doc.js  PASS 14  FAIL 0  EXC 0
./theme/page.js  PASS 22  FAIL 0  EXC 0
./theme/themes.js  PASS 12  FAIL 0  EXC 0
./walk/narrow.js  PASS 5  FAIL 1  EXC 0
    FAIL stability: route:ws.preview · 新建标签页 · button.btn.btn-sm.btn-icon[add] "新建标签页" — clicked control left the pointer: now 818,36 (clicked 670,50) @main<body<window [light@1000 ×1] walk/light@1000/1.png
./walk/walk.js  PASS 11  FAIL 1  EXC 0
    FAIL stability: route:ws.preview · 新建标签页 · button.btn.btn-sm.btn-icon[add] "新建标签页" — clicked control left the pointer: now 978,36 (clicked 830,50) @main<body<window [light@1440 ×1] walk/light@1440/1.png
gate/check.js  PASS 37  FAIL 0  EXC 0
contrast/cc.js  (每行“模式 [不达标项]”，[] = 达标)
    light []
    default-button light []
    bg-image home light []
    bg-image chat-follow light []
    bg-image chat-absolute light []
    bg-image settings light []
    dark []
    default-button dark []
    bg-image home dark []
    bg-image chat-follow dark []
    bg-image chat-absolute dark []
    bg-image settings dark []
privacy-grep: 0
ALLDONE
```

本轮未修改产品源码，未修改检查或快照。全量命令通过 tee 返回的进程码不能当作全绿依据，以上 FAIL 原文为准。检查产生的受跟踪截图和 last-run.txt 已恢复到运行前内容；本报告保留本次原文。

盘点一致性验证原文：

```text
PASS view-models.tsv: 70/70, missing=0, duplicate=0
PASS actions.tsv: 325/325, missing=0, duplicate=0
PASS react-renderers.tsv: 2743 declarations, 1545 files, all source locations exist
PASS AGENTS.md: original bytes preserved; exact design rules appended
PASS all VM/action target sources exist
```
