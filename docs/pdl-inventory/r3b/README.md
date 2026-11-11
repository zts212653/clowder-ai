# 第三轮 B · W1 r3b25：r133 应用绑定

本轮基线 HEAD `b2bdc0eec6`；继承 lang 已提交的 r133 复制（`840de31cb5`）。本轮不重复制、不改引擎／组件／主题 PDL；81 个文件独立 git show 复核，差异 0、额外 0、mock／proto／local 0。详细逐项检查点、移除清单和合并边界见 [W1.md](W1.md)。

**不提交、不 push、不改 .env、不启动／停止服务。** W2（执行／作品／任务／召回／回放／文件／记忆／Mission Hub）与 W3（评估／片子／成员状态／能力进化／信号／运维）的绑定文件和下面进度行未修改，由各自 W2.md／W3.md 合并。旧接口待审删除清单仍在 [r3b21-audit.md](r3b21-audit.md)，本轮只撤 lang 明确要求撤回的迁移新增 appearance 协议。

## 0. 本轮逐项检查点

本轮顺序：侧栏真实整理／标签／归档／新建；@ 与 # 对话／文件候选；消息正文任意选区和原生提议 owner；系统 general；云端恢复；插件 schema 与管理。见 [W1 本轮记录](W1.md#r3b25--按顺序逐项交付)，后面的 r3b23／r3b22 表为历史。

## 1. 本轮契约

外观偏好通过原 store 存 localStorage。撤迁移新增 appearance 读写协议、schema/default、saveAppearance 和宿主拦截；上传图片仍由原服务端目录保存。迁移前的 chatBackgrounds GET／PUT 与原 writer 保留，服务端旧 UI 偏好字段不读不清理。VM.chatBackgrounds 包含按对话数据，默认主题有意不读，v2 可用。

最近作品按真实 projectId（Thread.projectPath／新对话 intent.projectPath）先限制来源再取最近 3 条。新对话和工作台首页同一 recentWorks；详情仍复用 W2 的作品 owner，不复制一份。工作台最近打开和固定只由组件库的本地 rtMenu 管；没有 order、最近关闭或后端固定数据。

## 2. 看得见的变化

r3b25：侧栏整理／标签／归档／新建、@ 与 # 对话／文件候选、消息正文任意选区、原生提议卡、系统 general、用户源云端恢复、插件真实配置／操作已接。完整分项、可见变化和边界见 [W1 本轮报告](W1.md#r3b25-按层改动与可见效果)。下面保留 r3b23 的已接行为。

新对话页和工作台首页显示所属项目的最近作品（加载／错误重试／空态沿原声明）；托管执行详情在“进行中”顶上。消息执行记录按思考／真实子代理／工具三组展示；一次调用及其结果合成一行，展开可读输入、结果、resultMeta，错误用 warn。回复进行中跟随底部，结束后从上读。仅 src 的插件空间可成为工作台项；预览控制台默认收起、新标签为空。安装包的系统页桌面更新小节可手动检查、改自动检查、看下载进度、下载及确认安装；普通浏览器不造更新状态。外观选择只影响当前浏览器的本地偏好。

本轮只做 JSDOM／owner 检查；没有启动实例或新增截图，真实浏览器验收由 lang 另行安排。

## 3. 进度表

W1 按本轮结果更新；W2／W3 行保留 r3b22 状态，合并前不重算总数。r3b21 拆行与分类保留。已接只表示代码绑定落地，真实服务／浏览器验收另由 lang 安排；相似度快照最后处理。

类别：**A = 主题数据配置（PDL + VM，组件不动）**；**B = 疑似旧的不合理定制（先列出问 lang，不照搬）**；**C = 需调整组件（必须是通用能力）**。本轮未确认有必须改组件的项。A／B 同行时，B 只指未定的旧交互；逐项后端核对及依据见 [r3b21 复核清单](r3b21-audit.md)。

| 区域 / 工具 | 状态 | 类别 | 当前范围／剩余项 |
| --- | --- | --- | --- |
| 引擎装载、单根节点、全应用外壳 | 已接 | A | 原样脚本、CSS、PDL，React 只做数据宿主；此前先列清单，再删 3 个未挂载旧组件及其专属测试，宿主直接复用的函数／类型移出旧 UI，不留兼容 re-export |
| 应用数据汇总／通用数据错误 | 已接 | A | 21 份 binding 分别读取，新增 recentWorks／desktop；一份投影抛错只省略这一份，dataError／dataOk 仍由引擎唯一处理；已有 load:error／stale 组件状态不重复提示。 |
| 窄栏、侧栏、工作台入口与容器 | 已接 | A | 原主题和元数据；r133 固定／菜单固定／最近打开全由组件 rtMenu，移除 host order；无最近关闭数据或恢复动作，无旧 JSX。 |
| 侧栏对话快照、切换、折叠／调宽 | 已接 | A | `refreshSidebarThreadSnapshot`、路由与 sidebarStore；切换前刷新持久草稿 |
| 侧栏最近／置顶／收藏／系统、标签筛选 | 已接 | A | 从真实 threads 投影；重命名、置顶、收藏、软删除请求 |
| 侧栏项目分组、整理、回收站与恢复 | 已接；自动建议未接 | A | r3b25 接真实 thread-attention organize／改名／移出及 owner undo，标签创建／删除／线程 labels，项目归档沿既有软删除和恢复；项目 + 进入原新对话 admission，置顶／收藏／改名按点中的线程。组显示偏好存本地；回收站只恢复。自动分类建议缺真实 owner，见第 5 节。分项见 W1.md。 |
| 对话头部标题、成员、成员筛选与查找入口 | 已接 | A | `chatHeader`、真实 thread / cats |
| 普通消息、流式正文、引用、执行记录、纪要 | 已接 | A | 保留验证过的 outputLayout 原顺序；tool_use／result 按 toolUseId＋executionRef 配对，label／toolName、完整输入／结果／resultMeta 与 warn；思考／真实子代理／工具三组，live 跟随。API 原摘要仍留，新完整字段读取安全处理后的原文；旧历史已丢原文不补造。 |
| 更早消息、回到最新、当前消息定位 | 已接 | A | 原 history cursor；引擎 `STREAM_OLDER` / `scrollToMessage` / `streamScrollTo` 管滚动 |
| 消息查找、结果跨对话定位 | 已接 | A | 复用 useMessageSearch；跨对话保留目标，加载更早历史后交引擎定位；未在浏览器验收 |
| 文本、图片、回复、对话上下文草稿 | 已接 | A | useDurableComposerDraft；图片恢复／重试、移除附件与上下文 |
| 发送、首条消息创建对话、停止执行 | 已接 | A | useSendMessage / useNewConversationAdmission；现有连接与版本 admission；按精确 execution ID 取消 |
| 目标、悄悄话、输入历史与补全 | 已接 | A | 自动目标改读现有 useRoutingPreview / AgentRouter 真实预览；单／多成员与手选分别保留，未就绪时不猜成员、不重复显示“自动”。草稿／发送参数沿原 owner |
| 队列读取、停止后续处理、撤回编辑 | 已接 | A | 既有队列与 true recall；有草稿时等待引擎确认再写入 owner |
| 消息软删除／恢复、多选、复制 | 已接 | A | 精确 message ID；结果回读服务端 |
| 整条／多条消息转发 | 已接 | A | r128 声明式 chat.modal＋chatModal VM，已删除原手画回调；显式 targetCats；真实 Message Bundle 幂等提交，失败原因进入 dialog.error，原选择保留供重试 |
| Markdown / 公式 / Mermaid | 已接 | A | 原正文组件与项目 richRender；Mermaid 布局未在真实浏览器验证 |
| 运行时 question / approval 卡片 | 已接 | A | F306 canonical read / exact cardRef / respond；终态读真实结果 |
| 运行时 form / URL elicitation / conversation_decision | 已接 | A | r110 fields／decisions／choices，默认值与 primitive enum／false；外部授权只打开 URL，不自动授权。卡片／输入框文字回答共用 canonical writer；无真实运行时验收 |
| Thread 提议（F128）、Session 接力（F225）、日程审批（F139） | 已接 | A | F128／F225 真实 owner 读写；F139 原 controller。F128 可编辑字段与发修改要求，终态回读服务端 |
| 其它提议、记忆提议、内容修改等消息卡片 | 部分已接 | A | r3b25 画像 F231、事件 F321、品味 F221 接真实发布坐标／提交前回读与原生 writer；F193／F260／F266 的普通决定复用原审批 store，人物 F276 卡按原型只读真实状态、决定在待办。原位画像修改、实体冲突解决、其它插件／领域卡缺声明的部分另列第 5 节；不把历史显示字段当写权限。 |
| diff / checklist / 图库 / 音频 / 文件下载 | 已接 | A | 原组件字段，原 diff parser，真实 file URL；图库以 mid / blockId / item index 定位和预览 |
| 富卡正文、用户消息图片／文件嵌入 | 已接 | A | r110 的原正文位与 user.embeds；字段整理成 kv 的 k/v，图片一组、文件各一行 |
| 普通 interactive 富块 | 已接 | A | richPick／richRandom／richSubmit；单／多选、自定义、groupId、真实出题成员／messageTemplate／block-state；单块保留既有 callback allowlist。无真实后端验收 |
| html_widget 沙箱嵌入 | 已接 | A | 使用原 frame.html 和 RichBlock.html；没有另写 widget 画法 |
| 作品引用与作品详情／owner | 部分已接 | A | 当前对话与所有对话的真实作品、图片／视频及评审来源；查询、类型、作者、时间／对话／成员分组、列表／卡片已接。按稳定来源 key 打开，评审读取原作品 thread。主区“全部作品”页此前已接同一全局 owner；r3b22 小组件改为工作台标签，读取真实 HTML 块、重试和回原消息，媒体预览来源已接；其它格式、引用卡仍未接完 |
| 已读确认 | 已接 | A | 引擎完成挂载且文档可见时 POST read/latest；后台／导出模式不确认，不保留旧前端 unread suppression 生命周期状态 |
| 原生 lifecycle 投递／补充消息 | 已接 | A | 精确 dispatchRef、inputRead、statusMessageId、activeRun；追加输入复用原投影。r3b12 接云端桥当前尝试的真实回执；连接恢复与队列 target retry 尚未接，不算全覆盖 |
| 云端投递、连接恢复 | 部分已接 | A | r3b25 在真实 notice 上接原恢复／回复 owner：授权会话、绑定、attempt 重试和回执／返回证明、查看回复；旧尝试、撤回源不启用新的重试。沿原有界轮询与错误重试组件；猫来源仅绑定不重发的声明缺口见第 5 节；dot 插件不碰。 |
| 部署版本更新与启动恢复 | 已接 | A | chatPage.connection／runtimeReload／startupRecovery；仅真实 owner 状态，不本地重启工作 |
| 桌面运行时更新设置 | 已接；未做安装包验收 | A | 原 UpdateManager／设置／prompt／progress owner；补可信主 frame 手动检查 IPC，沿现有下载／安装命令和 dialog 等待／失败位，无新更新 manager。 |
| 上下文文件检索与选择 | 已接 | A | 既有 worktree 发现、真实 workspace/search 和 createFileContextAttachment；对话筛选与文件结果共用原 chat.pop |
| 文件浏览、输入时 @ / # 候选 | 部分已接 | A | r3b25 @ 用真实成员及保存顺序；# 用真实对话和工作区文件搜索，光标选择保留输入后缀。作品引用须 W2 作品 owner 的精确来源／版本，未造引用；见 W1.md。 |
| 按 block.id 多选、部分导出／转发 | 已接 | A | sel.blocks 为稳定 id；部分正文沿真实 quote attestation；含附件消息的部分正文仍按原边界拒绝 |
| 任意选中文字的引用／批注／转发 | 部分已接 | A；旧定制 B | r3b25 已接消息正文：真实 message ID／选区 offsets，replyTo、带批注的上下文草稿、原 quote item 转发；与原文件／片子选区复用同一 mouseup 和浮层。执行记录 CLI 分段来源未猜测，仍未接。 |
| 成员悬停详情 | 已接 | A | r124 memberCard 声明直接画真实 memberCard VM；作者悬停、真实昵称／品种／句柄／模型／职责、@它、Esc／关闭走通用机制。没有 popBox；r3b22 基础详情／编辑页已接，设置余项见 team 行 |
| 消息朗读 | 已接 | A | 精确 voice-output 服务可用性与现有 useTts，原 fold / speaking 绑定；未运行真实音频验收 |
| 消息重试（图片／上下文／悄悄话） | 已接 | A | 使用原图片恢复逻辑，图片未完整恢复就拒绝发送；保留上下文和悄悄话参数。泛型文件附件重试仍未接，明确报错，不丢附件后静默重发 |
| 语音输入 | 已接 | A | 既有 useVoiceInput 与真实服务可用性；未调用麦克风或运行真实录音验收 |
| Markdown / TXT 全量与所选消息导出 | 已接 | A | 现有受鉴权导出接口，统一 download；未用真实会话调用 |
| PNG 项目侧协议 | 已接 | A | 导出地址保持 #export-<id>；静止信号等待异步富正文；上轮两条失败原断言已通过，API 32 条导出测试通过 |
| PNG 导出帧原始资源与 DOM | 已接；截图未验收 | A | r124 原样 export.js 与同一只读消息组件；既有 #export-<id>、异步正文 settled、动作参数与实体 promise 原断言继续通过；真实 Chromium / Next 仍受沙箱限制 |
| 主区：全部作品 | 已接；未做真实浏览器验收 | A | 现有 page.works / VM.worksAll 接全局分页 owner；行、卡片、搜索、类型／作者／分组与作品详情复用同一模型，工作台与 home 当前对话范围不变 |
| 系统提示条／数据错误提示 | 已接 | A | 音频服务真实异常仍进 notices；取数失败由已有错误／重试组件或 r124 通用危险 toast 表达，不再额外添加语音／Git／记忆“读取失败”输入框提示。正常和加载中不造异常；既有音频退避不改 |
| 首页与其它主页面 | 部分已接 | A | 新对话首页和工作台首页同一项目 recentWorks，项目选择沿真实 new-conversation admission。详情跨对话 owner 合并见 W1.md；成员基础页、语音页仍沿前轮，系统其它小节未接。 |
| 个人背景（一个全局背景） | 已接 | A | 默认主题全局选择／透明度在原 background-v1 本地 store；上传图片目录、原始文件和删除由服务端保存。旧 chatBackgrounds 数据与原读写 owner 保留，VM 给 v2；默认主题有意不读，不清理。 |
| 主题设置 | 已接 | A | r133 按 lang 决定回到原本地 store：深浅／跟随系统、紧凑、字体、布局、计算器和自定义主题完整文档；撤新 appearance 后端保存，不回用旧 OKLCH themeStore。 |
| 插件页面／空间（含 Collective） | 部分已接 | A | r3b25 详情真实 schema、分支／字段／记录、带 lifecycleRevision 的配置保存、通用 test owner、声明的操作／行操作和逐次确认接通；启停／卸载沿原 writer。独立 frame 沿已验包 src／view，Collective 用真实连接地址。正式包声明不在本轮；二维码组件缺真实 src，安装等管理项仍待后续，不造宿主入口。 |
| 其它独立 frame 入口（猫猫星球／独立文档编辑器） | 未接 | A | 按第 4 类保留独立客户端；只接真实 owner 提供的入口和外壳。Collective 已并入插件行，不重复列一项；不挂旧 JSX。 |
| 工作台：home（最近打开／最近作品） | 部分已接；待作品 owner 合并 | A | r133 改为组件本地“最近打开”＋works.recent；和新对话页同一项目真实最近作品，加载／错误重试／空态已接。recentWorkOwners 原 DTO 已给合并口；跨对话详情需由 W2 并入既有作品 owner，未复制详情逻辑。原执行／等待摘要不再画在首页。 |
| 工作台：exec（执行） | 部分已接 | A；旧定制 B | 真实 sessions、invocations、运行详情、计划、封存／恢复／原生压缩、外部运行时会话和分页 chat；r112 已解除 sessionId 参数通道阻塞；r3b13 接 home/live 精确子调用、跨对话会话读取和退出实时列表后的详情刷新。搜索仍限已读摘要／工具名，完整轨迹全文检索及超大外部记录未接完 |
| 工作台：works-t（作品） | 部分已接 | A | 复用 useGlobalArtifacts 的真实分页 catalogue，接所有对话、作者筛选、时间／对话／成员分组与卡片；当前对话来源、home 摘要仍独立于全局筛选。稳定 key 含来源 thread，打开评审用原 thread；失去可读来源后不保留旧作品画面。主区“全部作品”已接同一全局 owner；r3b22 小组件标签及来源定位已接；其它格式仍未接完 |
| 工作台：tasks（任务） | 部分已接 | A；旧定制 B | 当前 thread 的 taskStore 列表、筛选、revision 保护的状态流转、新建请求与 owner 回读；r112 通用任务对话框等待／失败保留已验证。r3b17 补同一 source opener 回真实 thread，返回 false 不切页；其它任务能力沿原进度 |
| 工作台：live（实时语音／会议共享） | 已接；未做真实音视频验收 | A | 此项是上一轮语音投影内的 Live 会话控制：prepare / RTC / text / screen；会话共享按 capture intent 写入。它不对应名为 live 的“正在发生”工作台面板，后者r3b7 接入，另列下一行 |
| 工作台：live（进行中／等待与接回） | 已接；未做真实 owner 验收 | A | 执行、等待与接回复用原 VM.live；r133 托管命令 execDetail 开在此面板顶上，不再开 home；执行／等待 owner 和重试机制不改。 |
| 工作台：recall（召回） | 部分已接 | A | 复用 useThreadRecall：当前 thread 的历史／实时召回、结果摘要和回复定位；不可读来源不展示旧 snippet。r3b13 已接 owner 可读的画像（带 revision）和对话／消息来源，现有行菜单分别打开来源／原回复；缓存回复按 catId＋子调用精确匹配，不猜父调用或时间。r3b20 已接 owner 单页读取、真实回复分组与更早回复按钮；消息行的同组召回计数／打开与换对话清理已接；文档搜索来源仍未接完 |
| 工作台：replay（回放） | 部分已接 | A；旧定制 B | 当前 thread 的完整消息／封存会话读取、原事件合并／适配／空闲标记／时间压缩，原播放状态机；工作台与全窗剧场共用原消息组件和 player。播放、暂停、seek、速度、模式、跳空闲与章节已接；r3b14 默认重试重新读取已打开的 owner thread；跨 thread 聚合与逐字效果未接完，未迁移旧全局快捷键。 |
| 工作台：schedule（日程） | 已接；未做真实浏览器验收 | A | useEntrustedWorkProjection(schedule)：current owner 按 subjectRef / revision 去重；actual_start / business_deadline 投影为月／周日历与当天／无日期列表；排除 execution_trigger，保留 partial 与 error，入口打开真实 thread |
| 工作台：eval（评估） | 部分已接 | A | summary／事件／指标／审阅包、主备值班 expectedVersion 与评估成员 writer 保留。自动调度开关已决定删除，撤回宿主待定项；无 writer／本地开关。r116 已原样删除开关与 ENT.dom；宿主没有对应待定项 |
| 工作台：board（看板） | 部分已接 | A；旧定制 B | 真实 home backlog、feature 文档阶段／AC／依赖、相关 thread、选中项 SOP；新建／文档导入、建议／批准／拒绝、lease acquire / heartbeat / release；仅 owner 回读后更新。外部项目及其它自领／回收流程未接 |
| 工作台：files（文件） | 部分已接 | A | 工作区树／懒加载／搜索／读取、Markdown／源码、同源下载、open/reveal、worktreeId 与编辑租约下的新建／目录／上传及改名／删除 writer。r113 实体确认已解除阻塞；文件改名失败保留输入和 owner 原因；r3b18 接 r126 的图片／视频／音频 raw 预览、其它二进制空状态／元数据与原文件动作；r3b19 按 pageUnit 显示页数／幻灯片／工作表，Office 内容预览按 lang 决定不在本次范围；r3b22 open 常用操作与 reveal 菜单依真实权限分开。 |
| 工作台：git | 已接；未做真实 API 验收 | A | 真实 status/log/show/diff/health，复用 diff parser；r3b12 复用原 Git DTO，runtimeDrift:null 与请求错误有独立回归；原生审查用当前 thread 的 native review owner，显式选择会话；没有 review:start 演示端点或假结果 |
| 工作台：terminal（终端） | 已接；未做真实 PTY 验收 | A | 真实 status、session POST、PTY WebSocket、原始 io 输出／输入／尺寸、agent pane 只读与 DELETE 沿用 r3b7。r113 实体确认等待回执；终端 remove 直接返回 owner promise，失败留确认与原因。隐藏只关 socket，不删 tmux owner。 |
| 工作台：preview（预览） | 已接；未做真实预览验收 | A | r116 framePost("preview", data) 一次性发送 navigate/back/forward/reload，附原桥接 source；同一 iframe 不重设 src、不重放。既有 gateway／targetPort／admission／可信 origin／控制台／截图回执继续由真实 owner 处理，实际 PDL 与注入脚本检查通过 |
| 工作台：mem（记忆） | 部分已接 | A | 人物／画像（含开场摘要）／事件／实体／品味列表、分页、详情、来源、画像用量（r3b19 对齐真实 openingMode 与使用记录）、owner 修正／停用／遗忘与候选概括确认；资料库／图谱／全局召回／健康／全文搜索、r3b17 已接画像／实体／人物提议回原审批卡，只认 anchored 的真实 approvalCardRef；r3b22 已接开场引用（结构化展示／修改／取消，保留来源，真实 replace_content）；其它提议决策、事件／品味修订仍未接完 |
| 工作台：voice（录音）、设置语音页 | 已接；未做真实录音验收 | A | 同一 /api/services 快照：输入／输出／采集服务状态和设置；音源、采集、说话人修正、共享、带到草稿与真实保存回执；无后端历史就不造录音条目。此前服务探测 30 秒；采集服务不可用时不连 audio SSE／轮询采集，读取或 SSE 失败后 30 秒再试，健康录音运行时 5 秒 |
| 作品详情：评审 | 部分已接 | A | R01–R25 的 owner 落点见 r3b6-capabilities.tsv 历史快照；r112 已解除 annotationId、worktreeId 与对象 reference 的参数阻塞。文档作品正文、片子其余编辑等仍未接完 |
| 工作台：clips（片子） | 部分已接 | A | 真实导入／登记、冻结 input／digest，意见／处理回执／历史／回复、重新打开及丢失回执确认；按真实回执比较两版、各自框选／意见定位、草稿与发送 owner 保留。r3b16 删逐段跟随及 sync/spans：两个播放器独立、各有控件，group＋各自 mapping 的场景 points，compareGroup 只列共有场景；一起播放／暂停、按节点对齐走库动作。独立成片预览的真实意见标记／批注已接，打开已展示版本不重设左右比较；审片消息导入／同步失败恢复等仍未接完 |
| 工作台：team（团队） | 部分已接 | A；旧定制 B | 既有真实 routing-context／成员服务／信号／偏好退役与审计保留。r3b22 成员设置入口、列表／子集排序、基础编辑／创建／模板、默认成员和所有者 owner 已接；原生运行时准备、上下文策略、正典头像选择、语音参考音频上传和插件客户端动态表单仍未接；不挂旧 Team JSX，不恢复已删偏好新建／修改／续期 |
| 工作台：evolution（进化） | 部分已接 | A；旧定制 B | 已接精确 program 详情、准备四项及来源／历史、归因／观测、改动状态与真实回执、轮次历史；暂停／恢复／改名、同步、满足真实 owner 条件的决策、推进／提醒请求。expectedSequence 与 program／workspace 校验沿原 writer，409 接收真实新投影后要求重试。r3b14 复用真实 asset-review：版本历史、精确选择、人话差异、所选版本的真实使用／观测回执、Program 已采用版本标题和单一可确认父版本的回滚来源已接（只读，不执行回滚）。历史选择不改变采用；跨对话证据定位接通。探索节点／案例／对比／请求、新目标入口仍未接；r3b15 对齐 r122：仅一个 source-current 版本且一个父版本时出现回滚来源；多当前／多父不出现，仍在版本历史选，已不待定；没有伪造阶段推进 |
| 工作台：signals（信号） | 部分已接 | A | 原列表／来源／学习时间线保留；此前接文章正文／真实报告、最新就绪笔记、标签／备注／thread 关联／集合、enrich、播客生成与脚本／音频下载、真实讨论 thread 解析。无报告不出现报告。每次最多读 owner 允许的 100 篇，分页缺原声明出口且当前 API 只有 limit、无 cursor／offset（本轮重新核对，见 5.3）；播客播放、笔记历史与多成员研究投递仍未接完 |
| 工作台：ops（运维） | 部分已接 | A | 既有额度／用量／路由／排行榜／观测保留。Runtime 按打开的 sessionId 读真实 metadata，事件／交接／原始三页与 owner cursor；治理真实项目发现、选项、预览 checksum／409 再确认；休息设置 GET／PUT；命令来自 COMMANDS；救援扫描／精确勾选／原 writer 与结果。r3b12 区分超大 chat／handoff 引用，缺内容／摘要数组不会抛错；后台会话此前接真实注册 owner 的完整快照／逐行接管命令／诊断／刷新；r3b13 接根运维页默认重试 → 真实 refresh/reload；提醒预览及其它未接流程保留 |
| 设置：系统／过程段偏好 | 部分已接 | A | r3b25 general 已接：语言／默认记录开合本地保存，processTalk 原 owner，忙时发送写原全局 message-disposition；按对话覆盖由后端原规则决定。桌面 update 保留。其它系统小节不在本轮 general 范围。 |

## 4. 检查原文

r3b25 最新：[宿主 99 条通过](r3b25-owner-delivery.txt)、[API 63 条通过](r3b25-tests-api.txt)，类型／lint／Biome exit 0，privacy-grep 0。全量 Web 首轮 `77 failed | 1681 passed`／`253 failed | 13945 passed | 1 skipped`；其中 251 个同名失败在 HEAD 原样复现，另 2 个本轮中间版本问题已在定稿后的宿主 99 条中通过。全部失败行、HEAD 对照及原始结果见 [W1 检查原文](W1.md#r3b25-检查原文)；未宣称全量通过。

下方 r3b23 历史日志汇总见 [W1 检查](W1.md#检查原文)。下面 r3b22 表保留为上一轮回归记录，不能代替本轮结果。

W1 最新：r133 81 文件差异／额外／mock 皆 0；API `ℹ tests 72`／`ℹ pass 72`／`ℹ fail 0`；桌面原生 35 条全过；最终应用 owner `Tests 23 passed`。首次整组 Web `2 failed | 120 passed`，失败原文保存在 W1；按 r133 更新首页旧断言后，原样运行时＋思考块整组 `Tests 64 passed`。Web／API 类型、Web lint、Biome 均 `Exit code: 0`（警告原样保留）；privacy-grep 两处 0。无新增截图／服务操作。


| 检查 | 结果原文／日志 |
| --- | --- |
| r132 逐字节复核 | [copy-check](r3b22-copy-check.txt)：`Files checked: 81`；`Byte mismatches: 0`；`Extra files: 0`；`mock / proto / local files: 0`；`Exit code: 0`。 |
| 原型 tag 隔离构建 | [build](r3b22-prototype-build.txt)：`lint {'pdl-schema': 0, 'file-boundary': 0, 'derived-only': 0, 'css-important': 1} 基线 {'pdl-schema': 0, 'file-boundary': 0, 'derived-only': 0, 'css-important': 1}`；`Exit code: 0`。不运行／改动设计仓工作区。 |
| API 外观／成员顺序／共创者／偏好原子写 | [API](r3b22-tests-api.txt)：`ℹ tests 33`；`ℹ pass 33`；`ℹ fail 0`；`Exit code: 0`。由项目 with-test-home 隔离执行，不改实例配置。 |
| 前端整组宿主与相关 owner 回归 | [完整日志](r3b22-tests-web.txt)：`Test Files  116 passed (116)`；`Tests  1280 passed (1280)`；`Exit code: 0`。新增开场引用对话框用例后，运行时另全跑 53 条，见下一行。 |
| 最新原样运行时／应用脚本 | [runtime](r3b22-runtime-final.txt)：`Test Files  1 passed (1)`；`Tests  53 passed (53)`；`Exit code: 0`。包含 r111 settle、r112 typed args、r113 实体 promise、r128 chat.modal、r132 身份与成员声明、开场引用写入等待和失败原因。 |
| Web／API 类型 | [Web](r3b22-typecheck-web-verified.txt)、[API](r3b22-typecheck-api.txt)：`Exit code: 0`。 |
| 项目 Web lint | [lint](r3b22-lint-web.txt)：`Exit code: 0`；日志保留原 useEffect 依赖等警告。 |
| 改动范围 Biome | [Biome](r3b22-biome-final.txt)：`Checked 18 files`；`Found 735 warnings.`；`Found 56 infos.`；`Exit code: 0`。包含 classic JS 风格告警，未放宽规则／排除本轮应用文件。 |
| 脚本语法与运行图 | [syntax](r3b22-syntax.txt)：`JS files checked: 70`；`Syntax failures: 0`；`Exit code: 0`。[运行依赖](r3b22-runtime-dependencies.json)／[摘要](r3b22-runtime-graph.txt)：宿主运行图没有旧页面渲染器。 |
| 隐私 | [privacy](r3b22-privacy.txt)：`Isolated r132 build privacy-grep: 0`；`Project public runtime privacy-grep: 0`；`Exit code: 0`。 |

调试期的失败已修复：新增测试的 union 类型收窄、fixture 字段／DOM 属性与真实契约对齐；成员异步读取登记 settleHold 并在 DOM 测试关闭窗口前等待静止；Biome import 顺序已整理。原始日志保留，以上最新检查才是交付结果。没有为通过检查改规则、复制组件或旧断言；新增开场引用失败用例验证的是真实写入与对话框行为。

组件清单／对比度／全量浏览器检查沿 lang 的本轮豁免跳过，相似度快照留最后；没有启动 3013、没有新截图。JSDOM 只验证声明与动作，不算视觉验收。真实浏览器与验收数据按 lang 后续安排执行。

## 5. 未完成／需要 lang 决定

r3b21 余项（Collective 正式包声明、完整日志范围、录音历史／B 类旧定制、收件箱外壳）继续跟踪；W2／W3 的声明缺口由各自文档继续。桌面平台桥本轮已解。旧背景已定保留并给 v2，不再等清理决定。新增的真实声明缺口逐项记在本节，不改复制文件。

- 待办：r132 已去掉日程 tab，查看日程的声明直接打开工作台 schedule；宿主没有旧 main.tabs/todo/schedule 要保留。收件箱外壳和完整 VM 仍沿 r3b19 安排留收尾，本轮未把未接壳记为完成。
- 社区：r132 已改成固定接受／拒绝、推荐项主按钮和普通 findings 小节，宿主没有残留 acceptLabel；真实插件 community-board／decision-queue／resolve owner 尚未绑定，不把复制声明算作接通。后续与正式 GitHub 插件空间入口一起接，未增加宿主硬编码入口、未改插件仓或 dot。
- 成员设置仍是部分覆盖：基础字段／真实写入已接；原生运行时准备、上下文策略、正典头像选择、语音参考音频上传、插件客户端动态表单继续未接。正典关联的头像不绕过其独立 owner 上传。成员与 Codex 共用配置是两个 writer，先保存共用项，再写成员；后者失败时不会回滚已成功的共用配置，失败保持原草稿供重试。

### r3b25 新发现（原型声明／动作契约）

- `modal.classify` 固定画“接受全部建议”→ cafeClSuggest；r133 features.json 仍标 demo（proto/demo.js），项目只有标签 CRUD／线程 labels writer，没有分类建议 owner。手动赋标签已接；不编造 AI 建议或前端分类规则。该按钮需要原型给真实建议 VM／写入契约，或由 lang 确认省略后再复制。

- 插件二维码：r133 `library/widgets.js` 的 pcfOpHtml 对 `o.img` 固定画 grid 图标，没有读取真实二维码 src。配置普通字段／分支／记录、rows／live 操作继续接；`resultRender: img` 的启动动作暂不发送，不在项目拼图片 HTML。需要原型给真实图像 VM／组件读取位。
- 实体提议冲突解决：普通 F260 同意／拒绝可用；真实 conflict 需要选择合并／改名／放弃等请求，r133 card.proposal 只声明同意／拒绝／原位文字编辑，没有 entity conflict 的结构化 VM 与 action。冲突时不提供同意，保留拒绝；冲突解决等待原型契约。
- 社区 issue 预览／草稿：真实 GitHub 插件有配置仓库候选、创建草稿与 publish 恢复（draftId），r133 issuedraft 模板没有对应结构化 VM／创建后续写动作契约。是否由正式 GitHub 插件空间声明承接需要 lang 定；本轮不碰插件仓、不把 meta 直接当发布授权。评估修复实际是 F266，已找到并接原审批 owner，不再列为缺口。
- 画像提议原位修改：现有 card.proposal 在 editing 时固定画“想怎么改”；F231 的真实 writer 支持改 afterContent，却没有向猫发修改要求的接口。已先接原读取和同意／拒绝，未造修改请求；需要原型分开 editable 与可请求修改的能力。

- 猫来源云端恢复：原 owner 支持 bindingOnly（可以连接，不能重试猫发出的源消息）；r133 cloudRecovery 只声明“绑定并重试”，且 canSubmit 必须是 owner 的 user 源／有 attempt。此子项未接，未套用用户消息重试；需要原型给仅绑定的动作／状态契约。

### 本轮 W1 合并边界

最近作品的项目读取和显示已接；recentWorkOwners 尚需 W2 合并进既有 workOpen 查找源，条目先不附开启动作，待 W2 按真实来源／版本并入同一 owner 后挂原动作；不把 ref 当唯一授权，不复制作品详情、不修改 W2 文件。本轮系统 general／侧栏主动作／消息正文选区／用户源云端恢复／插件管理均已绑定。# 作品引用也需要精确的同一作品 owner（当前 shared 上下文没有任意 kind=work 的引用），待 W2 合并其来源／版本后接，不借标题或 ref 伪造。CLI 执行记录选区仍缺明确分段来源契约，不把它作为普通消息正文；消息正文已接。其余逐项缺口见上，不将未接项算完成。

## 6. Git

HEAD 保持 `b2bdc0eec6`。无提交、push、.env 或服务操作。`W1.md` 和检查日志是本轮交付文档，保留为未提交文件，由 lang 提交；不因自检提示自行 push。
